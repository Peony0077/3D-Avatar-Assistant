/**
 * RMS loudness envelope of a speech clip, normalised so typical stressed syllables are ~1.
 * Used to scale jaw opening (louder = wider) and to find emphasis points for head nods and
 * eyebrow flashes.
 */
export class LoudnessEnvelope {
  readonly frame: number;
  readonly values: Float32Array;

  constructor(samples: Float32Array, sampleRate: number, frame = 0.01) {
    this.frame = frame;
    const hop = Math.max(1, Math.round(sampleRate * frame));
    const n = Math.ceil(samples.length / hop);
    const rms = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      const a = i * hop;
      const b = Math.min(samples.length, a + hop * 2); // 20 ms window, 10 ms hop
      for (let j = a; j < b; j++) s += samples[j] * samples[j];
      rms[i] = Math.sqrt(s / Math.max(1, b - a));
    }
    // light smoothing
    const sm = new Float32Array(n);
    for (let i = 0; i < n; i++) sm[i] = (rms[Math.max(0, i - 1)] + 2 * rms[i] + rms[Math.min(n - 1, i + 1)]) / 4;
    const voiced = Array.from(sm).filter((x) => x > 1e-4).sort((x, y) => x - y);
    const ref = voiced.length ? voiced[Math.floor(voiced.length * 0.9)] : 1;
    for (let i = 0; i < n; i++) sm[i] = sm[i] / (ref || 1);
    this.values = sm;
  }

  static fromAudioBuffer(buf: AudioBuffer) {
    return new LoudnessEnvelope(buf.getChannelData(0), buf.sampleRate);
  }

  /** Normalised loudness at time t (seconds), linear interpolation. */
  at(t: number): number {
    const x = t / this.frame;
    const i = Math.floor(x);
    if (i < 0 || i >= this.values.length - 1) return 0;
    const f = x - i;
    return this.values[i] * (1 - f) + this.values[i + 1] * f;
  }

  /** Mean loudness over [t0, t1]. */
  mean(t0: number, t1: number): number {
    const a = Math.max(0, Math.floor(t0 / this.frame));
    const b = Math.min(this.values.length, Math.ceil(t1 / this.frame));
    if (b <= a) return this.at(t0);
    let s = 0;
    for (let i = a; i < b; i++) s += this.values[i];
    return s / (b - a);
  }
}
