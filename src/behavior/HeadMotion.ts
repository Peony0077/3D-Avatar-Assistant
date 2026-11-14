import * as THREE from "three";
import type { AvatarModel } from "../avatar/AvatarModel";
import { Noise1D, Spring, chance, clamp, deg, rand } from "../util/math";
import type { AvatarState } from "./types";

/** How strongly the head turns toward what the eyes attend to (rest is done by the eyes). */
const FOLLOW: Record<AvatarState, number> = { idle: 0.5, listening: 0.8, thinking: 0.55, speaking: 0.75 };

const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);

/**
 * Procedural head layer applied on top of the body mocap:
 *  - keeps the face oriented toward the attention point (partial, spring-smoothed)
 *  - nods on stressed words, a settle-nod at sentence ends, slow listening nods
 *  - head tilt for questions / attentive listening
 *  - speech-driven micro motion (loudness) + low-frequency drift so the head is never frozen
 * Rotation is split between neck (40%) and head (60%).
 */
export class HeadMotion {
  state: AvatarState = "idle";
  /** 0..1 loudness of current speech (set every frame while speaking). */
  speechLoud = 0;
  private yawS = new Spring(0, 5);
  private pitchS = new Spring(0, 5);
  private nodS = new Spring(0, 9);
  private tiltS = new Spring(0, 3.5);
  private loudS = new Spring(0, 14);
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
  private readonly ident = new THREE.Quaternion();

  constructor(private model: AvatarModel) {
    this.q0 = model.headRestWorld.clone();
  }

  setState(state: AvatarState, now: number) {
    this.state = state;
    this.tiltTarget = state === "listening" ? (chance(0.5) ? 1 : -1) * deg(rand(2, 4)) : 0;
    this.nextListenNod = now + rand(1.5, 3.5);
  }

  /** A nod: quick down-up. strength ~1 = 2.5-3 degrees. */
  nod(strength = 1) {
    this.nodS.kick(-1.25 * strength);
  }

  /** Two small nods ("mm-hm") while listening. */
  ackNod(now: number) {
    this.nod(0.8);
    this.pendingNods.push(now + 0.38);
  }

  questionTilt() {
    this.tiltTarget = (chance(0.5) ? 1 : -1) * deg(rand(3, 5));
  }

  clearTilt() {
    if (this.state !== "listening") this.tiltTarget = 0;
  }

  update(now: number, dt: number, attention: THREE.Vector3) {
    const { neck, head } = this.model.bones;
    this.model.root.updateMatrixWorld(true);

    // where does the animated head currently face, and where should it face?
    head.getWorldQuaternion(this.hq);
    head.getWorldPosition(this.headPos);
    this.fwd.set(0, 0, 1).applyQuaternion(this.qTmp.copy(this.hq).multiply(this.qTmp2.copy(this.q0).invert()));
    this.toTarget.copy(attention).sub(this.headPos).normalize();
    const curYaw = Math.atan2(this.fwd.x, this.fwd.z);
    const curPitch = Math.asin(clamp(this.fwd.y, -1, 1));
    const tgtYaw = Math.atan2(this.toTarget.x, this.toTarget.z);
    const tgtPitch = Math.asin(clamp(this.toTarget.y, -1, 1));
    const f = FOLLOW[this.state];
    const corrYaw = clamp((tgtYaw - curYaw) * f, deg(-25), deg(25));
    const corrPitch = clamp((tgtPitch - curPitch) * f, deg(-14), deg(14));

    // listening: occasional acknowledgement nods
    if (this.state === "listening" && now > this.nextListenNod) {
      this.ackNod(now);
      this.nextListenNod = now + rand(3, 7);
    }
    while (this.pendingNods.length && now >= this.pendingNods[0]) {
      this.pendingNods.shift();
      this.nod(0.6);
    }

    const yaw = this.yawS.update(corrYaw, dt) + deg(1.1) * this.nYaw.sample(now * 0.23);
    const loud = this.loudS.update(this.state === "speaking" ? this.speechLoud : 0, dt);
    const pitch =
      this.pitchS.update(corrPitch, dt) +
      this.nodS.update(0, dt) +
      deg(0.9) * this.nPitch.sample(now * 0.31) +
      deg(1.3) * (loud - 0.4) * (this.state === "speaking" ? 1 : 0);
    const roll = this.tiltS.update(this.tiltTarget, dt) + deg(0.8) * this.nRoll.sample(now * 0.19);

    // world-space rotation about the avatar's axes, applied as a pre-rotation in each bone's parent space
    this.qWorld.setFromAxisAngle(Y, yaw).multiply(this.qTmp.setFromAxisAngle(X, -pitch)).multiply(this.qTmp2.setFromAxisAngle(Z, roll));
    this.applyPart(neck, 0.4);
    neck.updateMatrixWorld(true);
    this.applyPart(head, 0.6);
    head.updateMatrixWorld(true);
  }

  private readonly qTmp2 = new THREE.Quaternion();

  private applyPart(bone: THREE.Bone, fraction: number) {
    this.qPart.copy(this.ident).slerp(this.qWorld, fraction);
    bone.parent!.getWorldQuaternion(this.qParent);
    // local = parent^-1 * qPart * parent
    this.qTmp.copy(this.qParent).invert().multiply(this.qPart).multiply(this.qParent);
    bone.quaternion.premultiply(this.qTmp);
  }
}
