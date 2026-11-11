# 3D Nowdz

A 3D modeler inside StykNowdz for making characters and props, which then pose
and animate like any other 3D figure. Open it from the **Model** tab beside
Animate, Draw and Build (it edits the selected model, or starts a new one),
**File › New 3D model**, the command palette ("3D Nowdz"), or right-click a
figure made in it and choose **Edit 3D model**. Opened from the tab it sits
under the band, so Animate, Draw or Build take you back (asking first when
there are changes); the animation's history, Save, Export and menus wait until
it closes.

It needs no new renderer: a finished model becomes an ordinary figure of the
existing 3D engine (`_styk.spatialMesh` skinned to spatial bones, see
docs/SPATIAL-MESHES.md and docs/RIG-CONSTRAINTS.md).

## Using it

| Area | What's there |
| --- | --- |
| Top bar | Object / Edit / Bones modes; Points / Edges / Faces in Edit; Move, Rotate, Scale (keys only on narrow windows); Undo, Redo; Front, Side, Top; perspective or flat view; Frame; File (Import OBJ or glTF, Export OBJ, Export GLB, Start over); the keyboard button (the controls card); Close (or any other workspace tab: the unfinished model is kept as a draft, see below); **Add to animation** (or **Update figure**) |
| Left | Parts list (click, Shift-click, double-click to rename, ● to hide), Add (Base character and primitives), Duplicate, Delete; the color palette (click to paint, right-click to change a color, + to add one) |
| Right | Properties for the mode: part position, rotation, size, Mirror left and right, Smooth 0–3, Moves with (a rigid bone or automatic); Edit tools; Skeleton tools and the selected bone; View toggles; reference images |
| Controls card | Shown over the viewport when 3D Nowdz opens: the main keys in four groups (Look around, Select, Shape, Bones). "Don't show this when 3D Nowdz opens" remembers the choice on this computer (`localStorage` key `stykNowdz.modeler.hideControls`); the keyboard button in the bar opens it again. Esc, Got it or a click outside closes it |
| Viewport | Right-drag or Alt-drag to orbit, Shift+right-drag to pan, scroll to zoom; click to select; drag what's under the pointer to move it (see Dragging), drag empty space (or Shift-drag) for a box; the status line says what the current tool expects |

### Modes

- **Object**: arrange whole parts. Start from the **Base character** (eleven
  parts with a matching 19-bone skeleton) or a cube, sphere, capsule, cylinder,
  cone, ring or plane. Join parts into one, or hide them while working.
- **Edit** (Tab): shape the selected part. Extrude (E), Inset (I), Loop cut
  (Ctrl+R), Subdivide, Merge (M), Fill (F), Delete (X), Duplicate (Shift+D),
  Separate (P), Select all (A), Select connected (L, Ctrl+L), Grow (Ctrl++),
  edge loops (Alt+click), Flip faces, Fix inside-out faces (Shift+N),
  Symmetrize, Merge doubles, and the tools ported from Blender below (Bevel,
  Knife, Dissolve, Merge options, Grid fill, Rip). Points behind the model can't be picked unless
  X-ray is on, as in Blender.
- **Bones**: Humanoid skeleton (fitted to the model's size), Add bone, Extrude
  bone (E), Delete, Mirror .L to .R; click a bone to select it and drag its
  joints (see Dragging). With one bone selected the model shows what it moves,
  blue (nothing) to red (fully). Bones mode sets the skeleton's rest shape: the
  mesh doesn't follow, as in Blender. Posing happens on the Animate stage.

### Toon look (cel shading)

The anime look from Blender tutorials, built in:

- **Ink outline** (part panel, Look): an inverted hull, the same trick as
  Blender's Solidify modifier with flipped normals and a black back-face-culled
  material. A copy of the part is pushed out by the line thickness and turned
  inside out; only its far side faces the viewer, so it shows as a rim around
  the silhouette and along deep creases. It shares the part's skin, so it bends
  with the bones. `src/modeler/toon.mjs` (`outlineHull`) builds it, and its
  topology is validated like any edit. Open shapes (a plane, a circle) get no
  rim, as in Blender.
- **Toon shadows** (Toon look section): a light fixed to the viewer (side and
  height), a shadow size and darkness. On the stage
  (`src/spatial-mesh.mjs`), each vertex gets a smooth normal from the posed
  mesh, and triangles that straddle the lit/shadow cut-off are split along the
  exact line, so the edge is a clean curve rather than a staircase of faces.
  Shadow colours are worked out from the colours shown
  (`src/toon-shading.mjs`), so recolouring a figure recolours its shadows.
  Parts with **Takes shadows** off, and all outlines, stay flat.
- **Toon preview** (View) shows 3D Nowdz's viewport the same way.
- **Line weight** (Edit mode, *Toon look of selected points*): each point's
  outline thickness factor (0–4; 0 = no line, 1 = the part's thickness).
  **Taper** thins it from the selection's root (where it joins the rest of the
  mesh) to 0 at the far end, for sharp hair tips and lashes (`taperWeights`).
- **Colour from the part** (Look): instead of one ink colour, each outline face
  takes a darker shade of its own face's colour (`inkColor` in
  toon-shading.mjs, *Darken* 0–1), for coloured line art. Shell faces carry
  `ink`; on export each (colour, darken) pair becomes one stage colour.
- **Shading normals** (Edit mode, same section): custom normals for toon
  shadows, like Blender's Normal Edit / Data Transfer tricks for anime faces:
  *Face front* (the model's front), *Face view* (the current view), *Like a
  sphere* (away from the part's middle: soft shadows without nose and cheek
  bumps), *Flatten* (one shared normal), *Reset*; *Strength* blends from the
  shape's own normal (`shadingNormals`). They change only shading: outlines
  still follow the shape.

Per-point data lives in `mesh.vdata = {line: {[point]: weight}, normal:
{[point]: [x, y, z]}}` (sparse; missing = default). `cleanup` renumbers it with
the points, `atomic` restores it when an edit is refused, transforms turn
normals with the inverse transpose, the mirror modifier and Symmetrize mirror
it, and Catmull-Clark gives new points the mean of their sources (a normal
only where all sources have one). Points added by an edit start at the
default. `readModel` keeps line weights in 0..4 and unit normals on existing
points, and drops the rest.

Stored on the figure as `_styk.spatialMesh.toon = {light, threshold,
strength, flat}` (`flat` lists part groups drawn without shadows), plus
`normals` when any point has a custom shading normal; a model
keeps `toon` and each part's `outline` / `shadows` for re-editing.

### Soft select, shear, clipping, circle

- **Soft select (O)**, Edit mode: points within the radius of the selection
  follow the move, rotate, scale, shear or drag part of the way (measured in
  world space). **Falloff** picks the curve, as Blender's proportional editing:
  Smooth, Sphere, Root, Inverse square, Sharp (pulls stay near the selection,
  the jaw-and-chin choice in anime-face tutorials), Linear or Constant
  (`SOFT_FALLOFFS`). Scroll while moving to change the radius;
  a dashed circle shows it. Each point gets its own matrix (`softWeights`,
  `transformMeshEach`). **Connected only (Alt+O)**, as Blender's: distance is
  measured along the mesh's edges and lines from the nearest selected point
  (Dijkstra over faces' edges and traced lines), so only points joined to the
  selection follow: an upper eyelid moves without the lower one passing close
  by.
- **Shear** (Ctrl+Alt+Shift+S or the Edit panel): slants the selection along
  the view's right (or a locked X/Y/Z) by its height in the view
  (`matrix.shearing`).
- **Keep the middle joined (clipping)**, on mirrored parts (on by default):
  points on the mirror line stay there and none cross it (`clipToMirror`).
- **Circle** (Add): one flat disc facing the front, for eye rings (inset it).

### Tracing a shape point by point

The anime-face method ("extrude a single vert"): start from one point and draw
the outline like dot-to-dot over a reference drawing, then fill faces.

| Step | How |
| --- | --- |
| Start | Add › Single point (opens Edit mode with it selected) |
| Next point | E, move, click (pulls a new point out of the selected one), or Ctrl+click where it should go |
| Start a new line | Deselect (Alt+A), then Ctrl+click |
| Join two points | Select both, F |
| Face from a ring | Select a closed ring of traced lines, F (keeps the ring's order) |
| Fill between two lines | Select both lines, Bridge (Ctrl+E): quads, or triangles where one line has more points; two rings make a tube |
| Grow a strip | Select a traced line (or an open border), E: quads |

New faces face the viewer unless they touch older faces, whose winding they
follow. On mirrored parts the other half shows dashed, and with clipping on a
point can't cross the middle.

**Data.** A mesh may carry `edges` ([[a, b]]: wire edges, lines with no face
yet) and `loose` ([i]: single points kept on purpose). The topology check adds
W1 (a wire joins two different existing points), W2 (a wire appears once and
isn't also a face edge) and L1 (a loose point exists, is listed once and is
used by nothing else); H7 now accepts points on wires or listed as loose.
Every edit keeps them consistent: `tidyWires` (run by every atomic edit) drops
wires that became face edges, `cleanup` renumbers them, and deletes, merges,
duplicates, joins and symmetrize carry them. Evaluation (`evaluatePart`)
takes only the surface, so traced lines never reach the stage, the outline
shell or export.

### Loops, loop cuts and slides

| Tool | How |
| --- | --- |
| Loop select | Alt+click an edge: a loop through quads, a whole open border (the outer edge of an eye ring), or a traced line through points with exactly two lines (stops at forks and ends). Shift+Alt+click adds |
| Loop cut | Ctrl+R, point at an edge, scroll (or + and -) for more cuts (up to 16, spaced evenly), click. A single cut then slides with the pointer along the ring; click or Enter places it, right-click or Esc leaves it in the middle |
| Edge slide | G, then G again: the selected points slide along their edges toward the pointer, all by the same share of their edges, so they stay on the surface (`slideNeighbours`, `slideMesh`) |
| E then S | G, R and S during a move, rotate or scale switch to the other one, starting over from where the selection began. Cancelling an extrusion's move keeps the new faces where they were made (E, right-click, S works as in Blender); a traced point's extrusion is undone instead, since a point on top of another is a trap |

`edgeRing` returns the ring end to end, every edge pointing the same way, so a
cut at `t` is at the same place on every quad.

### Dragging

Click and drag works like moving a node in the animation (no key needed):

| Drag | Bones mode | Object mode | Edit mode |
| --- | --- | --- | --- |
| A joint (a bone's end, or a child's start joined to it) | Bends that bone around its start, keeping its length; the bones below follow rigidly | | |
| Ctrl + a joint | Stretches: the joint follows the pointer, the bones below ride along | | |
| A bone's middle | Joined to its parent: bends it. Free: moves it with everything below | | |
| Ctrl + a free bone's start | Moves the start alone | | |
| A part / a point, edge or face | | Moves the selected parts (selecting it first) | Moves the selection (selecting it first) |

Drags move in the view's plane (use Front or Side for clean poses), Shift
snaps, release finishes, Esc or right-click cancels, and each drag is one undo
step. G, R and S still work for axis locks and exact moves.

### Transforms

G, R and S (or the buttons) start a move, rotate or scale that follows the
pointer. X, Y or Z locks to an axis (again to unlock), Ctrl snaps (0.05 units,
15°, tenths), click or Enter finishes, right-click or Esc cancels. Extrude moves
the new faces along their normal; when that points at you, drag up to push it out.

### glTF (.glb / .gltf) with bones

**File > Import OBJ or glTF** reads glTF 2.0: a `.glb`, or a `.gltf` chosen
together with its `.bin` files (data-URI buffers work too). Written from the
glTF 2.0 specification:

- Each mesh becomes a part. Triangles of all its primitives come in at the rest
  pose: a skinned mesh is placed with the file's own joint matrices and inverse
  bind matrices (the skinning sum), others by their node's world matrix. Points
  the file split along UV or normal seams are welded back (merge by distance
  1e-6), winding is made consistent, and the result is checked like any edit.
  Triangles stay triangles (Tris to quads, Alt+J, joins them).
- Base colour factors become palette colours (sRGB). Textures, morph targets,
  animations and compressed files (Draco, meshopt) aren't read; a file that
  requires an extension says so.
- Every skin joint becomes a bone (parent = nearest joint ancestor). Head at the
  joint; tail from `extras.tail` (3D Nowdz's own exports), else the middle of
  its child joints, else along the joint's Y axis for half its parent's length.
  Imported bones join any the model already has.
- The file's weights stay on the points (`mesh.vdata.skin`, bone ids). The
  animation and **Export GLB** use them (`partWeights`); points without them
  (new points from edits, a mirror modifier's other half) get automatic weights.

**File > Export GLB (with bones)** writes the visible parts, evaluated (mirror,
smooth), as triangles with smooth or custom normals, one material per palette
colour (linear factors), and with a skeleton a skin named Armature: one joint per
bone, +Y along the bone like Blender's exporter, inverse bind matrices, up to
four weights per point (normalised). Bone tails ride along in `extras.tail`, so
a model exported and imported again keeps its exact skeleton.

### Depth buffer

The viewport works out every face's colour on the CPU (lighting, toon shadows
cut along the exact shadow line, outline shells), then draws the coloured
triangles through a hardware depth buffer (`depth-pass.mjs`, WebGL with
antialiasing) onto a scratch canvas laid over the background, grid and
reference images. Each pixel shows the nearest surface, so parts that pass
through each other (hair through a head, a collar through a neck) meet along
the right line, and outline shells show only at silhouettes, as in Blender.
Projected points carry `d`, the depth value (1 − near/distance in perspective,
affine in screen space, so plain interpolation is exact; toon shadow splits
interpolate it too). Wire view draws edges with the same depth test, so hidden
edges stay hidden. Picking takes the nearest face at the clicked pixel.
X-ray, and setups without WebGL or after a lost context, fall back to filling
faces sorted back to front on the 2D canvas.

### Both sides of open meshes

Blender draws both sides of every face. Back-to-front sorting can't hide a
closed mesh's far side reliably and the depth buffer doesn't need to draw it, so a closed mesh still skips its far
side (it's hidden anyway), but an open one (a traced band, half a face, a
plane) is drawn and edited from both sides (`isOpenMesh`, `openOf` in
viewport.mjs, cached per face list). Before, a band folded over itself, such
as an eye ring extruded and moved sideways, lost the half that faced away,
along with its edges and points. Toon outline shells stay one-sided.

### Blender's modeling tools

Ported from Blender's own source (GPL-2.0-or-later, compatible with this
project's GPL-3.0-or-later): `source/blender/editors/mesh/editmesh_tools.cc`,
`editmesh_rip.cc`, `editmesh_knife.cc` and `bmesh/operators/` (`bmo_dissolve`,
`bmo_fill_grid`, `bmo_bevel`). The behaviour follows Blender; the code is a
smaller rewrite for this mesh format (src/modeler/mesh.mjs), each edit atomic
and validated like the rest.

| Tool | Keys | What it does |
| --- | --- | --- |
| Dissolve | Ctrl+X | By select mode. Points: the faces around each point become one face without it (a point in a line joins its two edges). Edges: the faces on both sides become one; ends left joining two edges go too (Blender's "Dissolve Vertices" option, on by default). Faces: each touching group becomes one face; a group around a hole is refused |
| Merge | M (menu) | At Center, At First, At Last (selection order), Collapse (each connected group at its own centre), By Distance (selection, or the whole part) |
| Grid fill | Edit panel | A selected closed ring of open edges (a hole or a traced outline), even point count: quads, Span × (ring/2 − Span). Start at the sharpest corner; Span from the next sharpest corner, else ring/4 (`gridFillLayout`). Inner points: a Coons patch of the four sides (Blender blends rails slightly differently). Span and Offset can be changed afterwards in the Edit panel (redoes the fill, like Blender's Adjust Last Operation) |
| Rip | V | Selected edges with faces on both sides: the side nearer the mouse gets its own points, then follows the mouse. Ends inside the surface stay joined (a slit); a line reaching the border cuts through |
| Bevel | Ctrl+B, Ctrl+Shift+B | Edges: a strip at right angles `width` from the edge (Offset mode, slide clamped at 95% of the edge), rounded by Segments (scroll; quadratic profile toward the old corner). Faces between two bevelled edges get the meeting point of the offset lines; corners left open are closed with one face; a corner left joining two edges is dissolved (the cube-corner pentagons). Points: each selected point is cut off by a face |
| Knife | K | Click points on edges or corners (Ctrl: edge middle); between points the cut follows the straight screen line across faces. Backspace removes the last point, Enter/Space cuts, Esc or right-click cancels. Clicks inside a face (away from edges) aren't supported yet |

| Smooth | Edit panel | Each selected point moves Factor of the way to the mean of its neighbours, Repeat times (Vertex > Smooth Vertices). Border points use border neighbours only; a traced line's ends stay put |
| Triangulate | Ctrl+T | Quads split along the shorter diagonal; larger faces by ear clipping in their own plane (concave faces come out right) |
| Tris to quads | Alt+J | Pairs of selected triangles sharing an edge join when they bend less than Max bend and the quad is convex with corners within 45° + Max shape of square; best pairs first |
| Poke | Edit panel | A point in the middle of each selected face, fanned to its corners |
| Fill holes | Edit panel | Every hole touching the selection with at most Sides corners (0 = any) gets one face |
| Shrinkwrap | Edit panel | Applied once, like the modifier's Nearest Surface Point: selected points move to the closest point on the other visible parts (world space, `shrinkwrapPoints`), then Offset out along that face's normal |

Smooth, Fill holes, Tris to quads, Shrinkwrap and Grid fill can be adjusted
after the fact in the Edit panel, like Blender's Adjust Last Operation:
`adjustable()` keeps the state from before the edit, and each change redoes
the edit from it with the new settings (one undo step in all).

Vertex slide is GG on points (the existing edge slide). Not ported yet: Bevel
profile shapes and vertex-only corner patches with several segments (an
n-gon closes them), Knife cuts starting inside a face, Rip of a single point,
Grid fill between two separate lines, Limited dissolve.

### Drafts and starting over

Leaving 3D Nowdz without **Add to animation** (Close or
another workspace tab) never asks and never loses work: the model and camera
are kept as a draft, one for a new model and one per figure being edited, and
saved in `localStorage` (`stykNowdz.modelDraft`) so they survive a restart.
Opening the Model tab again resumes the draft in the mode, part and selection
it was left in (`where` in the draft); a draft with one part comes back with
that part selected. **File > Start over** asks once
and clears parts, bones and references as one undoable step. Add to animation
or Update figure clears the draft.

### Mirror mode and Symmetrize

- **Mirror mode (X)** sits at the top of the Edit panel (and as Mirror left and
  right in Object mode). It mirrors across the world middle (X = 0), which is
  where new parts are now added, so tracing on one side shows the other side
  live. Turning it on says which side holds the points, or warns when every
  point is on the middle; Keep the middle joined (clipping) sits right under it.
- **Symmetrize** (Edit panel) copies one side of the world middle onto the
  other, even for a part placed off the middle: it uses the selection's side,
  or the side holding more of the part, and says which side it kept.

### Modifiers

- **Mirror left and right** builds the −X half from the +X half (across the
  model's middle), welding points on the middle and dropping faces that lie on it.
- **Smooth** is Catmull-Clark subdivision, 0–3 levels.

Both apply live in the viewport and on export; the editable cage stays the
original half and level 0.

### Reference images

Load a front and a side drawing. As in Blender, both stand in the scene and show
from any angle (`referenceCorners`, viewport.mjs): the front image is a wall 2
units behind the middle (-Z), facing the Front view; the side image a wall 2
units to the left (-X), facing the Right (Side) view, where the model's front is
on the left. Each is square-on in its own view and edge-on, out of the way, in
the other. Opacity, height, left/right and up/down (as seen from its own view;
the bottom edge sits at up/down) are adjustable, and **Flip** mirrors an image
that faces the other way. In a perspective view the image is drawn in pieces
on a scratch canvas, then laid on at its opacity, so no seams show. Images are
stored downscaled (1024 px JPEG) with the model.

## Data integrity

Three rules keep every model valid, whatever the tool or file it came from.

1. **Pure matrix math for every vertex transform** (src/modeler/matrix.mjs).
   4×4 affine matrices (row-major, p' = M·p) built by `translation`,
   `scaling`, `scalingAlong`, `rotationAxis`, `eulerXYZ`, `fromTRS`, `about`,
   `compose`, `multiply`, `invert`, `decomposeTRS` and `toEulerXYZ`, and applied
   by `transformPoint` and `transformDirection`. Each function checks its inputs,
   never changes them, and returns a new frozen value. `transformMesh` returns a
   new mesh, and moves in the workspace always start again from the mesh as it
   was when the drag began. Part transforms, evaluation, the viewport's rotate
   and the export's model → figure mapping all go through these functions.
2. **Every topology edit is atomic and validated** (src/modeler/mesh.mjs).
   Extrude, inset, subdivide, loop cut, merge, merge doubles, fill, flip, fix
   normals, duplicate, delete and symmetrize run on fresh arrays, then
   `validateMesh` checks the result. If any rule breaks, the mesh is put back
   exactly and a `TopologyError` (carrying the full result) is thrown. The
   workspace then restores its state, keeps the undo history unchanged, shows
   the reason in the status line, and the report is printed to the console.
   Opening a stored model, importing OBJ, joining and separating parts, and
   adding the evaluated (mirrored, smoothed) parts to an animation are checked
   the same way.
3. **`validateMesh(mesh, options)`** (src/modeler/topology.mjs), a standalone
   helper. Meshes are stored as a face-vertex list; it builds the half-edge view
   (one half-edge per face corner, twins found by reversing) and checks what a
   half-edge/BMesh structure guarantees:

   | Rule | Meaning |
   | --- | --- |
   | H1 structure | Vertices are three finite numbers; faces are `{v, c}` |
   | H2 dangling vertex index | Every corner points at an existing vertex |
   | H3 degenerate face | At least 3 corners, none repeated |
   | H4 half-edge used twice | Each directed edge belongs to one face: neighbours agree on winding |
   | H5 non-manifold edge | An edge joins at most two faces |
   | H6 non-manifold vertex | The faces around a vertex form one fan (no bow-ties) |
   | H7 orphan vertex | Every vertex is used by a face |
   | H8 duplicate face | No two faces use the same vertices |
   | H9 invalid color index | A face's color is a palette index |

   Open borders and faces with no area are allowed and listed as notes. It
   returns `{ok, errors, warnings, stats}` with the face, vertex or edge of each
   problem, and prints a grouped report (`formatTopologyReport`) to
   `console.error` when the mesh is broken, or always with `{print: true}`.
   `assertValidMesh` throws a `TopologyError` instead.

Rules that follow from this: Flip faces flips whole connected pieces (flipping
part of a closed surface would break H4), and edge extrusion works on open
border edges only (H5). Where Blender would leave a bow-tie, the tools keep
the mesh valid instead of refusing: Delete and Duplicate give each fan of
faces its own copy of a shared corner (`splitBowTies`; nothing moves), and
region Extrude moves corners inside the region with it and copies border
corners once per fan, as Blender does, so no corner is left unused. Loop cut
on a traced line splits the line. tests/modeler-integrity.test.mjs covers each rule,
purity, rollback and a run of random edits validated after every step.

## Adding to an animation

**Add to animation** (src/modeler/export-figure.mjs):

- One unit is 100 px. Model space is Y up with +Z toward the front view; figure
  space is Y down with +Z toward the camera (the mesh depth test keeps the larger
  depth). The engine shows triangles that look clockwise on screen, so each
  triangle's winding is reversed on export.
- Joints: a hidden zero-length **Figure rotation** joint first (figure rotation
  is measured from segment 0) with Figure turn/tilt controls, two hidden
  reference joints (Surface X, Surface Y) for the mesh's facing, then one 3D
  bone per skeleton bone with its own turn and tilt controls, so every joint
  poses in depth.
- Each bone's structural parent (`parent_id`) is its parent bone, the same as
  its 3D parent, so dragging a joint on the stage carries everything below it as
  with any Pivot figure. Root bones hang from the figure's root. The templates
  hang the thighs from the root beside Hips (as in Pivot), so bending the hips
  bends the upper body and leaves the legs. (Before 1.3.0 every bone had
  structural parent 0, so a drag turned one bone's mesh while its children
  stayed put and the model tore.)
- The mesh: every visible part evaluated (transform, mirror, smooth),
  triangulated, colors reduced to the palette entries used, one named group per
  part, skinned with up to four bones per point.
- Without a skeleton, the whole model follows one Body bone.
- The model rides along as `_styk.modelSource`. **Edit 3D model** reopens it;
  **Update figure** rebuilds the definition reusing each joint's ID by name, so
  `Editor.replaceFigureDefinition` keeps the figure's poses in every frame, as
  one undoable step.

### Automatic weights

`autoWeights` (src/modeler/armature.mjs) gives each point up to four bones:

1. Only bones that run through the part (sampled along the bone, inside the
   part's slightly grown bounds) are candidates, so a torso never follows an
   arm hanging beside it while a hip still takes the thighs that start inside it.
2. Each point blends its nearest candidate bone with that bone's parent and
   children, by inverse distance (power 6), skipping bones on the other side of
   the middle (.L is +X).
3. Weights are smoothed twice across the surface, keeping each point's allowed
   bones, then normalized.

Two refinements: a bone that only touches a part's edge (a thigh starting just
under the shirt, sampled inside the part's tight bounds once or its grown
bounds at most once) is not a candidate; and a part centred on a root bone
(the Hips piece) also blends with the other root bones (the thighs), since they
meet at the figure's root.

A part set to **Moves with** a bone follows it rigidly; its mirrored half
follows the opposite-side bone. A part that lies along one bone (at least 70%
of its points, per side for mirrored parts, project onto that bone's span
widened by 35% of its length) is bound rigidly to it too, so sleeves,
forearms, legs, shoes and heads keep their shape instead of pinching where they
touch the next bone.

### Face rig

**Face bones** (Bones panel) adds a face rig on the head: Jaw, LipUpper,
LipLower (under the jaw), LipCorner, Brow, Lid (upper eyelid) and Eye, .L and .R
where paired (`faceSkeleton`). They are fitted to the head bone (a bone named
Head; with none, one is added through the model, for a head modelled on its
own) and to the face's surface in front (+Z), at anime-ish heights: mouth 22%,
eyes 45%, brows 58% of the head. Running it again replaces them. Adjust them
like any bones (Mirror .L to .R copies the face settings), and set each eyeball
part to **Moves with** its Eye bone; **Move to selection** puts the selected bone
at the centre of the selected points or parts (its own side of a mirrored
selection), as Blender's cursor-to-selected.

A face bone (`face: true`, the **Face bone** checkbox) is posed like any joint
(it turns about its head), but:

- It is left out of the body's weights, so the head still binds to Head.
- It pulls only the skin around its tip, fading out (smoothstep) over **Reach**
  (`reach`, model units; 0 for the eyes, which move eyeballs rigidly), on skin
  that mostly follows the body bone it hangs from. Overlapping pulls share a
  point (squared, so the nearest wins) and the body keeps what they leave.
- **Pulls skin** (`cut`) keeps it to skin below (Jaw, LipLower) or above
  (LipUpper) its own head, over a soft band, so opening the jaw doesn't drag
  the upper lip.
- Parts set to Moves with a body bone (hair, a hat on Head) take no face pulls.
- On export the bone's joint gets `_stykControl: {level: 'face'}`.

On the stage, face controls stay hidden so the head isn't crowded: a figure with
any shows a small face badge beside its head joint. Clicking it shows that
figure's face joints (the badge turns blue); clicking again hides them. The
**Face controls** switch in the 3D rig panel does the same, a joint chosen from
Articulation stays visible on its own, and Build and joining show them all. Like
Show / hide joints, this is presentation state per editor (`rigFaceShown`,
src/face-badges.mjs): it never changes the pose or the figure and is not an
undo step.

## Files

| File | Purpose |
| --- | --- |
| src/modeler/matrix.mjs | Pure 4×4 matrix math |
| src/modeler/topology.mjs | validateMesh, the topology rules and TopologyError |
| src/modeler/mesh.mjs | Polygon mesh and its atomic edit operations |
| src/modeler/primitives.mjs | Primitives, the Base character, the default palette |
| src/modeler/model.mjs | Model document, validation, mirror and smoothing |
| src/modeler/armature.mjs | Bones, humanoid templates, automatic weights |
| src/modeler/export-figure.mjs | Model → figure |
| src/modeler/obj-format.mjs | OBJ/MTL import and export |
| src/modeler/gltf-format.mjs | glTF 2.0 (.glb, .gltf + .bin) import and export, with skeleton and skin weights |
| src/modeler/viewport.mjs | Camera, projection and drawing |
| src/modeler/modeler-ui.mjs | The workspace |
| src/styles/features/modeler.css | Its styles |
| tests/modeler.test.mjs | Operations, weights, export and re-editing |
| tests/modeler-integrity.test.mjs | Matrix purity, topology rules, atomic edits |

## Not yet

Sculpting, weight painting by hand, UVs and
textures, and glTF. Faces are flat-colored in the animation (the viewport adds
lighting only while modeling).
