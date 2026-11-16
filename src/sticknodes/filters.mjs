/** Stick Nodes filters → StykAnimate effects.
 *
 * Each imported instance records its Stick Nodes filter settings per pose in
 * `object._styk.sticknodes.style` (see decoder/project-layout.mjs readStyle).
 * `applyStickNodesFilters` turns them into the object's figure effect stack
 * (`object._stykVfx.figure`) so the stage, playback and exports draw them.
 *
 * Every pose of one instance carries the same effects with the same ids, so
 * effects tween between poses like Stick Nodes filters do. A pose without a
 * filter gets that effect at zero strength, keeping the colour or angle of the
 * nearest pose that uses it so a fade never shifts colour.
 *
 * Mapping (Stick Nodes values → effect settings); Stick Nodes renders filters
 * on its own GPU path, so sizes are close rather than pixel-exact:
 * - Saturation, Hue shift (a fraction of a full turn), Invert → Color grading
 * - Tint colour and amount → Tint
 * - Pixelation (cell size; 0 and 1 are off) → Pixelate
 * - Blur (amount) → Blur, Directional along the motion angle when Motion blur is on
 * - Outline thickness, colour and alpha → Outline (outside)
 * - Glow amount, colour and intensity → Glow (outer)
 * - Drop shadow alpha, colour, distance, angle (light direction) and blur → Shadow
 *
 * Camera wobble on main-timeline frames becomes Handheld camera moves (`wobbleClips`).
 */
import {createVfx} from '../vfx.mjs';
import {createCameraMotion,CAMERA_MOTION_LIMIT} from '../camera-motion.mjs';

export const FILTERS_VERSION=1;
const ORDER=['grade','tint','pixelate','blur','outline','glow','shadow'];
const ID=type=>`sn-${type}`;
const BLUR_PX=16,GLOW_PX=24,SHADOW_BLUR_PX=8;
const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
const num=(v,d=0)=>Number.isFinite(v)?v:d;
const colour=c=>c&&typeof c==='object'?((num(c.r)&255)<<16)|((num(c.g)&255)<<8)|(num(c.b)&255):0;
const alphaOf=c=>c&&typeof c==='object'&&Number.isFinite(c.a)?clamp(c.a/255,0,1):1;
const round=v=>Math.round(v*1e4)/1e4;

/** The effect settings one pose's filters ask for, keyed by effect type. Neutral filters are left out. */
export function filterEffects(style){
 if(!style||typeof style!=='object')return {};
 const out={},s=style;
 const saturation=clamp(num(s.saturation,1),0,3),turns=num(s.hueShift),hue=round(((turns*360%360)+540)%360-180),invert=s.invert?1:0;
 if(saturation!==1||hue||invert)out.grade={saturation,hue:Object.is(hue,-0)?0:hue,invert};
 const tint=clamp(num(s.tintAmount),0,1);
 if(tint>0)out.tint={color:colour(s.tintColor),mix:tint};
 const cells=Math.round(num(s.pixelation));
 if(cells>1)out.pixelate={size:clamp(cells,1,128),linked:1};
 const blur=Math.max(0,num(s.blur));
 if(blur>0){const radius=clamp(Math.round(blur*BLUR_PX),1,128);out.blur=s.motionBlur&&!s.omnidirectionalBlur?{mode:1,radius,angle:clamp(round(((-num(s.motionBlurAngle)%360)+540)%360-180),-180,180)}:{mode:0,radius};}
 const thickness=Math.max(0,num(s.outlineThickness)),outlineOpacity=clamp(num(s.outlineAlpha,1)*alphaOf(s.outlineColor),0,1);
 if(thickness>0&&outlineOpacity>0)out.outline={color:colour(s.outlineColor),width:clamp(round(thickness),0,64),opacity:outlineOpacity,mode:0};
 const glow=Math.max(0,num(s.glow));
 if(glow>0)out.glow={color:colour(s.glowColor),radius:clamp(Math.round(glow*GLOW_PX),1,128),intensity:clamp(round(num(s.glowIntensity,1)),0,3),mode:0};
 const shadow=clamp(num(s.dropShadowAlpha)*alphaOf(s.dropShadowColor),0,1);
 if(shadow>0){const distance=num(s.dropShadowDistance),angle=num(s.dropShadowAngle)*Math.PI/180;
  // The angle points at the light, as in Stick Nodes' default of 135° casting down and right.
  out.shadow={color:colour(s.dropShadowColor),opacity:shadow,radius:clamp(Math.round(Math.max(0,num(s.dropShadowBlur))*SHADOW_BLUR_PX),0,128),
   offsetX:clamp(round(-Math.cos(angle)*distance),-256,256),offsetY:clamp(round(Math.sin(angle)*distance),-256,256),mode:0};}
 return out;
}
/** The same effect at zero strength, keeping its colours, angles and sizes. */
function silenced(type,params){
 const p={...params};
 if(type==='grade')Object.assign(p,{saturation:1,hue:0,invert:0});
 else if(type==='tint')p.mix=0;else if(type==='pixelate')p.size=1;else if(type==='blur')p.radius=0;
 else if(type==='outline'||type==='shadow')p.opacity=0;else if(type==='glow')p.intensity=0;
 return p;
}
function effect(type,params){const base=createVfx(type,ID(type));return {...base,params:{...base.params,...params}};}
/** Every object's effect stack, by keyframe, for one timeline. Objects keep
 * any effects that are not Stick Nodes filters. Returns the number of poses changed. */
export function applyStickNodesFilters(keyframes){
 const poses=new Map();
 for(const [k,kf] of (keyframes??[]).entries())for(const o of kf?.objects??[]){
  const source=o?._styk?.sticknodes;if(!source)continue;
  const wanted=filterEffects(source.filterStyle??source.style),list=poses.get(o.unique_id)??[];list.push({k,o,wanted});poses.set(o.unique_id,list);
 }
 let changed=0;
 for(const list of poses.values()){
  const types=ORDER.filter(type=>list.some(p=>p.wanted[type]));
  for(const [i,pose] of list.entries()){
   const own=(pose.o._stykVfx?.figure??[]).filter(e=>!ORDER.some(type=>e.id===ID(type)));
   const ours=types.map(type=>{
    if(pose.wanted[type])return effect(type,pose.wanted[type]);
    let near=null;for(let d=1;d<list.length&&!near;d++)near=list[i-d]?.wanted[type]??list[i+d]?.wanted[type]??null;
    return effect(type,silenced(type,near));
   });
   if(!ours.length&&own.length===(pose.o._stykVfx?.figure?.length??0))continue;
   const stack=[...ours,...own].slice(0,16),next={...pose.o._stykVfx};
   if(stack.length)next.figure=stack;else delete next.figure;
   if(Object.keys(next).length)pose.o._stykVfx=next;else delete pose.o._stykVfx;
   if(ours.length)changed++;
  }
 }
 return changed;
}
/** Stick Nodes camera wobble as the settings of a Handheld camera move (a smooth random sway, which,
 * unlike a pure sine, never lines up with low frame rates and stands still), or null when it is off.
 * Intensity is in pixels (XY) and degrees (rotation); scale wobble has no intensity of its own in
 * Stick Nodes files and follows the XY intensity. Speed 3, Stick Nodes' default, sways at 1.5 Hz. */
export function cameraWobble(c){
 if(!c||typeof c!=='object')return null;
 const legacy=!!c.legacyWobble,xy=legacy||!!c.wobbleXY,roll=!!c.wobbleRotation,scale=!!c.wobbleScale;if(!xy&&!roll&&!scale)return null;
 const intensity=Math.max(0,num(legacy?c.legacyWobbleIntensity:c.wobbleXYIntensity)),speed=Math.max(0,num(c.wobbleSpeed));
 const params={moveX:xy?clamp(intensity,0,2000):0,moveY:xy?clamp(intensity,0,2000):0,roll:roll?clamp(Math.abs(num(c.wobbleRotationIntensity)),0,90):0,
  zoom:scale?clamp(round((intensity||8)/250),0,4):0,frequency:clamp(Math.round(speed*50)/100||1.5,.05,60)};
 return params.moveX||params.roll||params.zoom?params:null;
}
/** Handheld moves for each run of main-timeline frames with the same camera wobble. */
export function wobbleClips(keyframes){
 const runs=[];let tick=0;
 for(const kf of keyframes??[]){const w=cameraWobble(kf?._sticknodesFrame?.camera),n=Math.max(1,Number(kf?.duration_raw)||1),last=runs.at(-1);
  if(w){if(last&&last.start+last.duration===tick&&JSON.stringify(last.params)===JSON.stringify(w))last.duration+=n;else runs.push({start:tick,duration:n,params:w});}
  tick+=n;}
 return runs.slice(0,CAMERA_MOTION_LIMIT).map((run,i)=>{const clip=createCameraMotion('handheld',`sticknodes-wobble-${i+1}`,run.start,run.duration),fade=Math.min(6,Math.floor(run.duration/4));
  clip.params={...clip.params,...run.params,roughness:.2,fadeIn:fade,fadeOut:fade};return clip;});
}
/** Converts a whole imported document once: filters on every timeline, movieclips
 * included, and camera wobble on the main timeline. Documents saved before this
 * conversion existed pick it up when opened; changes made afterwards are kept. */
export function upgradeStickNodesFilters(document){
 const marker=document?._styk?.sticknodes;if(!marker||marker.filters>=FILTERS_VERSION)return 0;
 let changed=0;const seen=new Set();
 (function walk(doc){if(!doc||seen.has(doc))return;seen.add(doc);changed+=applyStickNodesFilters(doc.keyframes);for(const f of doc.figure_types??[])walk(f?._styk?.movieclip?.document);})(document);
 const motion=document._styk.cameraMotion,existing=motion?.clips??[],room=CAMERA_MOTION_LIMIT-existing.length;
 if(room>0&&!existing.some(c=>c.id.startsWith('sticknodes-wobble-'))){const clips=wobbleClips(document.keyframes).slice(0,room);if(clips.length){document._styk.cameraMotion={version:1,clips:[...existing,...clips]};changed+=clips.length;}}
 marker.filters=FILTERS_VERSION;return changed;
}
