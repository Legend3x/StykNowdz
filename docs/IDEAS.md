# StykNowdz ideas from reference videos

Notes taken from Blender tutorial clips, to plan what 3D Nowdz needs.
Each idea lists what the video shows, what 3D Nowdz has today, and what
building it means. Nothing here is built yet unless marked **Done**.

## Videos watched (2026-11-07)

1. Anime cel shading tutorial (witch girl; chapter "Creating cel shading
   outlines") and its finished turnaround.
2. "How to make Anime girl in Blender 3.6 [Timelapse]" (Kumo Blender 2):
   face poly modeling from a front/side reference sheet, then body.
3. Same series: anime eyes, eyebrows, lashes and ears.

## The anime / cel look

| Seen in the video | 3D Nowdz today | To build |
| --- | --- | --- |
| Flat "Emission" colors, no lighting | **Yes**: 3D models already draw flat | Nothing |
| Black outlines (inverted hull: Solidify, flipped normals, black backface-culled material) | **Done (1.4.0)** | Per-part Outline (on/off, thickness, color), added as an inverted hull when the model goes to the animation. The stage already hides back faces, so no renderer change |
| Thin lines in places (vertex group on the Solidify) | No | Paint where the outline is thinner (later, with weight painting) |
| Hard two-tone shadows that stay put as she turns | **Done (1.4.0)**, with a clean cut along the shadow line | A light direction plus a shadow color per color; the renderer picks lit or shadow per triangle. Renderer change |
| Soft oval shadow under the feet | No | Optional ground shadow under the figure |

## Modeling workflow

| Seen in the video | 3D Nowdz today | To build |
| --- | --- | --- |
| Front / side reference sheet behind the model, faded | **Yes**: per-view references with opacity | Maybe "show in front", and one sheet cut into front / side views |
| Start from one point and extrude points and edges along the drawing's outline, then fill faces between them | **Done (1.5.0)**: Single point, E, Ctrl+click, F, Bridge | Grid fill (fill a ring with a grid of quads) could come next |
| Mirror with "Clipping" (centre points stay on the centre line) | **Done (1.4.0)** | Clipping toggle |
| Loop cut, inset, extrude, merge At Center, fill | **Yes** | Nothing |
| Proportional editing (soft circle; neighbours follow smoothly) | **Done (1.4.0)**: Soft select (O) | Soft select with a radius (scroll to resize) for move / rotate / scale and dragging |
| Shear tool | **Done (1.4.0)** | Shear (Shift+Ctrl+Alt+S in Blender) |
| Sculpt Grab brush to push the face to match the drawing | No | A small sculpt set: grab, smooth, inflate |
| Subdivision (Catmull-Clark) | **Yes**: smooth 0-3 | Nothing |

## Anime eyes, brows, lashes, ears (video 3)

The eyes are **not pictures**: they are flat pieces of mesh in front of the
face, each face given a different flat color.

- Iris: a Circle mesh, inset into rings: dark outer ring, red middle, a lighter
  crescent at the bottom, black pupil, white highlight dot. 3D Nowdz can
  already color each face; the **Circle** shape was added in 1.4.0.
- Eye white: a flat shape following the drawing.
- Brows and lashes: thin curved strips (a plane, subdivided, bent along the
  drawing). Doable today with plane + subdivide + move; soft select would make
  it much faster.
- Ear: a few faces pulled out of the head with proportional editing.

## Suggested order

1. ~~Outline + toon shadow~~ (1.4.0)
2. ~~Soft select + shear + mirror clipping~~ (1.4.0)
3. ~~Circle shape~~ (1.4.0); ~~loose points / edges for drawing-led modeling~~ (1.5.0)
4. Ground shadow, sculpt brushes, thinner-line painting

## Anime face from one point (Martix 3D, part 1 of 3, 0:00-3:00) — gaps done in 1.6.0

Checked against 1.5.0. Steps in the video, in order:

| Step in the video | 3D Nowdz today | Gap |
| --- | --- | --- |
| Front / side references; cube, M › At Center down to one point | **Yes**: references, Add › Single point, M merges at the centre | Nothing |
| Mirror with Clipping + Merge; extrude the chin, outline the face with few points | **Yes**: mirror + "Keep the middle joined", E, Ctrl+click | Nothing |
| Proportional editing, falloff **Sharp**, pull the jaw forward; later scale with it | **Partly**: soft select (O, scroll for radius) works with G / R / S | Only one (smooth) falloff. Add a falloff picker: Smooth, Sphere, Root, Sharp, Linear, Constant |
| Shift+D one point, outline the eye with 12 points, close the loop | **Yes**: Shift+D on points, E, F joins two points | Nothing |
| Select the eye loop, E, then scale it outward (eye ring of quads) | **Partly**: E turns a wire loop into quads | **Alt+click on a wire loop does not select it** (only face edges); box select or L works. **S during the move is ignored**, and right-click undoes the whole extrude (Blender keeps the new faces and only cancels the move). For now: E, Enter, S |
| Shear tool to tilt the loop; match side view; check from top (Numpad 7) | **Yes** | Nothing |
| Alt+click the **outer border** of the ring and extrude again, out to the face edge | **No**: edgeLoop stops at border points (3 edges), so it picks 2 points, not the border | Border loops in edgeLoop (follow open edges) and on wires |
| Fill between the eye ring and the centre line, clipping on | **Yes**: F / Bridge + clipping | Nothing |
| Loop cut twice across the ring, move edges back | **Yes**: Ctrl+R works on closed rings | Number of cuts (scroll) would save repeats |
| Nose: extrude border edges twice, down over the lip | **Yes**: E on open edges | Nothing |
| Loop cut, E a point out, E up and join to another point (nostril) | **Yes**: E on a point, F to join | Auto-merge when a dragged point lands on another would match Blender's snap-to-vertex |

Worth doing first: border / wire loop select, S and R allowed while an extrude's
move is running (and right-click keeping the extrusion), proportional falloff types.

## Anime face, parts 2-3 (Martix 3D, 3:00-9:15 of 9:28) — gaps done in 1.6.0 (smooth-shaded preview not yet)

The rest of the video repeats the same few moves: extrude a point or edge,
join it to another point, fill the gap with F, loop cut, nudge points to the
references. Nose bridge, mouth, lips, chin, cheeks, forehead, then the top of
the head traced as lines and filled.

| Step in the video | 3D Nowdz today | Gap |
| --- | --- | --- |
| Nose: join points, fill a face, loop cut, extrude down | **Yes** | Nothing |
| **Edge slide** (G G) and **loop cut and slide**: "slide this edge closer to the middle", "slide the cut to the side", used about 6 times | **No**: Ctrl+R always cuts at the halfway point; G moves points freely, off the surface | Slide along the edges after a loop cut (mouse picks the spot) and G G edge slide |
| Shade smooth; Shift+N to fix inside-out faces | **Yes**: Shift+N (Fix inside-out faces); the stage uses smooth normals for toon | Optional smooth-shaded preview in the modeler |
| Mouth: copy a point, extrude two lines for the lip slit, join them, extrude the edges outward into lip quads | **Yes**: Shift+D, E, F / Bridge, E on lines | Nothing |
| Puff the upper lip forward, lower lip flatter (side view) | **Yes** | Nothing |
| "Loop cut them twice", "one more loop cut and space them out" | **Partly**: one cut per Ctrl+R | Scroll for more cuts at once, spaced evenly |
| Fill gaps between pieces (F), connect chin to lip | **Yes** | Nothing |
| Merge these points at the centre to close the forehead; merge points to make the head less dense | **Yes**: M | Nothing |
| Trace the top of the head as lines, extrude an edge along them, join and fill | **Yes**: E on points / edges, F | Alt+click loop select on those lines (see part 1) |

The whole video can be followed in 3D Nowdz today. Edge slide / loop cut slide
is the one move used often enough that its absence would be felt; the rest are
part 1's gaps (wire and border loop select, S right after E, falloff types).

## Face rig ("Easy Facial Rig in Blender in 90 sec", Quickie Tuts #08) — done in 1.6.0 (face bones, face weights, Move to selection, face badge); still open: live symmetry while dragging bones, expression sliders panel

Rigify: Add › Armature › Human (Meta-rig), delete all but the face bones, snap them
to the face in edit mode with symmetry on, Generate Rig, Ctrl+P › With Automatic
Weights, then pose. Eyeballs: origin to geometry, cursor to selected, snap the eye
bone there, Ctrl+P › Bone. Pose by moving small handles (brows, lids, lip corners,
cheeks, jaw).

| Step in the video | 3D Nowdz today | Gap |
| --- | --- | --- |
| Ready-made human rig to start from | **Body only**: Humanoid skeleton (hips, spine, neck, head, arms, legs) | **No face bones**: a face template (jaw, lips, lip corners, cheeks, brows, lids, eyes) placed on the head |
| Edit bones with symmetry on | **Yes**: Symmetrize, .L / .R names | Live symmetry while dragging a bone would match |
| Automatic weights | **Yes**, but tuned for limbs: each point is mostly given to its nearest bone | Many small face bones would move skin in chunks; face bones need a soft falloff and should be weighted as a group |
| Eyeball follows the eye bone (Ctrl+P › Bone) | **Yes**: part's "Follows bone" | Nothing |
| Snap a bone to the middle of the eyeball (cursor to selected) | **No** snap | "Put bone at selection centre" |
| Pose with small handles on the face | **Untested**: every bone becomes a joint on the stage | Check floating bones (head not on the parent's tip) and dozens of tiny joints crowding the head; may need a face-handles layer or hiding |
| Bone layers to hide the deform bones | **No** | Show/hide groups of bones |
