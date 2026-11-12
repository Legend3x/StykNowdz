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

- **Draw**: pick a shape (Capsule, Tube, Box, Ball, Ribbon; keys 1–5) and drag
  from a joint. The line starts at the joint and ends where you let go, on the
  plane through the joint facing you; turn the view (Side, Top) to set depth.
  Dragging on empty space starts a new piece (a new first joint, orange).
- **Move** (V): drag a joint; what hangs below follows (Alt: the joint alone).
  A piece's first joint, once attached, sits on its joint: dragging it moves
  that joint.
- **Shape** (click a line): Start and End thickness (radii; a ribbon's are
  half-widths), Bulge (wider in the middle; a ribbon's Curl bends it sideways),
  Width × and Depth × (squash across: a flat torso, an oval head), Roll (turns
  the cross-section around the line), Twist (ribbons), colour, and **Static**.
- **Static** lines get no bone: they move with the nearest posable line above
  them (a shoulder, a neck, a hair clip). They are dashed in the view.
- **Mirror** (M): copies the line and everything below it across X = 0,
  starting from the same joint when it is on the middle, else from the joint
  at the mirrored place. Side names swap (`Arm.L` → `Arm.R`).
- **Delete** (X): a line goes with everything below it; a selected first joint
  deletes its piece. Pieces attached below are let go, not deleted.
- **Pieces**: build each body part, hair lock or accessory as its own piece,
  then **Attach** (click the joint to snap onto). The whole piece moves there
  and follows that joint from then on; its first lines' bones hang from the
  bone of the line ending at that joint. **Detach** leaves it where it is.
  A piece can't hang from itself or from a piece hanging from it.

## Shapes

All shapes are generated around the line from its start joint `a` to its end
joint `b`, in a frame with `u` (side, Width) and `v` (front, Depth) turned by
Roll. `u` is `d × Z` (`d × Y` for lines along Z), so a vertical line's width is
along X and its depth along Z.

| Shape | Mesh |
| --- | --- |
| Capsule | 12 around; rounded ends (quarter circles of the end radius past each joint, as Styk's round line caps) |
| Tube | 12 around; flat caps at the joints |
| Box | 4 around (square cross-section), flat caps |
| Ball | The line is the diameter, as a Styk circle; 8 rows by 12; Width and Depth squash it across |
| Ribbon | An open strip, 2 points across; 8 rows when curled or twisted |

Thickness along a line is `lerp(start, end, t) × (1 + bulge × sin(πt))`;
Bulge adds 6 rows. Closed shapes are made to face outward
(`recalculateNormals`) and every shape passes the mesh rules.

## Parts, bones and weights

`generateSticks(model)` rebuilds the parts and bones made from the sticks
(marked `stick: lineId`) and keeps every other part and bone. Ids stay with
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
shape, color, static, name}], pieces: [{id, name, root, attach}], nextId}`.
`readSticks` (called by `readModel`) keeps joints with finite positions,
lines between joints of one piece forming trees that reach the piece's first
joint, shapes clamped to their ranges, and attachments that don't loop.
