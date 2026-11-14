import { SentenceStream } from "../speech/text";

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

const DEFAULT_SYSTEM =
  "You are a friendly, concise virtual assistant shown as a talking 3D avatar. Answer in one to three short " +
  "spoken sentences, no lists or markdown. You may start a reply with one mood tag such as [happy], [smile], " +
  "[concerned], [surprised] or [thinking] when it fits.";

/**
 * Minimal streaming client for any OpenAI-compatible chat endpoint (e.g. a local Ollama model via
 * the /llm dev proxy). Complete sentences are emitted as soon as they arrive so the avatar starts
 * speaking while the rest of the answer is still being generated.
 */
export class ChatClient {
  private history: Message[] = [];

  constructor(private model: string, private baseUrl = "/llm", private system = DEFAULT_SYSTEM) {}

  static fromEnv(): ChatClient | null {
    const model = import.meta.env.VITE_LLM_MODEL as string | undefined;
    if (!model) return null;
    return new ChatClient(model, "/llm", (import.meta.env.VITE_LLM_SYSTEM_PROMPT as string | undefined) || DEFAULT_SYSTEM);
  }

  async available(): Promise<boolean> {
    try {
      const r = await fetch(`${this.baseUrl}/v1/models`, { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  async ask(question: string, onSentence: (s: string) => void, signal?: AbortSignal): Promise<string> {
    const messages: Message[] = [{ role: "system", content: this.system }, ...this.history.slice(-10), { role: "user", content: question }];
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, messages, stream: true, temperature: 0.7 }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`LLM error (HTTP ${res.status})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const sentences = new SentenceStream();
    let full = "";
    let pending = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const l = line.trim();
        if (!l.startsWith("data:")) continue;
        const data = l.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const delta: string = JSON.parse(data).choices?.[0]?.delta?.content ?? "";
          if (!delta) continue;
          full += delta;
          for (const s of sentences.push(delta)) onSentence(s);
        } catch {
          /* keep-alive or partial line */
        }
      }
    }
    for (const s of sentences.flush()) onSentence(s);
    this.history.push({ role: "user", content: question }, { role: "assistant", content: full });
    return full;
  }
}
