"""Build the web-ready avatar GLB from Microsoft Rocketbox Female_Adult_01 (MIT licence).

Run (from the repo root, after `node tools/fetch-assets.mjs`):
    blender -b --factory-startup -noaudio --python tools/blender/build_avatar.py -- \
        --src assets-src/rocketbox --out public/avatar/avatar.glb

What it does
  1. Imports the "_facial" FBX (Biped skeleton + 176 facial blend shapes).
  2. Keeps the lip-sync / expression set under standard names:
       15 Oculus visemes  -> viseme_sil, viseme_PP, ... viseme_U
       52 ARKit shapes     -> browDownLeft, ... tongueOut
     and adds two lid-only helpers (eyesLookUp / eyesLookDown) so eyelids can follow
     bone-driven eye rotation without rotating the eyeballs twice.
  3. Splits the single mesh into Body / Head / Hair / Eyes / Mouth so each part gets a
     suitable material (skin, alpha-tested hair cards, glossy eyes, mouth interior).
  4. Converts the specular maps into roughness maps.
  5. Retargets selected Rocketbox female mocap clips (in-place versions) onto the avatar
     by copying each body bone's parent-relative rotation (rest poses differ between files).
  6. Exports one GLB with skinning, morph targets (+normals) and all clips.
"""
import argparse
import math
import os
import re
import sys

import bpy
import numpy as np
from mathutils import Matrix, Quaternion

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--src", default="assets-src/rocketbox")
ap.add_argument("--out", default="public/avatar/avatar.glb")
ap.add_argument("--blend", default="", help="optional .blend to save for inspection")
ap.add_argument("--no-anim", action="store_true")
args = ap.parse_args(argv)

SRC = os.path.abspath(args.src)
OUT = os.path.abspath(args.out)
TEX = os.path.join(SRC, "avatar", "Textures")
FBX = os.path.join(SRC, "avatar", "Export", "Female_Adult_01_facial.fbx")
ANIM_DIR = os.path.join(SRC, "animations")

# clip name in GLB  <-  Rocketbox file stem
CLIPS = {
    "idle_breathe_01": "f_idle_breathe_01",
    "idle_breathe_02": "f_idle_breathe_02",
    "idle_neutral_01": "f_idle_neutral_01",
    "idle_neutral_02": "f_idle_neutral_02",
    "talk_neutral_01": "f_gestic_talk_neutral_01",
    "talk_neutral_02": "f_gestic_talk_neutral_02",
    "talk_relaxed_01": "f_gestic_talk_relaxed_01",
    "talk_relaxed_02": "f_gestic_talk_relaxed_02",
    "listen_neutral_01": "f_gestic_listen_neutral_01",
    "listen_neutral_02": "f_gestic_listen_neutral_02",
    "listen_accept_01": "f_gestic_listen_accept_01",
    "listen_accept_02": "f_gestic_listen_accept_02",
}

VISEMES = {"Sil": "sil", "PP": "PP", "FF": "FF", "TH": "TH", "DD": "DD", "KK": "kk", "CH": "CH", "SS": "SS",
           "nn": "nn", "RR": "RR", "aa": "aa", "E": "E", "I": "I", "O": "O", "U": "U"}
ARKIT = ["browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight", "cheekPuff",
         "cheekSquintLeft", "cheekSquintRight", "eyeBlinkLeft", "eyeBlinkRight", "eyeLookDownLeft", "eyeLookDownRight",
         "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight", "eyeLookUpLeft", "eyeLookUpRight",
         "eyeSquintLeft", "eyeSquintRight", "eyeWideLeft", "eyeWideRight", "jawForward", "jawLeft", "jawOpen", "jawRight",
         "mouthClose", "mouthDimpleLeft", "mouthDimpleRight", "mouthFrownLeft", "mouthFrownRight", "mouthFunnel",
         "mouthLeft", "mouthLowerDownLeft", "mouthLowerDownRight", "mouthPressLeft", "mouthPressRight", "mouthPucker",
         "mouthRight", "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper", "mouthSmileLeft",
         "mouthSmileRight", "mouthStretchLeft", "mouthStretchRight", "mouthUpperUpLeft", "mouthUpperUpRight",
         "noseSneerLeft", "noseSneerRight", "tongueOut"]

# Facial bones are driven procedurally at runtime (eyes) or by blend shapes; only body bones get mocap.
FACE_BONE = re.compile(r"Bip01 (R|L|M)(Eye|Jaw|BottomLip|Tongue|MouthBottom|Masseter|UpperLip|Caninus|Upperlip|"
                       r"MouthCorner|Cheek|InnerEyebrow|MiddleEyebrow|OuterEyebrow|Nose)")

PART_BODY, PART_HEAD, PART_HAIR, PART_EYES, PART_MOUTH = range(5)
PART_NAMES = ["Body", "Head", "Hair", "Eyes", "Mouth"]


def log(*a):
    print("[build_avatar]", *a, flush=True)


# ----------------------------------------------------------------------------------------------- import
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.render.fps = 30
bpy.ops.import_scene.fbx(filepath=FBX, use_anim=False)
arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
mesh = next(o for o in bpy.context.scene.objects if o.type == "MESH")
for o in list(bpy.context.scene.objects):
    if o not in (arm, mesh):
        bpy.data.objects.remove(o, do_unlink=True)
arm.name, arm.data.name = "Avatar", "AvatarRig"
log("imported", mesh.name, len(mesh.data.vertices), "verts,", len(arm.data.bones), "bones")

# ----------------------------------------------------------------------------------------- shape keys
keys = mesh.data.shape_keys.key_blocks
for kb in list(keys)[1:]:
    m = re.match(r"AA_VI_\d+_(\w+)$", kb.name)
    if m and m.group(1) in VISEMES:
        kb.name = "viseme_" + VISEMES[m.group(1)]
        continue
    m = re.match(r"AK_\d+_(\w+)$", kb.name)
    if m:
        kb.name = m.group(1)[0].lower() + m.group(1)[1:]
        continue
    mesh.shape_key_remove(kb)
names = {kb.name for kb in mesh.data.shape_keys.key_blocks}
missing = [f"viseme_{v}" for v in VISEMES.values() if f"viseme_{v}" not in names] + [a for a in ARKIT if a not in names]
assert not missing, f"missing shape keys: {missing}"

def classify(obj):
    """Per-polygon part: original material (body / head / opacity) + the interior UV island of the
    head texture (teeth, gums, tongue, eyeballs) split into eyes vs mouth by dominant bone."""
    me = obj.data
    uv = me.uv_layers.active.data
    vg_name = {g.index: g.name for g in obj.vertex_groups}
    dom = [vg_name[max(v.groups, key=lambda g: g.weight).group] if v.groups else "" for v in me.vertices]
    mw = obj.matrix_world
    out = []
    for p in me.polygons:
        if p.material_index == 0:
            out.append(PART_BODY)
        elif p.material_index == 2:
            out.append(PART_HAIR)
        else:
            cu = sum(uv[i].uv.x for i in p.loop_indices) / p.loop_total
            cv = sum(uv[i].uv.y for i in p.loop_indices) / p.loop_total
            cw = mw @ p.center
            # a few neck polygons share the interior UV area, so also require the face region
            if cu < 0.36 and cv < 0.38 and cw.z > 1.50 and abs(cw.x) < 0.05:
                bones = [dom[i] for i in p.vertices]
                eye = sum(b in ("Bip01 LEye", "Bip01 REye") for b in bones) > len(bones) / 2
                out.append(PART_EYES if eye else PART_MOUTH)
            else:
                out.append(PART_HEAD)
    return out


me = mesh.data
poly_part = classify(mesh)
eyeball_verts = {i for p, part in zip(me.polygons, poly_part) if part == PART_EYES for i in p.vertices}

# Lid-only gaze helpers: both eyes' look-up / look-down, with eyeball movement removed.
basis = np.empty(len(me.vertices) * 3, dtype=np.float32)
keys[0].data.foreach_get("co", basis)
basis = basis.reshape(-1, 3)
eyeball_mask = np.zeros(len(me.vertices), dtype=bool)
eyeball_mask[list(eyeball_verts)] = True
for new, (l, r) in {"eyesLookUp": ("eyeLookUpLeft", "eyeLookUpRight"),
                    "eyesLookDown": ("eyeLookDownLeft", "eyeLookDownRight")}.items():
    delta = np.zeros_like(basis)
    for src in (l, r):
        co = np.empty_like(basis.ravel())
        keys[src].data.foreach_get("co", co)
        delta += co.reshape(-1, 3) - basis
    delta[eyeball_mask] = 0.0
    kb = mesh.shape_key_add(name=new, from_mix=False)
    kb.data.foreach_set("co", (basis + delta).ravel())
log("shape keys:", len(mesh.data.shape_keys.key_blocks) - 1, "(15 visemes + 52 ARKit + 2 lid helpers)")


# -------------------------------------------------------------------------------------- subdivision
def subdivide_with_shape_keys(obj, levels=1):
    """Catmull-Clark subdivision that keeps every shape key: the subdivided mesh is evaluated once
    per key (topology is identical), and the results become the new shape keys. Removes the
    faceted silhouette of the 2010-era low-poly game mesh (jaw line, ears, collar, eyeballs)."""
    kbs = obj.data.shape_keys.key_blocks
    names = [kb.name for kb in kbs]
    for kb in kbs:
        kb.value = 0.0
    for m in obj.modifiers:
        m.show_viewport = False  # evaluate in rest pose, without the armature
    sub = obj.modifiers.new("Subdivide", "SUBSURF")
    sub.levels = sub.render_levels = levels
    sub.uv_smooth = "PRESERVE_BOUNDARIES"
    sub.boundary_smooth = "ALL"
    view_layer = bpy.context.view_layer

    def evaluated_coords():
        view_layer.update()
        ev = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
        m = ev.to_mesh()
        co = np.empty(len(m.vertices) * 3, dtype=np.float32)
        m.vertices.foreach_get("co", co)
        ev.to_mesh_clear()
        return co

    view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    new_mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    coords = {}
    for kb in list(kbs)[1:]:
        kb.value = 1.0
        coords[kb.name] = evaluated_coords()
        kb.value = 0.0
    obj.modifiers.remove(sub)
    for m in obj.modifiers:
        m.show_viewport = True
    old = obj.data
    obj.shape_key_clear()
    obj.data = new_mesh
    bpy.data.meshes.remove(old)
    obj.shape_key_add(name="Basis", from_mix=False)
    base = np.empty(len(new_mesh.vertices) * 3, dtype=np.float32)
    new_mesh.vertices.foreach_get("co", base)
    for name in names[1:]:
        co = coords[name]
        # snap evaluation noise to exactly zero so unchanged vertices export as sparse morph data
        moved = np.abs(co - base).reshape(-1, 3).max(axis=1) > 2e-6
        co = np.where(np.repeat(moved, 3), co, base)
        kb = obj.shape_key_add(name=name, from_mix=False)
        kb.data.foreach_set("co", co)
    obj.data.polygons.foreach_set("use_smooth", [True] * len(obj.data.polygons))
    obj.data.update()


n_before = len(mesh.data.vertices)
subdivide_with_shape_keys(mesh, 1)
me = mesh.data
poly_part = classify(mesh)
log(f"subdivided: {n_before} -> {len(me.vertices)} verts, {len(me.shape_keys.key_blocks) - 1} shape keys kept")

# ------------------------------------------------------------------------------------------ materials
def load_img(name, non_color=False):
    img = bpy.data.images.load(os.path.join(TEX, name), check_existing=True)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    return img


def roughness_from_specular(spec_name, out_name, lo=0.36, hi=0.68):
    """Bright specular texels -> low roughness. Robust-normalised so the whole range is used."""
    spec = load_img(spec_name, non_color=True)
    px = np.empty(spec.size[0] * spec.size[1] * 4, dtype=np.float32)
    spec.pixels.foreach_get(px)
    px = px.reshape(-1, 4)
    lum = px[:, :3].mean(axis=1)
    a, b = np.percentile(lum, 2), np.percentile(lum, 98)
    t = np.clip((lum - a) / max(b - a, 1e-4), 0, 1)
    rough = hi - (hi - lo) * t
    out = bpy.data.images.new(out_name, spec.size[0], spec.size[1], alpha=False)
    out.colorspace_settings.name = "Non-Color"
    rgba = np.stack([rough, rough, rough, np.ones_like(rough)], axis=1).ravel()
    out.pixels.foreach_set(rgba)
    out.pack()
    return out


def make_material(name, color=None, normal=None, rough_img=None, roughness=0.5, alpha=False, coat=0.0,
                  specular=0.5):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Specular IOR Level"].default_value = specular
    if color:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = color
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        if alpha:
            nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
            mat.surface_render_method = "DITHERED"
    if normal:
        nt_tex = nt.nodes.new("ShaderNodeTexImage")
        nt_tex.image = normal
        nmap = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(nt_tex.outputs["Color"], nmap.inputs["Color"])
        nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    if rough_img:
        r_tex = nt.nodes.new("ShaderNodeTexImage")
        r_tex.image = rough_img
        nt.links.new(r_tex.outputs["Color"], bsdf.inputs["Roughness"])
    if coat > 0:
        bsdf.inputs["Coat Weight"].default_value = coat
        bsdf.inputs["Coat Roughness"].default_value = 0.03
    return mat


def image_array(img):
    a = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(img.size[1], img.size[0], 4)


def match_body_skin_to_head(me, parts, head_img, body_img):
    """The head and body textures of this model differ in skin tone, which shows as a line across
    the neck. Measure both textures along the shared seam and colour-correct only skin-coloured
    pixels of the body texture (chest, arms, hands), leaving clothes untouched."""
    uvl = me.uv_layers.active.data
    head_uv, body_uv = {}, {}
    for p, part in zip(me.polygons, parts):
        if part in (PART_HEAD, PART_BODY):
            d = head_uv if part == PART_HEAD else body_uv
            for li, vi in zip(p.loop_indices, p.vertices):
                d.setdefault(vi, tuple(uvl[li].uv))
    seam = [v for v in head_uv if v in body_uv]
    if len(seam) < 8:
        log("skin match: no head/body seam found, skipped")
        return body_img
    H, B = image_array(head_img), image_array(body_img)

    def sample(img, uvs, r=4):
        h, w = img.shape[:2]
        cols = []
        for u, v in uvs:
            x, y = int(u * (w - 1)), int(v * (h - 1))
            patch = img[max(0, y - r):y + r + 1, max(0, x - r):x + r + 1, :3]
            cols.append(patch.reshape(-1, 3).mean(0))
        return np.median(np.array(cols), axis=0)

    hc = sample(H, [head_uv[v] for v in seam])
    # part of the head/body boundary runs along the shirt collar: keep only seam points where the
    # body texture is skin-coloured (close to the head's neck colour)
    skin_seam = [v for v in seam if np.linalg.norm(sample(B, [body_uv[v]]) - hc) < 0.3]
    if len(skin_seam) < 6:
        log(f"skin match: only {len(skin_seam)} skin seam points, skipped")
        return body_img
    bc = sample(B, [body_uv[v] for v in skin_seam])
    gain = np.clip(hc / np.maximum(bc, 1e-3), 0.8, 1.25)
    dist = np.linalg.norm(B[..., :3] - bc, axis=-1)
    mask = np.clip(1 - dist / 0.22, 0, 1) ** 1.5
    B[..., :3] = np.clip(B[..., :3] * (1 + mask[..., None] * (gain - 1)), 0, 1)
    out = bpy.data.images.new("f001_body_color_matched", body_img.size[0], body_img.size[1], alpha=False)
    out.pixels.foreach_set(B.ravel())
    out.pack()
    log(f"skin match: seam head {np.round(hc, 3)} body {np.round(bc, 3)} -> gain {np.round(gain, 3)}, "
        f"{(mask > 0.5).mean() * 100:.1f}% of body texture is skin")
    return out


head_color = load_img("f001_head_color.tga")
head_normal = load_img("f001_head_normal.tga", non_color=True)
body_color = match_body_skin_to_head(me, poly_part, head_color, load_img("f001_body_color.tga"))
body_normal = load_img("f001_body_normal.tga", non_color=True)
hair_color = load_img("f001_opacity_color.tga")

mats = [
    make_material("Body", body_color, body_normal, roughness_from_specular("f001_body_specular.tga", "f001_body_rough")),
    make_material("Skin", head_color, head_normal, roughness_from_specular("f001_head_specular.tga", "f001_head_rough")),
    make_material("Hair", hair_color, None, None, roughness=0.55, alpha=True, specular=0.35),
    make_material("Eyes", head_color, None, None, roughness=0.12, coat=1.0, specular=0.6),
    make_material("Mouth", head_color, head_normal, None, roughness=0.32, specular=0.6),
]
me.materials.clear()
for m in mats:
    me.materials.append(m)
for p, part in zip(me.polygons, poly_part):
    p.material_index = part

# ---------------------------------------------------------------------------------------------- split
bpy.context.view_layer.objects.active = mesh
mesh.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.separate(type="MATERIAL")
bpy.ops.object.mode_set(mode="OBJECT")
parts = [o for o in bpy.context.scene.objects if o.type == "MESH"]
for o in parts:
    mat = o.data.materials[o.data.polygons[0].material_index].name
    o.name = o.data.name = {"Skin": "Head"}.get(mat, mat)
    # keep only this part's material slot
    keep = o.data.materials[o.data.polygons[0].material_index]
    o.data.materials.clear()
    o.data.materials.append(keep)
    o.data.polygons.foreach_set("material_index", [0] * len(o.data.polygons))
    # drop shape keys that do not move this part
    kbs = o.data.shape_keys.key_blocks
    b = np.empty(len(o.data.vertices) * 3, dtype=np.float32)
    kbs[0].data.foreach_get("co", b)
    for kb in list(kbs)[1:]:
        c = np.empty_like(b)
        kb.data.foreach_get("co", c)
        if np.abs(c - b).max() < 1e-4:
            o.shape_key_remove(kb)
    n = len(o.data.shape_keys.key_blocks) - 1 if o.data.shape_keys else 0
    if n == 0 and o.data.shape_keys:
        o.shape_key_clear()
    log(f"part {o.name:6s} verts={len(o.data.vertices):5d} morphs={n}")

# ------------------------------------------------------------------------------- teeth and tongue
# The Rocketbox mouth is a low-poly box with painted teeth, which reads as a black hole on open
# vowels. Replace the painted teeth / box tongue with CC0 MakeHuman teeth + tongue, fitted behind
# the lips, and give them blend shapes that reproduce the original jaw / tongue motion of every
# shape key (rigid fit per key, Kabsch).
MH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "makehuman")
TEETH_FRONT_Y = float(os.environ.get("TEETH_FRONT_Y", -0.0462))  # incisor front, ~3 mm behind the lips (avatar faces -Y)
BITE_Z = float(os.environ.get("BITE_Z", 1.5486))                 # bite plane, just below the lip line (z = 1.549)
TEETH_SCALE = float(os.environ.get("TEETH_SCALE", 0.088))        # MakeHuman units (dm) -> m (arch ~4.2 cm wide)
TONGUE_TIP = (0.0, -0.0415, 1.5420)  # tip rests behind the lower incisors (where the original tongue was)
TONGUE_SCALE = 0.075      # ~3.8 cm wide, fits inside the lower arch


def kabsch(P, Q):
    """Rigid transform (R, t) minimising |R @ p + t - q|."""
    cp, cq = P.mean(0), Q.mean(0)
    U, _, Vt = np.linalg.svd((P - cp).T @ (Q - cq))
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    R = Vt.T @ np.diag([1.0, 1.0, d]) @ U.T
    return R, cq - R @ cp


def world_coords(obj, flat):
    m = np.array(obj.matrix_world)
    return flat.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]


def add_teeth_and_tongue(mouth, head):
    gi = {g.index: g.name for g in mouth.vertex_groups}
    dom = [gi[max(v.groups, key=lambda g: g.weight).group] if v.groups else "" for v in mouth.data.vertices]
    jaw_idx = np.array([i for i, d in enumerate(dom) if d == "Bip01 MJaw"])
    tng_idx = np.array([i for i, d in enumerate(dom) if d == "Bip01 MTongue"])
    kbs = mouth.data.shape_keys.key_blocks
    n = len(mouth.data.vertices)
    base = np.empty(n * 3, dtype=np.float64)
    kbs[0].data.foreach_get("co", base)
    W0 = world_coords(mouth, base)
    motions = {}
    for kb in list(kbs)[1:]:
        co = np.empty(n * 3, dtype=np.float64)
        kb.data.foreach_get("co", co)
        W = world_coords(mouth, co)
        motions[kb.name] = (kabsch(W0[jaw_idx], W[jaw_idx]), kabsch(W0[tng_idx], W[tng_idx]))

    # remove the old box tongue
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = mouth
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="DESELECT")
    bpy.ops.object.mode_set(mode="OBJECT")
    for i in tng_idx:
        mouth.data.vertices[int(i)].select = True
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.delete(type="VERT")
    bpy.ops.object.mode_set(mode="OBJECT")

    # import CC0 teeth + tongue (same MakeHuman coordinate frame, so their relative fit is preserved)
    def import_obj(name):
        bpy.ops.object.select_all(action="DESELECT")
        bpy.ops.wm.obj_import(filepath=os.path.join(MH, name))
        o = bpy.context.selected_objects[0]
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)  # bake OBJ axis conversion
        o.data.materials.clear()
        return o

    teeth, tongue = import_obj("teeth_base.obj"), import_obj("tongue01.obj")
    T = np.array([v.co[:] for v in teeth.data.vertices])
    G = np.array([v.co[:] for v in tongue.data.vertices])

    # split teeth into upper/lower by the bite plane between the 16 upper and 16 lower teeth
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(teeth.data)
    bm.verts.ensure_lookup_table()
    seen, comps = set(), []
    for v in bm.verts:
        if v.index in seen:
            continue
        stack, comp = [v], []
        while stack:
            x = stack.pop()
            if x.index in seen:
                continue
            seen.add(x.index)
            comp.append(x.index)
            stack.extend(e.other_vert(x) for e in x.link_edges)
        comps.append(comp)
    bm.free()
    tooth_parts = [c for c in comps if len(c) < 500]
    cz = sorted(T[c, 2].mean() for c in tooth_parts)
    gaps = np.diff(cz)
    k = int(np.argmax(gaps))
    bite_mh = (cz[k] + cz[k + 1]) / 2
    tooth_verts = np.array([i for c in tooth_parts for i in c])
    front_mh = T[tooth_verts, 1].min()
    # Each tooth moves as a whole (upper incisors overlap the lower ones, so a per-vertex height
    # test would drag their tips down with the jaw); only the gum mesh is split per vertex.
    lower = T[:, 2] < bite_mh
    for c in tooth_parts:
        lower[c] = T[c, 2].mean() < bite_mh
    # The gum mesh joins upper and lower gums at the back; those joining faces would stretch into a
    # visible strip when the jaw opens, so remove them (vertices are kept, indices stay valid).
    bm = bmesh.new()
    bm.from_mesh(teeth.data)
    bm.verts.ensure_lookup_table()
    mixed = [f for f in bm.faces if len({bool(lower[v.index]) for v in f.verts}) > 1]
    bmesh.ops.delete(bm, geom=mixed, context="FACES_ONLY")
    bm.to_mesh(teeth.data)
    bm.free()
    log(f"teeth: {int(lower.sum())} lower-jaw verts, removed {len(mixed)} gum faces joining the jaws")

    anchor_mh = np.array([0.0, front_mh, bite_mh])
    anchor_rb = np.array([0.0, TEETH_FRONT_Y, BITE_Z])
    T = (T - anchor_mh) * TEETH_SCALE + anchor_rb
    # MakeHuman OBJs are not positioned relative to each other (fitting comes from .mhclo files),
    # so the tongue is anchored on its own front-most vertex.
    tip = G[np.argmin(G[:, 1])].copy()
    tip[0] = 0.0
    G = (G - tip) * TONGUE_SCALE + np.array(TONGUE_TIP)
    for o, P in ((teeth, T), (tongue, G)):
        o.data.vertices.foreach_set("co", P.astype(np.float32).ravel())
        o.data.update()

    def add_keys(o, P, which):
        o.shape_key_add(name="Basis", from_mix=False)
        for name, (jaw, tng) in motions.items():
            R, t = jaw if which == "jaw" else tng
            Q = P.copy()
            sel = lower if which == "jaw" else np.ones(len(P), dtype=bool)
            Q[sel] = P[sel] @ R.T + t
            if np.abs(Q - P).max() < 2e-5:
                continue
            kb = o.shape_key_add(name=name, from_mix=False)
            kb.data.foreach_set("co", Q.astype(np.float32).ravel())

    add_keys(teeth, T, "jaw")
    add_keys(tongue, G, "tongue")

    teeth_img = bpy.data.images.load(os.path.join(MH, "teeth.png"))
    tongue_img = bpy.data.images.load(os.path.join(MH, "tongue01_diffuse.png"))
    teeth.data.materials.append(make_material("Teeth", teeth_img, None, None, roughness=0.26, specular=0.55))
    tongue.data.materials.append(make_material("Tongue", tongue_img, None, None, roughness=0.42, specular=0.5))

    # mouth cavity: flat dark tissue colour instead of the old painted teeth
    cav = mouth.data.materials[0]
    bsdf = cav.node_tree.nodes["Principled BSDF"]
    for link in list(cav.node_tree.links):
        if link.to_socket == bsdf.inputs["Base Color"]:
            cav.node_tree.links.remove(link)
    bsdf.inputs["Base Color"].default_value = (0.20, 0.045, 0.045, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.55

    for o, name in ((teeth, "Teeth"), (tongue, "Tongue")):
        o.name = o.data.name = name
        o.parent = arm
        o.matrix_parent_inverse = arm.matrix_world.inverted()
        vg = o.vertex_groups.new(name="Bip01 Head")
        vg.add(list(range(len(o.data.vertices))), 1.0, "REPLACE")
        mod = o.modifiers.new("Armature", "ARMATURE")
        mod.object = arm
        log(f"part {name:6s} verts={len(o.data.vertices):5d} morphs={len(o.data.shape_keys.key_blocks) - 1}")
    return teeth, tongue


parts += list(add_teeth_and_tongue(bpy.data.objects["Mouth"], bpy.data.objects["Head"]))

# -------------------------------------------------------------------------------------- animations
def retarget_clip(clip_name, fbx_path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=fbx_path, use_anim=True)
    new = [o for o in bpy.data.objects if o not in before]
    src = next(o for o in new if o.type == "ARMATURE")
    src_action = src.animation_data.action
    f0, f1 = (int(round(x)) for x in src_action.frame_range)

    bones = [b for b in arm.data.bones if not FACE_BONE.match(b.name) and b.name in src.data.bones]
    order = sorted(bones, key=lambda b: len(b.parent_recursive))
    # avatar rest: parent-relative rest matrices
    rest_local = {b.name: (b.parent.matrix_local.inverted() @ b.matrix_local) if b.parent else b.matrix_local.copy()
                  for b in order}
    to_av = arm.matrix_world.inverted() @ src.matrix_world  # src armature space -> avatar armature space (root only)

    frames = list(range(f0, f1 + 1))
    rot = {b.name: np.zeros((len(frames), 4)) for b in order}
    root = order[0].name
    loc_root = np.zeros((len(frames), 3))
    scene = bpy.context.scene
    for fi, f in enumerate(frames):
        scene.frame_set(f)
        sp = src.pose.bones
        av_pose = {}
        for b in order:
            s = sp[b.name]
            if b.parent is None or b.parent.name not in av_pose:
                local_src = to_av @ s.matrix
                t = local_src.to_translation()
            else:
                local_src = sp[b.parent.name].matrix.inverted() @ s.matrix
                t = rest_local[b.name].to_translation()
            r = local_src.to_quaternion()
            parent_pose = av_pose.get(b.parent.name) if b.parent else None
            m_local = Matrix.Translation(t) @ r.to_matrix().to_4x4()
            av_pose[b.name] = (parent_pose @ m_local) if parent_pose is not None else m_local
            basis = rest_local[b.name].inverted() @ m_local
            q = basis.to_quaternion()
            prev = rot[b.name][fi - 1] if fi else None
            if prev is not None and np.dot(prev, q[:]) < 0:
                q = Quaternion((-q.w, -q.x, -q.y, -q.z))
            rot[b.name][fi] = q[:]
            if b.name == root:
                loc_root[fi] = basis.to_translation()[:]

    # "Motion extracted" clips still carry a pelvis offset (where the actor stood) and slow wandering /
    # stepping. High-pass the pelvis translation (minus a 2.5 s moving average) so the avatar stays
    # in frame while keeping the natural sway and weight shifts.
    win = min(75, len(loc_root) | 1)
    if win >= 5:
        pad = win // 2
        padded = np.pad(loc_root, ((pad, pad), (0, 0)), mode="edge")
        kernel = np.ones(win) / win
        trend = np.stack([np.convolve(padded[:, i], kernel, mode="valid") for i in range(3)], axis=1)
        loc_root = loc_root - trend[: len(loc_root)]
    loc_root -= loc_root.mean(axis=0)

    action = bpy.data.actions.new(clip_name)
    action.use_fake_user = True
    arm.animation_data_create()
    arm.animation_data.action = action
    xs = np.arange(len(frames), dtype=np.float32)

    def write(path, idx, values, group):
        fc = action.fcurve_ensure_for_datablock(arm, path, index=idx, group_name=group)
        fc.keyframe_points.add(len(values))
        fc.keyframe_points.foreach_set("co", np.stack([xs, values.astype(np.float32)], 1).ravel())
        for kp in fc.keyframe_points:
            kp.interpolation = "LINEAR"
        fc.update()

    for b in order:
        arm.pose.bones[b.name].rotation_mode = "QUATERNION"
        for i in range(4):
            write(f'pose.bones["{b.name}"].rotation_quaternion', i, rot[b.name][:, i], b.name)
    for i in range(3):
        write(f'pose.bones["{root}"].location', i, loc_root[:, i], root)

    for o in new:
        bpy.data.objects.remove(o, do_unlink=True)
    for a in [a for a in bpy.data.actions if a.users == 0 and a is not action and not a.use_fake_user]:
        bpy.data.actions.remove(a)
    log(f"clip {clip_name:18s} {len(frames)} frames ({len(frames) / 30:.1f}s), {len(order)} bones")
    return action


if not args.no_anim:
    # Avatar meshes need not be evaluated while sampling the source clips.
    for o in parts:
        o.hide_viewport = True
    actions = [retarget_clip(n, os.path.join(ANIM_DIR, f + ".max.fbx")) for n, f in CLIPS.items()]
    for o in parts:
        o.hide_viewport = False
    # Store each clip as an NLA track; the exporter emits one glTF animation per track.
    for a in actions:
        tr = arm.animation_data.nla_tracks.new()
        tr.name = a.name
        tr.strips.new(a.name, 0, a)
    arm.animation_data.action = None
for pb in arm.pose.bones:
    pb.matrix_basis = Matrix.Identity(4)

bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)

# ------------------------------------------------------------------------------------------- export
os.makedirs(os.path.dirname(OUT), exist_ok=True)
if args.blend:
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.blend))
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format="GLB",
    export_image_format="WEBP", export_image_quality=90,
    export_morph=True, export_morph_normal=True, export_morph_animation=False,
    export_skins=True, export_influence_nb=4,
    export_animations=not args.no_anim, export_animation_mode="NLA_TRACKS",
    export_force_sampling=True, export_optimize_animation_size=True, export_anim_slide_to_zero=True,
    export_yup=True, export_apply=False,
)
log("wrote", OUT, f"{os.path.getsize(OUT) / 1e6:.1f} MB")
