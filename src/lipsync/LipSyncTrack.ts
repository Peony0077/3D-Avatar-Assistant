import { clamp, smoothstep } from "../util/math";
import { LoudnessEnvelope } from "./loudness";
import { PROFILE, VISEMES, type Viseme, phonemeToVisemes } from "./visemes";

/** Timing data returned by the TTS server (HeadTTS format, milliseconds from audio start). */
export interface TTSTiming {
  words: string[];
  wtimes: number[];
  wdurations: number[];
  visemes: string[];
  vtimes: number[];
  vdurations: number[];
  phonemes?: string[];
}

export interface VisemeEvent {
  v: Viseme;
  t0: number; // acoustic start (s)
  t1: number; // acoustic end (s)
  amp: number; // peak weight
  lead: number; // how early the mouth starts moving (s)
  release: number; // decay after t1 (s)
}

export interface LipSyncOptions {
  /** Global articulation gain (1 = natural, 0.7 = subtle, 1.2 = exaggerated). */
  intensity?: number;
  /** Anticipation: mouth starts forming a shape this long before it is heard (s). */
  lead?: number;
  /** Decay after the sound ends (s). */
  release?: number;
  /**
   * Shift the whole visual track earlier (s). Viewers accept the mouth slightly ahead of the sound
   * but notice it lagging; measured with tools/analyze-sync.py, 0.06 puts the mouth ~20-40 ms ahead.
   */
  advance?: number;
}

export type VisemeWeights = Record<Viseme, number>;

export const emptyWeights = (): VisemeWeights =>
  Object.fromEntries(VISEMES.map((v) => [v, 0])) as VisemeWeights;

/**
 * Turn phoneme timings into viseme events:
 *  - own phoneme->viseme map (diphthongs glide between two shapes, "h" borrows the next vowel)
 *  - vowel opening scales with loudness and duration (stressed = wider, reduced = smaller)
 *  - repeated visemes merge (e.g. "m p" = one sustained closure)
 *  - lip rounding for O/U starts during the preceding consonant (anticipatory coarticulation)
 */
export function buildEvents(timing: TTSTiming, loud?: LoudnessEnvelope, opts: LipSyncOptions = {}): VisemeEvent[] {
  const intensity = opts.intensity ?? 1;
  const lead = opts.lead ?? 0.05;
  const release = opts.release ?? 0.06;
  const advance = opts.advance ?? 0.06;
  const raw: VisemeEvent[] = [];
  const n = Math.min(timing.vtimes.length, timing.vdurations.length);
  for (let i = 0; i < n; i++) {
    const t0 = timing.vtimes[i] / 1000 - advance;
    const dur = Math.max(0.02, timing.vdurations[i] / 1000);
    const parts = phonemeToVisemes(timing.phonemes?.[i], timing.visemes[i], timing.phonemes?.[i + 1]);
    let t = t0;
    for (const part of parts) {
      const d = dur * part.share;
      const prof = PROFILE[part.v];
      if (prof.kind !== "sil") {
        let amp = prof.amp * part.gain * intensity;
        if (prof.kind === "vowel") {
          const l = loud ? loud.mean(t + advance, t + advance + d) : 0.8;
          amp *= clamp(0.62 + 0.45 * l, 0.6, 1.15);
          amp *= clamp((d - 0.025) / 0.09, 0.5, 1);
        } else if (prof.kind === "consonant") {
          amp *= clamp((d - 0.015) / 0.06, 0.7, 1);
        } else {
          amp = Math.max(amp, 0.92); // closures: lips must meet regardless of speed
        }
        raw.push({
          v: part.v,
          t0: t,
          t1: t + d,
          amp: clamp(amp, 0, 1),
          lead: prof.kind === "closure" ? lead + 0.015 : lead,
          release,
        });
      }
      t += d;
    }
  }
  const events: VisemeEvent[] = [];
  for (const e of raw) {
    const last = events[events.length - 1];
    if (last && last.v === e.v && e.t0 - last.t1 < 0.03) {
      last.t1 = e.t1;
      last.amp = Math.max(last.amp, e.amp);
    } else {
      events.push({ ...e });
    }
  }
  for (let i = 1; i < events.length; i++) {
    const e = events[i];
    const p = events[i - 1];
    if ((e.v === "U" || e.v === "O") && PROFILE[p.v].kind === "consonant" && e.t0 - p.t1 < 0.03) {
      e.lead = Math.min(0.14, Math.max(e.lead, e.t0 - p.t0 + 0.02));
    }
  }
  return events;
}

function envelope(e: VisemeEvent, t: number): number {
  const dur = e.t1 - e.t0;
  const a = e.t0 - e.lead;
  const peakA = e.t0 + Math.min(0.35 * dur, 0.045);
  const peakB = Math.max(peakA, e.t1 - Math.min(0.3 * dur, 0.04));
  const r = e.t1 + e.release;
  if (t <= a || t >= r) return 0;
  return Math.min(smoothstep(a, peakA, t), 1 - smoothstep(peakB, r, t));
}

/** A viseme timeline for one audio clip; sample() gives blend weights at any time. */
export class LipSyncTrack {
  readonly events: VisemeEvent[];
  readonly duration: number;
  private readonly ends: number[];

  constructor(events: VisemeEvent[], duration?: number) {
    this.events = events;
    this.ends = events.map((e) => e.t1 + e.release);
    this.duration = duration ?? (events.length ? this.ends[this.ends.length - 1] : 0);
  }

  static fromTiming(timing: TTSTiming, loud?: LoudnessEnvelope, opts?: LipSyncOptions, duration?: number) {
    return new LipSyncTrack(buildEvents(timing, loud, opts), duration);
  }

  /** Viseme weights at time t (seconds from clip start). Writes into and returns `out`. */
  sample(t: number, out: VisemeWeights = emptyWeights()): VisemeWeights {
    for (const v of VISEMES) out[v] = 0;
    // first event that is still active at t (ends are monotonic)
    let lo = 0;
    let hi = this.ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ends[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    for (let j = lo; j < this.events.length; j++) {
      const e = this.events[j];
      if (e.t0 - e.lead > t) break;
      const w = envelope(e, t) * e.amp;
      if (w > out[e.v]) out[e.v] = w;
    }
    // Overlapping open shapes are additive on the mesh: keep total opening <= 1.
    let open = 0;
    for (const v of VISEMES) if (v !== "PP" && v !== "FF") open += out[v];
    if (open > 1) for (const v of VISEMES) if (v !== "PP" && v !== "FF") out[v] /= open;
    // Closure dominance: during P/B/M the lips close no matter what the neighbours do.
    const pp = out.PP;
    const ff = out.FF;
    if (pp > 0 || ff > 0) {
      const k = (1 - 0.92 * pp) * (1 - 0.55 * ff);
      for (const v of VISEMES) if (v !== "PP" && v !== "FF") out[v] *= k;
      out.FF *= 1 - 0.8 * pp;
    }
    return out;
  }
}
