#!/usr/bin/env node
// Downloads the MIT-licensed Microsoft Rocketbox avatar + selected female mocap clips into assets-src/.
// Usage: node tools/fetch-assets.mjs
import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "assets-src", "rocketbox");
const RAW = "https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/master/Assets";
const AVATAR = "Avatars/Adults/Female_Adult_01";

const files = [
  `${AVATAR}/Export/Female_Adult_01_facial.fbx`,
  ...["f001_body_color", "f001_body_normal", "f001_body_specular", "f001_head_color", "f001_head_normal",
      "f001_head_specular", "f001_opacity_color"].map((t) => `${AVATAR}/Textures/${t}.tga`),
];

// Female, in-place ("static" = motion extracted) clips used for idle / talking / listening behaviour.
export const ANIMATIONS = [
  "f_idle_breathe_01", "f_idle_breathe_02", "f_idle_neutral_01", "f_idle_neutral_02",
  "f_gestic_talk_neutral_01", "f_gestic_talk_neutral_02", "f_gestic_talk_relaxed_01", "f_gestic_talk_relaxed_02",
  "f_gestic_listen_neutral_01", "f_gestic_listen_neutral_02", "f_gestic_listen_accept_01", "f_gestic_listen_accept_02",
];
for (const a of ANIMATIONS) files.push(`Animations/all_animations_max_motextr_static/${a}.max.fbx`);
files.push("../LICENSE.md");

async function exists(p) { try { return (await stat(p)).size > 0; } catch { return false; } }

for (const f of files) {
  const dest = f === "../LICENSE.md" ? join(OUT, "LICENSE.md") : join(OUT, f.replace(`${AVATAR}/`, "avatar/").replace("Animations/all_animations_max_motextr_static/", "animations/"));
  if (await exists(dest)) { console.log("skip ", dest); continue; }
  const url = `${RAW}/${f}`.replace("/Assets/../", "/");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  console.log("saved", dest);
}
