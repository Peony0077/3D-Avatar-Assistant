import type { SpeechPlayer, Utterance } from "./SpeechPlayer";
import type { TTSClient, VoiceSettings } from "./TTSClient";
import { type Mood, normalizeForSpeech, parseMarkup, splitSentences } from "./text";

interface Job {
  text: string;
  mood?: Mood;
  result: Promise<Awaited<ReturnType<TTSClient["synthesize"]>> | null>;
}

const gapAfter = (text: string) => (/\?["')\]]*$/.test(text) ? 0.16 : /[.!…]["')\]]*$/.test(text) ? 0.1 : 0.02);

/**
 * Sentence pipeline: each sentence is sent to TTS as soon as it is known (so sentence N+1 is
 * synthesised while N plays), results are scheduled strictly in order, and an interrupt drops
 * everything that has not been heard yet.
 */
export class SpeechQueue {
  private generation = 0;
  private abort = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  private nextId = 1;
  private inFlight = 0;

  onUtterance: (u: Utterance) => void = () => {};
  onError: (err: Error) => void = (e) => console.error(e);

  constructor(
    private tts: TTSClient,
    private player: SpeechPlayer,
    private voice: () => VoiceSettings,
    private lipIntensity: () => number = () => 1,
  ) {}

  /** Number of sentences waiting for TTS or scheduling. */
  get pending(): number {
    return this.inFlight;
  }

  /** Speak text with optional [mood] markup. Resolves once every sentence is scheduled. */
  speak(text: string, mood?: Mood): Promise<void> {
    let p: Promise<void> = Promise.resolve();
    for (const seg of parseMarkup(text)) {
      for (const sentence of splitSentences(seg.text)) p = this.enqueue(sentence, seg.mood ?? mood);
    }
    return p;
  }

  /** Add one sentence (used directly for streamed LLM output). */
  enqueue(text: string, mood?: Mood): Promise<void> {
    const gen = this.generation;
    const signal = this.abort.signal;
    this.inFlight++;
    const job: Job = {
      text,
      mood,
      result: this.tts.synthesize(normalizeForSpeech(text), this.voice(), signal).catch((err: Error) => {
        if (gen === this.generation && err.name !== "AbortError") this.onError(err);
        return null;
      }),
    };
    this.tail = this.tail.then(async () => {
      try {
        const r = await job.result;
        if (!r || gen !== this.generation) return;
        const u = this.player.schedule(
          { id: this.nextId++, text: job.text, mood: job.mood, audio: r.audio, timing: r.timing, lipIntensity: this.lipIntensity() },
          gapAfter(this.lastText),
        );
        this.lastText = job.text;
        this.onUtterance(u);
      } finally {
        this.inFlight--;
      }
    });
    return this.tail;
  }

  private lastText = "";

  /** Barge-in: cancel pending synthesis and fade out current speech. */
  interrupt() {
    this.generation++;
    this.abort.abort();
    this.abort = new AbortController();
    this.player.clear();
    this.lastText = "";
  }
}
