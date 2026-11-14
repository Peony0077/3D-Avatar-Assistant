import type { Weights } from "../avatar/FaceController";
import { chance, rand, smoothstep } from "../util/math";
import type { AvatarState } from "./types";

/** Seconds between spontaneous blinks per state (people blink more when talking or thinking). */
const INTERVAL: Record<AvatarState, [number, number]> = {
  idle: [3.0, 6.5],
  listening: [2.8, 5.5],
  thinking: [1.8, 3.6],
  speaking: [2.0, 4.2],
};

const CLOSE = 0.075; // eyelid closes fast (ease-in)
const HOLD = 0.035;
const OPEN = 0.17; // and opens slower
const TOTAL = CLOSE + HOLD + OPEN;

function blinkCurve(t: number): number {
  if (t <= 0 || t >= TOTAL) return 0;
  if (t < CLOSE) {
    const x = t / CLOSE;
    return x * x;
  }
  if (t < CLOSE + HOLD) return 1;
  return 1 - smoothstep(0, OPEN, t - CLOSE - HOLD);
}

/** Natural blinking: state-dependent rate, occasional double / partial blinks, slight L/R offset. */
export class BlinkController {
  state: AvatarState = "idle";
  private next: number;
  private start = -1;
  private amp = 1;
  private rightDelay = 0;
  private double = false;

  constructor(now: number) {
    this.next = now + rand(0.8, 2.5);
  }

  /** Force a blink (gaze shifts, sentence starts). Ignored if one is already running. */
  trigger(now: number, amp = 1) {
    if (this.start >= 0 && now - this.start < TOTAL) return;
    this.start = now;
    this.amp = amp;
    this.rightDelay = rand(0, 0.012);
    this.double = chance(0.12);
  }

  update(now: number, out: Weights) {
    if (this.start < 0 && now >= this.next) this.trigger(now, chance(0.1) ? rand(0.55, 0.75) : 1);
    let l = 0;
    let r = 0;
    if (this.start >= 0) {
      const t = now - this.start;
      l = blinkCurve(t) * this.amp;
      r = blinkCurve(t - this.rightDelay) * this.amp;
      if (t > TOTAL + this.rightDelay) {
        this.start = -1;
        if (this.double) {
          this.double = false;
          this.next = now + rand(0.06, 0.16);
        } else {
          const [a, b] = INTERVAL[this.state];
          this.next = now + rand(a, b);
        }
      }
    }
    out.eyeBlinkLeft = l;
    out.eyeBlinkRight = r;
  }
}
