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

/** Client for the HeadTTS REST API (Kokoro neural TTS with phoneme/viseme timestamps). */
export class TTSClient {
  constructor(private ctx: BaseAudioContext, private baseUrl = "/tts", private timeoutMs = 30000) {}

  async synthesize(input: TTSInputItem[] | string, settings: VoiceSettings, signal?: AbortSignal): Promise<SynthResult> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const res = await fetch(`${this.baseUrl}/v1/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, voice: settings.voice, language: "en-us", speed: settings.speed, audioEncoding: "wav" }),
      signal: sig,
    });
    if (!res.ok) throw new Error(`TTS server error (HTTP ${res.status}). Is \`npm run tts\` running?`);
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

  /** True if the TTS server answers (CORS preflight route; the proxy returns 5xx when it is down). */
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/synthesize`, { method: "OPTIONS", signal: AbortSignal.timeout(3000) });
      return res.status < 500;
    } catch {
      return false;
    }
  }
}
