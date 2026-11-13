# Blender's engine inside 3D Nowdz (docs/BLENDER-LITE.md, "Blender tools").
#
# StykNowdz runs this script with no Blender window, in one of two ways:
#   <bundled python> styk_engine.py              Blender as a Python module (bpy),
#                                                 shipped with the Windows app
#   blender -b --factory-startup --python styk_engine.py -- --styk-engine
#                                                 the person's own Blender, elsewhere
# and keeps it running. Each request is one line of JSON on stdin:
#   {"id": "...", "request": "<file>", "result": "<file>"}
# The request file holds {"op", "params", "doc"}: `doc` is the same link
# document Open in Blender uses (src/modeler/blender-link.mjs), with the parts
# the tool works on. The engine builds them (styk_link.build), runs the tool,
# and writes the parts back exactly as Open in Blender sends them
# (styk_link.collect), so 3D Nowdz merges both the same way. When a request is
# done it prints one line:  @@styk-engine {"id": ..., "ok": true|false, ...}
# Everything else Blender prints is ignored by StykNowdz.

import json
import math
import os
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import bpy  # noqa: E402
import styk_link as link  # noqa: E402  (its start() does nothing without --styk-session)

MARK = "@@styk-engine "
OPS = ("remesh", "decimate", "boolean", "smooth", "text", "tube", "ping")
TEXTURES = {"clouds": "CLOUDS", "voronoi": "VORONOI", "marble": "MARBLE", "noise": "NOISE"}


def say(message):
    sys.stdout.write(MARK + json.dumps(message) + "\n")
    sys.stdout.flush()


def clean_scene():
    """An empty scene, and nothing left over from the last request."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for collection in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.textures, bpy.data.images):
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)


def number(params, name, default, low, high):
    try:
        value = float(params.get(name, default))
    except (TypeError, ValueError):
        value = default
    if not math.isfinite(value):
        value = default
    return max(low, min(high, value))


def objects_by_key():
    return {o.get("styk_key"): o for o in bpy.context.scene.objects if o.get("styk_key")}


def target(params, objs, name="target"):
    obj = objs.get(params.get(name))
    if obj is None:
        raise ValueError("the part to work on is missing")
    return obj


def material(rgb):
    return link.material_for([int(v) for v in rgb[:3]], {})


def new_object(name, data, at, color):
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    if color is not None:
        data.materials.append(material(color))
    # Placed at a 3D Nowdz point (Y up), facing the Front view.
    obj.location = link.to_b(at)
    return obj


# ---------- tools ----------

def op_remesh(params, objs):
    obj = target(params, objs)
    mod = obj.modifiers.new("Remesh", "REMESH")
    mod.mode = "VOXEL"
    mod.voxel_size = number(params, "size", 0.02, 0.0005, 10)
    mod.adaptivity = number(params, "adaptivity", 0, 0, 1)
    if hasattr(mod, "use_smooth_shade"):
        mod.use_smooth_shade = True


def op_decimate(params, objs):
    obj = target(params, objs)
    mod = obj.modifiers.new("Decimate", "DECIMATE")
    how = params.get("how", "collapse")
    if how == "planar":
        mod.decimate_type = "DISSOLVE"
        mod.angle_limit = math.radians(number(params, "angle", 5, 0.1, 90))
    elif how == "unsubdivide":
        mod.decimate_type = "UNSUBDIV"
        mod.iterations = int(number(params, "iterations", 1, 1, 10))
    else:
        mod.decimate_type = "COLLAPSE"
        mod.ratio = number(params, "ratio", 0.5, 0.001, 1)
        if params.get("symmetry"):
            mod.use_symmetry = True
            mod.symmetry_axis = "X"


def op_boolean(params, objs):
    obj, cutter = target(params, objs), target(params, objs, "cutter")
    if cutter == obj:
        raise ValueError("choose another part to cut with")
    mod = obj.modifiers.new("Boolean", "BOOLEAN")
    mod.operation = {"union": "UNION", "intersect": "INTERSECT"}.get(params.get("how"), "DIFFERENCE")
    mod.object = cutter
    if hasattr(mod, "solver"):
        try:
            mod.solver = "EXACT"
        except TypeError:
            pass
    # The cutter is a tool: collect() leaves it out, and 3D Nowdz keeps or removes it.


def op_smooth(params, objs):
    obj = target(params, objs)
    how = params.get("how", "smooth")
    if how == "corrective":
        mod = obj.modifiers.new("Corrective Smooth", "CORRECTIVE_SMOOTH")
        mod.factor = number(params, "factor", 0.5, 0, 1)
        mod.iterations = int(number(params, "iterations", 5, 1, 200))
        mod.smooth_type = "LENGTH_WEIGHTED"
        mod.use_pin_boundary = bool(params.get("keepEdges", True))
        # No rest shape: it smooths towards the shape's own relaxed form.
        mod.rest_source = "ORCO"
    elif how == "laplacian":
        mod = obj.modifiers.new("Laplacian Smooth", "LAPLACIANSMOOTH")
        mod.lambda_factor = number(params, "factor", 0.5, 0, 10)
        mod.iterations = int(number(params, "iterations", 5, 1, 200))
        mod.use_volume_preserve = True
    elif how == "displace":
        tex = bpy.data.textures.new("3D Nowdz Displace", TEXTURES.get(params.get("texture"), "CLOUDS"))
        if hasattr(tex, "noise_scale"):
            tex.noise_scale = number(params, "size", 0.25, 0.001, 100)
        mod = obj.modifiers.new("Displace", "DISPLACE")
        mod.texture = tex
        mod.texture_coords = "LOCAL"
        mod.strength = number(params, "strength", 0.02, -10, 10)
        mod.mid_level = 0.5
    else:
        mod = obj.modifiers.new("Smooth", "SMOOTH")
        mod.factor = number(params, "factor", 0.5, -10, 10)
        mod.iterations = int(number(params, "iterations", 5, 1, 200))


def op_text(params, objs):
    body = str(params.get("text", "")).replace("\r", "")[:200].strip()
    if not body:
        raise ValueError("type the text to make")
    curve = bpy.data.curves.new("Text", "FONT")
    curve.body = body
    curve.size = number(params, "size", 0.2, 0.001, 100)
    curve.extrude = number(params, "depth", 0.02, 0, 10)
    curve.bevel_depth = number(params, "bevel", 0.003, 0, 1)
    curve.bevel_resolution = int(number(params, "roundness", 2, 0, 8))
    curve.align_x, curve.align_y = "CENTER", "CENTER"
    obj = new_object(params.get("name") or body[:40], curve, params.get("at", [0, 1, 0]), params.get("color"))
    obj.rotation_euler = (math.pi / 2, 0, 0)  # standing up, readable from the Front view


def op_tube(params, objs):
    points = [p for p in params.get("points", []) if isinstance(p, list) and len(p) == 3 and all(isinstance(v, (int, float)) for v in p)]
    if len(points) < 2:
        raise ValueError("select two or more points in a row to run a tube through")
    curve = bpy.data.curves.new("Tube", "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = number(params, "radius", 0.01, 0.0001, 10)
    curve.bevel_resolution = int(number(params, "roundness", 3, 0, 12))
    curve.resolution_u = int(number(params, "smoothness", 8, 1, 64))
    curve.use_fill_caps = True
    closed = bool(params.get("closed")) and len(points) > 2
    spline = curve.splines.new("BEZIER")
    spline.bezier_points.add(len(points) - 1)
    for bp, p in zip(spline.bezier_points, points):
        bp.co = link.to_b(p)
        # Smooth handles: the tube passes through every point.
        bp.handle_left_type = bp.handle_right_type = "AUTO"
    spline.use_cyclic_u = closed
    taper = number(params, "taper", 0, 0, 1)
    if taper > 0:
        # Thinner towards the end: radius per point, as hair strands and tails want.
        n = len(spline.bezier_points)
        for i, bp in enumerate(spline.bezier_points):
            bp.radius = 1 - taper * (i / max(1, n - 1))
    new_object(params.get("name") or "Tube", curve, [0, 0, 0], params.get("color"))


def run(request):
    op, params, doc = request.get("op"), request.get("params") or {}, request.get("doc")
    if op not in OPS:
        raise ValueError("unknown tool %r" % op)
    if op == "ping":
        return {"format": link.LINK_FORMAT, "version": link.LINK_VERSION, "blender": bpy.app.version_string, "materials": [], "parts": [], "bones": []}
    if not doc or doc.get("format") != link.LINK_FORMAT or doc.get("version") != link.LINK_VERSION:
        raise ValueError("the request is from another version of StykNowdz")
    clean_scene()
    folder = os.path.dirname(request.get("_file", ""))
    link.build(doc, folder)
    objs = objects_by_key()
    globals()["op_" + op](params, objs)
    return link.collect()


def serve():
    say({"ready": True, "blender": bpy.app.version_string, "pid": os.getpid()})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        ident = None
        try:
            message = json.loads(line)
            ident = message.get("id")
            if message.get("quit"):
                break
            with open(message["request"], encoding="utf-8") as f:
                request = json.load(f)
            request["_file"] = message["request"]
            started = time.time()
            reply = run(request)
            with open(message["result"] + ".part", "w", encoding="utf-8") as f:
                json.dump(reply, f, separators=(",", ":"))
            os.replace(message["result"] + ".part", message["result"])
            say({"id": ident, "ok": True, "seconds": round(time.time() - started, 3), "parts": len(reply["parts"])})
        except Exception as error:  # one failed tool never stops the engine
            traceback.print_exc()
            say({"id": ident, "ok": False, "error": str(error) or error.__class__.__name__})


if __name__ in ("__main__", "<run_path>") or (bpy.app.background and "--styk-engine" in sys.argv):
    serve()
