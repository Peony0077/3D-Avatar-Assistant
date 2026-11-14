import * as THREE from "three";
import type { AvatarModel } from "../avatar/AvatarModel";
import { pick, rand } from "../util/math";
import type { AvatarState } from "./types";

export type GestureLevel = "full" | "subtle" | "none";

/**
 * Rocketbox female mocap clips per state (names given by tools/blender/build_avatar.py). The
 * conversational clips were recorded addressing other people; the most restless ones
 * (talk_relaxed_02, listen_neutral_02, idle_neutral_01: 10-15 cm head travel, large turns) are
 * left out so the assistant stays facing the user.
 */
const GROUPS: Record<AvatarState, string[]> = {
  idle: ["idle_breathe_02", "idle_neutral_02"],
  listening: ["listen_neutral_01"],
  thinking: ["idle_breathe_02", "idle_neutral_02"],
  speaking: ["talk_neutral_01", "talk_neutral_02", "talk_relaxed_01"],
};
const SUBTLE_TALK = ["talk_neutral_01"];
const NODS = ["listen_accept_01", "listen_accept_02"];
/** Calm breathing clip that always plays underneath, damping restless clips (see CLIP_WEIGHT). */
const ANCHOR = "idle_breathe_01";
/** How much of each clip's motion is used (the rest comes from the anchor). Measured head travel:
 *  talk_neutral_01 ~2 cm, talk_neutral_02 / talk_relaxed_01 ~10 cm with large torso turns. */
const CLIP_WEIGHT: Record<string, number> = {
  talk_neutral_02: 0.5,
  talk_relaxed_01: 0.5,
  idle_neutral_02: 0.7,
  listen_neutral_01: 0.75,
};

/**
 * Full-body motion from motion capture: breathing idles, listening posture, talking gestures.
 * Long clips are entered at random offsets and re-picked every few seconds so the motion never
 * visibly loops; all changes are cross-faded.
 */
export class BodyAnimator {
  readonly mixer: THREE.AnimationMixer;
  gestures: GestureLevel = "full";
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private currentName = "";
  private state: AvatarState = "idle";
  private segmentEnd = 0;
  private nodUntil = -1;
  private time = 0;

  private anchor: THREE.AnimationAction | null = null;

  constructor(model: AvatarModel) {
    this.mixer = new THREE.AnimationMixer(model.root);
    for (const clip of model.clips) {
      const a = this.mixer.clipAction(clip);
      a.setLoop(THREE.LoopRepeat, Infinity);
      this.actions.set(clip.name, a);
    }
    this.anchor = this.actions.get(ANCHOR) ?? null;
    this.anchor?.setEffectiveWeight(0).play();
  }

  get clipNames(): string[] {
    return [...this.actions.keys()];
  }

  private group(state: AvatarState): string[] {
    if (state === "speaking") {
      if (this.gestures === "none") return GROUPS.idle;
      if (this.gestures === "subtle") return SUBTLE_TALK;
    }
    return GROUPS[state].filter((n) => this.actions.has(n));
  }

  setState(state: AvatarState, fade = 0.8) {
    if (state === this.state && this.current) return;
    this.state = state;
    this.nodUntil = -1;
    this.playFrom(this.group(state), fade);
  }

  /** Short full-body "mm-hm" nod (listening acknowledgement). */
  nod() {
    const name = pick(NODS.filter((n) => this.actions.has(n)));
    if (!name || this.state === "speaking") return;
    const a = this.actions.get(name)!;
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    this.crossTo(a, name, 0.3, 0);
    this.nodUntil = this.time + a.getClip().duration - 0.35;
  }

  private playFrom(names: string[], fade: number) {
    if (!names.length) return;
    const options = names.length > 1 ? names.filter((n) => n !== this.currentName) : names;
    const name = pick(options);
    const a = this.actions.get(name)!;
    a.setLoop(THREE.LoopRepeat, Infinity);
    const dur = a.getClip().duration;
    const long = dur > 12;
    this.crossTo(a, name, fade, long ? rand(0, dur - 8) : rand(0, dur * 0.5));
    this.segmentEnd = this.time + (long ? rand(6, 11) : dur * rand(1.5, 2.5));
  }

  private crossTo(next: THREE.AnimationAction, name: string, fade: number, startAt: number) {
    if (next === this.current) return;
    next.reset();
    next.time = startAt;
    next.setEffectiveWeight(CLIP_WEIGHT[name] ?? 1);
    next.play();
    if (this.current) this.current.crossFadeTo(next, fade, false);
    this.current = next;
    this.currentName = name;
  }

  update(dt: number) {
    this.time += dt;
    if (this.nodUntil > 0 && this.time >= this.nodUntil) {
      this.nodUntil = -1;
      this.playFrom(this.group(this.state), 0.5);
    } else if (this.nodUntil < 0 && this.time >= this.segmentEnd) {
      this.playFrom(this.group(this.state), 1.2);
    }
    // anchor fills whatever weight the active clips leave (so the pose never blends toward bind pose)
    if (this.anchor) {
      let used = 0;
      for (const a of this.actions.values()) if (a !== this.anchor && a.isRunning()) used += a.getEffectiveWeight();
      this.anchor.setEffectiveWeight(Math.max(0, 1 - used));
    }
    this.mixer.update(dt);
  }
}
