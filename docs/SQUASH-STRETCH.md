# Squash and stretch

3D figures (3D Nowdz models and other figures with 3D bones) squash and stretch
from the Properties panel's **Squash and stretch** section on the stage, for
the whole figure or for one part. Both keep the volume: stretching by k thins
the shape across by 1/√k, and squashing widens it. Both are pose values, so
they key, tween and undo like any other pose change.

## Whole figure

`_stykSquash = {amount, angle, from}` on the posed object (`src/squash.mjs`):

- `amount`: 1 is none, above 1 stretches, below 1 squashes (0.2–5; the
  slider covers 20–300%).
- `angle`: the direction of the stretch, in degrees clockwise from straight up
  and down (the slider covers ±90°), for a ball flying at a slant.
- `from`: where it squashes from, from 0 (the figure's bottom, so a landing
  squashes into the ground) to 1 (its top), 0.5 being its middle. The figure's
  rest box comes from its 3D mesh, else its 3D bones (cached per definition).

Rest values are not stored. Between keys the amount tweens evenly in squash
and stretch (geometrically, so halfway from 0.5 to 2 is 1), and the direction
and `from` tween linearly; a side without a value is rest, keeping the other
side's direction so it doesn't swing.

It is applied where the figure meets the screen, after its bones and before
perspective: `squashTransform` gives a mapping of screen points, used by the
rig's projection (`rig-spatial.mjs` `evaluateSpatial`, through
`rig-constraints.mjs`) and the mesh's (`spatial-mesh.mjs`, whose cache key
includes it). The pose itself is unchanged, so taking the squash off gives the
same pose back.

Editing stays under the pointer: the object geometry keeps the mapping
(`squash`, with its inverse), `unprojectSpatial` undoes it, and joints keep
their unsquashed place as `rawPoint` when there is no perspective. With
perspective on as well, joints are edited in the squashed space (close, not
exact).

## One part

With a joint selected, **Part** stretches that bone (`editor-squash.mjs`
`setPartSquash`) through the rig's own proportions: its length (`lengths`) and
its width (`_stykSpatial.shape`, divided by √factor). **The parts below it
too** takes the bones under it along by the same factor (an arm with its
forearm and hand). Children follow the stretched bone's tip.

## Commands

- `getSquash()`, `setSquash({amount, angle, from})`, `resetSquash()`
- `getPartSquash()`, `setPartSquash(amount, {below})`
