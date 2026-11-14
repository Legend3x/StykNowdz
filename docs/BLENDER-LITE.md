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
| Top bar | Object / Edit / Bones modes; Points / Edges / Faces in Edit; Move, Rotate, Scale (keys only on narrow windows); Undo, Redo; Front, Side, Top; perspective or flat view; Frame; File (Import OBJ or glTF, Export OBJ, Export GLB, Open in Blender and Choose Blender… in the desktop app, Start over); the keyboard button (the controls card); Close (or any other workspace tab: the unfinished model is kept as a draft, see below); **Add to animation** (or **Update figure**) |
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
- **Bones**: Humanoid skeleton (fitted to the model's hands, crotch, ankles and toes; see Automatic weights), Add bone, Extrude
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

Typing a number replaces the pointer, as in Blender: units along the locked
axis (X when none) for G, degrees about the locked axis (the view's when none)
for R, a factor for S and Shear. `-` flips the sign, Backspace takes off a
character, and the status line shows what is typed. `G Z 0.5 Enter`,
`R Z 90 Enter`, `S 1.5 Enter`; E then `Z -0.03` pushes a fresh extrusion in.

### glTF (.glb / .gltf) with bones

**File > Import OBJ or glTF** reads glTF 2.0: a `.glb`, or a `.gltf` chosen
together with its `.bin` files (data-URI buffers work too). Written from the
glTF 2.0 specification:

- Each mesh becomes a part. Triangles of all its primitives come in at the rest
  pose: a skinned mesh is placed with the file's own joint matrices and inverse
  bind matrices (the skinning sum), others by their node's world matrix. Points
  the file split along UV or normal seams are welded back (1e-6), the file is
  repaired (`repairImportedMesh`, below), and the result is checked like any edit.
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

### Open in Blender

**File > Open in Blender** (desktop app) hands the model to the person's own
Blender and brings their changes back every time they save there (Ctrl+S) or
press **Send to 3D Nowdz** in Blender's sidebar (N > 3D Nowdz). Nothing leaves
the computer and nothing is installed into Blender.

- `desktop/blender-bridge.cjs` finds Blender (the one chosen with **File >
  Choose Blender…**, else the installer's `Blender Foundation\Blender x.y`
  folders newest first, Steam, the Microsoft Store alias, /Applications, Snap,
  PATH), writes a session folder in the temp folder (`outgoing.json` and a copy
  of `desktop/blender/styk_link.py`, since Blender can't read inside the app
  archive) and starts `blender --python styk_link.py -- --styk-session <folder>`.
  It watches `incoming.seq` (plus a 1.5 s poll) and tells the window; the
  renderer reads `incoming.json`. Folders older than two days are swept.
- `src/modeler/blender-link.mjs` is the format, both ways, in 3D Nowdz's space
  (the script converts Y up ↔ Blender's Z up: (x, y, z) ↔ (x, −z, y)). Parts go
  as their own mesh in object space with their transform, so quads, n-gons and
  wires survive; **Mirror** (about a locked "3D Nowdz Middle" empty at the
  world's middle), **Solidify** (offset −1) and **Smooth** (Subdivision Surface)
  become live Blender modifiers and come back as settings. Creases, line weights
  (`styk_line`) and custom normals (`styk_normal`) ride as attributes; bones
  become an armature with Strength and Reach as bone properties; every part
  gets the weights the animation uses as vertex groups; reference images become
  image empties where 3D Nowdz shows them.
- Coming back, objects and bones are matched by a key (new ones get their own),
  so a renamed bone keeps its id and the animations on it. An object Blender
  didn't change leaves its part exactly as it is in 3D Nowdz (edits made here
  meanwhile survive); a changed one takes Blender's mesh, transform and
  modifiers and keeps the 3D Nowdz-only settings (outline, shadows, Moves with).
  Anything Blender can't express as those three modifiers (Bevel, Boolean,
  Remesh, Array, Displace…, or a text, curve or metaball object) comes back
  **baked**: its final shape (Armature modifier left out). Boolean cutters,
  guide curves with no surface, cameras, lights and empties stay in Blender.
  Weights painted in Blender are kept on the points; points whose weights are
  what 3D Nowdz would give anyway stay automatic. The whole merge is one undo
  step. Up to 2 million points come back (Decimate in Blender for more).
- The link outlives the Model tab: changes saved while it's closed arrive when
  it opens again. A reply for another model is refused.

`.github/workflows/blender-link.yml` checks this against real Blender releases
(3.6, 4.2, 4.5 and the newest): `scripts/blender-link-stress.mjs` sends Juniper,
`scripts/blender-link-stress.py` stands in for a person in Blender (a bevelled
sword painted to the hand, a Boolean-cut mirrored pauldron, a remeshed and
displaced stone pedestal, a 3D text nameplate, a curve scarf, an Array of studs
bent round the waist, a second Smooth level on the head, creases, a new bone, a
rename, weaker shoulders, a deleted part), then the reply must merge, become a
posable figure whose sword follows the forearm, and a second untouched round
trip must change nothing. Under Xvfb it also saves with Ctrl+S's operator in a
real Blender window.

### Blender tools

Blender's own tools, run inside 3D Nowdz with no Blender window (desktop app):
**Remesh** (voxel), **Decimate** (keep a share of points, or merge flat areas),
**Boolean** (Cut, Join, Keep overlap; select the part to change, then the other),
**Smooth and sculpt** (Smooth, Laplacian smooth that keeps volume, Corrective
smooth to relax points, and Displace bumps with a Clouds, Cells, Marble or Grain
pattern), **3D text**, and in Edit mode a **Tube** through a selected row of
points (closed loops make rings; Taper thins it towards the end). Each is one
undo step.

- The engine is `desktop/blender/styk_engine.py`, run by
  `desktop/blender-engine.cjs`: on Windows it is Python 3.13 with Blender's
  `bpy` module shipped in the app (`resources/blender-engine`, built by
  `scripts/build-blender-engine.mjs`); elsewhere, or without it, the person's own
  Blender (`blender -b --factory-startup`, found as Open in Blender finds it).
  One process stays running and answers one request at a time: a request is a
  JSON line on stdin naming a request and a result file, the answer one
  `@@styk-engine {...}` line on stdout. A tool running past 10 minutes is
  stopped; a stopped engine restarts on the next request.
- A request is the link document above with only the parts the tool needs (no
  bones or reference images), built by `styk_link.build`; the result is read by
  `styk_link.collect`, so tools and Open in Blender share one conversion
  (`src/modeler/blender-engine.mjs` merges it with `readBlenderPart`). A changed
  part keeps its name and its 3D Nowdz-only settings (outline, shadows, Moves
  with) and comes back baked (Mirror, Smooth and Solidify applied, since a
  Remesh or Boolean works on the finished shape); painted weights go back to
  automatic. A Boolean's cutting part is removed, or kept hidden.
- `scripts/blender-engine-check.mjs` runs every tool on Juniper through the real
  engine; `.github/workflows/blender-link.yml` runs it in Blender 3.6–newest and
  on `bpy` alone, and `build-windows.yml` runs it on the packaged app's engine.

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
| Knife | K | Click points on edges or corners (Ctrl: edge middle); between points the cut follows the straight screen line across faces. Backspace removes the last point, Enter/Space cuts, Esc or right-click cancels. A face seen edge-on (the wall of a recess or a step straight down the view) has no area on screen; the cut goes down it to its far edge under the same spot, once per wall, so a line across an inset and pushed-in panel cuts its walls and floor too. Clicks inside a face (away from edges) aren't supported yet |

| Smooth | Edit panel | Each selected point moves Factor of the way to the mean of its neighbours, Repeat times (Vertex > Smooth Vertices). Border points use border neighbours only; a traced line's ends stay put |
| Triangulate | Ctrl+T | Quads split along the shorter diagonal; larger faces by ear clipping in their own plane (concave faces come out right) |
| Tris to quads | Alt+J | Pairs of selected triangles sharing an edge join when they bend less than Max bend and the quad is convex with corners within 45° + Max shape of square; best pairs first |
| Poke | Edit panel | A point in the middle of each selected face, fanned to its corners |
| Fill holes | Edit panel | Every hole touching the selection with at most Sides corners (0 = any) gets one face |
| Shrinkwrap | Edit panel | Applied once, like the modifier's Nearest Surface Point: selected points move to the closest point on the other visible parts (world space, `shrinkwrapPoints`), then Offset out along that face's normal. Wrap: Along view is the Project mode: each point moves to where a ray from the eye (as the view stood when the tool ran) through it first meets a surface, so a shape drawn in Front view lands where it is seen; a ray that misses leaves its point alone (`rayTriangle`) |

| Hide / Reveal | H, Shift+H, Alt+H | Edit mode: hide the selected points (or all others); faces using a hidden point aren't shown or picked in Edit mode, hidden points can't be selected (refresh drops them), Alt+H shows all and selects what comes back. Stored as point data (`vdata.hide`), so it survives edits, undo and saving; Object mode and the animation show the whole part |
| Edge crease | Shift+E | Selected edges between faces get crease 1 (again: 0). Catmull-Clark (Smooth) blends toward the sharp rules by the crease: edge points toward the edge's middle, a point on two creased edges uses the crease-vertex rule (6p + n1 + n2)/8, on three or more stays put. Each half of a creased edge keeps its crease at the next level, so 1 stays sharp at every level (fractional creases stay a little sharper than Blender's, which decay per level). Stored per edge (`vdata.crease`, 'a,b' keys renumbered with the points) |
| Solidify | Object panel | Like the modifier with Offset −1: after Mirror and before Smooth, a second layer Solidify units inside along the point normals, faces reversed, joined along open edges by a rim (closed surfaces get an inner shell only). Point data copies to the inner layer (custom normals turned inward) |

Smooth, Fill holes, Tris to quads, Shrinkwrap and Grid fill can be adjusted
after the fact in the Edit panel, like Blender's Adjust Last Operation:
`adjustable()` keeps the state from before the edit, and each change redoes
the edit from it with the new settings (one undo step in all). Inset (Thickness)
and Bevel (Width, Segments) are set with the mouse and then join the same panel
when they finish, so an exact amount can be typed after.

Vertex slide is GG on points (the existing edge slide). Not ported yet: Bevel
profile shapes and vertex-only corner patches with several segments (an
n-gon closes them), Knife cuts starting inside a face, Rip of a single point,
Grid fill between two separate lines, Limited dissolve.

### Examples

**Start > Examples** opens a finished character in place of the model (asking
first when there is one; Undo brings it back), to take apart or build on. Both
were made in 3D Nowdz with its own tools, driven through the workspace the way
a person uses it, and are kept as model files in `src/modeler/examples/`
(loaded only when opened):

- **Juniper**, an anime-style girl from Base character: Like a sphere face
  normals; eyes from a circle inset twice (iris, pupil) and a mouth and brows
  from planes, pressed onto the face and bangs with Shrinkwrap (Along view) and
  mirrored; bangs and long back hair extruded from the hair cap with typed
  moves and scales; an ahoge bent with typed rotations; a skirt from a
  cylinder with its caps deleted, the hem flared and every other point pushed
  out for pleats, a loop cut and Solidify; collar and bow; boots; toon
  shadows, outlines and face bones.
- **Kettle**, a robot from primitives in an A pose: body, head and feet
  bevelled (Ctrl+B, exact width and segments in the panel); a chest panel and
  visor inset and pushed in (E then Z typed); a belt line cut with the knife
  across the recessed panel; arms rotated with R Z 40 typed; loop-cut
  forearms; subdivided hands with extruded fingers; edges creased (Shift+E)
  under Smooth; toon shadows, outlines and a Humanoid skeleton fitted to the
  model.

Selecting faces is selecting their points, so in Faces mode picking both caps
of a cylinder picks every point and with them the sides: delete one cap at a
time (Blender keeps a separate face selection).

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
   the same way. Imports (OBJ and glTF) are repaired first by
   `repairImportedMesh` (src/modeler/mesh.mjs), because files from games and
   other programs routinely break these rules where Blender would accept them:
   points at the same place (1e-6) are welded, doubled faces dropped, a face
   that would be the third on an edge (a fin) or that cannot agree in winding
   with its neighbours (a Möbius strip) gets its own copies of that edge's
   points, bow-ties are split, and unused points go. Per-point data (bone
   weights) follows the copies. Only what is still wrong after that is refused,
   and the status line then shows the reason, never "imported".
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

Each bone has **Strength** and **Reach** (Bones mode, Bone panel; `pullOf` /
`setPull`). Strength (0–2, default 1) scales the bone's share in step 2 (cubed,
so it is felt against the steep distance falloff); 0 makes the bone move
nothing, like Deform off in Blender: its points go to the bones around it, and
its parent and children count as each other's neighbours. Reach, when set, is
the farthest a point can be from the bone and still follow it (fading over its
last quarter), also after smoothing; it gives way only where no other bone is
left. Defaults are not stored; Mirror bones copies both across.

Steps 1 and 2 work per connected piece: a part made of separate pieces (an
OBJ that imported both legs, or both legs and the hands, as one part) gets its
candidates from each piece's own bounds and blends each piece by its own
centre (and, on a Mirror part, each side by its own), so a left shin never pulls
the right leg and a hand hanging beside a thigh doesn't follow the leg
(`piecesOf`: points joined by faces or edges).

**Automatic weights** (Bones panel checkbox, `model.autoWeights`, on unless
`false`) can be turned off: then only painted points follow the bones and every
other point stays with the part's holding bone (`holdingBone`: its Moves with
bone, else the skeleton's root). The first bones added to a model that has none
(Humanoid skeleton or Add bone) start with it off, so nothing moves until you
paint it; ticking the box brings automatic weights back.

Two refinements: a bone that only touches a part's edge (a thigh starting just
under the shirt, sampled inside the part's tight bounds once or its grown
bounds at most once) is not a candidate; and a part centred on a root bone
(the Hips piece) also blends with the other root bones (the thighs), since they
meet at the figure's root.

### Weight painting

Bones mode, one bone selected, Weight painting > **Paint weights**: drag to
paint how much that bone moves each point, in the colours of "Show what the
selected bone moves" (red all, blue none), as Blender's Weight Paint mode.
Brushes: **Add**, **Remove**, **Smooth** (towards the neighbours' average) and
**Set** (to Amount); Size (pixels on screen) and Strength. Ctrl paints the other
way (Add ↔ Remove), Shift+click picks another bone, and a stroke is one undo
step. Strength and Reach are sliders, previewed live, saved on release.

- The brush is a sphere around the surface point under the pointer (its radius
  the brush circle at that depth), as Blender's default, so it never paints
  through to the far side. It paints a part's own points (every visible part
  in reach); on a Mirror part, the mirrored half is painted through its source
  point with the other side's bone (`mirrorBone`).
- **Paint only on highlighted parts**: while painting, click a part without
  moving the pointer (Alt+click) to add it to the highlight; the brush then
  paints only highlighted parts and the others are greyed out. **Paint
  everywhere** clears it, as Blender's face mask.
- **Mirror painting** paints the same spot on the other side with the other
  side's bone (Shoulder.L ↔ Shoulder.R), as X-Mirror in Blender.
- `src/modeler/weight-paint.mjs`: a painted point stores complete weights in
  `part.mesh.vdata.skin` (where an imported rig keeps its weights, saved with
  the model) and always adds up to 1 (Auto Normalize): weight taken from the
  bone goes to the bones already there, or where it had the point alone, to the
  bones that would have it without it. Weight taken away (Remove, or Set and
  Smooth lowering it) goes only to bones that don't ride on the painted bone
  (`ridersOf`: everything below it), else to its parent, so an erased spot
  really stops moving when the bone turns: erasing Shoulder.L from the chest
  gives it to the Chest, not to UpperArm.L, which the shoulder carries along.
  Bones below it keep what they had. Painted points no longer follow
  automatic changes (Strength, Reach, moving a bone) until **Back to
  automatic** forgets them.
- `partWeights` (armature.mjs): a part with carried weights gets complete
  weights on its own points (`completeSkin`: carried, automatic for the rest),
  which travel through Mirror (the copy's bones as negated ids, read back as
  the other side's bone by `sideResolver`) and Smooth. A smoothed point blends
  them with the automatic weights of the shown shape by how much of it comes
  from carried points (carried as a point value through Smooth), so points away
  from the brush keep exactly their automatic weights; at a brush edge a few
  percent of the painted area's neighbours can blend in, as at a Blender brush
  edge. Open in Blender sends a painted part's own points' weights
  (`{cage: true}`) as vertex groups.

A part set to **Moves with** a bone follows it rigidly; its mirrored half
follows the opposite-side bone. A part that lies along one bone (at least 70%
of its points, per side for mirrored parts, project onto that bone's span
widened by 35% of its length) is bound rigidly to it too, so sleeves,
forearms, legs, shoes and heads keep their shape instead of pinching where they
touch the next bone. It is not bound when more than 12% of its points run on
past a joint: beyond the span at a child's end or the parent's end, or along
the middle of the parent itself and nearer it (a leg in one piece from hip to
ankle, a shoe in one piece with the shin), so it still bends there. A parent
much shorter than the bone (under 40% of its length: a neck under a head)
doesn't count.

On a humanoid skeleton (bones named Neck, Head and UpperArm), a part centred
above the base of the neck and inside the shoulders (hair, quills, ears, a
hat) takes only the Head and Neck, even where it hangs down beside an arm or
behind the chest.

**Humanoid skeleton** fits the bones to the model itself (`fitHumanoid`, like
the marker step of an auto-rigger), reading the surfaces (sampled about every
1/60 of the height, so low-poly boxes have points in their middle) for:

- the crotch: going up from the ankles, the first height where the middle
  (X ≈ 0) fills in for good;
- the legs' X halfway up, and the trunk's half-width just above the crotch (the
  run of points out from the middle with no wide gap, so arms held out on a
  short cartoon trunk don't count);
- the hands: the widest point. Arms reaching less than 2.4× the trunk's
  half-width (down at the sides) fall back to an average adult fitted to the
  model's height and width, as before;
- the arm's line, tracked in from the hand tip a slab at a time around the
  previous centre, then fitted straight (Theil–Sen) through the forearm and
  upper arm so hair or quills beside the shoulder don't pull it. The wrist is
  where the hand's dense points (fingers, a fist, a glove) end, kept to 60–85%
  of the way out; the elbow is halfway to it;
- the ankles: going up, where the foot (long front to back) narrows into the
  leg; the toes: the foot's far end on the side it reaches further, which also
  gives the facing (±Z); knees halfway, nudged forward;
- the spine: the middle of the trunk front to back at each height, the chest
  60% of the way to the shoulders, the neck a fifth of the way from the
  shoulders to the top.

It is tested on a cartoon figure in separate pieces (big head, spikes behind
it, one-piece legs, large shoes, dense fists) in a T and an A pose.

### Pose mode

Bones panel > **Pose** (as Blender's Pose mode): drag a bone to turn it about
its start, in the view's plane; the bones below follow and the model bends by
its weights, so you can see how it will move before **Add to animation**.
Grabbing a joint shared with the parent turns the parent. Weight painting works
on the bent model (the brush finds the same spot on the unbent shape), so a
bad bend can be painted out while you look at it. **Reset pose** straightens
every bone and **Stop posing** (or leaving the Bones tab) ends it. A pose is
only a preview: it isn't saved, isn't an undo step and never moves the bones'
rest positions; G, R and S are blocked while posing.

`src/modeler/pose.mjs`: a pose is a Map of bone id → quaternion about the
bone's head in the rest frame; `poseFrames` composes parents first
(`turn = parent.turn · own`, the head carried by the parent), `posedMesh` is
linear blend skinning with `partWeights`, and `turnBone` turns a bone by a
rotation given in the scene's frame.

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
| src/modeler/blender-link.mjs | Open in Blender: the link format and merging Blender's changes |
| desktop/blender-bridge.cjs | Finding and starting Blender, watching for its saves |
| desktop/blender/styk_link.py | The script Blender runs: builds the scene, sends it back on save |
| src/modeler/viewport.mjs | Camera, projection and drawing |
| src/modeler/modeler-ui.mjs | The workspace |
| src/styles/features/modeler.css | Its styles |
| tests/modeler.test.mjs | Operations, weights, export and re-editing |
| tests/modeler-integrity.test.mjs | Matrix purity, topology rules, atomic edits |
| tests/modeler-blender-link.test.mjs, tests/blender-bridge.test.mjs | The Blender link's merge rules and desktop session |

## Not yet

Sculpting, weight painting by hand, UVs and
textures, and glTF. Faces are flat-colored in the animation (the viewport adds
lighting only while modeling).
