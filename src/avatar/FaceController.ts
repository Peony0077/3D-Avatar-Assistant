import type { AvatarModel } from "./AvatarModel";

export type Weights = Record<string, number>;

const MOUTH = /^(mouth|jaw|viseme_|tongue|cheekPuff)/;

/**
 * Blend-shape compositor. Each behaviour writes its own layer (expression, visemes, blink, gaze
 * lids, ...); apply() sums the layers and writes every morph once per frame. While speaking, the
 * mouth part of the expression layer is attenuated so visemes stay readable (a smile can still be
 * seen, but it never fights a lip closure).
 */
export class FaceController {
  private layers = new Map<string, Weights>();
  private names: string[];
  private final: Weights = {};

  constructor(private model: AvatarModel) {
    this.names = model.morphNames;
  }

  layer(name: string): Weights {
    let l = this.layers.get(name);
    if (!l) {
      l = {};
      this.layers.set(name, l);
    }
    return l;
  }

  /** Current composed value of a morph (after the last apply). */
  value(name: string): number {
    return this.final[name] ?? 0;
  }

  apply(speaking: number) {
    const f = this.final;
    for (const n of this.names) f[n] = 0;
    for (const [layerName, w] of this.layers) {
      const mouthScale = layerName === "expression" ? 1 - 0.55 * speaking : 1;
      for (const k in w) {
        const v = w[k];
        if (!v) continue;
        f[k] = (f[k] ?? 0) + (MOUTH.test(k) ? v * mouthScale : v);
      }
    }
    for (const n of this.names) {
      const v = f[n];
      this.model.setMorph(n, v < 0 ? 0 : v > 1 ? 1 : v);
    }
  }
}
