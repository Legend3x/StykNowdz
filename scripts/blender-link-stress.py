# Stress test for 3D Nowdz <-> Blender (scripts/blender-link-stress.mjs runs it).
# Blender runs desktop/blender/styk_link.py on Juniper, then this file stands in
# for a person working in Blender: detail no 3D Nowdz tool can make, then a
# save. Blender is Z up; Juniper faces -Y; her left (.L) is +X.
#   STYK_STRESS=detail  heavy edits (below)
#   STYK_STRESS=none    no edits: the round trip must change nothing
#   STYK_RENDER=<png>   also render the result with Cycles (CPU) for a look

import bpy
import bmesh
import math
import os
import random
import time
from mathutils import Vector

random.seed(7)
scene = bpy.context.scene
middle = bpy.data.objects["3D Nowdz Middle"]
arm = bpy.data.objects["Armature"]
log = []


def note(text):
    log.append(text)
    print("stress:", text)


def material(name, rgb):
    mat = bpy.data.materials.new(name)
    lin = [((c / 255 + .055) / 1.055) ** 2.4 if c / 255 > .04045 else c / 255 / 12.92 for c in rgb]
    mat.diffuse_color = (*lin, 1)
    if bpy.app.version < (5, 0, 0):
        mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*lin, 1)
    return mat


def new_object(mesh_op, name, mat, **kw):
    for o in list(bpy.context.selected_objects):
        o.select_set(False)
    mesh_op(**kw)
    obj = bpy.context.active_object
    obj.name = name
    obj.data.materials.append(mat)
    return obj


def weight_all(obj, bone, also=()):
    for name in (bone, *also):
        obj.vertex_groups.new(name=name)
    obj.vertex_groups[bone].add(list(range(len(obj.data.vertices))), 1.0, "REPLACE")


steel, gold, stone, red, leather = (material("Steel", (176, 186, 198)), material("Gold", (232, 184, 64)),
                                    material("Stone", (128, 120, 110)), material("Scarf red", (200, 40, 52)), material("Leather", (92, 58, 38)))
mode = os.environ.get("STYK_STRESS", "detail")
started = time.time()

if mode == "detail":
    # 1. A live modifier changed: the head gets a second level of Smooth.
    head = bpy.data.objects["Head"]
    head.modifiers["Subdivision"].levels = 2
    note("Head: Subdivision 1 -> 2 (stays live)")

    # 2. Points moved by hand: the hair gets a messy, windswept edit.
    hair = bpy.data.objects["Hair"]
    for v in hair.data.vertices:
        if v.co.z > 0 and v.co.y > -0.02:
            v.co += Vector((random.uniform(-.012, .012), random.uniform(0, .03), random.uniform(-.01, .015)))
    note("Hair: %d points pushed back (stays live)" % len(hair.data.vertices))

    # 3. Creases on the skirt hem (kept as creases).
    skirt = bpy.data.objects["Skirt"]
    zs = [v.co.z for v in skirt.data.vertices]
    low = min(zs)
    hem = {v.index for v in skirt.data.vertices if v.co.z < low + 1e-4}
    name = "crease_edge" if bpy.app.version >= (4, 0, 0) else "crease"
    layer = skirt.data.attributes.get(name) or skirt.data.attributes.new(name, "FLOAT", "EDGE")
    count = 0
    for e in skirt.data.edges:
        if e.vertices[0] in hem and e.vertices[1] in hem:
            if layer is not None:
                layer.data[e.index].value = 1.0
            else:
                e.crease = 1.0
            count += 1
    note("Skirt: %d hem edges creased" % count)

    # 4. A sword in her right hand: bevelled blade, torus guard, sphere pommel, one object.
    blade = new_object(bpy.ops.mesh.primitive_cube_add, "Sword", steel, size=1)
    blade.scale = (.012, .045, .55)
    blade.location = (-.42, -.06, .1)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bev = blade.modifiers.new("Bevel", "BEVEL")
    bev.width, bev.segments = .008, 3
    guard = new_object(bpy.ops.mesh.primitive_torus_add, "Guard", gold, major_radius=.06, minor_radius=.012, major_segments=32, minor_segments=12)
    guard.location = (-.42, -.06, .4)
    guard.rotation_euler = (0, math.pi / 2, 0)
    pommel = new_object(bpy.ops.mesh.primitive_uv_sphere_add, "Pommel", gold, radius=.025, segments=24, ring_count=12)
    pommel.location = (-.42, -.06, .56)
    grip = new_object(bpy.ops.mesh.primitive_cylinder_add, "Grip", leather, radius=.016, depth=.14, vertices=16)
    grip.location = (-.42, -.06, .48)
    for o in (guard, pommel, grip):
        o.select_set(True)
    blade.select_set(True)
    bpy.context.view_layer.objects.active = blade
    bpy.ops.object.join()
    weight_all(blade, "Hand.R")
    note("Sword: bevelled blade + guard + grip + pommel, painted to Hand.R (comes back baked)")

    # 5. A shoulder guard shaped with a Boolean, mirrored to both shoulders.
    pad = new_object(bpy.ops.mesh.primitive_uv_sphere_add, "Pauldron", steel, radius=.11, segments=32, ring_count=16)
    pad.location = (.33, 0, 1.4)
    pad.scale = (1, 1.1, .8)
    cutter = new_object(bpy.ops.mesh.primitive_cube_add, "Pauldron cutter", steel, size=.3)
    cutter.location = (.33, 0, 1.24)
    cutter.display_type = "WIRE"
    cutter.hide_render = True
    boolean = pad.modifiers.new("Cut", "BOOLEAN")
    boolean.operation, boolean.object = "DIFFERENCE", cutter
    solid = pad.modifiers.new("Shell", "SOLIDIFY")
    solid.thickness = .012
    mirror = pad.modifiers.new("Mirror", "MIRROR")
    mirror.mirror_object = middle
    pad.modifiers.new("Bevel", "BEVEL").width = .003
    weight_all(pad, "UpperArm.L", also=("UpperArm.R",))
    note("Pauldron: sphere cut by a Boolean, Solidify, Mirror, Bevel (baked; the cutter stays in Blender)")

    # 6. A stone pedestal: voxel Remesh + Displace, the heavy one.
    base = new_object(bpy.ops.mesh.primitive_cylinder_add, "Pedestal", stone, radius=.6, depth=.16, vertices=64)
    base.location = (0, 0, -.08)
    remesh = base.modifiers.new("Remesh", "REMESH")
    remesh.mode, remesh.voxel_size = "VOXEL", float(os.environ.get("STYK_VOXEL", ".006"))
    tex = bpy.data.textures.new("Rock", "CLOUDS")
    tex.noise_scale = .08
    disp = base.modifiers.new("Rock", "DISPLACE")
    disp.texture, disp.strength, disp.mid_level = tex, .012, .5
    note("Pedestal: voxel Remesh %.3f + Displace (baked, high detail)" % remesh.voxel_size)

    # 7. Her name in gold on the pedestal: a text object.
    bpy.ops.object.text_add(location=(0, -.61, -.1), rotation=(math.pi / 2, 0, 0))
    text = bpy.context.active_object
    text.name = "Nameplate"
    text.data.body = "JUNIPER"
    text.data.align_x, text.data.size, text.data.extrude, text.data.bevel_depth = "CENTER", .09, .006, .002
    text.data.materials.append(gold)
    note("Nameplate: 3D text (baked)")

    # 8. A scarf: a curve with thickness, round the neck and flowing back.
    curve = bpy.data.curves.new("Scarf", "CURVE")
    curve.dimensions, curve.bevel_depth, curve.bevel_resolution, curve.resolution_u = "3D", .025, 4, 12
    spline = curve.splines.new("BEZIER")
    points = [(0, -.1, 1.47), (.1, 0, 1.47), (0, .1, 1.47), (-.1, 0, 1.47), (-.05, -.09, 1.46), (.05, .2, 1.3), (.15, .35, 1.05)]
    spline.bezier_points.add(len(points) - 1)
    for bp, co in zip(spline.bezier_points, points):
        bp.co = co
        bp.handle_left_type = bp.handle_right_type = "AUTO"
    scarf = bpy.data.objects.new("Scarf", curve)
    scene.collection.objects.link(scarf)
    curve.materials.append(red)
    note("Scarf: Bezier curve with bevel (baked; weights come from 3D Nowdz)")

    # 9. Studs round the skirt's waist: an Array bent on a circle by a Curve modifier.
    stud = new_object(bpy.ops.mesh.primitive_ico_sphere_add, "Studs", gold, radius=.012, subdivisions=2)
    stud.location = (0, 0, 0)
    array = stud.modifiers.new("Row", "ARRAY")
    array.count, array.relative_offset_displace = 24, (2.2, 0, 0)
    bpy.ops.curve.primitive_bezier_circle_add(radius=.19, location=(0, 0, .8))
    ring = bpy.context.active_object
    ring.name = "Stud ring"
    bend = stud.modifiers.new("Round", "CURVE")
    bend.object = ring
    note("Studs: Array of 24 bent round the waist by a Curve modifier (baked)")

    # 10. Bones: a sword bone, weaker shoulders, and a rename.
    bpy.context.view_layer.objects.active = arm
    for o in list(bpy.context.selected_objects):
        o.select_set(False)
    arm.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm.data.edit_bones.new("Sword")
    eb.head, eb.tail = (-.42, -.06, .4), (-.42, -.06, -.1)
    eb.parent = arm.data.edit_bones["Hand.R"]
    arm.data.edit_bones["Jaw"].name = "Jaw.Main"
    bpy.ops.object.mode_set(mode="OBJECT")
    for side in "LR":
        arm.data.bones["Shoulder.%s" % side]["Strength"] = .3
    note("Bones: Sword added under Hand.R, Jaw renamed Jaw.Main, shoulders Strength 0.3")

    # 11. The single hair strand goes; a camera and a light are added (they stay in Blender).
    bpy.data.objects.remove(bpy.data.objects["Ahoge"], do_unlink=True)
    note("Ahoge deleted")

# A camera and lights for the look render (not parts: they stay in Blender).
bpy.ops.object.camera_add(location=(1.9, -3.4, 1.55), rotation=(math.radians(82), 0, math.radians(29)))
scene.camera = bpy.context.active_object
bpy.ops.object.light_add(type="SUN", rotation=(math.radians(40), math.radians(15), math.radians(30)))
bpy.context.active_object.data.energy = 3
note("edits took %.2fs" % (time.time() - started))

render = os.environ.get("STYK_RENDER")
if render:
    scene.render.engine = "CYCLES"
    scene.cycles.device, scene.cycles.samples = "CPU", 64
    scene.render.resolution_x, scene.render.resolution_y = 900, 1000
    scene.render.filepath = render
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 88
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.color = (.55, .6, .68)
    if world.use_nodes:
        bg = world.node_tree.nodes.get("Background")
        if bg:
            bg.inputs[0].default_value = (.55, .6, .68, 1)
            bg.inputs[1].default_value = .8
    t = time.time()
    bpy.ops.render.render(write_still=True)
    note("Cycles render took %.1fs" % (time.time() - t))

with open(os.path.join(os.environ.get("STYK_OUT", "."), "blender-log.txt"), "w") as f:
    f.write("Blender %s\n" % bpy.app.version_string + "\n".join(log) + "\n")
