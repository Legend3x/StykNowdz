# 3D stick building (Build mode)

Branch `stick-3d`. Build mode is Styk Builder in 3D: a character is drawn as
joints and lines, and every line is a 3D shape. The lines are the skeleton,
so whatever is built poses on the Animate stage with no separate rigging.
Mesh editing (Edit mode and the tools ported from Blender) is taken out of the
interface on this branch; the mesh library stays, for imports (OBJ, glTF) and
so the branch can be merged back.

Code: `src/modeler/sticks.mjs` (data, shapes, parts and bones),
`src/modeler/stick-build.mjs` (interaction and panel, wired in by
`modeler-ui.mjs`). Tests: `tests/modeler-sticks.test.mjs`, and the Build step
of `tests/modeler.browser.mjs`.

## Using it

Build mode is laid out like the Build tab: a tool rail floats on the view's
left edge, and the panel is an inspector for the picked line, joint or poly
fill. Numbers are sliders; a slider drag is one undo step.

- **Tools** (rail, top): Select (V), Line (L), Circle (C), Poly fill (P),
  Pan (H). Below them Split, Duplicate, Flip H, Flip V and Delete act on the
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

## Parts, bones and weights

`generateSticks(model)` rebuilds the parts and bones made from the sticks
(marked `stick: lineId`, or the fill's id) and keeps every other part and bone. Ids stay with
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
shape, color, static, name}], pieces: [{id, name, root, attach}], fills:
[{id, joints, color, inflate, name}], nextId}`. Shapes written by earlier
builds (capsule, tube, box, ball, ribbon) are read as round line, trapezoid,
square line, filled circle and plane.
`readSticks` (called by `readModel`) keeps joints with finite positions, fills
of three or more existing joints,
lines between joints of one piece forming trees that reach the piece's first
joint, shapes clamped to their ranges, and attachments that don't loop.
