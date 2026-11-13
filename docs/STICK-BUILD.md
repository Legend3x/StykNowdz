# 3D stick building (Build mode)

Branch `stick-3d`. Build mode is Styk Builder in 3D: a character is drawn as
joints and lines, and every line is a 3D shape. The lines are the skeleton,
so whatever is built poses on the Animate stage with no separate rigging.
Detail that sticks can't give (eye hollows, a mouth) is cut in Edit mode with
the tools ported from Blender, after **Convert to mesh**: Edit mode is only for
ordinary parts (imported, added, or converted), never for parts Build mode
remakes.

Code: `src/modeler/sticks.mjs` (data, shapes, parts and bones),
`src/modeler/stick-build.mjs` (interaction and panel, wired in by
`modeler-ui.mjs`). Tests: `tests/modeler-sticks.test.mjs`, and the Build step
of `tests/modeler.browser.mjs`.

## Using it

Build mode is laid out like the Build tab: a tool rail floats on the view's
left edge, and the panel is an inspector for the picked line, joint or poly
fill. Numbers are sliders; a slider drag is one undo step.

- **Tools** (rail, top): Select (V), Line (L), Circle (C), Poly fill (P),
  Head from outlines (E), Pan (H), and the **Guide lines** toggle: while it's
  on, new lines are guides (lines drawn from a guide are guides too). Below them Split, Duplicate, Flip H, Flip V and Delete act on the
  picked line (also in the inspector's title row, as in Build).
- **Line / Circle**: drag from a joint. The line starts at the joint and ends
  where you let go, on the plane through the joint facing you; turn the view
  (Side, Top) to set depth. Dragging on empty space starts a new piece (a new
  first joint, orange). Line draws the last line shape picked in the
  inspector (Round line at first); Circle draws a Filled circle.
- **Select** (V): click a line, joint or poly fill; drag a joint, and what
  hangs below follows (Alt: the joint alone). A piece's first joint, once
  attached, sits on its joint: dragging it moves that joint.
- **Bend**: right-drag (or Alt+right-drag) a line, or the joint it ends at,
  as in Build: the line's middle follows the pointer. That sets Curve (how far
  the middle stands off) and Bend direction (which way around the line, so
  lines bend in depth too). Only lines, square lines, trapezoids and planes
  bend. Right-drag on empty space still turns the view.
- **Poly fill** (P), as Pivot's: click joints in turn, then the first again
  (or Enter); Backspace drops the last, Esc cancels. See below.
- **Inspector** (a picked line): name; Style (colour, Shape, Thickness or
  Start/End thickness, the shape's own options, Curve, Circular arc, Bend
  direction); 3D (Width, Depth, Roll, Bulge or Curl, Twist for planes);
  Geometry (Length, **Static**).
- **Guide** lines are for tracing: no shape and no bone (dotted teal in the
  view). Lines hanging below a guide take their bone's parent from the nearest
  posable line above, as below a static line. Heads and poly fills can be
  made from guides.
- **Head from outlines** (E): click a line of the front outline, then a line
  of the side profile. See Heads below.
- **Convert to mesh** (a line's Geometry, or a fill's or head's title row;
  also in Object mode for any part made in Build mode): the shape becomes an
  ordinary part with the same points and weights, opened in Edit mode. A
  poly fill or head is removed (its joints and outlines stay); a line keeps
  its bone and stops making a shape (**Make its shape again** undoes that).
- **Static** lines get no bone: they move with the nearest posable line above
  them (a shoulder, a neck, a hair clip). They are dashed in the view.
- **Split** puts a joint in the middle of the line (on its curve). **Duplicate**
  copies the line and what hangs below it from the same joint, turned 20°
  about the view direction. **Flip H / Flip V** mirror the line's branch in
  place across the plane through its start joint.
- **Mirror** (M): copies the line and everything below it across X = 0,
  starting from the same joint when it is on the middle, else from the joint
  at the mirrored place. Side names swap (`Arm.L` → `Arm.R`); poly fills
  inside the branch are copied too.
- **Delete** (X, or the rail): a poly fill; a line with everything below it; a
  selected first joint deletes its piece. Pieces attached below are let go.
- **Pieces**: build each body part, hair lock or accessory as its own piece,
  then **Attach** (click the joint to snap onto). The whole piece moves there
  and follows that joint from then on; its first lines' bones hang from the
  bone of the line ending at that joint. **Detach** leaves it where it is.
  A piece can't hang from itself or from a piece hanging from it.

## Shapes

Build's segment shapes, the Stick Nodes ones included, plus a plane. All are
generated around the line from its start joint `a` to its end joint `b`, in a
frame with `u` (side, Width) and `v` (front, Depth) turned by Roll.

| Shape | Mesh |
| --- | --- |
| Round line | Swept round tube, rounded caps past each joint (Styk's round line caps) |
| Square line | Swept square tube, flat caps |
| White circle, Filled circle | A ball; the line is the diameter, as a Styk circle (White circle is the outline colour in 2D, a ball here too) |
| Clear circle | A ring (torus) around the line's middle, as thick as Thickness |
| Triangle | A cone along the line; Tip (start side, centred, end side) and Flip |
| Trapezoid | Swept tube from Start to End thickness; Round start / Round end |
| Ellipse | An ellipsoid; Half ellipse cuts it flat along the line (Flip: other half) |
| Polygon | A faceted ball, 3–12 Sides |
| Plane | An open strip for hair, Start/End are half-widths; Curl and Twist |

Lines, square lines, trapezoids and planes follow their **path**: straight,
or bowed by Curve, as a parabola through both joints, or a circular arc
(Circular arc). Swept shapes use rotation-minimising frames along the path,
so a bent tube doesn't twist. Thickness along a line is
`lerp(start, end, t) × (1 + bulge × sin(πt))`. Closed shapes face outward
(`recalculateNormals`) and every shape passes the mesh rules.

## Poly fill

A poly fill closes the area between three or more joints, as Pivot's poly
fill does, but as a 3D body rather than a flat plane:

- It's made of four-sided faces, like Blender's Grid fill: the outline is
  split into four sides at its corners (the points furthest toward each
  diagonal of its plane), a grid is stretched between them (a Coons patch,
  14 cells around the two directions), and the inside points are relaxed so a
  dented outline doesn't fold the grid. **Smooth** (0–2, default 1) is the
  part's subdivision.
- Its outline follows the lines between consecutive joints along their paths
  (so a curved arm gives a curved edge), and runs straight where no line
  joins two joints.
- Its rim is a rounded edge as thick as the lines around it (each outline
  point's thickness comes from the line it lies on, or the joint's line), so
  it meets the segments without a step.
- **Inflate** (0–2) domes both faces out toward the middle, like a torso;
  0 keeps it as thick as its lines all the way across.
- Its points are weighted to the bones of its joints (inverse distance
  squared, the four nearest), so a fill bends as the lines around it pose.

## Heads

A head is made from two traced pieces, the way modelers block out a head from
front and side drawings: the **front outline** (traced in Front view) and the
**side profile** (traced in Side view). Making one turns both pieces' lines
into guides; moving their joints reshapes the head, and deleting either piece
deletes it. Front is +Z.

- Rows of rings go up the height where the front outline is at least a third
  of its widest, closer together toward the ends (`rows`, default 12); each
  ring has `around` points (multiple of 4, default 16) and is mirrored
  across the outline's middle, so the head is symmetrical.
- A ring is as wide as the front outline at its height and as deep as the side
  profile: with **Side outline: Face only** (default) the profile is read as
  the face, from its back edge (the ear line) forward, and the back of the
  head goes `back` × the half-width behind the ear line; an open profile line
  puts the ear line a half-width behind it. **Whole head** reads the side
  outline as the whole head, front and back.
- **Squareness** makes the rings boxier (a superellipse), for a flatter face.
- **Top dome** and **Chin dome**: three shrinking rings and a point close the
  head up to the outline's top and down to its bottom (1 reaches them exactly).
- **Smooth** is the part's subdivision (default 1).
- **Draw faces on it** opens a new mirrored part in Edit mode with Poly build
  and Snap to surface on, to draw clean faces over the head point by point
  (BLENDER-LITE.md, "Drawing faces").
- Every point is weighted to the bone of the line ending at the joint the
  front (else the side) outline is attached to, normally the neck.

## Parts, bones and weights

`generateSticks(model)` rebuilds the parts and bones made from the sticks
(marked `stick:` the line's, fill's or head's id) and keeps every other part and bone. Ids stay with
their lines, so selection, outlines and visibility set on a part, and face
flags or names set on a bone, carry over. Bones are made parents first; a
line's bone hangs from the bone of the nearest posable line above it (across
an attachment). Every point of a line's shape is weighted 1 to that bone, or
for a static line to the nearest posable line's bone (`vdata.skin`), so shapes
follow their lines exactly. Lines with no posable line above (a static first
line) get automatic weights.

Parts and bones made from lines are moved, rotated and deleted only through
their lines: Object mode refuses to move or duplicate them (deleting one
deletes its line), and Bones mode shows their bones without moving them.

Lines are named when drawn (`Line 1`, `Line 2` …) and keep the name, since
the animation knows a bone by it.

## Stored data

`model.sticks = {joints: [{id, at, piece}], lines: [{id, from, to, piece,
shape, color, static, guide?, noMesh?, name}], pieces: [{id, name, root,
attach}], fills: [{id, joints, color, inflate, smooth, name}], heads: [{id,
front, side, color, name, rows, around, square, back, top, bottom, smooth,
whole}], nextId}`. Heads whose pieces are gone, or which name one piece for
both, are dropped on open. Shapes written by earlier
builds (capsule, tube, box, ball, ribbon) are read as round line, trapezoid,
square line, filled circle and plane.
`readSticks` (called by `readModel`) keeps joints with finite positions, fills
of three or more existing joints,
lines between joints of one piece forming trees that reach the piece's first
joint, shapes clamped to their ranges, and attachments that don't loop.
