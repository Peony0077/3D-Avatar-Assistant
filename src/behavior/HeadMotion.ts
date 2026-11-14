import * as THREE from "three";
import type { AvatarModel } from "../avatar/AvatarModel";
import { Noise1D, Spring, chance, clamp, damp, deg, rand } from "../util/math";
import type { AvatarState } from "./types";

/** How much of the body's head movement is cancelled to keep the face toward its target. */
const FOLLOW: Record<AvatarState, number> = { idle: 0.55, listening: 0.75, thinking: 0.6, speaking: 0.7 };
/** Share of a glance away that the head turns with (the eyes do the rest). */
const GLANCE: Record<AvatarState, number> = { idle: 0.4, listening: 0.3, thinking: 0.55, speaking: 0.4 };

const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);

/**
 * Procedural head layer applied on top of the body mocap:
 *  - keeps the face toward the viewer, and turns partly with glances away. The correction is
 *    computed from the current animated pose every frame (no lag), so it damps the body's head
 *    movement instead of chasing it; only the target direction is smoothed.
 *  - soft nods on stressed words, a settle-nod at sentence ends, occasional listening nods
 *  - head tilt for questions / attentive listening
 *  - slow loudness-driven lift and low-frequency drift so the head is never frozen
 * Rotation is split between neck (40%) and head (60%).
 */
export class HeadMotion {
  state: AvatarState = "idle";
  /** 0..1 loudness of current speech (set every frame while speaking). */
  speechLoud = 0;
  private tgtYawS = new Spring(0, 3.5);
  private tgtPitchS = new Spring(0, 3.5);
  private follow = FOLLOW.idle;
  private nodS = new Spring(0, 6);
  private tiltS = new Spring(0, 2.5);
  private loudS = new Spring(0, 3);
  private tiltTarget = 0;
  private nYaw = new Noise1D();
  private nPitch = new Noise1D();
  private nRoll = new Noise1D();
  private nextListenNod = 0;
  private pendingNods: number[] = [];

  private readonly q0: THREE.Quaternion;
  private readonly hq = new THREE.Quaternion();
  private readonly fwd = new THREE.Vector3();
  private readonly headPos = new THREE.Vector3();
  private readonly toTarget = new THREE.Vector3();
  private readonly qWorld = new THREE.Quaternion();
  private readonly qPart = new THREE.Quaternion();
  private readonly qParent = new THREE.Quaternion();
  private readonly qTmp = new THREE.Quaternion();
  private readonly qTmp2 = new THREE.Quaternion();
  private readonly ident = new THREE.Quaternion();
  /** Animated neck/head rotations before this layer changed them (see restore()). */
  private readonly baseNeck = new THREE.Quaternion();
  private readonly baseHead = new THREE.Quaternion();
  private applied = false;

  constructor(private model: AvatarModel) {
    this.q0 = model.headRestWorld.clone();
  }

  /**
   * Undo last frame's rotation; call before the animation mixer updates. three.js' AnimationMixer
   * only writes a bone when its animated value changed since the previous frame, so otherwise the
   * rotation would be applied on top of itself whenever the mocap holds still for a frame, which
   * shows as the head shaking.
   */
  restore() {
    if (!this.applied) return;
    this.model.bones.neck.quaternion.copy(this.baseNeck);
    this.model.bones.head.quaternion.copy(this.baseHead);
  }

  setState(state: AvatarState, now: number) {
    this.state = state;
    this.tiltTarget = state === "listening" ? (chance(0.5) ? 1 : -1) * deg(rand(2, 3.5)) : 0;
    this.nextListenNod = now + rand(2.5, 5);
  }

  /** A soft nod: down and back up in ~0.6 s. strength 1 = about 2.7 degrees. */
  nod(strength = 1) {
    this.nodS.kick(-0.8 * strength);
  }

  /** Two small nods ("mm-hm") while listening. */
  ackNod(now: number) {
    this.nod(0.7);
    this.pendingNods.push(now + 0.5);
  }

  questionTilt() {
    this.tiltTarget = (chance(0.5) ? 1 : -1) * deg(rand(2.5, 4));
  }

  clearTilt() {
    if (this.state !== "listening") this.tiltTarget = 0;
  }

  private dirTo(point: THREE.Vector3): [number, number] {
    this.toTarget.copy(point).sub(this.headPos).normalize();
    return [Math.atan2(this.toTarget.x, this.toTarget.z), Math.asin(clamp(this.toTarget.y, -1, 1))];
  }

  /**
   * @param viewer where the user is (the camera)
   * @param attention where the head should point: the viewer, or a glance target
   */
  update(now: number, dt: number, viewer: THREE.Vector3, attention: THREE.Vector3) {
    const { neck, head } = this.model.bones;
    this.model.root.updateMatrixWorld(true);

    // where does the animated head face now?
    head.getWorldQuaternion(this.hq);
    head.getWorldPosition(this.headPos);
    this.fwd.set(0, 0, 1).applyQuaternion(this.qTmp.copy(this.hq).multiply(this.qTmp2.copy(this.q0).invert()));
    const curYaw = Math.atan2(this.fwd.x, this.fwd.z);
    const curPitch = Math.asin(clamp(this.fwd.y, -1, 1));

    // where should it face? the viewer, turned part of the way toward a glance target (smoothed)
    const [vYaw, vPitch] = this.dirTo(viewer);
    const [aYaw, aPitch] = this.dirTo(attention);
    const g = GLANCE[this.state];
    const tgtYaw = this.tgtYawS.update(vYaw + g * (aYaw - vYaw), dt);
    const tgtPitch = this.tgtPitchS.update(vPitch + g * (aPitch - vPitch), dt);
    this.follow = damp(this.follow, FOLLOW[this.state], 0.6, dt);
    const corrYaw = clamp((tgtYaw - curYaw) * this.follow, deg(-25), deg(25));
    const corrPitch = clamp((tgtPitch - curPitch) * this.follow, deg(-14), deg(14));

    // listening: occasional acknowledgement nods
    if (this.state === "listening" && now > this.nextListenNod) {
      this.ackNod(now);
      this.nextListenNod = now + rand(5, 10);
    }
    while (this.pendingNods.length && now >= this.pendingNods[0]) {
      this.pendingNods.shift();
      this.nod(0.5);
    }

    const speaking = this.state === "speaking";
    const loud = this.loudS.update(speaking ? this.speechLoud : 0.4, dt);
    const yaw = corrYaw + deg(0.9) * this.nYaw.sample(now * 0.2);
    const pitch = corrPitch + this.nodS.update(0, dt) + deg(0.7) * this.nPitch.sample(now * 0.25) + deg(0.6) * (loud - 0.4);
    const roll = this.tiltS.update(this.tiltTarget, dt) + deg(0.6) * this.nRoll.sample(now * 0.17);

    // world-space rotation about the avatar's axes, applied as a pre-rotation in each bone's parent space
    this.qWorld.setFromAxisAngle(Y, yaw).multiply(this.qTmp.setFromAxisAngle(X, -pitch)).multiply(this.qTmp2.setFromAxisAngle(Z, roll));
    this.baseNeck.copy(neck.quaternion);
    this.baseHead.copy(head.quaternion);
    this.applied = true;
    this.applyPart(neck, 0.4);
    neck.updateMatrixWorld(true);
    this.applyPart(head, 0.6);
    head.updateMatrixWorld(true);
  }

  private applyPart(bone: THREE.Bone, fraction: number) {
    this.qPart.copy(this.ident).slerp(this.qWorld, fraction);
    bone.parent!.getWorldQuaternion(this.qParent);
    // local = parent^-1 * qPart * parent
    this.qTmp.copy(this.qParent).invert().multiply(this.qPart).multiply(this.qParent);
    bone.quaternion.premultiply(this.qTmp);
  }
}
