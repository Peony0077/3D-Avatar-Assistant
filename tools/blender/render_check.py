"""Verification renders of the exported GLB (Cycles GPU).
blender -b -noaudio --python tools/blender/render_check.py -- public/avatar/avatar.glb OUT_DIR
Renders: (a) waist-up frames from several animation clips, (b) face close-ups of key visemes."""
import bpy, sys, os, math
from mathutils import Vector
glb, out = sys.argv[sys.argv.index("--") + 1:][:2]
os.makedirs(out, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=glb)
for o in list(bpy.data.objects):
    if o.name.startswith("Icosphere"): bpy.data.objects.remove(o, do_unlink=True)
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
sc = bpy.context.scene
print("ANIMS", [a.name for a in bpy.data.actions])
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam
def light(name, loc, energy, size=1.0):
    L = bpy.data.objects.new(name, bpy.data.lights.new(name, "AREA")); L.data.energy = energy; L.data.size = size
    L.location = loc; sc.collection.objects.link(L); return L
sc.world = bpy.data.worlds.new("w"); sc.world.color = (0.12, 0.12, 0.14)
sc.render.engine = "CYCLES"; sc.cycles.samples = 32; sc.cycles.use_denoising = True
prefs = bpy.context.preferences.addons["cycles"].preferences
prefs.compute_device_type = "CUDA"; prefs.get_devices()
for d in prefs.devices: d.use = d.type == "CUDA"
sc.cycles.device = "GPU"
def head_pos():
    bpy.context.view_layer.update()
    pb = arm.pose.bones["Bip01 Head"]; return arm.matrix_world @ pb.head
def aim(cam_loc, target):
    cam.location = cam_loc; cam.rotation_euler = (target - cam_loc).to_track_quat("-Z", "Y").to_euler()
keys = [L for L in []]
# (a) body clips
sc.render.resolution_x, sc.render.resolution_y = 360, 480
cam.data.lens = 50
lights = [light("key", Vector((-1.2, -2.0, 2.0)), 300, 1.5), light("fill", Vector((1.5, -1.5, 1.5)), 120, 1.5), light("rim", Vector((0, 2, 2.2)), 150, 1.0)]
for L in lights: L.rotation_euler = (Vector((0, 0, 1.3)) - L.location).to_track_quat("-Z", "Y").to_euler()
for a in bpy.data.actions:
    if not any(k in a.name for k in ("talk_neutral_01", "idle_breathe_02", "listen_accept_01")): continue
    arm.animation_data.action = a
    if a.slots: arm.animation_data.action_slot = a.slots[0]
    f0, f1 = a.frame_range
    for t in (0.3, 0.6):
        sc.frame_set(int(f0 + (f1 - f0) * t)); h = head_pos()
        aim(Vector((h.x, h.y - 2.2, h.z - 0.25)), Vector((h.x, h.y, h.z - 0.45)))
        sc.render.filepath = os.path.join(out, f"body_{a.name}_{int(t*100)}.png"); bpy.ops.render.render(write_still=True)
        print("RENDERED", a.name, t)
# (b) face close-ups, rest pose
if arm.animation_data: arm.animation_data.action = None
for pb in arm.pose.bones: pb.matrix_basis.identity()
h = head_pos(); fc = h + Vector((0, 0, 0.06))
cam.data.lens = 85; sc.render.resolution_x, sc.render.resolution_y = 400, 400
aim(fc + Vector((0, -0.7, 0.0)), fc)
for L, off in zip(lights, [Vector((-0.5, -0.8, 0.35)), Vector((0.6, -0.7, 0.1)), Vector((0, 0.8, 0.5))]):
    L.location = fc + off; L.rotation_euler = (fc - L.location).to_track_quat("-Z", "Y").to_euler(); L.data.size = 0.5
lights[0].data.energy, lights[1].data.energy, lights[2].data.energy = 40, 15, 25
meshes = [o for o in bpy.data.objects if o.type == "MESH" and o.data.shape_keys]
for label, w in [("neutral", {}), ("viseme_aa", {"viseme_aa": 1}), ("viseme_O", {"viseme_O": 1}), ("viseme_PP", {"viseme_PP": 1}),
                 ("viseme_FF", {"viseme_FF": 1}), ("viseme_TH", {"viseme_TH": 1}), ("smile", {"mouthSmileLeft": .9, "mouthSmileRight": .9, "cheekSquintLeft": .4, "cheekSquintRight": .4}),
                 ("blink", {"eyeBlinkLeft": 1, "eyeBlinkRight": 1})]:
    for m in meshes:
        for kb in m.data.shape_keys.key_blocks[1:]: kb.value = w.get(kb.name, 0)
    sc.render.filepath = os.path.join(out, f"face_{label}.png"); bpy.ops.render.render(write_still=True); print("RENDERED", label)
