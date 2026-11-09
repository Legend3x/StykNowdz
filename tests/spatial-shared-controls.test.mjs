// Make 3D spike (docs/PSEUDO-3D-PLAN.md, 1.1): can child bones share one
// turn/tilt control pair? Yes for whole-figure turns and 2D posing; no for
// 3D posing of one bone, which would write the shared control and move its
// sharers, so the editor refuses that until the joint is made free.
import test from 'node:test';
import assert from 'node:assert/strict';
const R='../src/';
const {construction}=await import(new URL(R+'rig-examples-3d.mjs',import.meta.url));
const {createObject,createFrame,emptyDocument}=await import(new URL(R+'demo.mjs',import.meta.url));
const {buildGeometry}=await import(new URL(R+'pivot/geometry.mjs',import.meta.url));
const {Editor}=await import(new URL(R+'editor.mjs',import.meta.url));

// Chain: root bone (own turn/tilt) -> A -> B -> C. shared=true: A,B,C use one rest pair.
function chain(shared){
  const q=construction();q.add(0,0,0,'Figure rotation');
  const rootTurn=q.add(0,0,0,'Root turn'),rootTilt=q.add(0,0,0,'Root tilt');
  const restTurn=shared?q.add(0,0,0,'Rest turn'):0,restTilt=shared?q.add(0,0,0,'Rest tilt'):0;
  const bone=(parent,origin,tip,name,own)=>{
    let turn=restTurn,pitch=restTilt;
    if(own){turn=own[0];pitch=own[1];} else if(!shared){turn=q.add(0,0,0,name+' turn');pitch=q.add(0,0,0,name+' tilt');}
    const v=tip.map((n,i)=>n-origin[i]);
    return q.add(parent,Math.hypot(...v),Math.atan2(v[1],v[0]),name,{width:4,rig:{spatial:{parent,origin,tip,turn,pitch}}});
  };
  const root=bone(0,[0,0,0],[0,-60,0],'Spine',[rootTurn,rootTilt]);
  const a=bone(root,[0,-60,0],[40,-40,30],'A');
  const b=bone(a,[40,-40,30],[80,-10,-20],'B');
  const c=bone(b,[80,-10,-20],[100,30,10],'C');
  const figure={figure_type_id:1,segments:q.segments,polyfills:[],image_assets:[],text_assets:[]};
  const object=createObject(figure,1,300,300),doc={...emptyDocument(),figure_types:[figure],keyframes:[createFrame([object])]};
  return {doc,figure,object,ids:{root,a,b,c,rootTurn,rootTilt},count:q.segments.length};
}
const pts=(doc)=>{const g=buildGeometry(doc,doc.keyframes[0]).objects.get(0);return [...g.joints.entries()].filter(([id])=>id>0).map(([id,p])=>[id,+p.x.toFixed(3),+p.y.toFixed(3),+(p.depthOffset?.x??0).toFixed(3)]);};
const byName=(r)=>{const g=buildGeometry(r.doc,r.doc.keyframes[0]).objects.get(0),o={};for(const k of ['root','a','b','c']){const p=g.joints.get(r.ids[k]);o[k]=[+p.x.toFixed(3),+p.y.toFixed(3),+(p.depthOffset?.x??0).toFixed(3)];}return o;};

test('rest pose: shared and per-bone controls agree',()=>{
  const s=chain(true),p=chain(false);
  console.log('segments shared',s.count,'per-bone',p.count);
  assert.deepEqual(byName(s),byName(p));
});
test('whole-figure turn/tilt via root controls: shared and per-bone agree',()=>{
  for(const [turn,tilt] of [[Math.PI/2,0],[Math.PI,0],[0.7,0.4],[-1.2,0.9]]){
    const s=chain(true),p=chain(false);
    for(const r of [s,p]){r.object.angles[r.ids.rootTurn-1]+=turn;r.object.angles[r.ids.rootTilt-1]+=tilt;}
    assert.deepEqual(byName(s),byName(p),`turn ${turn} tilt ${tilt}`);
  }
});
test('ordinary 2D drag (bend) of a child: shared and per-bone agree',()=>{
  const res=[chain(true),chain(false)].map(r=>{const e=new Editor({demo:false});e.load(r.doc);e.select(1,r.ids.b-1);e.rotateJoint(0.6);
    const g=e.geometry.objects.get(0),o={};for(const k of ['a','b','c']){const q=g.joints.get(r.ids[k]);o[k]=[+q.x.toFixed(3),+q.y.toFixed(3)];}return o;});
  assert.deepEqual(res[0],res[1]);
});
test('3D posing one child that shares controls is refused; per-bone controls pose it alone',()=>{
  const [shared,own]=[chain(true),chain(false)].map(r=>{const e=new Editor({demo:false});e.load(r.doc);e.select(1,r.ids.b-1);return {e,r};});
  assert.throws(()=>shared.e.setSpatialPose({turn:shared.e.getSpatialPose().turn+0.8}),/Make free 3D joint/);
  const a=own.e.geometry.objects.get(0).joints.get(own.r.ids.a),bx=[a.x,a.y];
  own.e.setSpatialPose({turn:own.e.getSpatialPose().turn+0.8});
  const moved=own.e.geometry.objects.get(0).joints.get(own.r.ids.a);
  assert.deepEqual([moved.x,moved.y],bx);
});
