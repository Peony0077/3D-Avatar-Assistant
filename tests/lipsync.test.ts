import { describe, expect, it } from "vitest";
import fixture from "./fixtures/headtts-hello.json";
import { LipSyncTrack, buildEvents, type TTSTiming } from "../src/lipsync/LipSyncTrack";
import { LoudnessEnvelope } from "../src/lipsync/loudness";
import { VISEMES, phonemeToVisemes } from "../src/lipsync/visemes";

const timing = fixture as unknown as TTSTiming;

describe("phoneme -> viseme mapping", () => {
  it("fixes HeadTTS defaults that look wrong on the face", () => {
    expect(phonemeToVisemes("l", "RR")[0].v).toBe("nn"); // tongue tip, not lip rounding
    expect(phonemeToVisemes("ʃ", "SS")[0].v).toBe("CH"); // "sh" protrudes the lips
    expect(phonemeToVisemes("m", "PP")[0].v).toBe("PP");
    expect(phonemeToVisemes("f", "FF")[0].v).toBe("FF");
  });
  it("glides through diphthongs", () => {
    expect(phonemeToVisemes("I", "I").map((p) => p.v)).toEqual(["aa", "I"]); // "five"
    expect(phonemeToVisemes("O", "O").map((p) => p.v)).toEqual(["O", "U"]); // "go"
  });
  it("gives h the shape of the following vowel at reduced strength", () => {
    const [h] = phonemeToVisemes("h", undefined, "ɑ");
    expect(h.v).toBe("aa");
    expect(h.gain).toBeLessThan(0.6);
  });
  it("falls back to the server viseme for unknown phonemes", () => {
    expect(phonemeToVisemes("§", "kk")[0].v).toBe("kk");
  });
});

describe("LipSyncTrack on real HeadTTS output", () => {
  const events = buildEvents(timing);
  const track = new LipSyncTrack(events);

  it("produces events in time order", () => {
    for (let i = 1; i < events.length; i++) expect(events[i].t0).toBeGreaterThanOrEqual(events[i - 1].t0);
  });

  it("merges the m+p cluster in 'pumpkin' into one sustained closure", () => {
    // phonemes ... p ʌ m p k ...: m (4151) and p (4197) are adjacent PP visemes
    const adv = 0.06; // default visual advance
    const pp = events.filter((e) => e.v === "PP" && e.t0 >= 4.14 - adv && e.t0 <= 4.25 - adv);
    expect(pp).toHaveLength(1);
    expect(pp[0].t1).toBeGreaterThan(4.26 - adv);
  });

  it("fully closes the lips during bilabials and suppresses other shapes", () => {
    const closures = events.filter((e) => e.v === "PP");
    expect(closures.length).toBeGreaterThanOrEqual(6); // am, Bob(2), made, big, pumpkin, pies
    for (const e of closures) {
      const w = track.sample((e.t0 + e.t1) / 2);
      expect(w.PP).toBeGreaterThan(0.85);
      const others = VISEMES.filter((v) => v !== "PP").reduce((s, v) => s + w[v], 0);
      expect(others).toBeLessThan(0.15);
    }
  });

  it("starts moving the mouth before the sound (anticipation)", () => {
    const first = events[0];
    const w = track.sample(first.t0 - 0.02);
    expect(w[first.v]).toBeGreaterThan(0);
    expect(track.sample(first.t0 - 0.2)[first.v]).toBe(0);
  });

  it("never exceeds a total opening of 1 and never produces NaN", () => {
    for (let t = 0; t < 6.5; t += 0.005) {
      const w = track.sample(t);
      let open = 0;
      for (const v of VISEMES) {
        expect(Number.isFinite(w[v])).toBe(true);
        expect(w[v]).toBeGreaterThanOrEqual(0);
        if (v !== "PP" && v !== "FF") open += w[v];
      }
      expect(open).toBeLessThanOrEqual(1.0001);
    }
  });

  it("leads the audio: the visual track is advanced by the configured amount", () => {
    const pp = events.find((e) => e.v === "PP")!;
    expect(pp.t0).toBeCloseTo(1.224 - 0.06, 3); // "am": m at 1224 ms in the TTS timing
  });

  it("returns to rest in the pause between sentences and after the end", () => {
    // pause between "assistant." (ends ~2.75 s incl. final t) and "Bob" (2.888 s)
    const mid = track.sample(2.76);
    expect(Math.max(...VISEMES.map((v) => mid[v]))).toBeLessThan(0.35);
    const end = track.sample(7.0);
    expect(Math.max(...VISEMES.map((v) => end[v]))).toBe(0);
  });

  it("is smooth: no frame-to-frame jumps larger than a fast real mouth can make", () => {
    const dt = 1 / 60;
    let prev = track.sample(0);
    let maxJump = 0;
    for (let t = dt; t < 6.5; t += dt) {
      const w = { ...track.sample(t) };
      for (const v of VISEMES) maxJump = Math.max(maxJump, Math.abs(w[v] - prev[v]));
      prev = w;
    }
    expect(maxJump).toBeLessThan(0.6);
  });

  it("opens stressed (louder) vowels wider than unstressed ones in the same clip", () => {
    const sr = 1000;
    const samples = new Float32Array(2 * sr).fill(0.0);
    for (let i = 200; i < 400; i++) samples[i] = 0.08; // quiet vowel 0.2-0.4 s
    for (let i = 1200; i < 1400; i++) samples[i] = 0.4; // stressed vowel 1.2-1.4 s
    const tm: TTSTiming = {
      words: ["a", "A"], wtimes: [200, 1200], wdurations: [200, 200],
      visemes: ["aa", "aa"], vtimes: [200, 1200], vdurations: [200, 200], phonemes: ["ɑ", "ɑ"],
    };
    const [quiet, loud] = buildEvents(tm, new LoudnessEnvelope(samples, sr));
    expect(loud.amp).toBeGreaterThan(quiet.amp);
  });
});
