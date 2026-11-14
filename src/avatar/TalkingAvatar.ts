import * as THREE from "three";
import { BodyAnimator, type GestureLevel } from "../behavior/BodyAnimator";
import { BlinkController } from "../behavior/Blink";
import { ExpressionController } from "../behavior/Expressions";
import { GazeController } from "../behavior/Gaze";
import { HeadMotion } from "../behavior/HeadMotion";
import type { AvatarState } from "../behavior/types";
import { AudioLipSync } from "../lipsync/AudioLipSync";
import { type VisemeWeights, emptyWeights } from "../lipsync/LipSyncTrack";
import { VISEMES } from "../lipsync/visemes";
import { type Framing, Stage } from "../scene/Stage";
import { MicListener } from "../speech/MicListener";
import { SpeechPlayer, type Utterance } from "../speech/SpeechPlayer";
import { SpeechQueue } from "../speech/SpeechQueue";
import { TTSClient, type VoiceSettings } from "../speech/TTSClient";
import type { Mood } from "../speech/text";
import { AudioClock, type Clock, VirtualClock, WallClock } from "../util/clock";
import { chance, clamp, damp, rand, smoothstep } from "../util/math";
import { AvatarModel, loadAvatar } from "./AvatarModel";
import { FaceController } from "./FaceController";
import { type MouthMaterials, setupMaterials, updateMouthOcclusion } from "./materials";

export interface TalkingAvatarOptions {
  container: HTMLElement;
  avatarUrl?: string;
  ttsUrl?: string;
  /** Deterministic frame-by-frame rendering on a virtual clock (no audio output). */
  capture?: { width: number; height: number; fps: number };
  onProgress?: (fraction: number) => void;
}

export interface AvatarListeners {
  state?: (s: AvatarState) => void;
  subtitle?: (text: string, wordIndex: number, words: string[]) => void;
  error?: (e: Error) => void;
  frame?: (visemes: VisemeWeights) => void;
}

type ManualState = Exclude<AvatarState, "speaking">;

function wordIndexAt(u: Utterance, clipTime: number): number {
  const ms = clipTime * 1000;
  let idx = -1;
  for (let i = 0; i < u.timing.wtimes.length; i++) if (u.timing.wtimes[i] <= ms) idx = i;
  return idx;
}

/**
 * The talking avatar: owns rendering, speech, lip sync and all behaviour layers. Public API:
 * speak(), enqueue(), stop(), playAudio(), setState(), setMood(), setVoice(), setFraming().
 */
export class TalkingAvatar {
  readonly audioCtx: AudioContext;
  readonly stage: Stage;
  readonly tts: TTSClient;
  readonly player: SpeechPlayer;
  readonly speech: SpeechQueue;
  readonly mic: MicListener;
  model!: AvatarModel;
  listeners: AvatarListeners = {};

  voice: VoiceSettings = { voice: "af_heart", speed: 1 };
  /** Articulation strength (0.6 subtle .. 1.3 exaggerated). */
  lipIntensity = 1;
  /** Interrupt the avatar when the user starts talking (mic must be on). */
  bargeIn = false;
  state: AvatarState = "idle";

  private face!: FaceController;
  private blink!: BlinkController;
  private gaze!: GazeController;
  private head!: HeadMotion;
  private expr!: ExpressionController;
  private body!: BodyAnimator;
  private mouth!: MouthMaterials;
  private audioLip?: AudioLipSync;

  private readonly behaviorClock: Clock;
  private readonly speechClock: Clock;
  private readonly virtual?: VirtualClock;
  private readonly fps: number;
  private manual: ManualState = "idle";
  private waiting = false;
  private speakingAmt = 0;
  private lastFrame = 0;
  private currentU = -1;
  private lastClip = 0;
  private lastWord = -2;
  private visemes = emptyWeights();
  private silentWaiters: Array<() => void> = [];
  private running = false;

  constructor(private opts: TalkingAvatarOptions) {
    this.audioCtx = new AudioContext({ latencyHint: "interactive" });
    if (opts.capture) {
      this.virtual = new VirtualClock();
      this.behaviorClock = this.speechClock = this.virtual;
    } else {
      this.behaviorClock = new WallClock();
      this.speechClock = new AudioClock(this.audioCtx);
    }
    this.fps = opts.capture?.fps ?? 60;
    this.stage = new Stage(opts.container, opts.capture ? { capture: true, ...opts.capture } : {});
    this.tts = new TTSClient(this.audioCtx, opts.ttsUrl ?? "/tts");
    this.player = new SpeechPlayer(this.audioCtx, this.speechClock, !opts.capture);
    this.speech = new SpeechQueue(this.tts, this.player, () => this.voice, () => this.lipIntensity);
    this.speech.onError = (e) => {
      this.waiting = false;
      this.listeners.error?.(e);
    };
    this.mic = new MicListener(this.audioCtx);
    this.mic.onSpeechStart = () => {
      if (this.bargeIn && this.state === "speaking") this.stop();
      if (this.state !== "speaking") this.setState("listening");
    };
    this.mic.onSpeechEnd = () => {
      if (this.manual === "listening") {
        this.head?.ackNod(this.behaviorClock.now());
        if (chance(0.4)) this.body?.nod();
      }
    };
  }

  async load() {
    this.model = await loadAvatar(this.opts.avatarUrl ?? "/avatar/avatar.glb", this.opts.onProgress);
    this.stage.scene.add(this.model.root);
    this.mouth = setupMaterials(this.model);
    this.face = new FaceController(this.model);
    const now = this.behaviorClock.now();
    this.blink = new BlinkController(now);
    this.gaze = new GazeController(this.model, this.stage.camera, this.blink);
    this.head = new HeadMotion(this.model);
    this.expr = new ExpressionController();
    this.body = new BodyAnimator(this.model);
    this.body.setState("idle", 0);
    this.body.update(1 / 60);
    this.model.root.updateMatrixWorld(true);
    // frame on the rest-pose eyes
    const eyes = this.model.bones.leftEye.getWorldPosition(new THREE.Vector3())
      .add(this.model.bones.rightEye.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
    this.stage.setFocus(eyes);
    this.gaze.attention.copy(this.stage.camera.position);
    this.gaze.headAttention.copy(this.stage.camera.position);
    await this.stage.renderer.compileAsync(this.stage.scene, this.stage.camera);
    this.lastFrame = this.behaviorClock.now();
    if (!this.opts.capture) this.start();
  }

  // ------------------------------------------------------------------------------- public API

  /** Speak text (supports [mood] tags and emojis). Resolves when the avatar has finished talking. */
  async speak(text: string, mood?: Mood): Promise<void> {
    await this.resumeAudio();
    if (mood) this.expr.setMood(mood);
    this.waiting = true;
    await this.speech.speak(text, mood);
    return this.untilSilent();
  }

  /** Append one sentence to the current speech (streaming LLM output). */
  enqueue(sentence: string, mood?: Mood) {
    this.waiting = true;
    void this.resumeAudio();
    return this.speech.enqueue(sentence, mood);
  }

  /** Interrupt speech immediately (mouth closes smoothly with the audio fade). */
  stop() {
    this.speech.interrupt();
    this.audioLip?.stop();
    this.waiting = false;
  }

  /** Lip-sync an arbitrary audio file without timings (audio-driven fallback). */
  async playAudio(data: ArrayBuffer) {
    await this.resumeAudio();
    this.stop();
    this.audioLip ??= await AudioLipSync.create(this.audioCtx, this.player.output);
    await this.audioLip.play(data);
  }

  setState(s: ManualState) {
    this.manual = s;
  }

  setMood(m: Mood) {
    this.expr.setMood(m);
  }

  setExpressionIntensity(v: number) {
    this.expr.intensity = v;
  }

  setGestures(level: GestureLevel) {
    this.body.gestures = level;
  }

  setFraming(f: Framing) {
    this.stage.setFraming(f);
  }

  async resumeAudio() {
    if (this.audioCtx.state === "suspended") await this.audioCtx.resume();
  }

  untilSilent(): Promise<void> {
    return new Promise((resolve) => this.silentWaiters.push(resolve));
  }

  get speaking(): boolean {
    return this.state === "speaking";
  }

  /** Current viseme weights (lip-sync output of the last frame). */
  get currentVisemes(): Readonly<VisemeWeights> {
    return this.visemes;
  }

  // ------------------------------------------------------------------------------- frame loop

  private start() {
    if (this.running) return;
    this.running = true;
    this.stage.renderer.setAnimationLoop(() => this.frame());
  }

  /** Capture mode: render the frame for the current virtual time, then advance one frame. */
  step() {
    this.frame();
    this.virtual!.advance(1 / this.fps);
  }

  private setStateInternal(s: AvatarState, now: number) {
    const wasSpeaking = this.state === "speaking";
    this.state = s;
    this.blink.state = s;
    this.expr.state = s;
    this.gaze.setState(s, now);
    this.head.setState(s, now);
    this.body.setState(s, s === "speaking" ? 0.6 : 1.0);
    if (wasSpeaking) this.head.clearTilt();
    this.listeners.state?.(s);
  }

  private onUtteranceStart(u: Utterance, now: number, first: boolean) {
    this.currentU = u.id;
    this.lastClip = u.offset - 0.3;
    this.lastWord = -2;
    if (u.mood) this.expr.setMood(u.mood);
    this.gaze.onSentenceStart(now, first);
    if (!first && chance(0.35)) this.blink.trigger(now);
    this.listeners.subtitle?.(u.text, -1, u.timing.words);
  }

  private frame() {
    const now = this.behaviorClock.now();
    const dt = clamp(now - this.lastFrame, 0, 0.1);
    this.lastFrame = now;
    const sNow = this.speechClock.now();
    this.player.prune(sNow);
    this.mic.update(dt);
    this.audioLip?.update(dt * 1000);

    // ------------------------------------------------------------------ who is talking?
    const cur = this.player.at(sNow);
    const scheduledAhead = this.player.busy(sNow);
    const audioDriven = !!this.audioLip?.active;
    let next: AvatarState;
    if (cur || scheduledAhead || audioDriven) next = "speaking";
    else if (this.waiting && this.speech.pending > 0) next = "thinking";
    else next = this.manual;
    if (!cur && !scheduledAhead && this.speech.pending === 0) this.waiting = false;
    if (next !== this.state) {
      const first = this.state !== "speaking";
      this.setStateInternal(next, now);
      if (next === "speaking" && cur && cur.u.id !== this.currentU) this.onUtteranceStart(cur.u, now, first);
    }
    if (next !== "speaking" && this.silentWaiters.length && this.speech.pending === 0) {
      const w = this.silentWaiters;
      this.silentWaiters = [];
      w.forEach((r) => r());
    }

    // ------------------------------------------------------------------ speech cues + visemes
    if (cur) {
      const { u, clipTime } = cur;
      if (u.id !== this.currentU) this.onUtteranceStart(u, now, false);
      for (const e of u.emphasis) {
        if (this.lastClip < e && clipTime >= e) {
          this.head.nod(rand(0.6, 0.9));
          if (chance(0.5)) this.expr.browFlash(now, rand(0.22, 0.38));
        }
      }
      const n = u.timing.wtimes.length;
      if (n) {
        const lastStart = u.timing.wtimes[n - 1] / 1000;
        const lastEnd = lastStart + u.timing.wdurations[n - 1] / 1000;
        if (u.isQuestion && this.lastClip < lastStart && clipTime >= lastStart) {
          this.head.questionTilt();
          this.expr.browFlash(now, 0.3);
        }
        if (!u.isQuestion && this.lastClip < lastEnd - 0.1 && clipTime >= lastEnd - 0.1) this.head.nod(0.4);
      }
      const wi = wordIndexAt(u, clipTime);
      if (wi !== this.lastWord) {
        this.lastWord = wi;
        this.listeners.subtitle?.(u.text, wi, u.timing.words);
      }
      u.track.sample(clipTime, this.visemes);
      this.head.speechLoud = u.loud.at(clipTime);
      this.lastClip = clipTime;
    } else if (audioDriven) {
      for (const v of VISEMES) this.visemes[v] = Math.min(1, this.audioLip!.weights[v] * 1.15);
      this.head.speechLoud = this.audioLip!.loud;
    } else {
      for (const v of VISEMES) this.visemes[v] = damp(this.visemes[v], 0, 0.05, dt);
      if (this.lastWord !== -2 && this.state !== "speaking") {
        this.lastWord = -2;
        this.listeners.subtitle?.("", -1, []);
      }
    }

    const vl = this.face.layer("viseme");
    for (const v of VISEMES) vl[`viseme_${v}`] = v === "sil" ? 0 : this.visemes[v];

    // pre-speech inhale: lips part slightly ~300 ms before the first word
    const breath = this.face.layer("breath");
    const upcoming = this.player.at(sNow + 0.35);
    let b = 0;
    if (!cur && upcoming) {
      const lead = upcoming.u.start - (sNow - this.player.latency);
      b = smoothstep(0.35, 0.12, lead) * (1 - smoothstep(0.08, 0, lead));
    }
    breath.jawOpen = 0.07 * b;
    breath.mouthRollLower = 0.05 * b;

    this.speakingAmt = damp(this.speakingAmt, this.state === "speaking" ? 1 : 0, 0.15, dt);

    // ------------------------------------------------------------------ body, head, eyes, face
    this.head.restore();
    this.body.update(dt);
    this.head.update(now, dt, this.stage.camera.position, this.gaze.headAttention);
    this.gaze.update(now, dt, this.face.layer("gaze"));
    this.blink.update(now, this.face.layer("blink"));
    this.expr.update(now, dt, this.face.layer("expression"));
    this.face.apply(this.speakingAmt);

    const f = (k: string) => this.face.value(k);
    const open = f("viseme_aa") + 0.8 * f("viseme_O") + 0.6 * (f("viseme_E") + f("viseme_I") + f("viseme_U")) +
      f("jawOpen") + 0.5 * f("viseme_CH") + 0.4 * (f("viseme_TH") + f("viseme_DD") + f("viseme_SS") + f("viseme_kk") + f("viseme_nn") + f("viseme_RR"));
    updateMouthOcclusion(this.mouth, open);

    this.stage.render();
    this.listeners.frame?.(this.visemes);
  }

  /** Capture mode: the full soundtrack of everything spoken so far, as a WAV file. */
  soundtrackWav(): ArrayBuffer {
    const sr = 48000;
    const hist = this.player.history;
    const end = hist.reduce((m, u) => Math.max(m, u.end + 0.5), 0);
    const out = new Float32Array(Math.ceil(end * sr));
    for (const u of hist) {
      const src = u.audio.getChannelData(0);
      const ratio = u.audio.sampleRate / sr;
      const startIdx = Math.round(u.start * sr);
      const len = Math.round((u.end - u.start) * sr);
      for (let i = 0; i < len && startIdx + i < out.length; i++) {
        const s = (u.offset * sr + i) * ratio;
        const i0 = Math.floor(s);
        if (i0 + 1 >= src.length) break;
        out[startIdx + i] += src[i0] + (src[i0 + 1] - src[i0]) * (s - i0);
      }
    }
    const buf = new ArrayBuffer(44 + out.length * 2);
    const dv = new DataView(buf);
    const w = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
    w(0, "RIFF"); dv.setUint32(4, 36 + out.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    w(36, "data"); dv.setUint32(40, out.length * 2, true);
    for (let i = 0; i < out.length; i++) dv.setInt16(44 + i * 2, clamp(out[i], -1, 1) * 32767, true);
    return buf;
  }
}
