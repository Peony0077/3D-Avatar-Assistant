#!/usr/bin/env node
// Measures how much the avatar's head and body move, frame by frame, on the real runtime (capture
// mode: deterministic virtual clock). Needs `npm run dev` (and `npm run tts` for the speaking test).
//   node tools/measure-motion.mjs [--url http://localhost:5173] [--fps 60] [--seed 7] [--variants full,nohead,nobody]
// Variants: full runtime; nohead = procedural head layer off; nobody = body mocap frozen.
//
// For each state (idle, listening, speaking) it reports, per signal:
//   range   p95-p5 of the signal
//   sway    RMS of the slow part (< ~0.7 Hz): drifting, weight shifts
//   bob     RMS of the 0.7-4 Hz band: nods, bobbing, gesture-driven rocking ("shaking")
//   jitter  RMS of the > ~4 Hz part: trembling / frame-to-frame noise
//   turns/s direction reversals per second larger than a small threshold
// Signals: head yaw/pitch/roll (deg, relative to rest), head position (mm), chest position (mm),
// and the eyes' position on screen (px, 720x900 portrait framing).
import { chromium } from "playwright";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const url = arg("url", "http://localhost:5173");
const fps = Number(arg("fps", 60));
const variants = arg("variants", "full").split(",");
const TEXT =
  "Hello! I'm your virtual assistant. I can help you plan your day, answer questions about your " +
  "account, and keep track of your orders. Your package left the warehouse this morning, and it " +
  "should arrive on Thursday. Is there anything else you would like me to check for you?";

const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 720, height: 900 } });
// seeded Math.random, so every run makes the same behaviour choices (comparable measurements)
const seed = Number(arg("seed", 7));
await page.addInitScript((seed) => {
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}, seed);
page.on("pageerror", (e) => console.error("[pageerror]", e.message));

async function run(variant, state, seconds, speak) {
  await page.goto(`${url}/?capture&w=720&h=900&fps=${fps}`);
  await page.waitForFunction(() => window.__capture?.ready, null, { timeout: 120000 });
  return page.evaluate(
    async ({ variant, state, seconds, speak, fps }) => {
      const c = window.__capture;
      const av = c.avatar;
      av.stage.render = () => {}; // motion only: skip drawing (the camera never moves)
      if (variant === "nohead") av.head.update = () => {};
      if (variant === "nobody") av.body.mixer.timeScale = 0;
      c.step(fps); // settle 1 s
      if (state !== "speaking") c.state(state);
      let frames = Math.round(seconds * fps);
      if (speak) {
        const end = await c.speak(speak);
        frames = Math.round((end + 0.3) * fps);
      }
      const { model, stage } = av;
      const THREE = { v: () => model.root.position.clone(), q: () => model.root.quaternion.clone() };
      const q0inv = model.headRestWorld.clone().invert();
      const out = [];
      const q = THREE.q();
      const p = THREE.v();
      const f = THREE.v();
      const u = THREE.v();
      const e1 = THREE.v();
      const e2 = THREE.v();
      for (let i = 0; i < frames; i++) {
        c.step();
        const { head, spine2, leftEye, rightEye } = model.bones;
        head.getWorldQuaternion(q).multiply(q0inv);
        f.set(0, 0, 1).applyQuaternion(q);
        u.set(0, 1, 0).applyQuaternion(q);
        const yaw = Math.atan2(f.x, f.z), pitch = Math.asin(Math.max(-1, Math.min(1, f.y)));
        const roll = Math.atan2(-u.x, u.y);
        head.getWorldPosition(p);
        const hx = p.x, hy = p.y, hz = p.z;
        spine2.getWorldPosition(p);
        const cx = p.x, cy = p.y, cz = p.z;
        leftEye.getWorldPosition(e1);
        rightEye.getWorldPosition(e2);
        e1.add(e2).multiplyScalar(0.5).project(stage.camera);
        const R = 180 / Math.PI;
        out.push([yaw * R, pitch * R, roll * R, hx * 1000, hy * 1000, hz * 1000, cx * 1000, cy * 1000, cz * 1000,
          (e1.x * 0.5 + 0.5) * 720, (0.5 - e1.y * 0.5) * 900]);
      }
      return out;
    },
    { variant, state, seconds, speak, fps },
  );
}

// ---------------------------------------------------------------------------------- analysis
const movAvg = (x, w) => {
  const h = Math.max(1, Math.round(w / 2));
  return x.map((_, i) => {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(x.length - 1, i + h); j++) (s += x[j]), n++;
    return s / n;
  });
};
const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
const pct = (x, p) => [...x].sort((a, b) => a - b)[Math.floor((x.length - 1) * p)];
function turns(x, thr) {
  // count extrema separated by more than thr (hysteresis), on a lightly smoothed signal
  const s = movAvg(x, fps * 0.05);
  let dir = 1, ext = s[0], n = 0;
  for (const v of s) {
    if (dir >= 0 && v > ext) ext = v;
    else if (dir <= 0 && v < ext) ext = v;
    if (dir >= 0 && v < ext - thr) (dir = -1), (ext = v), n++;
    else if (dir <= 0 && v > ext + thr) (dir = 1), (ext = v), n++;
  }
  return n / (x.length / fps);
}
function stats(x, thr) {
  const fast = movAvg(x, fps * 0.25); // removes > ~4 Hz
  const slow = movAvg(x, fps * 1.4); // keeps < ~0.7 Hz
  const mean = x.reduce((a, b) => a + b, 0) / x.length;
  return {
    range: pct(x, 0.95) - pct(x, 0.05),
    sway: rms(slow.map((v) => v - mean)),
    bob: rms(fast.map((v, i) => v - slow[i])),
    jitter: rms(x.map((v, i) => v - fast[i])),
    turns: turns(x, thr),
  };
}
const SIGNALS = [
  ["head yaw (deg)", (r) => r[0], 0.3],
  ["head pitch (deg)", (r) => r[1], 0.3],
  ["head roll (deg)", (r) => r[2], 0.3],
  ["head pos x (mm)", (r) => r[3], 1],
  ["head pos y (mm)", (r) => r[4], 1],
  ["head pos z (mm)", (r) => r[5], 1],
  ["chest pos x (mm)", (r) => r[6], 1],
  ["chest pos z (mm)", (r) => r[8], 1],
  ["eyes on screen x (px)", (r) => r[9], 1],
  ["eyes on screen y (px)", (r) => r[10], 1],
];

const results = {};
for (const variant of variants) {
  for (const [state, seconds, speak] of [["idle", 20], ["listening", 12], ["speaking", 0, TEXT]]) {
    const rows = await run(variant, state, seconds, speak);
    console.log(`\n== ${variant} / ${state}: ${(rows.length / fps).toFixed(1)} s`);
    console.log("signal".padEnd(24), "range".padStart(7), "sway".padStart(7), "bob".padStart(7), "jitter".padStart(7), "turns/s".padStart(8));
    for (const [name, get, thr] of SIGNALS) {
      const s = stats(rows.map(get), thr);
      results[`${variant}/${state}/${name}`] = s;
      console.log(name.padEnd(24), ...[s.range, s.sway, s.bob, s.jitter].map((v) => v.toFixed(2).padStart(7)), s.turns.toFixed(2).padStart(8));
    }
  }
}
await browser.close();
if (process.env.MOTION_JSON) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(process.env.MOTION_JSON, JSON.stringify(results, null, 1));
}
