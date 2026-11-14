import type { TTSTiming } from "../lipsync/LipSyncTrack";
import type { TTSInputItem } from "./text";

export interface VoiceSettings {
  voice: string;
  speed: number;
}

export interface SynthResult {
  audio: AudioBuffer;
  timing: TTSTiming;
}

/** Female Kokoro voices fetched by `npm run fetch-voices` (Apache-2.0). */
export const VOICES = [
  { id: "af_heart", label: "Heart (US, warm)" },
  { id: "af_bella", label: "Bella (US, bright)" },
  { id: "af_nicole", label: "Nicole (US, soft)" },
  { id: "af_sarah", label: "Sarah (US)" },
  { id: "af_aoede", label: "Aoede (US)" },
  { id: "af_kore", label: "Kore (US)" },
  { id: "bf_emma", label: "Emma (UK)" },
  { id: "bf_isabella", label: "Isabella (UK)" },
] as const;

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Busy or briefly unavailable (rate limit, proxy without a free upstream): worth retrying. */
const RETRY_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 5;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
}

/** Seconds to wait before retry `attempt` (0-based): the server's Retry-After, else exponential backoff. */
export function retryDelay(attempt: number, retryAfter: string | null): number {
  const ra = Number(retryAfter);
  if (retryAfter && Number.isFinite(ra) && ra >= 0) return Math.min(ra, 8);
  return Math.min(0.5 * 2 ** attempt, 4) * (0.8 + 0.4 * Math.random());
}

function httpError(status: number): Error {
  if (status === 429) return new Error("The speech server is busy (too many requests). Please try again in a moment.");
  if (status >= 500) return new Error(`The speech server is not available (HTTP ${status}). Is \`npm run tts\` running?`);
  return new Error(`Speech server error (HTTP ${status}).`);
}

/** Client for the HeadTTS REST API (Kokoro neural TTS with phoneme/viseme timestamps). */
export class TTSClient {
  constructor(private ctx: BaseAudioContext, private baseUrl = "/tts", private timeoutMs = 45000) {}

  /** @param onBusy called when the server answers "busy" (before each retry) */
  async synthesize(input: TTSInputItem[] | string, settings: VoiceSettings, signal?: AbortSignal, onBusy?: (status: number) => void): Promise<SynthResult> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const body = JSON.stringify({ input, voice: settings.voice, language: "en-us", speed: settings.speed, audioEncoding: "wav" });
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${this.baseUrl}/v1/synthesize`, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: sig });
      if (res.ok) break;
      if (!RETRY_STATUS.has(res.status) || attempt >= MAX_RETRIES) throw httpError(res.status);
      onBusy?.(res.status);
      await sleep(retryDelay(attempt, res.headers.get("Retry-After")) * 1000, sig);
    }
    const data = await res.json();
    if (data.error) throw new Error(`TTS: ${data.error}`);
    const audio = await this.ctx.decodeAudioData(base64ToArrayBuffer(data.audio));
    const timing: TTSTiming = {
      words: data.words ?? [],
      wtimes: data.wtimes ?? [],
      wdurations: data.wdurations ?? [],
      visemes: data.visemes ?? [],
      vtimes: data.vtimes ?? [],
      vdurations: data.vdurations ?? [],
      phonemes: data.phonemes,
    };
    return { audio, timing };
  }

  /** True if the TTS server answers (CORS preflight route; the proxy returns 5xx when it is down;
   *  429 = up but busy). */
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/synthesize`, { method: "OPTIONS", signal: AbortSignal.timeout(3000) });
      return res.status < 500;
    } catch {
      return false;
    }
  }
}
