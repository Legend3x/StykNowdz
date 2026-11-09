# StykNowdz 3D roadmap

Status: plan only, nothing implemented yet. Order: (1) Make 3D for flat sticks,
(2) import 3D models, (3) a simple in-app 3D builder.

## What already exists (inherited from StykAnimate)

StykNowdz already has a real 3D rig engine. Each step below builds on it rather
than adding a second 3D system.

| Piece | Where | What it gives us |
| --- | --- | --- |
| Spatial bones | `_stykRig.spatial = {parent, origin, tip, turn, pitch}` in `src/rig-spatial.mjs` | A segment with a 3D rest origin/tip. Turn and tilt come from the angle channels of two control joints. Depth is derived and never stored per frame. |
| Skin points | `_stykRig.spatial = {point, bindings, viewPoints?}` | Joints that ride on up to 4 bones, with optional 4- or 8-view targets (turnaround correction). |
| Figure meshes | `_styk.spatialMesh` in `docs/SPATIAL-MESHES.md` | Dense triangle meshes bound to spatial bones, depth-tested on GPU and in software. |
| Posing tools | `src/editor-spatial.mjs`, `src/spatial-gizmo.mjs` | Rotate figure, the Turn / tilt pad, the D key to pose in depth, spatial IK, perspective in the Character rig inspector. |
| One-sided fills | `_stykSurface` in `docs/RIG-CONSTRAINTS.md` | Front/back culling and depth-guided Z-order for polyfills. |
| Test helper | `spatialFixture()` in `tests/rig-spatial.test.mjs`, `construction()` in `src/rig-examples-3d.mjs` | A known-good way to build spatial figures in code. |

The gaps for flat sticks like Pivot or Stick Nodes figures:

1. **No authoring path.** Spatial data can only be written in native definition
   data. Build Figure cannot create it (see "Spatial bindings are currently
   authored in native definition data" in `docs/RIG-CONSTRAINTS.md`).
2. **No depth.** A .piv/.stk segment is only a 2D length, angle and thickness. The
   Goku test file has about 790 figure pieces and no Z values.
3. **Segments don't re-sort by depth.** A segment's draw order is its static
   `z_order` (`src/pivot/geometry.mjs`, around line 772). Only fills with
   `_stykSurface.depth` guides move in Z. After a turn, an arm behind the body
   would still draw in front of it.

## Step 1: Make 3D (pseudo-3D for any stick)

Goal: right-click any figure, choose **Make 3D**, and turn it freely with the
existing Rotate figure / Turn / tilt tools. It should work on single sticks and
on big joined Pivot assemblies.

### 1.1 Converter: flat figure → spatial figure

New module `src/spatial-convert.mjs`, exposed as an undoable editor command
`makeFigure3D(options)` in `src/editor-spatial.mjs`.

For each segment of the figure definition:

- Compute the rest pose in figure space from the definition's lengths and angles
  (the same evaluation the builder uses), giving `start = (x, y)` and `end = (x, y)`.
- Write `spatial = {parent: <parent segment's id or 0>, origin: [x0, y0, z0],
  tip: [x1, y1, z1], turn, pitch}`. The Z values come from 1.2.
- Keep `segment_id`, names, colors, shapes (Triangle, Trapezoid, Ellipse, Polygon,
  Curve) and thickness. Only `_stykRig` is added, so undo, saving and
  Pivot/Stick Nodes provenance stay intact.

Turn and tilt controls: the validator only requires `turn !== pitch`. The
cheapest layout is:

- one root pair (**Figure turn**, **Figure tilt**) for the root bone, and
- one shared zero pair (**Rest turn**, **Rest tilt**) for every child bone.

That adds 4 hidden, static, zero-length segments per figure instead of 2 per
bone. A 30-segment stick would otherwise gain 60 control joints, and Goku would
gain thousands.

**Spike result (done, `tests/spatial-shared-controls.test.mjs`):**

| Case | Shared pair | Per-bone pairs |
| --- | --- | --- |
| Rest pose | identical | identical |
| Whole-figure turn/tilt (root controls), 4 angle sets | identical | identical |
| Ordinary 2D drag of a child bone | identical | identical |
| 3D posing of one child (`setSpatialPose` turn) | **leaks**: its siblings move too | correct |

The leak happens because `setSpatialPose` and `_setSpatialWorldOrientation`
(the D-key and twist gestures) add the new turn/tilt to the bone's own control
angles in `o.angles`, and those controls are shared.

**Decision: hybrid.**

- Child bones use the shared rest pair by default.
- Bones marked **Free 3D joint** get their own pair. The converter auto-marks
  the root, any bone with two or more child branches (shoulders, hips) and
  bones named like neck/head/shoulder/hip/knee/elbow, and the user can change
  the marks in the dialog.
- Guard: 3D posing (Turn / tilt pad, D-key depth drag, twist, Rotate) on a bone
  that uses the shared pair is refused with "Make this a Free 3D joint first",
  plus a one-click button that adds its pair as one undoable definition edit.
  Ordinary 2D dragging keeps working everywhere.

**Goku numbers** (decoded with `codecs/piv_codec.py`): 1,061 figure types,
10,629 segments in total, 762 polyfills, 17 frames. Frame 1 has 494 objects
(2,417 segments), 490 of them joined into one assembly. Most pieces have 1–10
segments, so the 3D turning mostly happens between pieces, at the joins, not
inside them. Pieces are swapped between frames (most frames share no objects
with frame 1), so the side-view depth mode can only match this file by figure
type, and only partly.

Fills: every polyfill gets `_stykSurface.depth = [its joint IDs]` so its Z
follows its corners. Fills stay double-sided by default, with an opt-in
**One-sided** toggle for things like faces.

Refuse cleanly (no partial edit) for figures that already have spatial data,
movieclips, and figures whose IK or connectors the converter can't map yet. The
refusal message should name the part.

### 1.2 Where depth comes from

All modes write only `origin[2]` and `tip[2]`, so they can be mixed and re-run.

| Mode | How it works | Best for |
| --- | --- | --- |
| **Flat (layered)** | `z = (z_order - mean) × spacing`. Front view looks identical to before; turning shows the layers as stacked cards. | Instant default, and any figure |
| **From side view** | The user picks a frame where the same figure is drawn in side view. Joint IDs match between frames, so `z_i = (sideX_i - sideRootX) × facing`, and the front frame supplies X and Y. | Turnarounds like your head turnaround idea; the most accurate mode |
| **Symmetry guess** | Detect mirrored branches (left/right arm and leg by name or by mirrored rest angles) and push them to ±Z by their X offset from the spine. | Ordinary human sticks |
| **Paint depth** | A side-view editing mode: the figure is shown turned 90°, and dragging a joint left/right sets its Z. Brush mode nudges many joints at once. | Fixing any of the above by hand |

For the Goku file, the side-view mode needs a side-view frame of the same
pieces. Without one, use Flat plus Paint depth on the hair spikes and limbs.

### 1.3 Depth-sorted drawing

Add an opt-in per-figure flag `_styk.depthSort: true`, set by Make 3D. In
`buildGeometry` (`src/pivot/geometry.mjs`), when the flag is set, give each
segment render `z = base z_order + k × depth(mid-point)` instead of the static
`z_order`. The depth comes from the bone frames already evaluated
(`renders[i].spatialFrame`). Fills already do this through `_stykSurface.depth`.

- Use stable sorting with a small hysteresis band, so parts at nearly equal
  depth don't flicker while turning.
- Joined assemblies: Pivot pieces are separate objects, so sorting inside one
  figure isn't enough for Goku. Add a second pass that orders the objects of
  one joined group by mean depth, within that group's painter slot only, so
  layers outside the group are untouched.
- Exports, playback workers, onion skins and WebGPU all read the same `z`, so
  there's no renderer-specific code. Re-run `npm run benchmark:dense` because
  this sits on a hot path.

### 1.4 Turning joined Pivot assemblies

Goku is a main figure with many pieces joined to it. The existing joined
spatial followers (`joinedSpatialFollowers`) and Rotate figure already carry
joined spatial children with their parent. So **Make 3D** on the selected
figure should offer **Include joined figures**, converting every figure in the
connected group in one undo step and giving them a common Z reference (the
joint each piece is joined to).

### 1.5 UI

- Right-click figure → **Make 3D…** opens a small dialog: depth mode, spacing
  slider, Include joined figures, and a live preview turning slowly.
- After conversion, the Character rig inspector already shows Rotate figure,
  Turn / tilt and Perspective. Add **Edit depth** (Paint depth) and
  **Make flat again** there. Make flat again removes the spatial data and keeps
  the current front-view pose.
- Changelog entry, once working: "Make 3D: turn any stick figure in depth,
  including joined Pivot figures."

### 1.6 Saving and compatibility

- .styk/.stkz store everything natively. `_stykRig` and `_styk` already round-trip.
- Pivot .piv/.stk export can't hold spatial data. Export the current projected
  pose as ordinary flat segments with a one-line notice. Never fail silently.

### 1.7 Tests

- `tests/spatial-convert.test.mjs`: converting at turn 0 gives every joint
  within 0.01 of its original position. 180° gives X mirrored around the root.
  Undo restores the exact original definition. Every shape type survives.
- Side-view depth: construct two frames from `spatialFixture()` and check the
  recovered Z.
- Depth sort: a two-arm figure turned 180° swaps the arms' draw order, with no
  swap flicker at ±0.5° around the crossing.
- Goku smoke test (`scripts/smoke-make-3d.mjs`, kept local because the file is
  not ours to commit): import, Make 3D with joined figures, turn 0→360 in 15°
  steps, and record frame time and memory.

### 1.8 Milestones (each one committed separately)

1. ~~Spike: shared turn/tilt controls (1.1).~~ Done: hybrid, see 1.1.
2. ~~Converter with Flat depth, plus tests.~~ Done, see "Built in milestone 2" below.
3. Depth-sorted segments, plus the joined-group pass and benchmarks.
4. Make 3D dialog and Make flat again.
5. Side-view depth and symmetry guess.
6. Paint depth mode.
7. ~~Include joined figures, tested on Goku.~~ Done in 1.1.0, see "Built: whole-group Make 3D" below.

### Built in milestone 2

Code: `src/spatial-convert.mjs` (pure converter), `src/editor-make-3d.mjs`
(`makeFigure3D`, `makeFree3DJoint`, guard), right-click **Make 3D** /
**Make free 3D joint** and palette commands in `src/app.mjs` and
`src/ui/command-catalog.mjs`. Tests: `tests/spatial-convert.test.mjs`,
`tests/spatial-shared-controls.test.mjs`.

Changes from the original plan, found while building:

- **Figure rotation is the root 3D bone.** Figure rotation is read from
  segment 0, so a hidden zero-length **Figure rotation** joint is inserted
  first. It's a spatial bone driven by **Figure turn / Figure tilt**, and every
  original root part hangs from it spatially. That makes a whole-figure turn
  rigid even for figures with several root parts (the Walker's spine and legs).
  Turn the figure by selecting that joint: `setSpatialPose(..., {wholeFigure: true})`.
- **Controls sit on the figure origin** (parent 0). A bone can't own the
  controls that drive it (the rig reports a cycle), and controls on segment 0
  would be such a case.
- **Free joints by default:** any part whose parent joint has two or more
  children, including the figure origin (hips), plus parts with body-part names.
- **3D length channel:** a bone leaning in depth has a longer 3D chord, so its
  length channel is scaled by 3D chord / flat chord (definition and any
  per-instance lengths). At turn 0 the projected length is exact.
- **Curved parts:** spatial bones used to ignore native bends (drawn straight,
  ends moved). Converted bones carry `curve: true` in `_stykRig.spatial`:
  `evaluateSpatial` aims the bone along the arc's chord (angle + b/2, length ×
  sinc(b/2), with the rest bend reversed under reflection) and
  `buildGeometry` draws the native arc between the projected ends. Assets
  without the flag behave exactly as before.
- **Guard:** on a bone sharing its controls, Turn / tilt, depth swings and
  twists are refused with a hint to use Make free 3D joint. Plain drags still
  work and bend the part in its own plane.
- **Refused for now:** figures with rig relationships, IK turned on, an
  animation origin, movieclips and drawings. Fills keep their painter order:
  their depth guides need reference joints, so they move to milestone 3.

Measured on Goku (frame 1, biggest piece: 23 segments, 15 instances): Make 3D
takes about 80 ms, every one of the scene's 2,911 joints stays within 0.0001 px,
a quarter turn takes about 5 ms, and two undos restore it exactly.

### Built: whole-group Make 3D

Code: `src/spatial-convert-group.mjs` (assembly, layered and side-view depth),
`makeGroup3D` and `turnJoinedPieces3D` in `src/editor-make-3d.mjs`,
right-click **Make whole group 3D…** in `src/app.mjs` (asks for an optional
side-view frame). Tests: `tests/spatial-convert-group.test.mjs`.

- **One definition per piece, baked from its on-screen pose.** Joined figures
  don't inherit a parent's 3D orientation, so every piece must turn about the
  same screen axes: its rest pose is its current pose (figure rotation 0,
  drawn unmirrored in that frame; lines look identical). Types are shared
  widely in Pivot assemblies (Goku frame 11: 175 pieces, 79 types), so each
  piece gets its own new definition. The same pieces in other frames switch
  too, keeping their own lengths and bends.
- **Turning together:** a whole-figure turn/tilt on a piece (Rotate figure)
  also turns every 3D piece joined below it, inside the same drag and undo
  step. Yaw is shared; tilt follows each piece's reflection. Tests check that
  all 3D distances between joints are kept.
- **Depth:** layered (paint order across the whole assembly) or from a
  side-view frame. Side-view pieces are matched by figure type and height on
  the body, because join paths differ between turnaround views (matching by
  join path found 3 of 175 on Goku; by height, 130). Unmatched pieces sit at
  their attachment's depth. Facing comes from draw order; scale from the
  views' heights.
- **Goku:** frame 11 (front) with frame 9 (side) converts 175 pieces in about
  0.2 s with nothing moving, and a 90° turn gives a side view close to the
  artist's frame 9. Back views show the front artwork from behind, and parts
  overlap wrongly until milestone 3 (depth-sorted drawing).
- Refused for now: layer-sheet projects and frame sources (Pivot-style
  keyframe animations only).

## Step 2: Import 3D models (outline)

No three.js is needed: the app already renders `_styk.spatialMesh` with depth
testing.

- Add a `.glb` / `.gltf` importer (`codecs/` or `src/import-gltf.mjs`) that reads
  positions, indices and base colors (one palette entry per material) into
  `spatialMesh`. Keep it within the validator's bounds of 200k vertices and 400k
  triangles.
- Skinned models: map glTF joints to spatial bones (`origin`/`tip` from the
  inverse bind matrices) and JOINTS_0/WEIGHTS_0 to four `bones`/`weights` slots.
  Unskinned models bind to one root bone.
- Result: a 3D model becomes a posable figure that uses the same Rotate,
  Turn / tilt, perspective and IK as Step 1, and can be traced over as a
  reference layer (lower opacity, locked).
- Textures are out of scope at first (palette colors only), and so are glTF
  animations.

## Step 3: 3D Nowdz, a simple 3D builder (planned)

Requested as a fallback in case pseudo-3D isn't enough. The app already
renders depth-tested 3D meshes bound to 3D bones (`_styk.spatialMesh`,
docs/SPATIAL-MESHES.md) on GPU and in software, with saving, undo and
playback, but meshes can only be authored outside the app. 3D Nowdz adds
in-app authoring on top of that, with no new renderer.

Milestones:

1. **3D viewport mode** in Build: orbit (right-drag), pan, zoom, front/side/top
   buttons, a ground grid, and an X/Y/Z gizmo. It reuses the spatial projection
   and gizmo code (`src/spatial-projection.mjs`, `src/spatial-gizmo.mjs`).
2. **Primitives:** add a box, cylinder, sphere, capsule or cone to a 3D bone as
   generated `spatialMesh` triangles (size, segments, color), so a body can be
   blocked out quickly. Each primitive is a named triangle group, so it can be
   selected and recolored.
3. **Move / rotate / scale** primitives and bones with the gizmo, numeric
   fields, snapping and mirror (X symmetry for characters).
4. **Simple edit mode:** select vertices, faces or edges of a primitive. Move,
   extrude and inset faces, merge vertices, flip normals. No sculpting or UVs.
5. **Skinning made simple:** a primitive follows the bone it was added to
   (single-bone weights). Smooth weights across a joint come later.
6. **Bones in 3D:** draw new 3D bones directly in the viewport (Make 3D
   creates bones by conversion; here they're authored).
7. **Import/export .glb** (Step 2) so models can go to and from Blender.

Out of scope: sculpting, textures/UVs, modifiers, physics, rendering
settings. Those stay in Blender, through .glb import.

## Step 3 (earlier outline)

Built after Steps 1–2, on the same data:

- **3D stick builder**: Build Figure gains a 3D view (orbit with right-drag)
  where new segments are drawn in 3D, so spatial bones get authored directly
  instead of converted.
- **Primitive parts**: add a box, cylinder, sphere or capsule mesh bound to a
  bone (generated `spatialMesh` triangles), to block out bodies quickly.
- **Turnaround views**: author 4/8-view `viewPoints` for a head or hair clump
  from drawn front/side/back frames, using the existing view-corrected skin.
- Full mesh modeling (edit vertices, sculpting, UVs) stays in Blender. Import it
  through Step 2.
