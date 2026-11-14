import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpeechPlayer } from "../src/speech/SpeechPlayer";
import { MAX_SYNTH, SpeechQueue } from "../src/speech/SpeechQueue";
import { type SynthResult, TTSClient, retryDelay } from "../src/speech/TTSClient";

const ok = () =>
  new Response(JSON.stringify({ audio: "UklGRg==", words: ["Hi."], wtimes: [0], wdurations: [300], visemes: [], vtimes: [], vdurations: [] }), {
    status: 200,
  });
const busy = () => new Response("", { status: 429, headers: { "Retry-After": "0" } });
const ctx = { decodeAudioData: async () => ({ duration: 0.5 }) } as unknown as BaseAudioContext;
const voice = { voice: "af_heart", speed: 1 };

afterEach(() => vi.unstubAllGlobals());

describe("TTSClient", () => {
  it("retries when the server is busy (HTTP 429) and then succeeds", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(busy()).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetch);
    const r = await new TTSClient(ctx).synthesize("Hi.", voice);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(r.timing.words).toEqual(["Hi."]);
  });

  it("gives up with a clear message when the server stays busy", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => busy()));
    await expect(new TTSClient(ctx).synthesize("Hi.", voice)).rejects.toThrow(/busy/);
  });

  it("does not retry client errors", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("", { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    await expect(new TTSClient(ctx).synthesize("Hi.", voice)).rejects.toThrow(/HTTP 400/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("follows Retry-After, else backs off exponentially", () => {
    expect(retryDelay(0, "2")).toBe(2);
    expect(retryDelay(0, "600")).toBe(8);
    expect(retryDelay(0, null)).toBeLessThan(retryDelay(3, null));
  });
});

describe("SpeechQueue", () => {
  /** A fake TTS whose requests finish when the test says so. */
  function setup() {
    const calls: Array<{ text: string; done: (r: SynthResult) => void }> = [];
    let running = 0;
    let maxRunning = 0;
    const tts = {
      synthesize: (input: unknown, _v: unknown, signal: AbortSignal) =>
        new Promise<SynthResult>((resolve, reject) => {
          const text = [input].flat().join("");
          running++;
          maxRunning = Math.max(maxRunning, running);
          signal.addEventListener("abort", () => (running--, reject(signal.reason)));
          calls.push({ text, done: (r) => (running--, resolve(r)) });
        }),
    } as unknown as TTSClient;
    const scheduled: string[] = [];
    const player = { schedule: (init: { text: string }) => (scheduled.push(init.text), init), clear() {} } as unknown as SpeechPlayer;
    const q = new SpeechQueue(tts, player, () => voice);
    const result = { audio: { duration: 1 }, timing: { words: [], wtimes: [], wdurations: [], visemes: [], vtimes: [], vdurations: [] } } as unknown as SynthResult;
    return { q, calls, scheduled, result, maxRunning: () => maxRunning };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it(`sends at most ${MAX_SYNTH} sentences to TTS at once, in order`, async () => {
    const { q, calls, scheduled, result, maxRunning } = setup();
    const all = q.speak("One. Two. Three. Four. Five.");
    await tick();
    expect(calls.map((c) => c.text)).toEqual(["One.", "Two."]);
    calls[1].done(result); // a later one finishing first frees a slot, but playback stays in order
    await tick();
    expect(calls.map((c) => c.text)).toEqual(["One.", "Two.", "Three."]);
    expect(scheduled).toEqual([]);
    calls[0].done(result);
    await tick();
    expect(scheduled).toEqual(["One.", "Two."]);
    for (let i = 2; i < 5; i++) {
      await tick();
      calls[i].done(result);
    }
    await all;
    expect(scheduled).toEqual(["One.", "Two.", "Three.", "Four.", "Five."]);
    expect(maxRunning()).toBe(MAX_SYNTH);
  });

  it("an interrupt drops waiting sentences and later speech still runs", async () => {
    const { q, calls, scheduled, result } = setup();
    void q.speak("One. Two. Three. Four.");
    await tick();
    q.interrupt();
    await tick();
    expect(calls.length).toBe(MAX_SYNTH); // Three and Four never reach the server
    const next = q.speak("Again.");
    await tick();
    expect(calls.at(-1)!.text).toBe("Again.");
    calls.at(-1)!.done(result);
    await next;
    expect(scheduled).toEqual(["Again."]);
  });
});

describe("SpeechQueue on a busy server", () => {
  it("drops to one sentence at a time after an HTTP 429", async () => {
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    let first = true;
    const tts = {
      synthesize: async (input: unknown, _v: unknown, _s: AbortSignal, onBusy?: (s: number) => void) => {
        const text = [input].flat().join("");
        running++;
        maxRunning = Math.max(maxRunning, running);
        if (first) {
          first = false;
          onBusy?.(429); // the server pushed back once
          maxRunning = 0;
        }
        await new Promise((r) => setTimeout(r, 5));
        order.push(text);
        running--;
        return { audio: { duration: 1 }, timing: { words: [], wtimes: [], wdurations: [], visemes: [], vtimes: [], vdurations: [] } };
      },
    } as unknown as TTSClient;
    const scheduled: string[] = [];
    const player = { schedule: (init: { text: string }) => (scheduled.push(init.text), init), clear() {} } as unknown as SpeechPlayer;
    await new SpeechQueue(tts, player, () => voice).speak("One. Two. Three. Four.");
    expect(scheduled).toEqual(["One.", "Two.", "Three.", "Four."]);
    expect(maxRunning).toBe(1);
  });
});
