/** Oculus/Meta viseme set (15). Blend shapes on the avatar are named `viseme_<id>`. */
export const VISEMES = ["sil", "PP", "FF", "TH", "DD", "kk", "CH", "SS", "nn", "RR", "aa", "E", "I", "O", "U"] as const;
export type Viseme = (typeof VISEMES)[number];

export type VisemeKind = "sil" | "closure" | "consonant" | "vowel";

export interface VisemeProfile {
  kind: VisemeKind;
  /** Peak weight for a normally stressed, normally long instance. */
  amp: number;
}

/**
 * Peak weights tuned for the Rocketbox shapes (viseme_aa at 1.0 drops the jaw ~18 mm, so natural
 * conversational vowels sit around 0.6-0.8). Closures must reach (almost) full weight: missing
 * lip contact on P/B/M is the most visible lip-sync error.
 */
export const PROFILE: Record<Viseme, VisemeProfile> = {
  sil: { kind: "sil", amp: 0 },
  PP: { kind: "closure", amp: 1.0 },
  FF: { kind: "closure", amp: 0.9 },
  TH: { kind: "consonant", amp: 0.7 },
  DD: { kind: "consonant", amp: 0.55 },
  kk: { kind: "consonant", amp: 0.5 },
  CH: { kind: "consonant", amp: 0.8 },
  SS: { kind: "consonant", amp: 0.65 },
  nn: { kind: "consonant", amp: 0.5 },
  RR: { kind: "consonant", amp: 0.6 },
  aa: { kind: "vowel", amp: 0.72 },
  E: { kind: "vowel", amp: 0.6 },
  I: { kind: "vowel", amp: 0.58 },
  O: { kind: "vowel", amp: 0.72 },
  U: { kind: "vowel", amp: 0.68 },
};

export const morphName = (v: Viseme) => `viseme_${v}`;

type Glide = Array<[Viseme, number]>;

/**
 * Kokoro / Misaki phonemes (IPA plus single-letter diphthong tokens) -> visemes.
 * Diphthongs glide between two mouth shapes, split by duration share.
 */
const PHONEME_MAP: Record<string, Viseme | Glide> = {
  // bilabials / labiodentals
  p: "PP", b: "PP", m: "PP",
  f: "FF", v: "FF",
  // dentals / alveolars / velars
  "θ": "TH", "ð": "TH",
  t: "DD", d: "DD", "ɾ": "DD", "ʔ": "DD",
  k: "kk", "ɡ": "kk", g: "kk", "ŋ": "kk",
  "ʧ": "CH", "ʤ": "CH", "ʃ": "CH", "ʒ": "CH",
  s: "SS", z: "SS",
  n: "nn", l: "nn", "ɫ": "nn",
  "ɹ": "RR", r: "RR",
  // glides
  w: "U", j: "I",
  // vowels
  "æ": "aa", "ɑ": "aa", "ʌ": "aa", a: "aa", "ɐ": "aa", "ɒ": "aa",
  "ɛ": "E", e: "E", "ə": "E", "ɜ": "E", "ɚ": "E",
  "ɪ": "I", i: "I", "ᵻ": "I",
  "ɔ": "O", o: "O",
  "ʊ": "U", u: "U",
  // Misaki diphthongs: A=eɪ I=aɪ W=aʊ Y=ɔɪ O=oʊ Q=əʊ
  A: [["E", 0.6], ["I", 0.4]],
  I: [["aa", 0.6], ["I", 0.4]],
  W: [["aa", 0.55], ["U", 0.45]],
  Y: [["O", 0.55], ["I", 0.45]],
  O: [["O", 0.6], ["U", 0.4]],
  Q: [["E", 0.5], ["U", 0.5]],
};

const isViseme = (s: string): s is Viseme => (VISEMES as readonly string[]).includes(s);

/**
 * Map one phoneme to viseme(s). `h` has no mouth shape of its own: it takes the shape of the
 * following vowel at reduced strength (returned with a 0.45 weight hint).
 */
export function phonemeToVisemes(
  phoneme: string | undefined,
  fallback: string | undefined,
  nextPhoneme?: string,
): Array<{ v: Viseme; share: number; gain: number }> {
  const p = (phoneme ?? "").replace(/[ˈˌː]/g, "");
  if (p === "h") {
    const next = nextPhoneme ? phonemeToVisemes(nextPhoneme, undefined)[0] : undefined;
    return [{ v: next && PROFILE[next.v].kind === "vowel" ? next.v : "E", share: 1, gain: 0.45 }];
  }
  const m = PHONEME_MAP[p];
  if (typeof m === "string") return [{ v: m, share: 1, gain: 1 }];
  if (Array.isArray(m)) return m.map(([v, share]) => ({ v, share, gain: 1 }));
  if (fallback && isViseme(fallback)) return [{ v: fallback, share: 1, gain: 1 }];
  return [{ v: "sil", share: 1, gain: 1 }];
}
