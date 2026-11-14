import * as THREE from "three";
import type { AvatarModel } from "./AvatarModel";

const DIFFUSE_LINE = "reflectedLight.directDiffuse += irradiance * diffuseBRDF * ( 1.0 - F );";
const SKIN_DIFFUSE = /* glsl */ `
	{
		// Skin: wrapped diffuse with a red-shifted wrap (cheap subsurface-scattering look).
		float skinNdl = dot( geometryNormal, directLight.direction );
		vec3 skinWrap = vec3( 0.46, 0.24, 0.17 );
		vec3 skinIrr = clamp( ( vec3( skinNdl ) + skinWrap ) / ( 1.0 + skinWrap ), 0.0, 1.0 ) * directLight.color;
		reflectedLight.directDiffuse += skinIrr * diffuseBRDF * ( 1.0 - F );
	}`;

let warnedPatch = false;

function toPhysical(m: THREE.Material): THREE.MeshPhysicalMaterial {
  if ((m as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) return m as THREE.MeshPhysicalMaterial;
  const s = m as THREE.MeshStandardMaterial;
  const p = new THREE.MeshPhysicalMaterial();
  THREE.MeshStandardMaterial.prototype.copy.call(p, s);
  p.name = s.name;
  return p;
}

function makeSkin(m: THREE.Material): THREE.MeshPhysicalMaterial {
  const p = toPhysical(m);
  p.sheen = 0.25;
  p.sheenColor = new THREE.Color(0.85, 0.42, 0.36);
  p.sheenRoughness = 0.7;
  p.envMapIntensity = 0.55;
  p.onBeforeCompile = (shader) => {
    const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
    if (!chunk.includes(DIFFUSE_LINE)) {
      if (!warnedPatch) console.warn("Skin shader patch target not found; using standard lighting.");
      warnedPatch = true;
      return;
    }
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <lights_physical_pars_fragment>",
      chunk.replace(DIFFUSE_LINE, SKIN_DIFFUSE),
    );
  };
  p.customProgramCacheKey = () => "avatar-skin";
  return p;
}

export interface MouthMaterials {
  teeth?: THREE.MeshStandardMaterial;
  tongue?: THREE.MeshStandardMaterial;
  cavity?: THREE.MeshStandardMaterial;
  teethBase: THREE.Color;
  tongueBase: THREE.Color;
  cavityBase: THREE.Color;
}

/** Configure avatar materials for realistic real-time rendering. */
export function setupMaterials(model: AvatarModel): MouthMaterials {
  const mouth: MouthMaterials = {
    teethBase: new THREE.Color(1.0, 0.94, 0.86),
    tongueBase: new THREE.Color(0.95, 0.8, 0.8),
    cavityBase: new THREE.Color(0.36, 0.1, 0.1),
  };
  for (const mesh of model.meshes) {
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const name = mat.name; // parts are identified by material (mesh names are not kept by gltfpack)
    mesh.castShadow = name === "Skin" || name === "Body" || name === "Hair";
    mesh.receiveShadow = true;
    switch (name) {
      case "Skin":
      case "Body":
        mesh.material = makeSkin(mat);
        break;
      case "Hair": {
        mat.transparent = false;
        mat.alphaToCoverage = true;
        mat.alphaTest = 0.08;
        mat.depthWrite = true;
        mat.side = THREE.DoubleSide;
        mat.envMapIntensity = 0.4;
        mesh.renderOrder = 1;
        break;
      }
      case "Eyes": {
        const p = toPhysical(mat);
        p.roughness = 0.12;
        p.clearcoat = 1;
        p.clearcoatRoughness = 0.03;
        p.envMapIntensity = 1.2;
        mesh.material = p;
        mesh.castShadow = false;
        break;
      }
      case "Teeth":
        mat.roughness = 0.38;
        mat.envMapIntensity = 0.2;
        mat.color.copy(mouth.teethBase);
        mouth.teeth = mat;
        mesh.castShadow = false;
        break;
      case "Tongue":
        mat.roughness = 0.45;
        mat.envMapIntensity = 0.35;
        mat.color.copy(mouth.tongueBase);
        mouth.tongue = mat;
        mesh.castShadow = false;
        break;
      case "Mouth":
        mat.roughness = 0.6;
        mat.envMapIntensity = 0.15;
        mat.color.copy(mouth.cavityBase);
        mouth.cavity = mat;
        mesh.castShadow = false;
        break;
    }
  }
  return mouth;
}

/**
 * Mouth occlusion: the inside of a barely-open mouth receives almost no light. Without this,
 * teeth glow behind slightly parted lips. `open` is 0 (closed) .. 1 (wide).
 */
export function updateMouthOcclusion(m: MouthMaterials, open: number) {
  const k = 0.35 + 0.65 * Math.min(1, open * 1.8);
  m.teeth?.color.copy(m.teethBase).multiplyScalar(k);
  m.tongue?.color.copy(m.tongueBase).multiplyScalar(0.25 + 0.75 * Math.min(1, open * 1.6));
  m.cavity?.color.copy(m.cavityBase).multiplyScalar(0.4 + 0.6 * Math.min(1, open * 1.5));
}
