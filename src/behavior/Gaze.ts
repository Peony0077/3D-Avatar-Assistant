import * as THREE from "three";
import type { AvatarModel } from "../avatar/AvatarModel";
import type { Weights } from "../avatar/FaceController";
import { chance, clamp, damp, deg, pick, rand } from "../util/math";
import type { BlinkController } from "./Blink";
import type { AvatarState } from "./types";

type Mode = "contact" | "avert" | "wander";

const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);

/** Fixation points on the viewer's face (camera space, metres): their left eye, right eye, mouth. */
const FIXATIONS = [new THREE.Vector3(-0.032, 0.01, 0), new THREE.Vector3(0.032, 0.01, 0), new THREE.Vector3(0, -0.06, 0)];

/** How long one fixation lasts in each state (s). */
const DWELL: Record<AvatarState, [number, number]> = {
  idle: [1.4, 3.2],
  listening: [0.8, 2.2],
  thinking: [1.2, 2.6],
  speaking: [0.6, 1.6],
};

/**
 * Eye behaviour: eye contact with saccades between the viewer's eyes and mouth, micro-saccades,
 * gaze aversion while thinking / when starting a sentence, idle glances, and eyelids that follow
 * vertical gaze. Eyes are driven by bones (correct rotation, no mesh distortion); the target is
 * a world point, so eyes compensate head motion automatically (vestibulo-ocular reflex).
 */
export class GazeController {
  state: AvatarState = "idle";
  /** World point the avatar is attending to (head follows this partially). */
  readonly attention = new THREE.Vector3();
  /** Where the head should point: the viewer during eye contact (the eyes alone make the small
   *  eye/mouth fixation shifts), the glance target while looking away. */
  readonly headAttention = new THREE.Vector3();
  private mode: Mode = "contact";
  private modeUntil = 0;
  private fixation = 0;
  private fixUntil = 0;
  private micro = new THREE.Vector2();
  private microUntil = 0;
  private avertDir = new THREE.Vector2(); // yaw, pitch (rad) in the avatar's frame
  private yaw = 0; // current eye angles relative to head (rad)
  private pitch = 0;
  private lastTargetYaw = 0;
  private lastTargetPitch = 0;
  private thinkSide = chance(0.5) ? 1 : -1;

  private readonly tmpQ = new THREE.Quaternion();
  private readonly headQ = new THREE.Quaternion();
  private readonly toNeutral = new THREE.Quaternion();
  private readonly eyeCenter = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly qDelta = new THREE.Quaternion();
  private readonly qYaw = new THREE.Quaternion();
  private readonly qPitch = new THREE.Quaternion();
  private readonly q0Inv: THREE.Quaternion;

  constructor(private model: AvatarModel, private camera: THREE.Camera, private blink: BlinkController) {
    this.q0Inv = model.headRestWorld.clone().invert();
  }

  setState(state: AvatarState, now: number) {
    this.state = state;
    if (state === "thinking") {
      this.thinkSide = chance(0.7) ? this.thinkSide : -this.thinkSide;
      this.avert(now, rand(1.5, 3.0), this.thinkSide * rand(deg(12), deg(22)), rand(deg(6), deg(14)));
    } else if (state === "listening") {
      this.contact(now);
    }
  }

  /** Called when a new sentence starts: speakers often glance away briefly while planning. */
  onSentenceStart(now: number, first: boolean) {
    if (chance(first ? 0.45 : 0.3)) {
      const side = chance(0.5) ? 1 : -1;
      this.avert(now, rand(0.5, 1.2), side * rand(deg(7), deg(16)), rand(deg(-6), deg(8)));
    } else {
      this.contact(now);
    }
  }

  private avert(now: number, dur: number, yaw: number, pitch: number) {
    this.mode = "avert";
    this.modeUntil = now + dur;
    this.avertDir.set(yaw, pitch);
  }

  private contact(now: number) {
    this.mode = "contact";
    this.modeUntil = now + 1e9;
    this.fixUntil = now; // pick a fixation immediately
  }

  update(now: number, dt: number, lids: Weights) {
    // ------------------------------------------------------------ choose the target
    if (now > this.modeUntil) {
      if (this.state === "thinking") this.avert(now, rand(1.2, 2.5), this.thinkSide * rand(deg(10), deg(22)), rand(deg(4), deg(14)));
      else if (this.state === "idle" && chance(0.45)) {
        this.mode = "wander";
        this.modeUntil = now + rand(1.0, 2.8);
        this.avertDir.set(rand(deg(-24), deg(24)), rand(deg(-8), deg(9)));
      } else this.contact(now);
    }
    if (this.mode === "contact" && now > this.fixUntil) {
      this.fixation = this.state === "speaking" ? pick([0, 1, 0, 1, 2]) : pick([0, 1, 2, 0, 1]);
      const [a, b] = DWELL[this.state];
      this.fixUntil = now + rand(a, b);
    }
    if (now > this.microUntil) {
      this.micro.set(rand(-1, 1), rand(-1, 1)).multiplyScalar(deg(0.35));
      this.microUntil = now + rand(0.25, 0.8);
    }

    const head = this.model.bones.head;
    head.getWorldQuaternion(this.headQ);
    const le = this.model.bones.leftEye.getWorldPosition(this.eyeCenter);
    const re = this.model.bones.rightEye.getWorldPosition(this.dir);
    le.add(re).multiplyScalar(0.5);

    if (this.mode === "contact") {
      const fix = FIXATIONS[this.fixation].clone().applyQuaternion(this.camera.quaternion);
      this.attention.copy(this.camera.position).add(fix);
      this.headAttention.copy(this.camera.position);
    } else {
      // direction in the avatar's (root) frame -> world point 1.5 m away
      const d = new THREE.Vector3(Math.sin(this.avertDir.x) * Math.cos(this.avertDir.y), Math.sin(this.avertDir.y),
        Math.cos(this.avertDir.x) * Math.cos(this.avertDir.y));
      const toCam = this.camera.position.clone().sub(this.eyeCenter).setY(0).normalize();
      const baseYaw = Math.atan2(toCam.x, toCam.z);
      d.applyAxisAngle(Y, baseYaw);
      this.attention.copy(this.eyeCenter).addScaledVector(d, 1.5);
      this.headAttention.copy(this.attention);
    }

    // ----------------------------------------------- target direction relative to the head
    this.toNeutral.copy(this.model.headRestWorld).multiply(this.tmpQ.copy(this.headQ).invert());
    this.dir.copy(this.attention).sub(this.eyeCenter).normalize().applyQuaternion(this.toNeutral);
    let tYaw = Math.atan2(this.dir.x, this.dir.z) + this.micro.x;
    let tPitch = Math.asin(clamp(this.dir.y, -1, 1)) + this.micro.y;
    tYaw = clamp(tYaw, deg(-30), deg(30));
    tPitch = clamp(tPitch, deg(-22), deg(20));

    // large saccades often come with a blink
    const jump = Math.hypot(tYaw - this.lastTargetYaw, tPitch - this.lastTargetPitch);
    if (jump > deg(12) && chance(0.55)) this.blink.trigger(now);
    this.lastTargetYaw = tYaw;
    this.lastTargetPitch = tPitch;

    // saccade dynamics: ~95% of the way in 55 ms
    this.yaw = damp(this.yaw, tYaw, 0.018, dt);
    this.pitch = damp(this.pitch, tPitch, 0.018, dt);

    // ------------------------------------------------------------------- drive eye bones
    this.qYaw.setFromAxisAngle(Y, this.yaw);
    this.qPitch.setFromAxisAngle(X, -this.pitch);
    this.qDelta.copy(this.qYaw).multiply(this.qPitch); // in head-neutral frame
    // local = (Q0^-1 * qDelta * Q0) * restLocal  (eye bones are children of the head)
    const local = this.tmpQ.copy(this.q0Inv).multiply(this.qDelta).multiply(this.model.headRestWorld);
    this.model.bones.leftEye.quaternion.copy(local).multiply(this.model.restLocal.leftEye);
    this.model.bones.rightEye.quaternion.copy(local).multiply(this.model.restLocal.rightEye);

    // eyelids follow vertical gaze
    lids.eyesLookUp = clamp(this.pitch / deg(18)) * 0.6;
    lids.eyesLookDown = clamp(-this.pitch / deg(20)) * 0.75;
  }
}
