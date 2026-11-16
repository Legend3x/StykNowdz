import test from 'node:test';
import assert from 'node:assert/strict';
import {filterEffects,applyStickNodesFilters,upgradeStickNodesFilters,FILTERS_VERSION} from '../src/sticknodes/filters.mjs';
import {validateVfxStack,interpolateVfx,activeVfx} from '../src/vfx.mjs';
import {importWarningMessage} from '../src/import-notes-localization.mjs';

const color=(r,g,b,a=255)=>({r,g,b,a});
const neutral={opacity:1,blur:0,motionBlur:false,omnidirectionalBlur:false,motionBlurAngle:0,saturation:1,pixelation:0,tintColor:color(255,255,255),tintAmount:0,hueShift:0,invert:false,
 glow:0,glowColor:color(0,150,255),glowIntensity:1,outlineColor:color(255,0,150),outlineAlpha:1,outlineThickness:0,dropShadowColor:color(0,0,0),dropShadowAlpha:0,dropShadowDistance:10,dropShadowAngle:135,dropShadowBlur:.5};
const pose=(uid,style,extra={})=>({unique_id:uid,figure_type_id:1,_styk:{sticknodes:{style:{...neutral,...style}}},...extra});

test('untouched Stick Nodes filters, including old files storing pixelation 0, add no effects',()=>{
 assert.deepEqual(filterEffects(neutral),{});
 assert.deepEqual(filterEffects({...neutral,pixelation:1}),{});
 assert.deepEqual(filterEffects(undefined),{});
});

test('each Stick Nodes filter becomes the matching effect with valid settings',()=>{
 const fx=filterEffects({...neutral,saturation:.35,hueShift:.1,invert:true,tintColor:color(0x58,0x7f,0x4f),tintAmount:.45,pixelation:6,blur:.5,
  outlineThickness:3,outlineColor:color(255,0,0,128),glow:.65,glowColor:color(255,255,0),glowIntensity:1.9,dropShadowAlpha:1,dropShadowDistance:10,dropShadowAngle:135,dropShadowBlur:0});
 assert.deepEqual(fx.grade,{saturation:.35,hue:36,invert:1});
 assert.deepEqual(fx.tint,{color:0x587f4f,mix:.45});
 assert.deepEqual(fx.pixelate,{size:6,linked:1});
 assert.deepEqual(fx.blur,{mode:0,radius:8});
 assert.equal(fx.outline.color,0xff0000);assert.ok(Math.abs(fx.outline.opacity-128/255)<1e-9);assert.equal(fx.outline.width,3);
 assert.deepEqual(fx.glow,{color:0xffff00,radius:16,intensity:1.9,mode:0});
 // Stick Nodes' default 135° light casts the shadow down and to the right.
 assert.ok(fx.shadow.offsetX>7&&fx.shadow.offsetY>7,JSON.stringify(fx.shadow));assert.equal(fx.shadow.radius,0);
 const motion=filterEffects({...neutral,blur:.25,motionBlur:true,motionBlurAngle:30});assert.deepEqual(motion.blur,{mode:1,radius:4,angle:-30});
 assert.equal(filterEffects({...neutral,hueShift:-.75}).grade.hue,90,'turns wrap into −180…180');
 const keyframes=[{objects:[pose(1,{saturation:.35,hueShift:.1,tintAmount:.45,blur:.5,glow:.65,outlineThickness:3,dropShadowAlpha:1,pixelation:6})]}];
 applyStickNodesFilters(keyframes);
 const stack=keyframes[0].objects[0]._stykVfx.figure;
 assert.deepEqual(stack.map(e=>e.type),['grade','tint','pixelate','blur','outline','glow','shadow']);
 assert.doesNotThrow(()=>validateVfxStack(stack));
});

test('filters tween between poses: poses without one fade it with the nearest colour',()=>{
 const keyframes=[{objects:[pose(7,{})]},{objects:[pose(7,{tintAmount:1,tintColor:color(0x3e,0x54,0x3a)})]},{objects:[pose(7,{tintAmount:.5,tintColor:color(0,0,0)})]},{objects:[pose(7,{})]}];
 assert.equal(applyStickNodesFilters(keyframes),4);
 const tints=keyframes.map(k=>k.objects[0]._stykVfx.figure.find(e=>e.type==='tint'));
 assert.deepEqual(tints.map(t=>t.params.mix),[0,1,.5,0]);
 assert.deepEqual(tints.map(t=>t.params.color),[0x3e543a,0x3e543a,0,0],'a fade keeps the colour of the pose it fades from or to');
 assert.equal(new Set(tints.map(t=>t.id)).size,1,'one id across poses so the effect tweens');
 const half=interpolateVfx(keyframes[0].objects[0]._stykVfx,keyframes[1].objects[0]._stykVfx,.5).figure[0];
 assert.equal(half.params.mix,.5);
 assert.equal(activeVfx(keyframes[0].objects[0]._stykVfx.figure).length,0,'a zero-strength pose draws nothing');
});

test('an instance’s own effects stay, and converting again replaces rather than duplicates',()=>{
 const own={version:2,id:'mine',type:'glow',enabled:true,params:{intensity:.4}};
 const keyframes=[{objects:[pose(3,{tintAmount:.2,tintColor:color(0,0,0)},{_stykVfx:{figure:[own],'1/2':[own]}})]}];
 applyStickNodesFilters(keyframes);applyStickNodesFilters(keyframes);
 const vfx=keyframes[0].objects[0]._stykVfx;
 assert.deepEqual(vfx.figure.map(e=>e.id),['sn-tint','mine']);assert.deepEqual(vfx['1/2'],[own]);
 assert.deepEqual(filterEffects(undefined),{});
});

test('a child using its parent’s filters takes the parent’s settings',()=>{
 const child=pose(2,{});child._styk.sticknodes.filterStyle={...neutral,glow:.5,glowColor:color(255,0,0)};
 const keyframes=[{objects:[pose(1,{glow:.5,glowColor:color(255,0,0)}),child]}];
 applyStickNodesFilters(keyframes);
 assert.deepEqual(keyframes[0].objects[1]._stykVfx.figure,keyframes[0].objects[0]._stykVfx.figure);
});

test('documents saved before the conversion gain their filters once, movieclips included',()=>{
 const clip={keyframes:[{objects:[pose(5,{saturation:.5})]}],figure_types:[]};
 const doc={_styk:{sticknodes:{version:1}},keyframes:[{objects:[pose(1,{tintAmount:1,tintColor:color(0,181,0)})]}],figure_types:[{_styk:{movieclip:{document:clip}}}]};
 assert.equal(upgradeStickNodesFilters(doc),2);assert.equal(doc._styk.sticknodes.filters,FILTERS_VERSION);
 assert.equal(clip.keyframes[0].objects[0]._stykVfx.figure[0].type,'grade');
 delete doc.keyframes[0].objects[0]._stykVfx;
 assert.equal(upgradeStickNodesFilters(doc),0,'effects removed afterwards stay removed');
 assert.equal(doc.keyframes[0].objects[0]._stykVfx,undefined);
 assert.equal(upgradeStickNodesFilters({_styk:{}}),0,'other documents are untouched');
});

test('the filters import note is translated by code',()=>{
 assert.deepEqual(importWarningMessage({code:'FILTERS',message:'x'}),{messageKey:'importNotes.filters'});
});

import {cameraWobble,wobbleClips} from '../src/sticknodes/filters.mjs';
import {validateCameraMotion,sampleCameraMotion} from '../src/camera-motion.mjs';
test('camera wobble becomes one Handheld move per run of frames with the same wobble',()=>{
 assert.equal(cameraWobble({wobbleXY:false,wobbleRotation:false,wobbleScale:false,wobbleXYIntensity:8}),null);
 const scale={wobbleXY:false,wobbleRotation:false,wobbleScale:true,wobbleXYIntensity:8,wobbleRotationIntensity:.5,wobbleSpeed:3};
 assert.deepEqual(cameraWobble(scale),{moveX:0,moveY:0,roll:0,zoom:.032,frequency:1.5});
 assert.deepEqual(cameraWobble({wobbleXY:true,wobbleRotation:true,wobbleScale:false,wobbleXYIntensity:12,wobbleRotationIntensity:2,wobbleSpeed:4}),{moveX:12,moveY:12,roll:2,zoom:0,frequency:2});
 assert.equal(cameraWobble({legacyWobble:true,legacyWobbleIntensity:5,wobbleSpeed:3}).moveX,5,'older files’ single wobble moves the camera');
 const kf=(n,camera)=>({duration_raw:n,_sticknodesFrame:{camera}});
 const clips=wobbleClips([kf(20,scale),kf(20,scale),kf(10,{}),kf(8,{...scale,wobbleXY:true}),kf(4,scale)]);
 assert.deepEqual(clips.map(c=>[c.type,c.start,c.duration]),[['handheld',0,40],['handheld',50,8],['handheld',58,4]]);
 const state={version:1,clips};assert.doesNotThrow(()=>validateCameraMotion(state));
 assert.equal(sampleCameraMotion(state,45).zoom,1,'frames without wobble stay still');
 assert.ok([5,12,20,30].some(t=>Math.abs(sampleCameraMotion(state,t).zoom-1)>.005),'the wobbling frames sway');
});
test('opening a saved import adds its camera wobble once and keeps the user’s camera moves',()=>{
 const scale={wobbleScale:true,wobbleXYIntensity:8,wobbleSpeed:3};
 const own={id:'mine',type:'shake',start:0,duration:4,enabled:true,params:{strength:1,moveX:12,moveY:12,roll:1,zoom:0,frequency:8,roughness:.5,direction:0,recovery:5,phase:0,fadeIn:2,fadeOut:4,seed:1}};
 const doc={_styk:{sticknodes:{version:1},cameraMotion:{version:1,clips:[own]}},keyframes:[{duration_raw:10,objects:[],_sticknodesFrame:{camera:scale}}],figure_types:[]};
 upgradeStickNodesFilters(doc);
 assert.deepEqual(doc._styk.cameraMotion.clips.map(c=>c.id),['mine','sticknodes-wobble-1']);
 doc._styk.sticknodes.filters=0;upgradeStickNodesFilters(doc);
 assert.equal(doc._styk.cameraMotion.clips.length,2,'never added twice');
});
