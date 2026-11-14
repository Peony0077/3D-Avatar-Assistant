import { LipSyncTrack, type TTSTiming } from "../lipsync/LipSyncTrack";
import { LoudnessEnvelope } from "../lipsync/loudness";
import type { Clock } from "../util/clock";
import type { Mood } from "./text";

/** One synthesized sentence, scheduled on the speech clock. */
export interface Utterance {
  id: number;
  text: string;
  mood?: Mood;
  audio: AudioBuffer;
  timing: TTSTiming;
  track: LipSyncTrack;
  loud: LoudnessEnvelope;
  /** Seconds trimmed from the start of the clip (leading silence). */
  offset: number;
  /** Speech-clock time at which clip time `offset` is played. */
  start: number;
  /** Speech-clock time after which this utterance is over (trailing silence trimmed). */
  end: number;
  /** Clip times (s) of emphasised words: head nods, eyebrow flashes. */
  emphasis: number[];
  isQuestion: boolean;
}

export type UtteranceInit = Omit<Utterance, "start" | "end" | "offset" | "emphasis" | "isQuestion" | "loud" | "track"> & {
  lipIntensity?: number;
};

/** Find stressed words: locally loudest, at least ~0.7 s apart. */
export function findEmphasis(timing: TTSTiming, loud: LoudnessEnvelope): number[] {
  const scored = timing.words.map((w, i) => {
    const t0 = timing.wtimes[i] / 1000;
    const d = timing.wdurations[i] / 1000;
    const content = w.replace(/[^a-zA-Z0-9]/g, "").length > 3; // skip function words
    return { t: t0, s: loud.mean(t0, t0 + Math.min(d, 0.35)) * (content ? 1 : 0.6) };
  });
  const picks: number[] = [];
  for (const c of [...scored].sort((a, b) => b.s - a.s)) {
    if (c.s < 0.75) break;
    if (picks.every((p) => Math.abs(p - c.t) > 0.7)) picks.push(c.t);
    if (picks.length >= Math.max(1, Math.round(scored.length / 4))) break;
  }
  return picks.sort((a, b) => a - b);
}

/**
 * Gapless sentence playback on the Web Audio clock. Lip sync samples the same clock, compensated by
 * the output latency, so mouth movement matches what the listener hears.
 */
export class SpeechPlayer {
  readonly output: GainNode;
  private queue: Utterance[] = [];
  private sources = new Map<number, AudioBufferSourceNode>();
  /** Every scheduled utterance (capture mode mixes these into the exported soundtrack). */
  readonly history: Utterance[] = [];

  constructor(private ctx: AudioContext, private clock: Clock, private playAudio = true) {
    this.output = ctx.createGain();
    this.output.connect(ctx.destination);
  }

  get latency(): number {
    if (!this.playAudio) return 0;
    const c = this.ctx as AudioContext & { outputLatency?: number };
    return (c.outputLatency || 0) + (c.baseLatency || 0);
  }

  schedule(init: UtteranceInit, gap: number): Utterance {
    const { audio, timing } = init;
    const loud = LoudnessEnvelope.fromAudioBuffer(audio);
    const track = LipSyncTrack.fromTiming(timing, loud, { intensity: init.lipIntensity ?? 1 }, audio.duration);
    // Trim Kokoro's leading/trailing silence so sentences flow naturally.
    const firstWord = timing.wtimes.length ? timing.wtimes[0] / 1000 : 0;
    const lastWordEnd = timing.wtimes.length
      ? (timing.wtimes[timing.wtimes.length - 1] + timing.wdurations[timing.wdurations.length - 1]) / 1000
      : audio.duration;
    const offset = Math.max(0, Math.min(firstWord - 0.12, audio.duration));
    const keepTail = Math.min(audio.duration, lastWordEnd + 0.22);

    const now = this.clock.now();
    const last = this.queue[this.queue.length - 1];
    const start = Math.max(now + 0.08, last ? last.end + gap : 0);
    const u: Utterance = {
      ...init,
      loud,
      track,
      offset,
      start,
      end: start + (keepTail - offset),
      emphasis: findEmphasis(timing, loud),
      isQuestion: /\?["')\]]*\s*$/.test(init.text),
    };
    if (this.playAudio) {
      const src = this.ctx.createBufferSource();
      src.buffer = audio;
      src.connect(this.output);
      src.start(start, offset);
      src.onended = () => this.sources.delete(u.id);
      this.sources.set(u.id, src);
    }
    this.queue.push(u);
    this.history.push(u);
    return u;
  }

  /** The utterance audible at speech-clock time t, with its clip-relative time. */
  at(t: number): { u: Utterance; clipTime: number } | null {
    const heard = t - this.latency;
    for (const u of this.queue) {
      if (heard >= u.start - 0.2 && heard <= u.end + 0.15) return { u, clipTime: heard - u.start + u.offset };
    }
    return null;
  }

  /** True while audio is scheduled or playing. */
  busy(t: number): boolean {
    const last = this.queue[this.queue.length - 1];
    return !!last && t - this.latency < last.end;
  }

  get lastEnd(): number {
    return this.queue.length ? this.queue[this.queue.length - 1].end : 0;
  }

  prune(t: number) {
    const heard = t - this.latency;
    while (this.queue.length && this.queue[0].end + 1 < heard) this.queue.shift();
  }

  /** Stop everything with a short fade (interruption / barge-in). */
  clear(fade = 0.06) {
    const now = this.ctx.currentTime;
    if (this.playAudio && this.sources.size) {
      const g = this.output.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + fade);
      for (const src of this.sources.values()) {
        try {
          src.stop(now + fade + 0.01);
        } catch {
          /* already stopped */
        }
      }
      g.setValueAtTime(1, now + fade + 0.02);
    }
    this.sources.clear();
    // keep the currently audible utterance only until the fade has finished (mouth closes smoothly)
    const t = this.clock.now();
    for (const u of this.queue) {
      if (u.start < t) u.end = Math.min(u.end, t + fade);
    }
    this.queue = this.queue.filter((u) => u.start < t);
  }
}
