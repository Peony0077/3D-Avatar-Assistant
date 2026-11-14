#!/usr/bin/env node
// Downloads Kokoro voice style vectors (Apache-2.0) used by the HeadTTS server into server/voices/.
import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "server", "voices");
const BASE = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices";
// Female English voices (American af_*, British bf_*). af_heart / af_bella are the highest rated.
const VOICES = ["af_heart", "af_bella", "af_nicole", "af_sarah", "af_aoede", "af_kore", "bf_emma", "bf_isabella"];

await mkdir(OUT, { recursive: true });
for (const v of VOICES) {
  const dest = join(OUT, `${v}.bin`);
  try { if ((await stat(dest)).size > 0) { console.log("skip ", dest); continue; } } catch {}
  const res = await fetch(`${BASE}/${v}.bin`);
  if (!res.ok) throw new Error(`${res.status} ${v}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  console.log("saved", dest);
}
