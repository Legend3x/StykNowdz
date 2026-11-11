/** Wavefront OBJ in and out for 3D Nowdz, so models travel to and from
 * Blender and other tools. Groups (`o`/`g`) become parts; materials (`usemtl`)
 * become palette colors when a companion MTL's `Kd` is given. */
import {evaluatePart} from './model.mjs';
import {recalculateNormals, repairImportedMesh} from './mesh.mjs';
import {validateMesh, TopologyError} from './topology.mjs';

/** The model's evaluated parts (mirror and smooth applied) as OBJ text, plus an MTL for colors. */
export function exportObj(model, {name = 'model'} = {}) {
  const lines = [`# StykNowdz 3D Nowdz`, `mtllib ${name}.mtl`], mtl = [];
  model.palette.forEach((c, i) => mtl.push(`newmtl color${i}`, `Kd ${c.map(v => (v / 255).toFixed(4)).join(' ')}`, ''));
  let offset = 1;
  for (const part of model.parts.filter(p => p.visible !== false)) {
    const mesh = evaluatePart(part);
    lines.push(`o ${String(part.name || 'Part').replace(/\s+/g, '_')}`);
    for (const p of mesh.verts) lines.push(`v ${p.map(v => +v.toFixed(6)).join(' ')}`);
    let current = -1;
    for (const f of mesh.faces) {
      if (f.c !== current) { current = f.c; lines.push(`usemtl color${current}`); }
      lines.push(`f ${f.v.map(i => i + offset).join(' ')}`);
    }
    offset += mesh.verts.length;
  }
  return {obj: lines.join('\n') + '\n', mtl: mtl.join('\n')};
}

/** Parse OBJ (and optional MTL) text into parts: [{name, mesh}], adding material colors to `palette`. */
export function importObj(text, {mtl = '', palette = []} = {}) {
  const colors = new Map();
  let current = null;
  for (const raw of mtl.split(/\r?\n/)) {
    const [key, ...rest] = raw.trim().split(/\s+/);
    if (key === 'newmtl') current = rest.join(' ');
    else if (key === 'Kd' && current) colors.set(current, rest.slice(0, 3).map(v => Math.max(0, Math.min(255, Math.round(Number(v) * 255)))));
  }
  const verts = [], parts = [];
  let part = null, material = 0;
  const start = name => { part = {name: name || `Part ${parts.length + 1}`, map: new Map(), mesh: {verts: [], faces: []}}; parts.push(part); };
  const paletteIndex = name => {
    const rgb = colors.get(name);
    if (!rgb) return 0;
    let i = palette.findIndex(c => c.every((v, k) => v === rgb[k]));
    if (i < 0) { palette.push(rgb); i = palette.length - 1; }
    return i;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line[0] === '#') continue;
    const [key, ...rest] = line.split(/\s+/);
    if (key === 'v') { const p = rest.slice(0, 3).map(Number); if (p.length === 3 && p.every(Number.isFinite)) verts.push(p); else throw new Error('This OBJ file has a vertex that is not a number.'); }
    else if (key === 'o' || key === 'g') start(rest.join(' '));
    else if (key === 'usemtl') material = paletteIndex(rest.join(' '));
    else if (key === 'f') {
      if (!part) start('Imported');
      const ids = rest.map(token => { const n = parseInt(token.split('/')[0], 10); return n < 0 ? verts.length + n : n - 1; });
      if (ids.length < 3 || ids.some(i => !Number.isInteger(i) || i < 0 || i >= verts.length)) throw new Error('This OBJ file has a face that points at a missing vertex.');
      const local = ids.map(i => { if (!part.map.has(i)) { part.map.set(i, part.mesh.verts.length); part.mesh.verts.push(verts[i].slice()); } return part.map.get(i); });
      if (new Set(local).size === local.length) part.mesh.faces.push({v: local, c: material});
    }
  }
  const out = parts.filter(p => p.mesh.faces.length).map(p => ({name: p.name, mesh: p.mesh}));
  if (!out.length) throw new Error('This OBJ file has no faces.');
  // Imported parts must follow the topology rules. Files from games and other
  // programs often break them (doubled faces, fins, mixed winding, bow-ties), so
  // those are split apart on the way in; anything still wrong is refused in full.
  for (const p of out) {
    repairImportedMesh(p.mesh, {weld: 1e-6});
    try { recalculateNormals(p.mesh); }
    catch (error) {
      if (!(error instanceof TopologyError)) throw error;
      const check = validateMesh(p.mesh, {label: `imported part “${p.name}”`, print: false});
      throw new TopologyError(`Importing part “${p.name}”`, check.ok ? error.result : check);
    }
  }
  return out;
}
