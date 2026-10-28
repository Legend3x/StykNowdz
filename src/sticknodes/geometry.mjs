/** Imported shapes use the common geometry path (GPU, Canvas, SVG and clips).
 * Handles keep their native chord endpoints; artwork may extend past them. */
import {segmentCurve} from './decoder/geometry.mjs';

export function sticknodesShape(seg,obj){const shape=obj._sticknodesShapes?.[seg.segment_id]??seg._sticknodes;if(!shape)return null;const primitive=shape.kind==='rounded-segment'?0:shape.kind==='segment'?6:3;return Number(seg.primitive_code??primitive)===primitive?shape:null;}
export function sticknodesCurve(shape,start,angle,length,scale){
 const c=Math.cos(angle),s=Math.sin(angle);
 return segmentCurve(length,(shape.sagitta??0)*Math.abs(scale)*(shape.reversed?-1:1),shape.curve_circulization).points.map(p=>({x:start.x+c*p.x-s*p.y,y:start.y+s*p.x+c*p.y}));
}
export function sticknodesSpriteAsset(asset,obj){
 const p=obj._sticknodesSprite;if(!p||!asset)return asset;
 return {...asset,display_width:asset.width,display_height:asset.height*p.ratio,
  anchor_start:{x:asset.width*p.pivotX,y:asset.height*p.ratio*(1-p.pivotY)}};
}
/** Triangle and Trapezoid can be authored in Build as well as imported. Both
 * are primitive 3 segments whose `_sticknodes.kind` selects the drawn shape. */
export const AUTHORED_SHAPES=Object.freeze(['triangle','trapezoid','ellipse','polygon']);
export const POLYGON_SIDES=Object.freeze({min:3,max:256,initial:5});
export const authoredShapeOf=seg=>seg?.primitive_code===3&&AUTHORED_SHAPES.includes(seg._sticknodes?.kind)?seg._sticknodes.kind:null;
/** Start/end widths of a trapezoid in definition units, mirroring sticknodesDrawables:
 * a negative top ratio selects the explicit start/end fields, otherwise the end is a ratio of the width. */
export function trapezoidWidths(shape,thickness){
 const ratio=shape?.trapezoid_top_thickness_ratio??.5;
 return ratio<0?{start:Math.abs(shape.trapezoid_thickness_start??thickness),end:Math.abs(shape.trapezoid_thickness_end??thickness/2)}
  :{start:thickness,end:Math.abs(thickness*ratio)};
}
/** The shape written by choosing a shape in Build; Trapezoid starts at the current width and halves toward its end. */
export const authoredShape=(kind,thickness)=>kind==='trapezoid'
 ?{kind,trapezoid_top_thickness_ratio:-1,trapezoid_thickness_start:thickness,trapezoid_thickness_end:thickness/2}
 :kind==='polygon'?{kind,num_polygon_vertices:POLYGON_SIDES.initial}:{kind};
/** Round lines, square lines and trapezoids can bend into an arc (`sagitta`, in definition units). Returns the shape kind that carries it. */
export const curvableKind=seg=>authoredShapeOf(seg)==='trapezoid'?'trapezoid':seg?.primitive_code===0?'rounded-segment':seg?.primitive_code===6?'segment':null;
/** Parts a right-drag can bend into an arc: round lines, square lines and Stick Nodes trapezoids. */
export const bendableSegment=seg=>[0,6].includes(seg?.primitive_code??((seg?.flags??0)&255))||authoredShapeOf(seg)==='trapezoid';
/** The shape after setting its curve: zero removes it, and a line left with nothing but its kind returns undefined so it is a plain line again. */
export function withCurve(seg,sagitta){
 const kind=curvableKind(seg),shape={...(seg._sticknodes?.kind===kind?seg._sticknodes:{kind})};
 if(sagitta)shape.sagitta=sagitta;else delete shape.sagitta;
 return kind!=='trapezoid'&&Object.keys(shape).length===1?undefined:shape;
}
/** Shape after toggling an option flag (`true` stores it, `false` drops it); `kind` must match so a stale shape is never edited. */
export function withShapeFlag(shape,key,on){const next={...shape};if(on)next[key]=true;else delete next[key];return next;}
/** The shape after one end is set: both ends become explicit and every other imported field is kept. */
export function withTrapezoidEnd(shape,thickness,end,value){
 const w=trapezoidWidths(shape,thickness);
 return {...shape,kind:'trapezoid',trapezoid_top_thickness_ratio:(shape?.trapezoid_top_thickness_ratio??.5)<0?shape.trapezoid_top_thickness_ratio:-1,
  trapezoid_thickness_start:end==='start'?value:w.start,trapezoid_thickness_end:end==='end'?value:w.end};
}
/** The four corners of a straight trapezoid whose sides run tangent to any round cap, so a cap blends into the body instead of leaving a notch.
 * `a` and `b` are the start and end nodes, `r0` and `r1` their half-widths. A flat end keeps its square corners.
 * Returns null when neither end is round or a cap swallows the other end, and the caller keeps the plain corners. */
export function roundedTrapezoid(a,b,r0,r1,roundStart,roundEnd){
 const L=Math.hypot(b.x-a.x,b.y-a.y);if(!(roundStart||roundEnd)||!(L>1e-9))return null;
 let ua,ub;
 if(roundStart&&roundEnd){const s=(r1-r0)/L;if(!(Math.abs(s)<1))return null;const c=Math.sqrt(1-s*s);ua=[-r0*s,r0*c];ub=[L-r1*s,r1*c];}
 else if(roundStart){const d=Math.hypot(L,r1);if(!(d>r0))return null;const t=Math.atan2(r1,L)+Math.acos(r0/d);ua=[r0*Math.cos(t),r0*Math.sin(t)];ub=[L,r1];}
 else{const d=Math.hypot(L,r0);if(!(d>r1))return null;const t=Math.atan2(r0,-L)-Math.acos(r1/d);ua=[0,r0];ub=[L+r1*Math.cos(t),r1*Math.sin(t)];}
 const ux=(b.x-a.x)/L,uy=(b.y-a.y)/L,at=([x,y])=>({x:a.x+ux*x-uy*y,y:a.y+uy*x+ux*y});
 return [at(ua),at(ub),at([ub[0],-ub[1]]),at([ua[0],-ua[1]])];
}
export function sticknodesDrawables(s){
 const n=sticknodesShape(s.seg,s.obj);if(!n)return null;
 const scale=Math.abs(s.obj.scale??1),L=n.connector?(n.drawRatio?s.length*n.drawRatio:n.drawLength*scale):s.length,T=s.thickness;
 const c=Math.cos(s.angle),sn=Math.sin(s.angle),point=(x,y=0)=>{if(n.reversed){x=s.length-x;y=-y;}return {x:s.start.x+c*x-sn*y,y:s.start.y+sn*x+c*y};};
 const start=point(0),end=point(L),base={...s,start:n.reversed?end:start,end:n.reversed?start:end,length:L},out=[];
 const poly=(points,extra={})=>out.push({...base,type:'poly',points,...extra});
 const circle=(center,r,color,inner=0)=>{
  const length=inner?r+inner:2*r,thickness=inner?r-inner:0;
  out.push({...base,type:'circle',start:{x:center.x-c*length/2,y:center.y-sn*length/2},end:{x:center.x+c*length/2,y:center.y+sn*length/2},length,thickness,points:[center],
   seg:{...s.seg,segment_kind:inner?'circleClear':'circleFill',...(color?{paint:undefined,secondary:null}:{})},...(color?{rgb:color,alpha:n.outlineAlpha??1}:{})});
 };
 const oval=(cx,rx,ry,half=false,flipped=false)=>Array.from({length:half?65:64},(_,i)=>{const t=half?-Math.PI/2+Math.PI*i/64:Math.PI*i/32;return point(cx+(flipped?-1:1)*rx*Math.cos(t),ry*Math.sin(t));});
 const curvePoints=()=>Math.abs(s.bend)>1e-7&&!s._sticknodesCurve?(n.reversed?s.points.toReversed():s.points):n.sagitta?sticknodesCurve({...n,reversed:false},start,s.angle+(n.reversed?Math.PI:0),L,scale):[start,end];
 if(n.kind==='rounded-segment')return [{...base,type:'line',points:curvePoints()}];
 if(n.kind==='segment'||n.kind==='trapezoid'){
  const pts=curvePoints();
  let ws=T,we=T;
  if(n.kind==='trapezoid'){const ratio=n.trapezoid_top_thickness_ratio??.5;we=Math.abs(T*ratio);if(ratio<0){ws=Math.abs(n.trapezoid_thickness_start??T)*scale;we=Math.abs(n.trapezoid_thickness_end??T/2)*scale;}}
  const smooth=n.kind==='trapezoid'&&pts.length===2?roundedTrapezoid(pts[0],pts[1],ws/2,we/2,!!n.trapezoid_is_rounded_start,!!n.trapezoid_is_rounded_end):null;
  if(smooth)poly(smooth);else{const a=[],b=[];for(let i=0;i<pts.length;i++){const prev=pts[Math.max(0,i-1)],next=pts[Math.min(i+1,pts.length-1)],d=Math.hypot(next.x-prev.x,next.y-prev.y)||1,r=(ws+(we-ws)*i/(pts.length-1))/2,dx=-(next.y-prev.y)/d*r,dy=(next.x-prev.x)/d*r;a.push({x:pts[i].x+dx,y:pts[i].y+dy});b.push({x:pts[i].x-dx,y:pts[i].y-dy});}poly([...a,...b.reverse()]);}
  if(n.trapezoid_is_rounded_start)circle(pts[0],ws/2);
  if(n.trapezoid_is_rounded_end)circle(pts[pts.length-1],we/2);
 }else if(n.kind==='circle'){
  const r=(L+T)/2,inner=Math.max(0,(L-T)/2),mid=point(L/2);
  if(n.half_arc)poly(oval(n.triangle_upside_down?L+T/2:-T/2,L+T,L+T,true,n.triangle_upside_down));
  else if(n.use_circle_outline&&n.circle_is_hollow)circle(mid,r,n.outline,inner);
  else{circle(mid,r,n.use_circle_outline?n.outline:null);if(n.use_circle_outline&&inner>0)circle(mid,inner);}
 }else if(n.kind==='ellipse')poly(oval(n.half_arc?(n.triangle_upside_down?L:0):L/2,n.half_arc?L:L/2,T/2,n.half_arc,n.triangle_upside_down&&n.half_arc));
 else if(n.kind==='triangle')poly([[0,-T/2],[0,T/2],[L,Math.sign(n.right_triangle_direction??0)*T/2]].map(([x,y])=>point(n.triangle_upside_down?L-x:x,y)));
 else {const count=Math.max(3,Math.min(256,n.num_polygon_vertices??5)),r=(L+T)/2;poly(Array.from({length:count},(_,i)=>point(L/2+r*Math.cos(i*2*Math.PI/count),r*Math.sin(i*2*Math.PI/count))));}
 return out;
}
