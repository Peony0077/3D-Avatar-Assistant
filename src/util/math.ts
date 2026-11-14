export const clamp = (x: number, lo = 0, hi = 1) => (x < lo ? lo : x > hi ? hi : x);

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Hermite smoothstep between edges a and b. */
export function smoothstep(a: number, b: number, x: number): number {
  if (a === b) return x < a ? 0 : 1;
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential approach (tau = time constant in seconds). */
export const damp = (current: number, target: number, tau: number, dt: number) =>
  tau <= 0 ? target : target + (current - target) * Math.exp(-dt / tau);

export const rand = (a: number, b: number) => a + Math.random() * (b - a);

export const chance = (p: number) => Math.random() < p;

export const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)];

export const deg = (d: number) => (d * Math.PI) / 180;

/** Critically-damped spring (value + velocity), stable for any dt. */
export class Spring {
  value: number;
  velocity = 0;
  constructor(value = 0, public omega = 10) {
    this.value = value;
  }
  update(target: number, dt: number): number {
    const w = this.omega;
    const x = this.value - target;
    const exp = Math.exp(-w * dt);
    const v = this.velocity;
    this.value = target + (x + (v + w * x) * dt) * exp;
    this.velocity = (v - w * (v + w * x) * dt) * exp;
    return this.value;
  }
  kick(velocity: number) {
    this.velocity += velocity;
  }
}

/** Smooth 1D value noise (sum of two octaves), range roughly [-1, 1]. */
export class Noise1D {
  private readonly seed: number;
  constructor(seed = Math.random() * 1000) {
    this.seed = seed;
  }
  private hash(i: number) {
    const s = Math.sin((i + this.seed) * 127.1) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  }
  private octave(t: number) {
    const i = Math.floor(t);
    const f = t - i;
    const u = f * f * (3 - 2 * f);
    return lerp(this.hash(i), this.hash(i + 1), u);
  }
  sample(t: number) {
    return this.octave(t) * 0.7 + this.octave(t * 2.3 + 17.3) * 0.3;
  }
}
