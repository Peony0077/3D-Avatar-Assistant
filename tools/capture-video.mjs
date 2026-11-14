#!/usr/bin/env node
// Renders the real browser runtime frame-by-frame (deterministic virtual clock) and muxes the exact
// TTS soundtrack, producing an MP4 for lip-sync verification or demo reels.
//
//   npm run tts & npm run dev &
//   node tools/capture-video.mjs --text "Hello there!" --out demo.mp4 [--voice af_heart] [--speed 1]
//        [--w 720 --h 900 --fps 30] [--framing portrait|upper] [--mood smile] [--url http://localhost:5173]
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const text = args.text ?? "Hello! I'm your virtual assistant. Peter Piper picked a peck of pickled peppers.";
const out = args.out ?? ".work/capture.mp4";
const w = Number(args.w ?? 720), h = Number(args.h ?? 900), fps = Number(args.fps ?? 30);
const url = args.url ?? "http://localhost:5173";
const lead = Number(args.lead ?? 0.6); // idle seconds before speaking
const tail = Number(args.tail ?? 0.9);
const work = join(".work", "capture-frames");
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });

const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(e.message));
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
await page.goto(`${url}/?capture&w=${w}&h=${h}&fps=${fps}&framing=${args.framing ?? "portrait"}`);
await page.waitForFunction(() => window.__capture?.ready, null, { timeout: 120000 });
await page.evaluate(([v, s, m]) => {
  window.__capture.voice(v, s);
  if (m) window.__capture.mood(m);
}, [args.voice ?? "af_heart", Number(args.speed ?? 1), args.mood ?? ""]);

let frame = 0;
const weights = [];
const grab = async (n) => {
  for (let i = 0; i < n; i++) {
    const { image, visemes } = await page.evaluate(() => window.__capture.grab());
    weights.push(visemes);
    await writeFile(join(work, `${String(frame++).padStart(5, "0")}.jpg`), Buffer.from(image.split(",")[1], "base64"));
  }
};

const t0 = Date.now();
await grab(Math.round(lead * fps));
const end = await page.evaluate((t) => window.__capture.speak(t), text);
const total = Math.ceil((end + tail) * fps) - frame;
await grab(total);
const wav = await page.evaluate(() => window.__capture.soundtrack());
await writeFile(join(work, "sound.wav"), Buffer.from(wav, "base64"));
await writeFile(join(work, "visemes.json"), JSON.stringify({ fps, frames: weights }));
const errors = await page.evaluate(() => window.__capture.errors);
await browser.close();
console.log(`rendered ${frame} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const ff = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-framerate", String(fps), "-i", join(work, "%05d.jpg"),
  "-i", join(work, "sound.wav"), "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out], { stdio: "inherit" });
if (ff.status !== 0) process.exit(ff.status ?? 1);
console.log(`wrote ${out}`);
if (errors.length || consoleErrors.length) console.log("errors:", [...errors, ...consoleErrors]);
