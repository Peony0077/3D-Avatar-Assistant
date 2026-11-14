import { TalkingAvatar } from "./avatar/TalkingAvatar";
import type { GestureLevel } from "./behavior/BodyAnimator";
import { ChatClient } from "./llm/ChatClient";
import { VISEMES } from "./lipsync/visemes";
import type { Framing } from "./scene/Stage";
import { VOICES } from "./speech/TTSClient";
import { MOODS, type Mood } from "./speech/text";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const params = new URLSearchParams(location.search);
if (params.has("capture")) void runCapture();
else void runApp();

function toast(msg: string) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout((t as unknown as { _h?: number })._h);
  (t as unknown as { _h?: number })._h = window.setTimeout(() => t.classList.remove("show"), 7000);
}

async function runApp() {
  const avatar = new TalkingAvatar({
    container: $("viewport"),
    onProgress: (f) => ($<HTMLProgressElement>("load-progress").value = f),
  });
  try {
    await avatar.load();
  } catch (e) {
    $("loading").innerHTML = `<div>Could not load the avatar.</div><small>${(e as Error).message}</small>
      <small>Run <code>npm run setup</code> to build <code>public/avatar/avatar.glb</code>.</small>`;
    throw e;
  }
  $("loading").classList.add("hidden");
  (window as unknown as { avatar: TalkingAvatar }).avatar = avatar;

  // ------------------------------------------------------------------ status
  const stateChip = $("state-chip");
  avatar.listeners.state = (s) => (stateChip.textContent = s);
  avatar.listeners.error = (e) => toast(e.message);
  const ttsChip = $("tts-chip");
  const checkTts = async () => {
    const ok = await avatar.tts.ping();
    ttsChip.textContent = ok ? "TTS: online" : "TTS: offline (npm run tts)";
    ttsChip.className = `chip ${ok ? "ok" : "err"}`;
    return ok;
  };
  void checkTts();
  setInterval(checkTts, 8000);

  const unlock = () => void avatar.resumeAudio();
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);

  // ------------------------------------------------------------------ subtitles
  const sub = $("subtitle");
  avatar.listeners.subtitle = (text, wi, words) => {
    if (!text) {
      sub.classList.remove("show");
      return;
    }
    sub.classList.add("show");
    sub.replaceChildren(
      ...words.map((w, i) => {
        const s = document.createElement("span");
        s.className = `w${i < wi ? " done" : i === wi ? " now" : ""}`;
        s.textContent = w;
        return s;
      }),
    );
  };

  // ------------------------------------------------------------------ talk
  const textEl = $<HTMLTextAreaElement>("text");
  $<HTMLSelectElement>("samples").addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v) textEl.value = v;
    (e.target as HTMLSelectElement).value = "";
  });
  const chat = ChatClient.fromEnv();
  const askLabel = $("ask-label");
  const askInput = askLabel.querySelector("input")!;
  askInput.disabled = true;
  askLabel.title = "Set VITE_LLM_MODEL in .env (OpenAI-compatible endpoint, e.g. Ollama) to enable";
  if (chat) void chat.available().then((ok) => (askInput.disabled = !ok));
  let chatAbort: AbortController | null = null;

  const speak = async () => {
    const text = textEl.value.trim();
    if (!text) return;
    await avatar.resumeAudio();
    avatar.stop();
    chatAbort?.abort();
    const mode = (document.querySelector('input[name="mode"]:checked') as HTMLInputElement).value;
    if (mode === "ask" && chat) {
      chatAbort = new AbortController();
      avatar.setState("thinking");
      try {
        await chat.ask(text, (s) => void avatar.enqueue(s), chatAbort.signal);
      } catch (e) {
        if ((e as Error).name !== "AbortError") toast((e as Error).message);
      } finally {
        avatar.setState("idle");
      }
    } else {
      await avatar.speak(text);
    }
  };
  $("speak").addEventListener("click", () => void speak());
  textEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void speak();
  });
  $("stop").addEventListener("click", () => {
    chatAbort?.abort();
    avatar.stop();
  });

  // ------------------------------------------------------------------ voice
  const voiceSel = $<HTMLSelectElement>("voice");
  for (const v of VOICES) voiceSel.append(new Option(v.label, v.id));
  voiceSel.addEventListener("change", () => (avatar.voice.voice = voiceSel.value));
  const bindRange = (id: string, out: string, apply: (v: number) => void) => {
    const el = $<HTMLInputElement>(id);
    const o = $<HTMLOutputElement>(out);
    const upd = () => {
      o.value = Number(el.value).toFixed(2);
      apply(Number(el.value));
    };
    el.addEventListener("input", upd);
    upd();
  };
  bindRange("speed", "speed-v", (v) => (avatar.voice.speed = v));
  bindRange("articulation", "art-v", (v) => (avatar.lipIntensity = v));

  // ------------------------------------------------------------------ mood + behaviour
  const moods = $("moods");
  const moodButtons: HTMLButtonElement[] = [];
  for (const m of MOODS) {
    const b = document.createElement("button");
    b.textContent = m;
    b.addEventListener("click", () => {
      avatar.setMood(m as Mood);
      moodButtons.forEach((x) => x.classList.toggle("active", x === b));
    });
    if (m === "smile") b.classList.add("active");
    moodButtons.push(b);
    moods.append(b);
  }
  $<HTMLInputElement>("expr-int").addEventListener("input", (e) => avatar.setExpressionIntensity(Number((e.target as HTMLInputElement).value)));
  const stateButtons = [...document.querySelectorAll<HTMLButtonElement>("#states button")];
  for (const b of stateButtons) {
    b.addEventListener("click", () => {
      avatar.setState(b.dataset.state as "idle" | "listening" | "thinking");
      stateButtons.forEach((x) => x.classList.toggle("active", x === b));
    });
  }
  stateButtons[0].classList.add("active");
  $<HTMLSelectElement>("gestures").addEventListener("change", (e) => avatar.setGestures((e.target as HTMLSelectElement).value as GestureLevel));
  $<HTMLSelectElement>("framing").addEventListener("change", (e) => avatar.setFraming((e.target as HTMLSelectElement).value as Framing));

  // ------------------------------------------------------------------ audio
  $<HTMLInputElement>("audio-file").addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      await avatar.playAudio(await file.arrayBuffer());
    } catch (err) {
      toast(`Audio lip-sync failed: ${(err as Error).message}`);
    }
  });
  $<HTMLInputElement>("mic").addEventListener("change", async (e) => {
    const on = (e.target as HTMLInputElement).checked;
    try {
      await avatar.resumeAudio();
      if (on) await avatar.mic.start();
      else avatar.mic.stop();
    } catch (err) {
      (e.target as HTMLInputElement).checked = false;
      toast(`Microphone unavailable: ${(err as Error).message}`);
    }
  });
  $<HTMLInputElement>("barge").addEventListener("change", (e) => (avatar.bargeIn = (e.target as HTMLInputElement).checked));

  // ------------------------------------------------------------------ panel + debug
  $("panel-toggle").addEventListener("click", () => $("panel").classList.toggle("collapsed"));
  const bars = $("debug-bars");
  const fills: HTMLElement[] = [];
  for (const v of VISEMES) {
    const label = document.createElement("span");
    label.textContent = v;
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("i");
    bar.append(fill);
    bars.append(label, bar);
    fills.push(fill);
  }
  $<HTMLInputElement>("debug").addEventListener("change", (e) => (bars.hidden = !(e.target as HTMLInputElement).checked));
  avatar.listeners.frame = (w) => {
    if (bars.hidden) return;
    VISEMES.forEach((v, i) => (fills[i].style.width = `${Math.round(w[v] * 100)}%`));
  };
}

/**
 * Capture mode (?capture&w=720&h=900&fps=30): deterministic frame-by-frame rendering of the real
 * runtime, driven by tools/capture-video.mjs (Playwright) to produce verification/demo videos.
 */
async function runCapture() {
  document.body.classList.add("capture");
  $("panel").remove();
  $("hud").remove();
  const width = Number(params.get("w") ?? 720);
  const height = Number(params.get("h") ?? 900);
  const fps = Number(params.get("fps") ?? 30);
  const avatar = new TalkingAvatar({ container: $("viewport"), capture: { width, height, fps } });
  await avatar.load();
  $("loading").classList.add("hidden");
  if (params.get("framing") === "upper") avatar.setFraming("upper");
  const canvas = avatar.stage.renderer.domElement;
  const errors: string[] = [];
  avatar.listeners.error = (e) => errors.push(e.message);
  const api = {
    ready: true,
    errors,
    voice: (v: string, speed = 1) => Object.assign(avatar.voice, { voice: v, speed }),
    mood: (m: Mood) => avatar.setMood(m),
    state: (s: "idle" | "listening" | "thinking") => avatar.setState(s),
    /** Schedule speech; resolves when every sentence has been synthesised and scheduled. */
    speak: async (text: string) => {
      void avatar.speak(text);
      await new Promise((r) => setTimeout(r, 50));
      while (avatar.speech.pending > 0) await new Promise((r) => setTimeout(r, 50));
      return avatar.player.lastEnd;
    },
    step: (n = 1) => {
      for (let i = 0; i < n; i++) avatar.step();
    },
    frame: () => canvas.toDataURL("image/jpeg", 0.9),
    /** Step one frame, return the image and the lip-sync weights used for it. */
    grab: () => {
      avatar.step();
      return { image: canvas.toDataURL("image/jpeg", 0.9), visemes: { ...avatar.currentVisemes } };
    },
    currentState: () => avatar.state,
    soundtrack: () => {
      const bytes = new Uint8Array(avatar.soundtrackWav());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    },
  };
  (window as unknown as { __capture: typeof api }).__capture = api;
}
