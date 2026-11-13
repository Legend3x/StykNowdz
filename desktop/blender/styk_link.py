# 3D Nowdz <-> Blender link (docs/BLENDER-LITE.md, "Open in Blender").
#
# StykNowdz starts Blender as:
#   blender --python styk_link.py -- --styk-session <folder>
# The folder holds outgoing.json (the model, see src/modeler/blender-link.mjs).
# This script builds the scene from it, saves <folder>/<name>.blend and, every
# time the file is saved (Ctrl+S) or "Send to 3D Nowdz" is pressed in the
# sidebar (N > 3D Nowdz), writes incoming.json and bumps incoming.seq, which
# StykNowdz watches.
#
# Mirror, Solidify and Subdivision Surface stay live modifiers both ways. An
# object with any other modifier, or one that isn't a mesh (text, curve,
# metaball), is sent "baked": its final shape (the Armature modifier left out).
# Boolean cutters, cameras, lights and empties stay in Blender.
#
# 3D Nowdz is Y up; Blender is Z up: (x, y, z) here is (x, -z, y) in Blender.

import bpy
import json
import math
import os
import sys
import time
import uuid
import base64
from mathutils import Matrix, Vector

LINK_FORMAT = "styk-blender-link"
LINK_VERSION = 1
MIDDLE = "3D Nowdz Middle"
REFS = "3D Nowdz References"
KNOWN = ("MIRROR", "SOLIDIFY", "SUBSURF", "ARMATURE")

Y_TO_Z = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
Z_TO_Y = Y_TO_Z.inverted()

state = {"session": None, "seq": 0, "status": "", "error": "", "busy": False}


def arg(name):
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return argv[argv.index(name) + 1] if name in argv and argv.index(name) + 1 < len(argv) else None


def to_b(p):
    return (p[0], -p[2], p[1])


def from_b(p):
    return [p[0], p[2], -p[1]]


def rows(m):
    return Matrix((m[0:4], m[4:8], m[8:12], m[12:16]))


def flat(m):
    return [m[r][c] for r in range(4) for c in range(4)]


def srgb_to_linear(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def linear_to_srgb(v):
    v = max(0.0, min(1.0, v))
    return 255.0 * (v * 12.92 if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055)


def crease_layer(mesh, create=False):
    """Edge creases: the "crease_edge" attribute from Blender 4.0 ("crease" in 3.x);
    None means older Blenders' edge.crease property is used instead."""
    name = "crease_edge" if bpy.app.version >= (4, 0, 0) else "crease"
    layer = mesh.attributes.get(name)
    if layer is not None and (layer.domain != "EDGE" or layer.data_type != "FLOAT"):
        return None
    if layer is None and create:
        try:
            layer = mesh.attributes.new(name, "FLOAT", "EDGE")
        except Exception:
            layer = None
    return layer


# ---------- building the scene ----------

def material_for(rgb, cache):
    key = tuple(int(v) for v in rgb[:3])
    if key in cache:
        return cache[key]
    mat = bpy.data.materials.new("3D Nowdz %02X%02X%02X" % key)
    linear = [srgb_to_linear(v) for v in key]
    mat.diffuse_color = (*linear, 1.0)
    mat.roughness = 0.9
    if bpy.app.version < (5, 0, 0):
        mat.use_nodes = True  # always on from Blender 5.0
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if mat.node_tree else None
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (*linear, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.9
    cache[key] = mat
    return mat


def build_reference(ref, folder, collection):
    head, data = ref["src"].split(",", 1)
    ext = ".png" if "png" in head else ".webp" if "webp" in head else ".jpg"
    path = os.path.join(folder, "reference-%s%s" % (ref["view"], ext))
    with open(path, "wb") as f:
        f.write(base64.b64decode(data))
    image = bpy.data.images.load(path)
    w, h = image.size if image.size[0] and image.size[1] else (1, 1)
    empty = bpy.data.objects.new("%s reference" % ref["view"].capitalize(), None)
    empty.empty_display_type = "IMAGE"
    empty.data = image
    height = float(ref.get("height", 2))
    # Blender sizes an image empty by its longer side; 3D Nowdz by its height.
    empty.empty_display_size = height * max(w, h) / h
    empty.empty_image_offset = (-0.5, 0.0)  # bottom centre on the ground, like 3D Nowdz
    empty.use_empty_image_alpha = True
    empty.color[3] = float(ref.get("opacity", 0.5))
    empty.show_empty_image_perspective = False
    empty.show_empty_image_only_axis_aligned = True
    empty.empty_image_side = "FRONT"
    ox, oy = float(ref.get("offsetX", 0)), float(ref.get("offsetY", 0))
    # As in 3D Nowdz (src/modeler/viewport.mjs referenceCorners): the front image is a
    # wall 2 m behind the middle facing the Front view, the side image one 2 m to the
    # character's right (-X) facing the Right view; offsets move them as seen from there.
    if ref["view"] == "side":
        empty.rotation_euler = (math.pi / 2, 0, math.pi / 2)
        empty.location = (-2, ox, oy)
    else:
        empty.rotation_euler = (math.pi / 2, 0, 0)
        empty.location = (ox, 2, oy)
    if ref.get("flip"):
        empty.scale.x = -1
    empty.hide_select = True
    collection.objects.link(empty)


def build(doc, folder):
    scene = bpy.context.scene
    for obj in list(scene.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    scene.unit_settings.system = "METRIC"
    scene["styk_link"] = True

    middle = bpy.data.objects.new(MIDDLE, None)
    middle.empty_display_type = "PLAIN_AXES"
    middle.empty_display_size = 0.05
    middle.lock_location = middle.lock_rotation = middle.lock_scale = (True, True, True)
    middle.hide_select = True
    scene.collection.objects.link(middle)

    arm_obj = None
    if doc["bones"]:
        arm = bpy.data.armatures.new("Armature")
        arm.display_type = "OCTAHEDRAL"
        arm_obj = bpy.data.objects.new("Armature", arm)
        arm_obj.show_in_front = True
        scene.collection.objects.link(arm_obj)
        bpy.context.view_layer.objects.active = arm_obj
        bpy.ops.object.mode_set(mode="EDIT")
        made = {}
        for b in doc["bones"]:
            eb = arm.edit_bones.new(b["name"])
            eb.head, eb.tail = to_b(b["head"]), to_b(b["tail"])
            eb.roll = 0
            made[b["name"]] = eb
        for b in doc["bones"]:
            if b.get("parent") in made:
                made[b["name"]].parent = made[b["parent"]]
        bpy.ops.object.mode_set(mode="OBJECT")
        for b in doc["bones"]:
            bone = arm.bones[b["name"]]
            bone["styk_key"] = b["key"]
            bone["Strength"] = float(b.get("strength", 1))
            bone["Reach"] = float(b.get("range", 0))

    palette, materials = doc["palette"], {}
    for order, p in enumerate(doc["parts"]):
        mesh = bpy.data.meshes.new(p["name"])
        loose_edges = [tuple(e) for e in p.get("edges", [])]
        mesh.from_pydata([to_b(v) for v in p["verts"]], loose_edges, [tuple(f) for f in p["faces"]])
        used = {}
        for c in sorted(set(p["colors"])):
            used[c] = len(mesh.materials)
            mesh.materials.append(material_for(palette[c] if 0 <= c < len(palette) else (200, 200, 200), materials))
        mesh.polygons.foreach_set("material_index", [used[c] for c in p["colors"]])
        mesh.polygons.foreach_set("use_smooth", [True] * len(mesh.polygons))
        if p.get("crease"):
            index = {tuple(sorted(e.vertices)): e.index for e in mesh.edges}
            layer = crease_layer(mesh, True)
            for key, value in p["crease"].items():
                a, b = (int(x) for x in key.split(","))
                i = index.get((min(a, b), max(a, b)))
                if i is None:
                    continue
                if layer is not None:
                    layer.data[i].value = value
                else:
                    mesh.edges[i].crease = value
        if p.get("line"):
            layer = mesh.attributes.new("styk_line", "FLOAT", "POINT")
            for i, w in p["line"].items():
                layer.data[int(i)].value = w
        if p.get("normal"):
            layer = mesh.attributes.new("styk_normal", "FLOAT_VECTOR", "POINT")
            for i, n in p["normal"].items():
                layer.data[int(i)].vector = to_b(n)
        mesh.update()
        obj = bpy.data.objects.new(p["name"], mesh)
        scene.collection.objects.link(obj)
        obj["styk_key"] = p["key"]
        obj["styk_order"] = order
        obj.matrix_world = Y_TO_Z @ rows(p["matrix"]) @ Z_TO_Y
        if p.get("mirror"):
            mod = obj.modifiers.new("Mirror", "MIRROR")
            mod.use_axis = (True, False, False)
            mod.mirror_object = middle
            mod.use_clip = bool(p.get("clip", True))
            mod.use_mirror_merge = True
            mod.merge_threshold = 1e-4
        if p.get("solidify"):
            mod = obj.modifiers.new("Solidify", "SOLIDIFY")
            mod.thickness = float(p["solidify"])
            mod.offset = -1
        if p.get("smooth"):
            mod = obj.modifiers.new("Subdivision", "SUBSURF")
            mod.levels = mod.render_levels = int(p["smooth"])
        if arm_obj is not None:
            groups = {}
            for i, pairs in p.get("weights", {}).items():
                for name, w in pairs:
                    if name not in groups:
                        groups[name] = obj.vertex_groups.new(name=name)
                    groups[name].add([int(i)], float(w), "REPLACE")
            for b in doc["bones"]:
                if b["name"] not in groups:
                    groups[b["name"]] = obj.vertex_groups.new(name=b["name"])
            obj.parent = arm_obj
            obj.matrix_world = Y_TO_Z @ rows(p["matrix"]) @ Z_TO_Y
            mod = obj.modifiers.new("Armature", "ARMATURE")
            mod.object = arm_obj
        if not p.get("visible", True):
            obj.hide_set(True)

    if doc.get("references"):
        refs = bpy.data.collections.new(REFS)
        scene.collection.children.link(refs)
        for ref in doc["references"]:
            try:
                build_reference(ref, folder, refs)
            except Exception as error:  # a broken image only loses its reference
                print("3D Nowdz: reference skipped:", error)

    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                for space in area.spaces:
                    if space.type == "VIEW_3D":
                        space.shading.color_type = "MATERIAL"


# ---------- sending back ----------

def material_rgb(mat):
    if mat is None:
        return [200, 200, 200]
    color = list(mat.diffuse_color)[:3]
    if mat.node_tree and (bpy.app.version >= (5, 0, 0) or mat.use_nodes):
        bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf is not None and not bsdf.inputs["Base Color"].is_linked:
            color = list(bsdf.inputs["Base Color"].default_value)[:3]
    return [round(linear_to_srgb(v), 2) for v in color]


def live_modifiers(obj, middle):
    """Mirror/Solidify/Smooth settings when the stack is one 3D Nowdz can keep live, else None."""
    if obj.type != "MESH":
        return None
    found = {}
    order = []
    for mod in obj.modifiers:
        if not mod.show_viewport:
            continue
        if mod.type not in KNOWN or mod.type in found:
            return None
        found[mod.type] = mod
        order.append(mod.type)
    shape = [t for t in order if t != "ARMATURE"]
    if shape != sorted(shape, key=["MIRROR", "SOLIDIFY", "SUBSURF"].index):
        return None
    out = {"mirror": False, "clip": True, "solidify": 0, "smooth": 0}
    mirror = found.get("MIRROR")
    if mirror is not None:
        # 3D Nowdz mirrors about the middle of the world (X = 0).
        plain = all(abs(obj.matrix_world[r][c] - (1.0 if r == c else 0.0)) < 1e-6 for r in range(4) for c in range(4))
        about_middle = mirror.mirror_object == middle or (mirror.mirror_object is None and plain)
        if tuple(mirror.use_axis) != (True, False, False) or tuple(mirror.use_bisect_axis) != (False, False, False) or not about_middle:
            return None
        out["mirror"], out["clip"] = True, bool(mirror.use_clip)
    solid = found.get("SOLIDIFY")
    if solid is not None:
        if abs(solid.offset + 1) > 1e-6 or not solid.use_rim:
            return None
        out["solidify"] = solid.thickness
    sub = found.get("SUBSURF")
    if sub is not None:
        if sub.subdivision_type != "CATMULL_CLARK" or sub.levels > 3:
            return None
        out["smooth"] = sub.levels
    return out


def mesh_data(mesh, obj, bone_names):
    import numpy as np
    n = len(mesh.vertices)
    co = np.empty(n * 3, dtype=np.float64)
    mesh.vertices.foreach_get("co", co)
    co = co.reshape(n, 3)
    verts = np.round(np.stack([co[:, 0], co[:, 2], -co[:, 1]], axis=1), 7).tolist()
    loops = np.empty(len(mesh.loops), dtype=np.int64)
    mesh.loops.foreach_get("vertex_index", loops)
    starts = np.empty(len(mesh.polygons), dtype=np.int64)
    totals = np.empty(len(mesh.polygons), dtype=np.int64)
    mesh.polygons.foreach_get("loop_start", starts)
    mesh.polygons.foreach_get("loop_total", totals)
    mats = np.empty(len(mesh.polygons), dtype=np.int64)
    mesh.polygons.foreach_get("material_index", mats)
    loops = loops.tolist()
    faces = [loops[s:s + t] for s, t in zip(starts.tolist(), totals.tolist())]
    in_faces = set()
    for p in mesh.polygons:
        in_faces.update(p.edge_keys)
    edges = [list(e.vertices) for e in mesh.edges if tuple(sorted(e.vertices)) not in in_faces]
    used = set(loops)
    for a, b in edges:
        used.add(a)
        used.add(b)
    loose = [i for i in range(n) if i not in used]
    crease = {}
    layer = crease_layer(mesh)
    for e in mesh.edges:
        value = layer.data[e.index].value if layer is not None else getattr(e, "crease", 0.0)
        if value > 1e-4:
            a, b = sorted(e.vertices)
            crease["%d,%d" % (a, b)] = round(value, 4)
    line, normal = {}, {}
    lw = mesh.attributes.get("styk_line")
    if lw is not None and lw.domain == "POINT":
        for i, d in enumerate(lw.data):
            if d.value != 0:
                line[i] = round(d.value, 4)
    nv = mesh.attributes.get("styk_normal")
    if nv is not None and nv.domain == "POINT":
        for i, d in enumerate(nv.data):
            v = d.vector
            if v.length > 1e-6:
                v = v.normalized()
                normal[i] = [round(v.x, 5), round(v.z, 5), round(-v.y, 5)]
    weights = {}
    if bone_names and obj is not None and obj.vertex_groups:
        names = {g.index: g.name for g in obj.vertex_groups}
        for v in mesh.vertices:
            pairs = [[names[g.group], round(g.weight, 5)] for g in v.groups if g.group in names and names[g.group] in bone_names and g.weight > 1e-4]
            if pairs:
                weights[v.index] = pairs
    return {"verts": verts, "faces": faces, "mats": mats.tolist(), "edges": edges, "loose": loose,
            "crease": crease, "line": line, "normal": normal, "weights": weights}


def collect():
    scene = bpy.context.scene
    middle = bpy.data.objects.get(MIDDLE)
    arm_obj = bpy.data.objects.get("Armature")
    if arm_obj is None or arm_obj.type != "ARMATURE":
        arm_obj = next((o for o in scene.objects if o.type == "ARMATURE"), None)
    for obj in scene.objects:
        if obj.mode == "EDIT" and obj.type == "MESH":
            obj.update_from_editmode()

    bones = []
    if arm_obj is not None:
        for bone in arm_obj.data.bones:
            if "styk_key" not in bone:
                bone["styk_key"] = "blender-" + uuid.uuid4().hex
            head = arm_obj.matrix_world @ bone.head_local
            tail = arm_obj.matrix_world @ bone.tail_local
            bones.append({"key": bone["styk_key"], "name": bone.name, "head": from_b(head), "tail": from_b(tail),
                          "parent": bone.parent.name if bone.parent else None,
                          "strength": float(bone.get("Strength", 1.0)), "range": float(bone.get("Reach", 0.0))})
    bone_names = {b["name"] for b in bones}

    materials, material_index = [], {}

    def color_of(mat):
        rgb = tuple(material_rgb(mat))
        if rgb not in material_index:
            material_index[rgb] = len(materials)
            materials.append(list(rgb))
        return material_index[rgb]

    refs = bpy.data.collections.get(REFS)
    # Boolean cutters are tools, not parts of the model: they stay in Blender.
    cutters = set()
    for obj in scene.objects:
        for mod in obj.modifiers:
            if mod.type == "BOOLEAN" and mod.show_viewport:
                if getattr(mod, "operand_type", "OBJECT") == "COLLECTION" and mod.collection:
                    cutters.update(mod.collection.all_objects)
                elif mod.object:
                    cutters.add(mod.object)
    candidates = [o for o in scene.objects if o.type in {"MESH", "CURVE", "SURFACE", "META", "FONT"}
                  and o != middle and o not in cutters and not (refs and o.name in refs.objects)]
    candidates.sort(key=lambda o: (o.get("styk_order", 1e9), o.name))
    keys, parts = set(), []
    # Baked objects are read with Armature modifiers off: the rest pose.
    paused = []
    for obj in candidates:
        if live_modifiers(obj, middle) is None:
            for mod in obj.modifiers:
                if mod.type == "ARMATURE" and mod.show_viewport:
                    mod.show_viewport = False
                    paused.append(mod)
    try:
        depsgraph = bpy.context.evaluated_depsgraph_get()
        depsgraph.update()
        for obj in candidates:
            key = obj.get("styk_key")
            if not isinstance(key, str) or key in keys:
                key = obj["styk_key"] = "blender-" + uuid.uuid4().hex
            keys.add(key)
            live = live_modifiers(obj, middle)
            if live is not None:
                data = mesh_data(obj.data, obj, bone_names)
                slots = obj.data.materials
            else:
                evaluated = obj.evaluated_get(depsgraph)
                temp = evaluated.to_mesh()
                try:
                    data = mesh_data(temp, obj, bone_names)
                    slots = [s.material for s in evaluated.material_slots] or list(temp.materials)
                finally:
                    evaluated.to_mesh_clear()
                live = {"mirror": False, "clip": True, "solidify": 0, "smooth": 0}
                if not data["faces"] and obj.type != "MESH":
                    continue  # a curve with no thickness (a path for a Curve modifier) is a guide, not a part
            palette_of_slots = [color_of(m) for m in slots] or [color_of(None)]
            colors = [palette_of_slots[m] if 0 <= m < len(palette_of_slots) else palette_of_slots[0] for m in data.pop("mats")]
            parts.append({"key": key, "name": obj.name, "matrix": flat(Z_TO_Y @ obj.matrix_world @ Y_TO_Z),
                          "colors": colors, "baked": obj.type != "MESH" or live_modifiers(obj, middle) is None,
                          "visible": not obj.hide_get() and not obj.hide_viewport, **live, **data})
    finally:
        for mod in paused:
            mod.show_viewport = True
    return {"format": LINK_FORMAT, "version": LINK_VERSION, "blender": bpy.app.version_string,
            "name": scene.get("styk_name", "3D model"), "materials": materials, "parts": parts, "bones": bones}


def send(*_):
    folder = state["session"]
    if not folder or state["busy"]:
        return None
    state["busy"] = True
    try:
        reply = collect()
        target = os.path.join(folder, "incoming.json")
        with open(target + ".part", "w", encoding="utf-8") as f:
            json.dump(reply, f, separators=(",", ":"))
        os.replace(target + ".part", target)
        state["seq"] += 1
        with open(os.path.join(folder, "incoming.seq.part"), "w") as f:
            f.write(str(state["seq"]))
        os.replace(os.path.join(folder, "incoming.seq.part"), os.path.join(folder, "incoming.seq"))
        state["status"] = "Sent %d object(s) to 3D Nowdz at %s" % (len(reply["parts"]), time.strftime("%H:%M:%S"))
        state["error"] = ""
        print("3D Nowdz:", state["status"])
    except Exception as error:
        state["error"] = str(error)
        print("3D Nowdz: could not send:", error)
    finally:
        state["busy"] = False
    for window in getattr(bpy.context.window_manager, "windows", []):
        for area in window.screen.areas:
            area.tag_redraw()
    return None


@bpy.app.handlers.persistent
def after_save(*_):
    # Outside the save itself, so the file is complete and the UI is free.
    bpy.app.timers.register(send, first_interval=0.05)


class STYK_OT_send(bpy.types.Operator):
    bl_idname = "styk.send_to_nowdz"
    bl_label = "Send to 3D Nowdz"
    bl_description = "Send the model back to 3D Nowdz now (saving with Ctrl+S does this too)"

    def execute(self, context):
        send()
        if state["error"]:
            self.report({"ERROR"}, "3D Nowdz: " + state["error"])
            return {"CANCELLED"}
        self.report({"INFO"}, state["status"])
        return {"FINISHED"}


class STYK_PT_link(bpy.types.Panel):
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "3D Nowdz"
    bl_label = "3D Nowdz"

    def draw(self, context):
        col = self.layout.column()
        col.operator(STYK_OT_send.bl_idname, icon="EXPORT")
        col.label(text="Ctrl+S also sends your changes.")
        if state["error"]:
            col.label(text=state["error"], icon="ERROR")
        elif state["status"]:
            col.label(text=state["status"], icon="CHECKMARK")
        col.separator()
        col.label(text="Kept live: Mirror, Solidify, Subdivision.")
        col.label(text="Other modifiers come back applied.")


def start():
    folder = arg("--styk-session")
    if not folder:
        return
    state["session"] = folder
    with open(os.path.join(folder, "outgoing.json"), encoding="utf-8") as f:
        doc = json.load(f)
    if doc.get("format") != LINK_FORMAT or doc.get("version") != LINK_VERSION:
        raise SystemExit("3D Nowdz: this link file is from another version of StykNowdz.")
    build(doc, folder)
    bpy.context.scene["styk_name"] = doc.get("name", "3D model")
    for cls in (STYK_OT_send, STYK_PT_link):
        bpy.utils.register_class(cls)
    if after_save not in bpy.app.handlers.save_post:
        bpy.app.handlers.save_post.append(after_save)
    safe = "".join(ch if ch.isalnum() or ch in " -_" else "_" for ch in doc.get("name", "model")).strip() or "model"
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(folder, safe + ".blend"))
    state["status"] = "Linked to 3D Nowdz"
    if bpy.app.background and arg("--styk-test"):
        # Headless tests (scripts/blender-link-stress.py) drive the scene, then send.
        import runpy
        runpy.run_path(arg("--styk-test"), run_name="__styk_test__")
        send()


start()
