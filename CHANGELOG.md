# StykNowdz changelog

What's new in each version of StykNowdz. StykNowdz is built on StykAnimate; its earlier history is in docs/STYKANIMATE-CHANGELOG.md.

<!-- Maintainers: follow the writing guide in docs/RELEASING.md before adding entries. -->

## [Unreleased]

### Added

- 3D Nowdz File > Open in Blender sends your model to Blender and brings your changes back each time you save there, with bones, mirror and smoothing kept. Blender's other tools, such as Boolean, Remesh, text and curves, come back as finished shapes.
- 3D Nowdz bones have Strength and Reach, so a bone stops tugging nearby parts it shouldn't move, such as a shoulder pulling the back. Turn on Show weights to see the change as you type.
- 3D Nowdz Start > Examples opens two finished characters made with its own tools, Juniper and Kettle, to take apart or build on.
- Type a number while moving, rotating or scaling in 3D Nowdz for an exact amount, as in Blender (for example G Z 0.5 or R 90).
- 3D Nowdz Inset and Bevel can be changed after they finish, with exact thickness, width and segments.
- 3D Nowdz Humanoid skeleton now fits imported and cartoon models: bones go where the model's hands, crotch, ankles and toes are, for big heads, short legs, large shoes and arms held out in a T or A pose, so a model from a game can be rigged in one click and posed on the stage.
- 3D Nowdz OBJ import gives each material its own colour when no .mtl file is chosen.
- 3D Nowdz outlines can taper to sharp tips and use a darker shade of each part's colour for coloured line art.
- 3D Nowdz can set shading normals, so faces shade smoothly like a 2D drawing instead of showing every nose and cheek bump.
- 3D Nowdz soft select has Connected only (Alt+O), so pulling an upper eyelid or lip leaves the one next to it alone.
- 3D Nowdz has Blender's modeling tools: Bevel (Ctrl+B), Knife (K), Dissolve (Ctrl+X), Rip (V), Grid fill, Smooth, Triangulate (Ctrl+T), Tris to quads (Alt+J), Poke, Fill holes, and a Merge menu (M) with At First, At Last and Collapse.
- 3D Nowdz Shrinkwrap presses points onto another part's surface, for hair or clothes on a head or body. Set Wrap to Along view to press them onto the surface you see them on, so an eye drawn in Front view lands on the face.
- 3D Nowdz can hide parts of a model while you edit (H, Shift+H, Alt+H), keep edges sharp when smoothing (Shift+E), and give clothes and hair thickness with Solidify.
- 3D Nowdz can import .glb and .gltf models with their bones and weights, and export models as .glb with the rig attached.
- 3D Nowdz: Mirror mode is now a checkbox at the top of the Edit panel, so you can trace one side of a face and see the other side follow.
- 3D Nowdz: File > Start over clears the model in one step, and Undo brings it back.

### Changed

- Blender Lite is now called 3D Nowdz.
- Leaving 3D Nowdz for another tab keeps your unfinished model, and it comes back where you left off the next time you open the Model tab, even after a restart.
- Extrude, Delete and Duplicate now work on selections Blender allows, such as faces that touch only at a corner or a whole block of faces.

### Fixed

- Fixed movieclips made while another layer had figures joining their figures to the wrong part (or to itself), which could stop the project from opening with “Figures contain a cyclic join.” Such projects now open with their movieclips repaired.
- Fixed the 3D Nowdz knife refusing to cut across a pushed-in panel or step.
- Fixed 3D Nowdz automatic weights locking a leg made in one piece to the thigh so it couldn't bend at the knee, and hair or quills at the back of the head following the chest or an arm.
- Fixed 3D Nowdz showing "OBJ imported" while adding nothing. Models from games and other programs that break the mesh rules (doubled faces, three faces on one edge, mixed winding) are now repaired on import, and a file that still can't be read shows why.
- Fixed 3D Nowdz drawing parts that pass through each other wrongly, such as hair through a head: each spot now shows the nearest surface.
- Fixed stretched or resized 3D limbs pinching thin where two bones meet when they twist.
- Fixed being unable to leave the Model tab without closing the app.
- Fixed traced points looking greyed out and not editable after coming back to the Model tab.
- Fixed half of an extruded eye ring or other open surface disappearing in 3D Nowdz: both sides now show and can be edited, as in Blender.
- Fixed Close and Add to animation being hidden off the edge of the 3D Nowdz bar on smaller windows.
- Fixed Symmetrize mirroring around the part instead of the middle of the model.
- Fixed the walls of an extruded eye ring disappearing while you dragged them.
- Fixed Loop cut on a traced line, which now cuts the line into pieces.

## [1.6.2]

Credits for StykAnimate

### Added

- The welcome screen now says that StykNowdz is a fork of StykAnimate by Alexio, credits his work, asks you to support him, and lists what StykNowdz adds.

### Fixed

- Fixed the missing space in "What's new in StykNowdz" on the welcome screen.

## [1.6.1]

Reference images that stay put

### Added

- Flip for reference images, for a side drawing that faces the other way.

### Fixed

- Fixed reference images in Blender lite vanishing when you orbited or switched views, which also made loading the side image look like it replaced the front one. Both now stand in the scene as in Blender: the front image behind the model and the side image off to its left, each facing you in its own view.

## [1.6.0]

Face rigs, edge slide and a cleaner Blender lite

### Added

- Face bones in Blender lite: one click adds a jaw, lips, lip corners, brows, eyelids and eyes to the head. Each pulls only the skin around it, the jaw and lower lip never drag the upper lip, eyeballs can follow their Eye bone, and Move to selection snaps a bone onto an eyeball.
- On the stage, a figure's face joints hide behind a small face badge on its head, so the head isn't crowded. Click the badge (or Face controls in the rig panel) to show them, and again to hide them.
- Loop cuts with several cuts at once (scroll while pointing), and a single cut slides along the edges before you place it.
- Edge slide (G, then G again) moves points along their edges so they stay on the surface.
- Soft select falloffs: Smooth, Sphere, Root, Inverse square, Sharp, Linear and Constant.
- A controls card shows the main keys when Blender lite opens. Tick "Don't show this when Blender lite opens" to stop it; the keyboard button in the bar brings it back.

### Changed

- Blender lite now looks like the rest of StykNowdz: floating panels, pill buttons, segmented modes and the app's icons.
- Alt+click selects a traced line or the whole open border of a shape, such as the outer edge of an eye ring.
- While moving, rotating or scaling, G, R and S switch to the other one, and cancelling an extrude's move keeps the extruded faces, so E, right-click, S works as in Blender.

## [1.5.0]

Trace a face point by point

### Added

- Model the way anime-face tutorials do, from a single point: Add › Single point, then E pulls out the next point (or Ctrl+click puts it where you click), F joins two points with a line or fills a traced ring into a face, and Bridge (Ctrl+E) fills the strip between two traced lines with faces. Traced lines show in Edit and Object mode (mirrored parts show the other half dashed), new faces face you, and lines that are not filled yet stay out of the animation.
- Selecting, deleting, merging, duplicating, joining, mirroring, undo and the mesh integrity checks all understand traced points and lines.

## [1.4.0]

Toon look (cel shading) and anime modeling tools

### Added

- Toon look for Blender lite models: ink outlines on any part (thickness and colour), hard-edged toon shadows from a light you can move, and a Toon preview that shows the model as the stage will. Shadows follow the figure as it turns, recolouring a figure recolours its shadows, and parts such as eyes can stay flat.
- Soft select (O) in Edit mode: nearby points follow what you move, less the farther they are; scroll while moving to change the circle.
- Shear (Ctrl+Alt+Shift+S) to slant points, as in Blender.
- Mirror clipping: on mirrored parts the middle stays joined and nothing crosses it.
- A Circle shape: one flat disc facing the front, ready to inset into anime eye rings.

## [1.3.1]

Smooth 3D turning, and StykNowdz everywhere

### Changed

- The app now says StykNowdz everywhere you see its name: the window title, menus, messages, file types in Windows, and the library folder (Documents\StykNowdz). Links about the original StykAnimate project still name it.

### Fixed

- Turning a 3D figure with the rotation ball on Figure rotation no longer makes it jump between poses: rolling it now turns the whole figure, so its turn and tilt stay put.

## [1.3.0]

Model tab, drag-to-pose bones, and smoother 3D models

### Added

- A Model tab beside Animate, Draw and Build opens Blender lite (it edits the selected 3D model, or starts a new one). Animate, Draw or Build takes you back.
- Drag bones like nodes in Blender lite: drag a joint to bend its bone (the bones below follow), hold Ctrl and drag to stretch it, or drag a bone's middle to move it. Drag a part or a point to move it too; G, R and S still work.

### Fixed

- Posing a Blender lite model on the stage no longer tears it: bending the hips now carries the whole upper body, and the legs stay where they are.
- Sleeves, forearms, legs, shoes and heads keep their shape when you bend a joint instead of flattening where they meet.
- Make 3D now works on figures with IK, like the starting stickman: it switches IK off for that figure (Undo brings it back).

## [1.2.0]

Blender lite: model your own 3D characters

### Added

- Blender lite, a 3D modeler inside StykNowdz: choose File › New 3D model, start from a base character or a simple shape, and add the result to your animation as a 3D figure you can pose.
- Shape parts with extrude, inset, loop cut, subdivide, merge, fill, symmetrize and more, with mirror and smooth that update as you work.
- Build a skeleton from a humanoid template or bone by bone; each part follows its bones automatically, and you can see what a bone moves.
- Paint parts and faces from a color palette, trace over front and side reference drawings, and bring models in and out as OBJ files.
- Right-click a figure made in Blender lite and choose Edit 3D model to change it; its poses stay in every frame.
- Every modeling change is checked: one that would break the model's surface (a loose point, an edge shared by three faces, a bow-tie) is undone with an explanation, so models always stay clean.

## [1.1.0]

Make 3D: turn your stick figures in depth

### Added

- Make 3D: right-click any stick figure and choose Make 3D to turn it in depth with Rotate figure and Turn / tilt. It looks the same until you turn it, curved parts included.
- Make whole group 3D: turn a figure built from many joined pieces, like a Pivot character, as one solid figure. Give it a side-view frame from a turnaround to take depth from the drawing.
- Make free 3D joint: right-click a part of a 3D figure to pose it in depth on its own.

## [1.0.0]

The first StykNowdz release: new segment shapes and curves

### Added

- Build a part as a Triangle that tapers to a point (flip it or turn it into a right triangle), an Ellipse (or half ellipse), a Polygon with 3 to 256 sides, or a Trapezoid with its own Start and End thickness and an optional rounded start or end, to shape muscles or fake depth.
- Bend a round line, square line or trapezoid into an arc with the new Curve setting.
- Stick Nodes projects keep their triangles, ellipses, polygons, trapezoids and curves when you import them.
- Everyday Props · Pivot 3D: 30 editable everyday objects with working hinges and wheels for your animations.
- Vehicles · Pivot 3D asset pack with twelve editable vehicles, spinning wheels, steering and opening parts.
- Named poses for articulated figures, with detailed controls that can be shown when needed.
- Change individual colors on 3D figures from the Colors palette.
- Keep several projects open at once in tabs, each with its own undo history, and switch between them with a click or Ctrl+Tab.
- A new Home page to start an animation in landscape, vertical or square, reopen your projects and organize them with pins and folders.
- Five short interactive tutorials that guide you step by step through the canvas, posing, the timeline and the panels.
- Right-click a joint and choose Disconnect segment to turn that part of a figure into a figure of its own.

### Changed

- StykNowdz is a free, open-source edition of StykAnimate 1.2.5 under the GPL-3.0 license.
- Automatic updates are off. New versions are posted on the StykNowdz GitHub page.
- Ctrl-dragging a node that uses IK stretches it like any other node.
- A calmer top bar: the menus are in the app menu, and your open projects take their place.

### Fixed

- Fixed an error when deleting your last color palette.
