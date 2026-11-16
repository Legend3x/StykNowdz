# 2D face rig

A 3D Nowdz model can wear a **2D face**: drawn eyes, brows, mouths and extras
painted onto its head's texture and rebuilt for every pose. It combines the
flexibility of a 2D puppet's face (any drawing, lip-sync shapes, smears, anime
eyes) with a head that turns in 3D, and it costs one texture.

It sits beside the other two ways to build a face (docs/BLENDER-LITE.md, "Face
sets" and "Face rig"): swap sets of modelled parts, and face bones that pull the
skin. All three can be used on one model.

## Model

`src/face-rig.mjs` owns the data and the picture; it has no DOM and runs on any
thread.

A face belongs to one texture (`face.texture`, the head's) and lists up to 24
**features**, each a box on that texture: centre `x`, `y` and size `w`, `h` in
UV units (v up, as the model's UVs), `angle` in degrees. A feature has a kind
and up to 24 drawn **states** (PNG data URLs, drawn to fill the box):

| Kind | A state holds | Posed by |
| --- | --- | --- |
| `eye` | `under` (the eye white, also where the pupil can show) and `over` (lids, lashes); the feature's `pupil` is one drawing (`size` a fraction of the width, `range` how far it moves) | state, look `x`/`y` (-1..1) |
| `brow` | `over` | state, raise `r` and tilt `a` (-1..1) |
| `mouth` | `over` (the starter set is named for lip-sync: Rest, Smile, Frown, Open, A, E, O, U, M) | state |
| `extra` | `over` (blush, sweat, tears…) | state, opacity `o` (0..1; hidden at rest) |

A feature with `mirrorOf` shows another feature's drawings flipped (a right eye
following the left until it is drawn on its own). Its look still means the same
direction on screen, and a brow tilt mirrors, so equal values look symmetric.

`readFace` cleans a stored face: unknown kinds, broken images and dangling or
chained mirrors go, numbers are clamped, and a face whose texture is missing is
dropped. 3D Nowdz models keep it as `model.face` (model.mjs `readModel`), and
`modelToFigure` copies it to the figure's spatial mesh with its texture id
turned into the texture slot (`spatialMesh.face`).

## Posing

A posed object holds `_stykFace`: per feature id, `{s, x, y, r, a, o}`. Missing
values are rest (first state, looking ahead, level, extras hidden) and are not
stored, so a face at rest saves nothing. Between keys the numbers tween and
states hold until the next key (pivot/geometry.mjs, `interpolateFace`).

Editor commands (`src/editor-face.mjs`):

- `setFaceValues(patch, {linked})` changes values on the selected figure as one
  undo step, or as part of a `beginDrag`/`commitDrag` gesture. With `linked`, a
  change also applies to the features mirroring or mirrored by it.
- `blinkFace(closed)` keys the eyes closed at the playhead and back to their
  state two frames on, leaving the playhead where it was.
- `resetFace()` puts the face back to rest; `faceValues()` reads what shows now.

Auto key applies as for any pose change.

## Pictures

Each distinct combination of a face, its base texture and values is one
picture. `faceRecipe` lists what to draw and a key naming exactly that picture
(values rounded to 1/256); the mesh's texture URL for the face's slot becomes
`stykface:<key>` (spatial-mesh.mjs `faceTextures`), so the renderer's image
caches, raster keys and invalidation treat it like any image.

`src/face-compose.mjs` keeps recipes by URL (the latest 512, per thread) and
paints a URL into an ImageBitmap on an OffscreenCanvas: the base texture, then
each feature in order (an eye: white, the pupil cut to the white with
`destination-in`, then the lids). Decoded drawings are kept (96 at most). No
PNG is encoded. `ImageResources.preloadImages` composes face URLs instead of
fetching them.

Drawables made on one thread and decoded on another (the stage's preview image
worker) carry the recipe with the image item (`faceRecipe`), and the loader
registers it before painting. The stage's image batch includes textured meshes
(`frameMeshTextureDrawables`), so a face picture stays decoded while it shows.

## 3D Nowdz

**+ › 2D face** (or the head's right-click menu) adds a face to the face part
(`facePart`: a part named Head or Face, else the selected one):

1. A mirrored head is made whole, so each side can differ.
2. If the head's front has no texture, it is unwrapped for a face
   (`src/modeler/face-2d.mjs` `faceUnwrap`): faces turned to the front are
   projected from the front into a big square (drawings keep their shape), the
   rest smart-unwrapped into a strip beside it, and the colours baked.
3. The starter places (eyes, brows, mouth, blush, sweat; `starterPlaces`, from
   the face's frame) are found on the texture by casting onto the front of the
   head (`uvAtFront`), sized by measuring the texture around them.
4. The starter drawings (`src/face-starter-art.mjs`) are drawn for each box.

Object mode's **2D face** section (the face part selected) lists the features.
For the chosen one: its states (click to preview, double-click to rename; Paint,
Copy state, Delete state), preview sliders for the look, brows or opacity, and
Place (across, up–down, size, angle), saved as one undo step when let go. Eyes
also set the pupil size and paint the pupil. A mirrored side can **Draw on its
own** (it gets flipped copies of the drawings), and a side can **Mirror** the
other. Previews are never saved. The viewport and UV editor show the composed
face in place of its texture.

**Paint** opens the state in Draw (app.mjs `startTexturePainting`, the same
session as Paint texture): a locked layer with the face around the box under
it, then a layer per image (an eye: Eye white, then Lids and lashes). Done
writes each layer back; a layer left empty removes that image (a closed eye has
no white). Cancel changes nothing.

## Stage

A figure with a 2D face shows the face badge beside its head. Clicking it opens
the face panel (`src/face-panel.mjs`): a look pad, each eye's states and Blink,
brow raise and tilt, the mouth's states, each extra's opacity, Both sides
together (on by default) and Reset face. Drags and sliders are one undo step.
The panel follows the playhead and closes when its figure goes.

## Limits

- One face per model, on one texture.
- Drawings are raster images; a feature's box sets their resolution on the
  head (the starter set draws about 256 pixels across the longer side).
- Brow raise and tilt move the drawing; they do not reshape it. Use states for
  very different brows.
