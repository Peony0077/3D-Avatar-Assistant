import * as THREE from "three";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/** Bone names in the Rocketbox Biped rig (three.js replaces spaces with underscores). */
export const BONES = {
  pelvis: "Bip01_Pelvis",
  spine1: "Bip01_Spine1",
  spine2: "Bip01_Spine2",
  neck: "Bip01_Neck",
  head: "Bip01_Head",
  leftEye: "Bip01_LEye",
  rightEye: "Bip01_REye",
} as const;

type BoneKey = keyof typeof BONES;

interface MorphSlot {
  mesh: THREE.Mesh;
  index: number;
}

/** Loaded avatar: meshes, morph-target index, key bones and animation clips. */
export class AvatarModel {
  readonly root: THREE.Object3D;
  readonly meshes: THREE.Mesh[] = [];
  readonly clips: THREE.AnimationClip[];
  readonly bones = {} as Record<BoneKey, THREE.Bone>;
  /** Rest-pose local rotations of bones we drive procedurally. */
  readonly restLocal = {} as Record<BoneKey, THREE.Quaternion>;
  /** World rotation of the head bone in the rest pose (defines the head's "neutral" frame). */
  readonly headRestWorld = new THREE.Quaternion();
  private readonly morphs = new Map<string, MorphSlot[]>();

  constructor(gltf: { scene: THREE.Object3D; animations: THREE.AnimationClip[] }) {
    this.root = gltf.scene;
    this.clips = gltf.animations;
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        this.meshes.push(m);
        m.frustumCulled = false; // skinned + morphed bounds are unreliable
        const dict = m.morphTargetDictionary;
        if (dict) {
          for (const [name, index] of Object.entries(dict)) {
            const list = this.morphs.get(name) ?? [];
            list.push({ mesh: m, index });
            this.morphs.set(name, list);
          }
        }
      }
    });
    for (const [key, name] of Object.entries(BONES) as Array<[BoneKey, string]>) {
      const bone = this.root.getObjectByName(name) as THREE.Bone | undefined;
      if (!bone) throw new Error(`Avatar is missing bone ${name}`);
      this.bones[key] = bone;
      this.restLocal[key] = bone.quaternion.clone();
    }
    this.root.updateMatrixWorld(true);
    this.bones.head.getWorldQuaternion(this.headRestWorld);
  }

  get morphNames(): string[] {
    return [...this.morphs.keys()];
  }

  hasMorph(name: string) {
    return this.morphs.has(name);
  }

  setMorph(name: string, value: number) {
    const slots = this.morphs.get(name);
    if (!slots) return;
    for (const s of slots) s.mesh.morphTargetInfluences![s.index] = value;
  }

  /** Mesh by its material name: Skin, Body, Hair, Eyes, Mouth, Teeth, Tongue. */
  part(materialName: string): THREE.Mesh | undefined {
    return this.meshes.find((m) => (m.material as THREE.Material).name === materialName);
  }
}

export async function loadAvatar(url: string, onProgress?: (fraction: number) => void): Promise<AvatarModel> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder); // avatar.glb is meshopt-compressed by gltfpack
  const gltf = await loader.loadAsync(url, (e) => {
    if (onProgress && e.total) onProgress(e.loaded / e.total);
  });
  return new AvatarModel(gltf);
}
