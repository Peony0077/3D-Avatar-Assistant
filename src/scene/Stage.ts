import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { damp } from "../util/math";

export type Framing = "portrait" | "upper";

/** Screen area (CSS px from each edge) covered by UI, which the avatar is framed around. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * What each framing keeps in view, in metres relative to the eyes, plus the camera height (also
 * relative to the eyes; the camera looks level, so she looks straight at the viewer).
 */
const SHOTS: Record<Framing, { top: number; bottom: number; halfWidth: number; camY: number; shadow: [number, number, number] }> = {
  // head and shoulders: close-up for lip reading
  portrait: { top: 0.21, bottom: -0.35, halfWidth: 0.22, camY: -0.03, shadow: [0.5, 0.5, -0.5] },
  // mid-thigh up: every gesture and the hands at rest. Measured over all body clips: fingertips
  // reach 0.9 m below the eyes at rest and 0.5 m to the side (a little more when moved toward the camera).
  upper: { top: 0.2, bottom: -0.98, halfWidth: 0.57, camY: -0.02, shadow: [0.72, 0.45, -0.95] },
};

function backdropTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 16;
  c.height = 512;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, "#2b3240");
  grad.addColorStop(0.55, "#1c2029");
  grad.addColorStop(1, "#121419");
  g.fillStyle = grad;
  g.fillRect(0, 0, 16, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Renderer, camera, studio lighting (3-point + soft environment) and framing. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50);
  readonly key: THREE.DirectionalLight;
  framing: Framing = "upper";
  private focus = new THREE.Vector3(0, 1.6, 0);
  private insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  private size = { width: 1, height: 1 };
  private sized = false;
  /** Camera placement now (view) and what the framing asks for (viewTarget); see update(). */
  private view = { dist: 3, offX: 0, offY: 0, camY: 1.6 };
  private viewTarget = { dist: 3, offX: 0, offY: 0, camY: 1.6 };
  private settled = false;
  private readonly smooth: boolean;
  private readonly fixedSize?: { width: number; height: number };

  constructor(private container: HTMLElement, opts: { capture?: boolean; width?: number; height?: number } = {}) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: !!opts.capture,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(opts.capture ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    if (opts.width && opts.height) this.fixedSize = { width: opts.width, height: opts.height };
    this.smooth = !opts.capture; // capture renders must be exactly reproducible

    this.scene.background = backdropTexture();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;

    this.key = new THREE.DirectionalLight(0xfff0e4, 2.3);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    const sc = this.key.shadow.camera; // extents are set per framing in updateCamera()
    sc.near = 0.1;
    sc.far = 8;
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.015;
    this.key.shadow.radius = 4;
    const fill = new THREE.DirectionalLight(0xdde6ff, 0.75);
    const rim = new THREE.DirectionalLight(0xfff6ee, 1.5);
    const hemi = new THREE.HemisphereLight(0xfaf6f2, 0x3a3532, 0.35);
    this.scene.add(this.key, this.key.target, fill, fill.target, rim, rim.target, hemi);
    this.lights = { fill, rim };

    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  private lights: { fill: THREE.DirectionalLight; rim: THREE.DirectionalLight };

  /** Frame the camera on a point between the eyes (world) and place lights relative to it. */
  setFocus(eyes: THREE.Vector3) {
    this.focus.copy(eyes);
    const f = this.focus;
    this.key.position.set(f.x - 1.1, f.y + 1.2, f.z + 2.0);
    this.key.target.position.copy(f).add(new THREE.Vector3(0, -0.15, 0));
    this.lights.fill.position.set(f.x + 1.6, f.y + 0.3, f.z + 1.4);
    this.lights.fill.target.position.copy(f);
    this.lights.rim.position.set(f.x + 0.6, f.y + 1.4, f.z - 2.0);
    this.lights.rim.target.position.copy(f);
    this.updateCamera();
  }

  setFraming(framing: Framing) {
    this.framing = framing;
    this.updateCamera();
  }

  /** Keep the avatar inside the part of the screen that the UI (panel, subtitles) leaves free. */
  setInsets(insets: Insets) {
    const i = this.insets;
    if (i.top === insets.top && i.right === insets.right && i.bottom === insets.bottom && i.left === insets.left) return;
    this.insets = { ...insets };
    this.updateCamera();
  }

  private updateCamera() {
    const f = this.focus;
    const s = SHOTS[this.framing];
    const { width: W, height: H } = this.size;
    const { top, right, bottom, left } = this.insets;
    // the free area (never smaller than half the screen, in case the UI covers nearly everything)
    const vw = Math.max(W * 0.5, W - left - right);
    const vh = Math.max(H * 0.5, H - top - bottom);
    // scale: the shot's box fills the free area; the distance follows from the field of view
    const ppm = Math.min(vh / (s.top - s.bottom), vw / (2 * s.halfWidth)); // CSS px per metre at her depth
    const dist = H / (2 * ppm * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    const camY = f.y + s.camY;
    // lens shift (no tilt): centre the box horizontally in the free area; spare height goes mostly
    // below her (subtitles live there, e.g. on tall phone screens)
    const boxY = H / 2 + (camY - (f.y + (s.top + s.bottom) / 2)) * ppm;
    const boxH = (s.top - s.bottom) * ppm;
    const freeX = Math.min(left, W - vw) + vw / 2;
    const freeY = Math.min(top, H - vh) + Math.max(0, vh - boxH) * 0.3 + boxH / 2;
    this.viewTarget = { dist, offX: W / 2 - freeX, offY: boxY - freeY, camY };
    if (!this.smooth || !this.settled) Object.assign(this.view, this.viewTarget);
    this.applyView();

    // shadow map covers the framed body
    const [half, up, down] = s.shadow;
    const sc = this.key.shadow.camera;
    sc.left = -half;
    sc.right = half;
    sc.top = up;
    sc.bottom = down;
    sc.updateProjectionMatrix();
  }

  /**
   * Eases the camera toward the current framing; call once per frame. Framing changes (UI panels
   * opening, camera option, window size) then glide instead of jumping.
   */
  update(dt: number) {
    const v = this.view;
    const t = this.viewTarget;
    if (v.dist === t.dist && v.offX === t.offX && v.offY === t.offY && v.camY === t.camY) {
      this.settled = true;
      return;
    }
    const close = Math.abs(v.dist - t.dist) < 1e-4 && Math.abs(v.offX - t.offX) < 0.05 && Math.abs(v.offY - t.offY) < 0.05 && Math.abs(v.camY - t.camY) < 1e-5;
    if (close || !this.settled) Object.assign(v, t);
    else for (const k of ["dist", "offX", "offY", "camY"] as const) v[k] = damp(v[k], t[k], 0.12, dt);
    this.settled = true;
    this.applyView();
  }

  private applyView() {
    const { width: W, height: H } = this.size;
    const f = this.focus;
    const v = this.view;
    this.camera.position.set(f.x, v.camY, f.z + v.dist);
    this.camera.lookAt(f.x, v.camY, f.z);
    this.camera.setViewOffset(W, H, v.offX, v.offY, W, H);
    this.camera.updateMatrixWorld();
  }

  resize() {
    const w = Math.max(1, this.fixedSize?.width ?? this.container.clientWidth);
    const h = Math.max(1, this.fixedSize?.height ?? this.container.clientHeight);
    const pr = this.fixedSize ? 1 : Math.min(window.devicePixelRatio, 2);
    // resizing the canvas clears it, so only do it when something really changed (mobile
    // browsers fire resize for many reasons, e.g. the on-screen keyboard)
    if (this.sized && w === this.size.width && h === this.size.height && pr === this.renderer.getPixelRatio()) return;
    this.sized = true;
    this.size = { width: w, height: h };
    if (!this.fixedSize) this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, !this.fixedSize);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.updateCamera();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
