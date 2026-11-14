import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export type Framing = "portrait" | "upper";

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
  framing: Framing = "portrait";
  private focus = new THREE.Vector3(0, 1.6, 0);
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

    this.scene.background = backdropTexture();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;

    this.key = new THREE.DirectionalLight(0xfff0e4, 2.3);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    const sc = this.key.shadow.camera;
    sc.left = sc.bottom = -0.5;
    sc.right = sc.top = 0.5;
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

  private updateCamera() {
    const f = this.focus;
    // visible height / width to fit, and where the frame is centred relative to the eyes
    const [h, w, drop] = this.framing === "portrait" ? [0.56, 0.44, 0.07] : [1.0, 0.8, 0.33];
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const dist = Math.max(h / 2 / Math.tan(vfov / 2), w / 2 / Math.tan(hfov / 2));
    const center = new THREE.Vector3(f.x, f.y - drop, f.z);
    this.camera.position.set(center.x, center.y + 0.04, center.z + dist);
    this.camera.lookAt(center);
    this.camera.updateMatrixWorld();
  }

  resize() {
    const w = this.fixedSize?.width ?? this.container.clientWidth;
    const h = this.fixedSize?.height ?? this.container.clientHeight;
    this.renderer.setSize(w, h, !this.fixedSize);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.updateCamera();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
