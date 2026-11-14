import type { TalkingAvatar } from "../avatar/TalkingAvatar";
import type { Framing } from "../scene/Stage";

/** Phone layout: controls in a bottom sheet instead of the side panel (matches styles.css). */
export const narrowQuery = window.matchMedia("(max-width: 720px)");

type Detent = "min" | "compact" | "full";

/**
 * Keeps the avatar framed in the part of the screen the controls leave free, and runs the panel:
 *  - desktop: side panel on the right, collapsible with ☰.
 *  - phones: bottom sheet with three snap positions: "min" (handle only), "compact" (text box +
 *    Speak/Stop, the default) and "full" (all settings). Tap the handle to open/close it, or drag
 *    and flick it. When the on-screen keyboard opens, the sheet rides above it (visualViewport;
 *    iOS Safari has no interactive-widget support) and the avatar is not reframed, so typing
 *    never makes her jump.
 * The camera glides to each new framing (Stage.update), so opening or closing the panel is smooth.
 */
export function setupLayout(avatar: TalkingAvatar) {
  const panel = document.getElementById("panel")!;
  const handle = document.getElementById("sheet-handle")!;
  const label = document.getElementById("sheet-label")!;
  const body = document.getElementById("panel-body")!;
  const talk = document.getElementById("talk")!;
  const subtitle = document.getElementById("subtitle")!;
  const framingSel = document.getElementById("framing") as HTMLSelectElement;
  let detent: Detent = "compact";
  let sheetY = 0; // translateY of the sheet (px; 0 = fully open)

  const px = (v: string) => parseFloat(v) || 0;
  const safeBottom = () => px(getComputedStyle(panel).paddingBottom) - 10;

  /** How many px of the sheet are visible in a snap position. */
  const visibleAt = (d: Detent) => {
    if (d === "full") return panel.offsetHeight;
    if (d === "compact") return talk.offsetTop + talk.offsetHeight + 8 + safeBottom();
    return handle.offsetTop + handle.offsetHeight + safeBottom();
  };

  const setSheetY = (y: number) => {
    sheetY = y;
    panel.style.setProperty("--sheet-y", `${y}px`);
  };

  /** Frame the avatar around the UI; also places the subtitle just above the sheet on phones. */
  const updateInsets = () => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (narrowQuery.matches) {
      const covered = panel.offsetHeight - sheetY; // keyboard lift is ignored on purpose
      subtitle.style.left = "";
      subtitle.style.maxWidth = "";
      subtitle.style.setProperty("--sub-bottom", `${covered + 8}px`);
      const cs = getComputedStyle(subtitle);
      // two lines + padding + gap (no subtitles while all settings are open)
      const subtitleZone = detent === "full" ? 0 : px(cs.fontSize) * 1.4 * 2 + 12 + 8;
      const top = px(getComputedStyle(document.getElementById("hud")!).top) + 30;
      avatar.setViewInsets({ top, right: 0, bottom: covered + subtitleZone, left: 0 });
    } else {
      const collapsed = panel.classList.contains("collapsed");
      // layout position (offsetLeft ignores the slide transform, so this is the final state)
      const right = collapsed ? 44 + (W - panel.offsetLeft - panel.offsetWidth) : W - panel.offsetLeft;
      const free = W - right;
      subtitle.style.left = `${free / 2}px`;
      subtitle.style.maxWidth = `min(760px, ${Math.round(free * 0.9)}px)`;
      const cs = getComputedStyle(subtitle);
      const subtitleZone = px(cs.bottom) + px(cs.fontSize) * 1.4 + 24; // one line + padding + gap
      avatar.setViewInsets({ top: 0, right, bottom: Math.min(subtitleZone, H * 0.25), left: 0 });
    }
  };

  const snapTo = (d: Detent) => {
    detent = d;
    panel.dataset.sheet = d;
    if (d !== "full") body.scrollTop = 0;
    handle.setAttribute("aria-expanded", String(d === "full"));
    handle.setAttribute("aria-label", d === "full" ? "Hide settings" : "Show all settings");
    label.textContent = d === "full" ? "Close" : d === "min" ? "Controls" : "Settings";
    // all settings open: show her face close up above the sheet, so mood/voice changes are visible
    document.body.classList.toggle("sheet-full", d === "full");
    avatar.setFraming(d === "full" ? "portrait" : (framingSel.value as Framing));
    // the layout of the sheet depends on the detent (compact hides some rows), so measure after
    setSheetY(Math.max(0, panel.offsetHeight - visibleAt(d)));
    updateInsets();
  };

  // ------------------------------------------------------------------ drag / tap on the handle
  let drag: { y0: number; sheet0: number; t0: number; lastY: number; lastT: number; v: number } | null = null;
  handle.addEventListener("pointerdown", (e) => {
    if (!narrowQuery.matches) return;
    handle.setPointerCapture(e.pointerId);
    drag = { y0: e.clientY, sheet0: sheetY, t0: e.timeStamp, lastY: e.clientY, lastT: e.timeStamp, v: 0 };
    panel.classList.add("dragging");
  });
  handle.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dtMs = Math.max(1, e.timeStamp - drag.lastT);
    drag.v = 0.7 * drag.v + 0.3 * ((e.clientY - drag.lastY) / dtMs); // px/ms, + = down
    drag.lastY = e.clientY;
    drag.lastT = e.timeStamp;
    const maxY = panel.offsetHeight - visibleAt("min");
    setSheetY(Math.min(maxY, Math.max(0, drag.sheet0 + e.clientY - drag.y0)));
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag) return;
    const moved = Math.abs(e.clientY - drag.y0);
    const v = drag.v;
    drag = null;
    panel.classList.remove("dragging");
    if (moved < 6) {
      snapTo(detent === "full" ? "compact" : detent === "min" ? "compact" : "full"); // tap
      return;
    }
    // flick: project where the sheet would coast to, then take the nearest snap position
    const projected = sheetY + v * 180;
    const ys: Array<[Detent, number]> = (["full", "compact", "min"] as Detent[]).map((d) => [d, panel.offsetHeight - visibleAt(d)]);
    ys.sort((a, b) => Math.abs(a[1] - projected) - Math.abs(b[1] - projected));
    snapTo(ys[0][0]);
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
  handle.addEventListener("click", (e) => e.preventDefault());

  // ------------------------------------------------------------------ desktop side panel
  document.getElementById("panel-toggle")!.addEventListener("click", () => {
    panel.classList.toggle("collapsed");
    updateInsets();
  });

  // ------------------------------------------------------------------ on-screen keyboard
  const vv = window.visualViewport;
  const updateKeyboard = () => {
    const lift = narrowQuery.matches && vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    panel.style.setProperty("--kb", `${Math.round(lift)}px`);
  };
  vv?.addEventListener("resize", updateKeyboard);
  vv?.addEventListener("scroll", updateKeyboard);

  // ------------------------------------------------------------------ layout changes
  const relayout = () => {
    if (narrowQuery.matches) {
      panel.classList.remove("collapsed");
      snapTo(detent);
    } else {
      panel.style.removeProperty("--sheet-y");
      sheetY = 0;
      document.body.classList.remove("sheet-full");
      avatar.setFraming(framingSel.value as Framing);
      updateInsets();
    }
    updateKeyboard();
  };
  narrowQuery.addEventListener("change", relayout);
  window.addEventListener("resize", relayout);
  // the compact sheet's height depends on the text box (it can be resized on desktop only)
  new ResizeObserver(() => relayout()).observe(talk);
  relayout();

  return {
    /** Close the on-screen keyboard (phones) so speech starts with the full view. */
    blurInputs() {
      if (narrowQuery.matches && document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)) {
        document.activeElement.blur();
      }
    },
  };
}
