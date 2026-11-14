#!/usr/bin/env node
// Browser smoke test (headless Chromium via Playwright) against a running dev server + TTS server:
//   npm run tts & npm run dev &   then   node tools/smoke-test.mjs [http://localhost:5173]
// Checks: avatar loads, no console errors, TTS online, speaking state + subtitles + viseme activity.
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://localhost:5173";
const out = ".work/smoke";
await mkdir(out, { recursive: true });

const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") errors.push(`[${m.type()}] ${m.text()}`);
});
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));

const t0 = Date.now();
await page.goto(url);
await page.waitForSelector("#loading.hidden", { state: "attached", timeout: 120000 });
console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await page.waitForFunction(() => document.querySelector("#tts-chip")?.textContent?.includes("online"), null, { timeout: 30000 });
await page.screenshot({ path: `${out}/1-idle.png` });

await page.fill("#text", "Hello! I'm your virtual assistant. Peter Piper picked a peck of pickled peppers.");
await page.click("#speak");
await page.waitForFunction(() => document.querySelector("#state-chip")?.textContent === "speaking", null, { timeout: 30000 });
const maxViseme = await page.evaluate(async () => {
  let max = 0;
  const avatar = window.avatar;
  avatar.listeners.frame = (w) => (max = Math.max(max, ...Object.values(w)));
  await new Promise((r) => setTimeout(r, 1500));
  return max;
});
await page.screenshot({ path: `${out}/2-speaking.png` });
const subtitle = await page.textContent("#subtitle");
await page.waitForFunction(() => document.querySelector("#state-chip")?.textContent !== "speaking", null, { timeout: 60000 });
await page.screenshot({ path: `${out}/3-after.png` });

// Interrupt: start a long sentence, press Stop, the avatar must leave the speaking state quickly.
await page.fill("#text", "This is a long sentence that will be interrupted before it finishes, to test barge-in handling.");
await page.click("#speak");
await page.waitForFunction(() => document.querySelector("#state-chip")?.textContent === "speaking", null, { timeout: 30000 });
await page.waitForTimeout(600);
// measured in-page (Playwright's click() waits for scrolling/stability, which would inflate this)
const stopMs = await page.evaluate(async () => {
  const t0 = performance.now();
  document.getElementById("stop").click();
  while (window.avatar.state === "speaking" && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
  return Math.round(performance.now() - t0);
});

// Audio-driven lip sync (HeadAudio) from an audio file without timings.
let audioMax = -1;
if (process.env.SMOKE_WAV) {
  await page.setInputFiles("#audio-file", process.env.SMOKE_WAV);
  await page.waitForFunction(() => document.querySelector("#state-chip")?.textContent === "speaking", null, { timeout: 30000 });
  audioMax = await page.evaluate(async () => {
    let max = 0;
    window.avatar.listeners.frame = (w) => (max = Math.max(max, ...Object.values(w)));
    await new Promise((r) => setTimeout(r, 1500));
    return max;
  });
  await page.screenshot({ path: `${out}/4-audio-file.png` });
}

console.log("max viseme weight while speaking:", maxViseme.toFixed(2));
console.log("subtitle:", JSON.stringify(subtitle));
console.log(`stop -> not speaking in ${stopMs} ms`);
if (audioMax >= 0) console.log("audio-file lip-sync max viseme:", audioMax.toFixed(2));
console.log("console errors/warnings:", errors.length ? "\n  " + errors.join("\n  ") : "none");
await browser.close();
if (maxViseme < 0.3 || !subtitle || stopMs > 1500 || (audioMax >= 0 && audioMax < 0.2)) process.exit(1);
