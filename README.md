# 3D Avatar Assistant

A realistic, lip-synced 3D virtual-assistant avatar that runs in the browser (Three.js), with an open-source
neural voice (Kokoro via HeadTTS). Everything is free and open source; see [Licences](#licences).

- **Lip sync from phoneme timings**: every sentence comes back from TTS with phoneme timestamps, which are
  mapped to 15 visemes with coarticulation, glides through diphthongs, full lip closure on P/B/M, lip
  rounding that starts early before O/U, and vowel opening that follows loudness. Timing runs on the
  audio clock. Measured on the rendered runtime it is in sync with the voice (−4 ms; see
  [Verification](#verification)).
- **Realistic mouth**: real teeth (upper and lower jaw) and a tongue that move with every viseme. The
  inside of the mouth darkens when the lips are nearly closed, so teeth never glow.
- **Lifelike behaviour**:
  - **Blinks:** the rate depends on her state; there are double and partial blinks, and she blinks on large gaze shifts.
  - **Eyes:** saccades and micro-saccades around your eyes and mouth. She glances away while thinking and at
    the start of some sentences, and her eyelids follow her gaze.
  - **Head:** nods on stressed words and a slight tilt on questions. The head keeps facing you while the
    body moves.
  - **Face:** eyebrow raises on stressed words, mood expressions, and small idle movements.
  - **Body:** breathing and talking or listening motion capture. Every clip shares one calm posture,
    and torso sway is reduced so she stays facing the viewer; arm gestures are kept.
- **Responsive**:
  - **Pipelined speech:** the next sentence is synthesised while the current one plays, and replies from a
    streaming LLM start speaking at their first sentence.
  - **Interruption:** Stop (or the user talking, if barge-in is on) cuts speech within about 150 ms.
  - **States:** idle, listening, thinking and speaking.
- **Audio-driven fallback**: lip-syncs any audio file without timings (HeadAudio), for example
  pre-recorded voice or another TTS.

## Quick start

Requirements: Node.js 22+. Blender 5 is needed only to rebuild the avatar asset.

```bash
npm install
npm run fetch-voices        # Kokoro voice files -> server/voices/
npm run tts                 # TTS server on 127.0.0.1:8882 (downloads the 330 MB model on first run)
npm run dev                 # http://localhost:5173  (proxies /tts and /llm)
```

`public/avatar/avatar.glb` is prebuilt. To rebuild it from source (Microsoft Rocketbox `Female_Adult_01`
plus 12 female motion-capture clips):

```bash
npm run fetch-assets        # downloads the MIT Rocketbox avatar + clips into assets-src/
npm run build-avatar        # Blender (headless) + gltfpack -> public/avatar/avatar.glb (~6 MB)
```

Optional assistant replies: set `VITE_LLM_MODEL` (and `LLM_BASE_URL`) in `.env` to any
OpenAI-compatible endpoint, for example a local `ollama serve`. "Ask assistant" then streams the reply
sentence by sentence into speech. See `.env.example`.

Production hosting (Cloudflare Tunnel, Caddy, systemd user services): see [deploy/README.md](deploy/README.md).

## Using it from your assistant

```ts
import { TalkingAvatar } from "./src/avatar/TalkingAvatar";

const avatar = new TalkingAvatar({ container: document.getElementById("viewport")! });
await avatar.load();

await avatar.speak("[happy] Great news! Your order has shipped.");  // resolves when finished
avatar.enqueue("First sentence of a streamed reply.");             // streaming: add sentence by sentence
avatar.stop();                                                      // interrupt immediately
avatar.setState("listening");                                       // idle | listening | thinking
avatar.setMood("concerned");                                        // neutral smile happy sad surprised concerned thinking angry
avatar.voice = { voice: "af_heart", speed: 1 };                     // 8 female voices, see TTSClient.VOICES
await avatar.playAudio(arrayBuffer);                                // audio-driven lip sync for any audio
avatar.listeners.subtitle = (text, wordIndex, words) => { /* ... */ };
```

Text may contain mood tags (`[smile]`, `[concerned]`, …) and emojis. Money, percentages, dates, ordinals,
titles and ranges are rewritten into spoken form (for example `$12.50`, `2026-11-18`, `Dr.`), while the
subtitles keep the original text.

## How it works

```
text ─► split into sentences ─► spoken-form normalisation ─► HeadTTS (Kokoro-82M, CPU)
                                                              │ WAV + words/phonemes with ms timings
                         ┌────────────────────────────────────┘
                         ▼
      loudness envelope + phoneme→viseme map + coarticulation ─► LipSyncTrack (viseme weights at any time t)
                         │
 Web Audio clock ──► SpeechPlayer (gapless, interruptible) ──► per frame: sample track at the heard time
                                                                    │
  BodyAnimator (mocap) → HeadMotion → Gaze (eye bones) → Blink → Expressions → FaceController (blend shapes)
```

- **Avatar build** (`tools/blender/build_avatar.py`):
  - Imports Rocketbox's facial FBX and keeps 15 Oculus visemes and 52 ARKit shapes under their standard
    names, plus lids-only gaze helpers.
  - Adds one level of Catmull-Clark subdivision while keeping every shape, and colour-matches the body
    skin to the head.
  - Replaces the painted low-poly mouth with CC0 MakeHuman teeth and tongue, fitted per shape.
  - Retargets the motion-capture clips and exports a GLB, compressed with gltfpack (meshopt).
- **Runtime** (`src/`):
  - `lipsync/` builds the viseme timing.
  - `speech/` handles TTS, scheduling and text.
  - `behavior/` holds the gaze, blink, head, expression and body layers.
  - `avatar/TalkingAvatar.ts` orchestrates them; `scene/Stage.ts` handles rendering and lighting.

## Verification

```bash
npm test                                   # 23 unit tests (lip-sync engine on real TTS output, text rules)
node tools/smoke-test.mjs                  # headless Chromium: load, speak, subtitles, stop, audio-file lip sync
node tools/capture-video.mjs --text "…" --out demo.mp4   # frame-exact video of the real runtime + soundtrack
<blender-python> tools/analyze-sync.py .work/capture-frames   # mouth vs audio offset, closures (needs numpy)
node tools/measure-motion.mjs --variants full,nohead,nobody   # head/body sway, bobbing and tremble per state
```

`measure-motion.mjs` steps the runtime at 60 fps and reports how far the head, chest and eyes (on
screen) move while idle, listening and speaking. It splits that movement into slow sway, 0.7–4 Hz
bobbing and tremble above 4 Hz. Last measurement while speaking: head travel 12 mm side to side
and 10 mm forward/back, eyes within 28 px on a 720 px frame, tremble under 0.3 px.

The smoke test and capture need `npm run tts` and `npm run dev` running. `capture-video.mjs` renders the
browser runtime on a virtual clock, so the video shows exactly what users see. Last measurement on
14.4 s of speech: −4 ms audio/visual offset (well under the ~45 ms where people notice), 38 full lip
closures, and the mouth at rest in pauses.

## Licences

| Component | Licence |
|---|---|
| Avatar `Female_Adult_01` + motion capture: [Microsoft Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox) | MIT (`public/avatar/LICENSE-rocketbox.md`) |
| Teeth and tongue: [MakeHuman](https://static.makehumancommunity.org/) system assets | CC0 (`tools/assets/makehuman/README.md`) |
| Voice model [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped) and voices | Apache-2.0 |
| [HeadTTS](https://github.com/met4citizen/HeadTTS), [HeadAudio](https://github.com/met4citizen/HeadAudio) | MIT |
| [three.js](https://threejs.org), [gltfpack/meshoptimizer](https://github.com/zeux/meshoptimizer) | MIT |

## Limitations

- **English only:** the Kokoro voices with phoneme timings are English. Audio-driven lip sync works for
  any language, but less precisely.
- **Source model:** Rocketbox is a 2010s game model. Subdivision and the new mouth make it hold up at
  portrait distance, but it is not film-grade (for example, the hair is made of flat cards).
- **Machine:** on this WSL machine (5.8 GB RAM) the TTS server uses about 1.3 GB with 2 threads and runs
  about 4× faster than real time on the CPU.
