import type { Weights } from "../avatar/FaceController";
import type { Mood } from "../speech/text";
import { Noise1D, damp, smoothstep } from "../util/math";
import type { AvatarState } from "./types";

const both = (l: string, r: string, v: number): Weights => ({ [l]: v, [r]: v });
const pair = (base: string, v: number) => both(`${base}Left`, `${base}Right`, v);

/**
 * ARKit-weight presets. The Rocketbox smile shapes are subtle, so smiles combine several shapes
 * (corner pull + cheek raise + eye squint = a "Duchenne" smile that reads as genuine).
 */
export const MOOD_PRESETS: Record<Mood, Weights> = {
  neutral: {},
  smile: { ...pair("mouthSmile", 0.55), ...pair("cheekSquint", 0.25), ...pair("eyeSquint", 0.12), ...pair("mouthDimple", 0.2) },
  happy: {
    ...pair("mouthSmile", 1.0), ...pair("cheekSquint", 0.55), ...pair("eyeSquint", 0.3), ...pair("mouthDimple", 0.35),
    ...pair("mouthUpperUp", 0.12), browInnerUp: 0.12,
  },
  sad: { browInnerUp: 0.75, ...pair("mouthFrown", 0.55), ...pair("mouthPress", 0.2), ...pair("eyeSquint", 0.15), ...pair("browDown", 0.1), mouthShrugLower: 0.2 },
  surprised: { browInnerUp: 0.85, ...pair("browOuterUp", 0.8), ...pair("eyeWide", 0.55), jawOpen: 0.12, mouthFunnel: 0.1 },
  concerned: { browInnerUp: 0.55, ...pair("browDown", 0.2), ...pair("mouthPress", 0.25), ...pair("mouthFrown", 0.2), ...pair("eyeSquint", 0.1) },
  thinking: {
    browDownLeft: 0.35, browInnerUp: 0.25, browOuterUpRight: 0.2, eyeSquintLeft: 0.2, eyeSquintRight: 0.1,
    ...pair("mouthPress", 0.3), mouthRollLower: 0.2, mouthLeft: 0.15,
  },
  angry: { ...pair("browDown", 0.75), ...pair("noseSneer", 0.35), ...pair("eyeSquint", 0.35), ...pair("mouthPress", 0.35), ...pair("mouthFrown", 0.25), jawForward: 0.1 },
};

interface Flash {
  t0: number;
  amp: number;
}

/**
 * Facial expression layer: mood with smooth transitions, eyebrow flashes on stressed words
 * (a strong cue of natural speech), and low-amplitude idle micro-movement so the face never
 * freezes into a mask.
 */
export class ExpressionController {
  mood: Mood = "smile";
  intensity = 1;
  state: AvatarState = "idle";
  private current: Weights = {};
  private flashes: Flash[] = [];
  private nBrow = new Noise1D();
  private nMouth = new Noise1D();
  private nSmile = new Noise1D();

  setMood(mood: Mood) {
    this.mood = mood;
  }

  /** Quick eyebrow raise (emphasis, question endings, greetings). */
  browFlash(now: number, amp = 0.35) {
    this.flashes.push({ t0: now, amp });
  }

  update(now: number, dt: number, out: Weights) {
    // "thinking" state overrides the mood with a thinking face
    const preset = this.state === "thinking" ? MOOD_PRESETS.thinking : MOOD_PRESETS[this.mood];
    const keys = new Set([...Object.keys(this.current), ...Object.keys(preset)]);
    for (const k of keys) {
      const target = (preset[k] ?? 0) * this.intensity;
      this.current[k] = damp(this.current[k] ?? 0, target, 0.22, dt);
    }
    for (const k of Object.keys(out)) out[k] = 0;
    for (const k of keys) out[k] = this.current[k];

    // eyebrow flashes: rise 120 ms, hold 150 ms, fall 350 ms
    let flash = 0;
    this.flashes = this.flashes.filter((f) => now - f.t0 < 0.65);
    for (const f of this.flashes) {
      const t = now - f.t0;
      flash = Math.max(flash, f.amp * Math.min(smoothstep(0, 0.12, t), 1 - smoothstep(0.27, 0.62, t)));
    }
    out.browInnerUp = (out.browInnerUp ?? 0) + flash;
    out.browOuterUpLeft = (out.browOuterUpLeft ?? 0) + flash * 0.8;
    out.browOuterUpRight = (out.browOuterUpRight ?? 0) + flash * 0.8;

    // micro-movement
    const listening = this.state === "listening" ? 1 : 0;
    out.browInnerUp += 0.04 * (this.nBrow.sample(now * 0.4) + 1) + 0.06 * listening;
    const m = 0.025 * (this.nMouth.sample(now * 0.35) + 1);
    out.mouthPressLeft = (out.mouthPressLeft ?? 0) + m;
    out.mouthPressRight = (out.mouthPressRight ?? 0) + m;
    if (listening) {
      const s = 0.06 * (this.nSmile.sample(now * 0.25) + 1);
      out.mouthSmileLeft = (out.mouthSmileLeft ?? 0) + s;
      out.mouthSmileRight = (out.mouthSmileRight ?? 0) + s;
    }
  }
}
