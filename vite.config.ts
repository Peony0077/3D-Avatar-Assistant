import { defineConfig, loadEnv } from "vite";

// Dev server: proxies the local open-source TTS server (HeadTTS/Kokoro, `npm run tts`) and an
// optional OpenAI-compatible LLM endpoint (e.g. Ollama) so the browser talks to one origin.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const ttsTarget = env.TTS_URL || "http://127.0.0.1:8882";
  const llmTarget = env.LLM_BASE_URL || "http://127.0.0.1:11434";
  const proxy = {
    "/tts": { target: ttsTarget, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/tts/, "") },
    "/llm": { target: llmTarget, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/llm/, "") },
  };
  return {
    server: { host: "0.0.0.0", port: 5173, proxy },
    preview: { host: "0.0.0.0", port: 4173, proxy },
    build: { target: "es2022", chunkSizeWarningLimit: 1500 },
  };
});
