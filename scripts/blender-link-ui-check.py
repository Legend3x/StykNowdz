# Runs inside a real Blender window (CI: under Xvfb) after desktop/blender/styk_link.py:
# presses Ctrl+S's operator like a person would and waits for the link to write
# incoming.seq, proving the save -> send path and the sidebar panel work.
import bpy, os, sys, time

folder = sys.argv[sys.argv.index("--styk-session") + 1]
started = time.time()


def save():
    window = bpy.context.window_manager.windows[0]
    with bpy.context.temp_override(window=window):
        assert "STYK_PT_link" in dir(bpy.types), "the 3D Nowdz sidebar panel is registered"
        bpy.ops.wm.save_mainfile()
    return None


def wait():
    if os.path.exists(os.path.join(folder, "incoming.seq")):
        print("ui-check: Ctrl+S sent the model in %.1fs" % (time.time() - started))
        with bpy.context.temp_override(window=bpy.context.window_manager.windows[0]):
            bpy.ops.wm.quit_blender()
        return None
    if time.time() - started > 90:
        print("ui-check: nothing was sent after saving")
        os._exit(1)
    return 0.5


bpy.app.timers.register(save, first_interval=3)
bpy.app.timers.register(wait, first_interval=4)
