#!/usr/bin/env node
// Starts the open-source HeadTTS server (Kokoro-82M neural voice, Apache-2.0) used for speech +
// phoneme/viseme timestamps. HeadTTS resolves its worker module relative to the working directory,
// so it must run from inside its package; this launcher does that and turns the project config's
// relative paths into absolute ones.
//
//   npm run tts                # 127.0.0.1:8882, settings from server/headtts.json
//   TTS_THREADS=1 npm run tts  # override worker threads (each thread holds one model copy)
//   TTS_HOST=0.0.0.0 npm run tts  # listen on all interfaces (default: loopback only)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const PKG = dirname(require.resolve("@met4citizen/headtts/package.json"));

const cfg = JSON.parse(readFileSync(join(ROOT, "server", "headtts.json"), "utf8"));
cfg.tts.dictionaryPath = join(PKG, "dictionaries");
// HeadTTS's postinstall creates an empty node_modules/@huggingface/transformers inside its own
// package, which shadows the real module for bare-specifier imports. Pass the exact module URL.
cfg.tts.transformersModule = import.meta.resolve("@huggingface/transformers");
cfg.tts.voicePath = resolve(ROOT, cfg.tts.voicePath);
if (process.env.TTS_THREADS) cfg.tts.threads = Number(process.env.TTS_THREADS);
// fp32 (best quality) | fp16 | q8 (about 1/4 the memory, for small servers) | q4
if (process.env.TTS_DTYPE) cfg.tts.dtype = process.env.TTS_DTYPE;
if (process.env.TTS_PORT) cfg.server.port = Number(process.env.TTS_PORT);

const missing = (cfg.tts.voices || []).concat(cfg.tts.defaults.voice)
  .filter((v) => !existsSync(join(cfg.tts.voicePath, `${v}.bin`)));
if (missing.length) {
  console.error(`Missing voice files (${missing.join(", ")}). Run: npm run fetch-voices`);
  process.exit(1);
}

// transformers.js caches the downloaded Kokoro model here (~330 MB, first start only).
const entry = require.resolve("@huggingface/transformers", { paths: [PKG] });
const marker = join("node_modules", "@huggingface", "transformers");
const transformersDir = entry.slice(0, entry.lastIndexOf(marker) + marker.length);
mkdirSync(join(transformersDir, ".cache"), { recursive: true });

const runtimeCfg = join(ROOT, ".work", "headtts.runtime.json");
mkdirSync(dirname(runtimeCfg), { recursive: true });
writeFileSync(runtimeCfg, JSON.stringify(cfg, null, 2));

// Browsers reach TTS only through a same-origin proxy (Vite in dev, Caddy in production), so
// listen on loopback unless TTS_HOST says otherwise. listen-host.mjs applies it inside HeadTTS.
const host = process.env.TTS_HOST || "127.0.0.1";
const preload = pathToFileURL(join(ROOT, "server", "listen-host.mjs")).href;
const child = spawn(
  process.execPath,
  ["--import", preload, "./modules/headtts-node.mjs", "--config", runtimeCfg, ...process.argv.slice(2)],
  { cwd: PKG, stdio: "inherit", env: { ...process.env, TTS_HOST: host } },
);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
