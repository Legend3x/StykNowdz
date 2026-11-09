/** 3D Nowdz workspace (docs/BLENDER-LITE.md): a full-window 3D modeler
 * over the app. Object mode arranges parts, Edit mode shapes their polygons,
 * Bones mode builds the skeleton the figure is posed with. Everything works
 * on a plain model document (model.mjs); `onDone(model)` hands it back. */
import {t} from '../localization.mjs';
import * as M from './mesh.mjs';
import {PRIMITIVES, baseCharacter, DEFAULT_PALETTE} from './primitives.mjs';
import {emptyModel, addPart, evaluatePart, evaluateModel, readModel, SMOOTH_MAX} from './model.mjs';
import {addBone, boneOrder, deleteBones, symmetrizeBones, humanoidSkeleton, baseCharacterSkeleton, autoWeights, sideOf, otherSide, faceSkeleton, setFace, faceOf, FACE_CUTS} from './armature.mjs';
import {exportObj, importObj} from './obj-format.mjs';
import {defaultCamera, cameraFrame, VIEWS, paint, pickPolygon, insidePolygon, segmentPixelDistance, VIEW_COLORS, openOf} from './viewport.mjs';
import * as X from './matrix.mjs';
import {TopologyError, assertValidMesh} from './topology.mjs';
import {outlineHull, partOutline, toonSettings, OUTLINE_DEFAULTS, OUTLINE_MAX} from './toon.mjs';
import {TOON_DEFAULTS} from '../toon-shading.mjs';
import {icon as iconMarkup} from '../icons.mjs';

const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
};
const deg = r => Math.round(r * 180 / Math.PI * 100) / 100;
const rad = d => d * Math.PI / 180;
const fmt = v => String(Math.round(v * 1000) / 1000);
// Modal transforms driven by the pointer.
const TRANSFORMS = ['grab', 'rotate', 'scale', 'shear'];
const hex = rgb => '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const rgbOf = value => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));

/**
 * Open the modeler. Resolves nothing; calls `onDone(model)` when the user
 * adds the model to the animation and `onClose()` when they leave. Returns
 * {close, element, state} (state for tests).
 */
/** `draft`: an unfinished model left open last time ({model, camera}), carried on from.
 * onClose(draft) gets the unfinished model when it was closed without Add / Update
 * (null when nothing was changed or it was added), so leaving never loses work. */
export function openModeler({host = document.body, top = 0, model: initial = null, editing = false, draft = null, onDone, onClose} = {}) {
  if (draft?.model) initial = draft.model;
  let model = initial ? readModel(initial) : emptyModel();
  const S = {mode: 'object', selectMode: 'vert', parts: new Set(), active: model.parts[0]?.id ?? null, verts: new Set(), bones: new Set(), boneEnd: null,
    camera: defaultCamera(), xray: false, wire: false, grid: true, toonPreview: Boolean(model.toon?.shadows || model.parts.some(q => q.outline?.on)), soft: false, softRadius: .25, softFalloff: 'smooth', showBones: false, weights: true, modal: null, hover: null, polys: [], undo: [], redo: [], cache: new Map(), refImages: new Map()};
  const listeners = new AbortController(), signal = listeners.signal;

  // ---------- history ----------
  const snapshot = () => JSON.stringify({model, parts: [...S.parts], active: S.active, verts: [...S.verts], bones: [...S.bones], mode: S.mode});
  const restore = text => { const v = JSON.parse(text); model = v.model; S.parts = new Set(v.parts); S.active = v.active; S.verts = new Set(v.verts); S.bones = new Set(v.bones); S.mode = v.mode; S.cache.clear(); syncRefs(); refresh(); };
  /** Run a change as one undo step. A change that would break a mesh is
   * refused: the model goes back to how it was, the full topology report is
   * printed to the console, and the reason shows in the status line. */
  const commit = (fn, {keepRedo = false} = {}) => {
    const before = snapshot();
    let result;
    S.lastOp = null;
    try { result = fn(); }
    catch (error) { restore(before); refuse(error); return undefined; }
    S.undo.push(before); if (S.undo.length > 120) S.undo.shift(); if (!keepRedo) S.redo = []; touch(); return result;
  };
  /** Run an edit that starts an interactive move: on failure nothing changes and no move starts. */
  const attempt = fn => { const before = snapshot(); try { return fn(); } catch (error) { restore(before); refuse(error); return undefined; } };
  function refuse(error) {
    if (error instanceof TopologyError || error instanceof RangeError || error?.modelerMessage) { toast(error.message); return; }
    throw error;
  }
  const undo = () => { if (!S.undo.length) return; S.lastOp = null; S.redo.push(snapshot()); restore(S.undo.pop()); };
  const redo = () => { if (!S.redo.length) return; S.lastOp = null; S.undo.push(snapshot()); restore(S.redo.pop()); };
  const touch = (partId = null) => { if (partId) S.cache.delete(partId); else S.cache.clear(); refresh(); };
  let finished = false;

  const part = id => model.parts.find(p => p.id === id);
  const activePart = () => part(S.active);
  const evaluated = p => {
    const key = p.id, hit = S.cache.get(key);
    if (hit) return hit;
    const mesh = evaluatePart(p); S.cache.set(key, mesh); return mesh;
  };
  // A part's outline shell, rebuilt when its surface or outline settings change.
  const hullOf = p => {
    const outline = partOutline(p, model.palette.length);
    if (!outline) return null;
    const mesh = evaluated(p), key = `hull:${p.id}`, hit = S.cache.get(key);
    if (hit?.mesh === mesh && hit.thickness === outline.thickness && hit.color === outline.color) return hit.hull;
    const hull = outlineHull(mesh, outline.thickness, outline.color);
    S.cache.set(key, {mesh, ...outline, hull}); return hull;
  };

  // ---------- DOM ----------
  const canvas = el('canvas', {class: 'modeler-canvas', tabindex: '0', 'aria-label': t("modeler.viewport")});
  const status = el('div', {class: 'modeler-status', role: 'status'});
  const outliner = el('div', {class: 'modeler-list'}), palette = el('div', {class: 'modeler-palette'}), props = el('div', {class: 'modeler-props'});
  const button = (label, onclick, {title, pressed, icon} = {}) => el('button', {type: 'button', class: 'modeler-button', title: title ?? label, 'aria-pressed': pressed === undefined ? undefined : String(Boolean(pressed)), onclick}, icon ? [el('span', {class: 'modeler-key', text: icon}), label] : label);
  /** The app's own line icons (src/icons.mjs), as elements. */
  const glyph = name => { const tpl = document.createElement('template'); tpl.innerHTML = iconMarkup(name); return tpl.content.firstElementChild; };
  const iconButton = (name, label, onclick, extra = '') => { const b = el('button', {type: 'button', class: `modeler-button modeler-icon-only ${extra}`.trim(), title: label, 'aria-label': label, onclick}); b.append(glyph(name)); return b; };
  const quiet = (label, onclick, title) => { const b = button(label, onclick, {title}); b.classList.add('modeler-quiet'); return b; };
  const header = el('div', {class: 'modeler-bar'});
  const left = el('aside', {class: 'modeler-side'}, [el('h3', {text: t("modeler.parts")}), outliner, el('div', {class: 'modeler-row'}, [
    button(t("modeler.add"), e => addMenu(e.currentTarget)), button(t("modeler.duplicate"), () => duplicateParts(), {title: t("modeler.duplicateHint")}),
    button(t("modeler.delete"), () => deleteSelection(), {title: t("modeler.deleteHint")})]), el('h3', {text: t("modeler.colors")}), palette,
    el('p', {class: 'modeler-hint', text: t("modeler.colorsHint")})]);
  const right = el('aside', {class: 'modeler-side modeler-side-right'}, [props]);
  const stage = el('div', {class: 'modeler-stage'}, [canvas]);
  const root = el('div', {class: 'modeler', role: 'dialog', 'aria-modal': 'true', 'aria-label': t("modeler.title")}, [header, el('div', {class: 'modeler-main'}, [left, stage, right]), status]);
  // Docked under the app's band (the Model tab) when `top` is given.
  if (top) root.style.top = `${top}px`;
  host.append(root);

  const segmented = (options, value, onpick) => el('div', {class: 'modeler-segmented', role: 'group'}, options.map(([id, label, title]) =>
    el('button', {type: 'button', class: 'modeler-button', 'aria-pressed': String(id === value), title: title ?? label, onclick: () => onpick(id)}, label)));

  function renderHeader() {
    const badge = el('span', {class: 'modeler-title-badge'}); badge.append(glyph('ws-model'));
    header.replaceChildren(...[
      el('strong', {class: 'modeler-title'}, [badge, t("modeler.title")]),
      segmented([['object', t("modeler.objectMode"), t("modeler.objectModeHint")], ['edit', t("modeler.editMode"), t("modeler.editModeHint")], ['bones', t("modeler.bonesMode"), t("modeler.bonesModeHint")]], S.mode, setMode),
      S.mode === 'edit' ? segmented([['vert', t("modeler.vertices"), '1'], ['edge', t("modeler.edges"), '2'], ['face', t("modeler.faces"), '3']], S.selectMode, m => { S.selectMode = m; refresh(); }) : null,
      el('span', {class: 'modeler-gap'}),
      ...[['grab', t("modeler.move"), 'G', t("modeler.moveHint")], ['rotate', t("modeler.rotate"), 'R', t("modeler.rotateHint")], ['scale', t("modeler.scale"), 'S', t("modeler.scaleHint")]].map(([kind, label, key, title]) => {
        const b = button(label, () => startTransform(kind), {icon: key, title}); b.classList.add('modeler-transform'); return b; }),
      el('span', {class: 'modeler-gap'}),
      iconButton('undo', `${t("modeler.undo")} (Ctrl+Z)`, undo), iconButton('redo', `${t("modeler.redo")} (Ctrl+Shift+Z)`, redo),
      el('span', {class: 'modeler-gap'}),
      quiet(t("modeler.front"), () => setView('front'), t("modeler.frontHint")), quiet(t("modeler.side"), () => setView('right'), t("modeler.sideHint")),
      quiet(t("modeler.top"), () => setView('top'), t("modeler.topHint")),
      quiet(S.camera.ortho ? t("modeler.orthographic") : t("modeler.perspective"), () => { S.camera.ortho = !S.camera.ortho; refresh(); }, t("modeler.projectionHint")),
      iconButton('fit', t("modeler.frameSelectedHint"), frameSelected),
      el('span', {class: 'modeler-spacer'}),
      quiet(t("modeler.file"), e => popover(e.currentTarget, [
        el('button', {type: 'button', class: 'modeler-menu-item', onclick: () => { closePopover(); importObjFile(); }}, t("modeler.importObj")),
        editing ? null : el('button', {type: 'button', class: 'modeler-menu-item', onclick: () => { closePopover(); startOver(); }}, t("modeler.startOver")),
        el('button', {type: 'button', class: 'modeler-menu-item', onclick: () => { closePopover(); exportObjFile(); }}, t("modeler.exportObj"))])),
      iconButton('keyboard', t("modeler.controls"), () => showControls()),
      button(t("modeler.close"), requestClose),
      el('button', {type: 'button', class: 'modeler-button modeler-primary', onclick: done}, editing ? t("modeler.updateFigure") : t("modeler.addToAnimation"))].filter(Boolean));
  }

  function renderOutliner() {
    outliner.replaceChildren(...model.parts.map(p => {
      const row = el('div', {class: 'modeler-item', 'aria-selected': String(S.parts.has(p.id)), dataset: {part: p.id}, onclick: e => { selectPart(p.id, e.shiftKey); },
        ondblclick: () => rename(p)}, [
        el('button', {type: 'button', class: 'modeler-eye', title: p.visible ? t("modeler.hide") : t("modeler.show"), 'aria-pressed': String(p.visible !== false),
          onclick: e => { e.stopPropagation(); commit(() => { p.visible = p.visible === false; }); }}, p.visible === false ? '◌' : '●'),
        el('span', {class: 'modeler-name', text: p.name}),
        p.mirror ? el('span', {class: 'modeler-tag', text: t("modeler.mirrorTag"), title: t("modeler.mirrorX")}) : null,
        p.smooth ? el('span', {class: 'modeler-tag', text: `◒${p.smooth}`, title: t("modeler.smooth")}) : null]);
      return row;
    }));
    if (!model.parts.length) outliner.append(el('p', {class: 'modeler-hint', text: t("modeler.noParts")}));
  }

  function renderPalette() {
    palette.replaceChildren(...model.palette.map((c, i) => {
      const input = el('input', {type: 'color', value: hex(c), class: 'modeler-color-input', 'aria-label': t("modeler.editColor"),
        onchange: e => commit(() => { model.palette[i] = rgbOf(e.target.value); })});
      const swatch = el('button', {type: 'button', class: 'modeler-swatch', title: t("modeler.applyColor"), onclick: () => applyColor(i), oncontextmenu: e => { e.preventDefault(); input.click(); }}, [el('span', {class: 'modeler-swatch-fill'})]);
      swatch.firstChild.style.background = hex(c);
      return el('div', {class: 'modeler-swatch-wrap'}, [swatch, input]);
    }), el('button', {type: 'button', class: 'modeler-swatch modeler-swatch-add', title: t("modeler.addColor"), onclick: () => commit(() => { if (model.palette.length < 64) model.palette.push([200, 200, 200]); })}, '+'));
  }

  const field = (label, value, onchange, {step = .01, min, max} = {}) => el('label', {class: 'modeler-field'}, [el('span', {text: label}),
    el('input', {type: 'number', step, min, max, value: fmt(value), onchange: e => { const v = Number(e.target.value); if (Number.isFinite(v)) onchange(v); }})]);
  const vector = (label, values, onchange, options) => el('div', {class: 'modeler-vector'}, [el('span', {class: 'modeler-label', text: label}),
    ...['X', 'Y', 'Z'].map((axis, k) => field(axis, values[k], v => onchange(k, v), options))]);
  const section = (title, children) => el('section', {class: 'modeler-section'}, [el('h3', {text: title}), ...children]);
  const actions = list => el('div', {class: 'modeler-actions'}, list.map(([label, fn, title]) => button(label, fn, {title})));

  // ---------- toon look ----------
  const slider = (label, value, min, max, step, onchange, title) => el('label', {class: 'modeler-field modeler-wide', title}, [el('span', {text: label}),
    el('input', {type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), onchange: e => onchange(Number(e.target.value))})]);
  const colorRow = (selected, onpick) => el('div', {class: 'modeler-swatch-row'}, model.palette.map((c, i) => {
    const b = el('button', {type: 'button', class: 'modeler-swatch', 'aria-pressed': String(i === selected), title: t("modeler.outlineColorIndex", {index: i + 1}), onclick: () => onpick(i)}, [el('span', {class: 'modeler-swatch-fill'})]);
    b.firstChild.style.background = hex(c); return b;
  }));
  /** The darkest palette colour, for new outlines. */
  const inkColor = () => model.palette.reduce((best, c, i) => c[0] + c[1] + c[2] < model.palette[best].reduce((a, v) => a + v, 0) ? i : best, 0);
  const setOutline = (targets, on) => { if (on) S.toonPreview = true; commit(() => { for (const q of targets) q.outline = {...(q.outline ?? {thickness: OUTLINE_DEFAULTS.thickness, color: inkColor()}), on}; }); };
  function partLook(p) {
    const outline = p.outline ?? {on: false, thickness: OUTLINE_DEFAULTS.thickness, color: inkColor()}, toon = toonSettings(model);
    return [
      el('label', {class: 'modeler-check', title: t("modeler.outlineHint")}, [el('input', {type: 'checkbox', checked: Boolean(outline.on), onchange: e => setOutline([p], e.target.checked)}), t("modeler.outline")]),
      outline.on ? slider(t("modeler.outlineThickness"), outline.thickness, .002, .06, .001, v => commit(() => { p.outline = {...outline, thickness: Math.max(.001, Math.min(OUTLINE_MAX, v))}; })) : null,
      outline.on ? el('span', {class: 'modeler-label', text: t("modeler.outlineColor")}) : null,
      outline.on ? colorRow(outline.color, i => commit(() => { p.outline = {...outline, color: i}; })) : null,
      toon.shadows ? el('label', {class: 'modeler-check', title: t("modeler.partShadowsHint")}, [el('input', {type: 'checkbox', checked: p.shadows !== false,
        onchange: e => commit(() => { if (e.target.checked) delete p.shadows; else p.shadows = false; })}), t("modeler.partShadows")]) : null,
    ];
  }
  function toonLook() {
    const toon = toonSettings(model), set = patch => { if (patch.shadows) S.toonPreview = true; commit(() => { model.toon = {...toonSettings(model), ...patch}; }); };
    const outlined = model.parts.filter(q => q.outline?.on).length;
    return [
      el('p', {class: 'modeler-hint', text: t("modeler.toonHint")}),
      el('label', {class: 'modeler-check'}, [el('input', {type: 'checkbox', checked: toon.shadows, onchange: e => set({shadows: e.target.checked})}), t("modeler.toonShadows")]),
      ...(toon.shadows ? [
        slider(t("modeler.lightTurn"), toon.turn, -180, 180, 5, v => set({turn: v}), t("modeler.lightTurnHint")),
        slider(t("modeler.lightHeight"), toon.height, -80, 80, 5, v => set({height: v})),
        slider(t("modeler.shadowSize"), toon.size, 0, 1, .02, v => set({size: v})),
        slider(t("modeler.shadowStrength"), toon.strength, .05, .8, .01, v => set({strength: v})),
        button(t("modeler.resetLight"), () => set({turn: TOON_DEFAULTS.turn, height: TOON_DEFAULTS.height, size: TOON_DEFAULTS.size, strength: TOON_DEFAULTS.strength}))] : []),
      el('p', {class: 'modeler-hint', text: t("modeler.outlinedCount", {count: outlined, total: model.parts.length})}),
      actions([[t("modeler.outlineEverything"), () => setOutline(model.parts, true), t("modeler.outlineEverythingHint")],
        [t("modeler.removeOutlines"), () => setOutline(model.parts.filter(q => q.outline), false)]]),
    ];
  }

  function renderProps() {
    const blocks = [];
    const p = activePart();
    if (S.mode === 'object') {
      if (p && S.parts.size === 1) {
        blocks.push(section(t("modeler.part"), [
          el('label', {class: 'modeler-field modeler-wide'}, [el('span', {text: t("modeler.name")}), el('input', {type: 'text', value: p.name, maxlength: '120', onchange: e => commit(() => { p.name = e.target.value.trim() || p.name; })})]),
          vector(t("modeler.position"), p.position, (k, v) => commit(() => { p.position[k] = v; S.cache.delete(p.id); })),
          vector(t("modeler.rotation"), p.rotation.map(deg), (k, v) => commit(() => { p.rotation[k] = rad(v); S.cache.delete(p.id); }), {step: 1}),
          vector(t("modeler.size"), p.scale, (k, v) => commit(() => { p.scale[k] = v || .001; S.cache.delete(p.id); })),
          el('label', {class: 'modeler-check'}, [el('input', {type: 'checkbox', checked: p.mirror, onchange: e => setMirror(p, e.target.checked)}), t("modeler.mirrorX")]),
          p.mirror ? el('label', {class: 'modeler-check', title: t("modeler.clippingHint")}, [el('input', {type: 'checkbox', checked: p.clip !== false, onchange: e => commit(() => { if (e.target.checked) delete p.clip; else p.clip = false; })}), t("modeler.clipping")]) : null,
          el('p', {class: 'modeler-hint', text: t("modeler.mirrorHint")}),
          el('label', {class: 'modeler-field modeler-wide'}, [el('span', {text: t("modeler.smooth")}), el('input', {type: 'range', min: '0', max: String(SMOOTH_MAX), step: '1', value: String(p.smooth),
            onchange: e => commit(() => { p.smooth = Number(e.target.value); S.cache.delete(p.id); })})]),
          el('label', {class: 'modeler-field modeler-wide'}, [el('span', {text: t("modeler.followsBone")}), el('select', {onchange: e => commit(() => { const v = Number(e.target.value); if (v) p.bone = v; else delete p.bone; })},
            [el('option', {value: '0', text: t("modeler.automaticWeights")}), ...boneOrder(model).map(b => el('option', {value: String(b.id), text: b.name, selected: p.bone === b.id}))])]),
          el('p', {class: 'modeler-hint', text: t("modeler.followsBoneHint")}),
        ]));
        blocks.push(section(t("modeler.partLook"), partLook(p)));
      } else if (S.parts.size > 1) blocks.push(section(t("modeler.parts"), [el('p', {class: 'modeler-hint', text: t("modeler.partsSelected", {count: S.parts.size})}),
        actions([[t("modeler.joinParts"), joinParts, t("modeler.joinPartsHint")]])]));
      else blocks.push(section(t("modeler.start"), [el('p', {class: 'modeler-hint', text: model.parts.length ? t("modeler.clickAPart") : t("modeler.startHint")}),
        actions([[t("modeler.baseCharacter"), addBaseCharacter, t("modeler.baseCharacterHint")], [t("modeler.cube"), () => addPrimitive('cube')], [t("modeler.sphere"), () => addPrimitive('sphere')]])]));
    } else if (S.mode === 'edit' && p) {
      const mesh = p.mesh, faces = M.facesFromVerts(mesh, S.verts);
      blocks.push(section(t("modeler.editing", {name: p.name}), [
        el('p', {class: 'modeler-hint', text: t("modeler.selectionCount", {verts: S.verts.size, faces: faces.size})}),
        // Mirror mode (Blender's Mirror modifier) where it's needed: while editing.
        el('label', {class: 'modeler-check modeler-mirror-toggle', title: t("modeler.mirrorHint")}, [el('input', {type: 'checkbox', checked: p.mirror, onchange: e => setMirror(p, e.target.checked)}), t("modeler.mirrorX")]),
        p.mirror ? el('label', {class: 'modeler-check', title: t("modeler.clippingHint")}, [el('input', {type: 'checkbox', checked: p.clip !== false, onchange: e => commit(() => { if (e.target.checked) delete p.clip; else p.clip = false; })}), t("modeler.clipping")]) : null,
        actions([[t("modeler.extrude"), extrude, 'E'], [t("modeler.inset"), startInset, 'I'], [t("modeler.bevel"), () => startBevel(S.selectMode === 'vert' && !M.edgesFromVerts(activePart().mesh, S.verts).length), 'Ctrl+B'], [t("modeler.loopCut"), startLoopCut, 'Ctrl+R'], [t("modeler.knife"), startKnife, 'K'],
          [t("modeler.subdivide"), subdivide, t("modeler.subdivideHint")], [t("modeler.merge") + ' ▾', e => merge(e?.currentTarget), 'M'], [t("modeler.fill"), fill, 'F'], [t("modeler.gridFill"), gridFillSelected, t("modeler.gridFillHint")],
          [t("modeler.deleteSelected"), deleteSelection, 'X'], [t("modeler.dissolve"), dissolve, 'Ctrl+X'], [t("modeler.duplicateSelected"), duplicateSelected, 'Shift+D'], [t("modeler.separate"), separate, 'P'], [t("modeler.rip"), ripSelected, 'V'],
          [t("modeler.shear"), startShear, t("modeler.shearHint")], [t("modeler.bridge"), bridgeSelected, t("modeler.bridgeHint")]]),
        S.lastOp?.kind === 'grid' && S.lastOp.part === p.id ? el('div', {class: 'modeler-last-op'}, [el('span', {class: 'modeler-hint', text: t("modeler.gridFill")}),
          field(t("modeler.gridSpan"), S.lastOp.span, v => redoGridFill(Math.max(1, Math.min(S.lastOp.max, Math.round(v))), S.lastOp.offset), {step: 1, min: 1, max: S.lastOp.max}),
          field(t("modeler.gridOffset"), S.lastOp.offset, v => redoGridFill(S.lastOp.span, Math.round(v)), {step: 1})]) : null,
        el('p', {class: 'modeler-hint', text: t("modeler.traceHint")}),
        el('label', {class: 'modeler-check', title: t("modeler.softHint")}, [el('input', {type: 'checkbox', checked: S.soft, onchange: e => { S.soft = e.target.checked; renderProps(); }}), t("modeler.softSelect")]),
        S.soft ? field(t("modeler.softRadius"), S.softRadius, v => { S.softRadius = Math.max(.01, Math.min(10, v)); }, {step: .05, min: .01}) : null,
        S.soft ? el('label', {class: 'modeler-field modeler-wide', title: t("modeler.softFalloffHint")}, [el('span', {text: t("modeler.softFalloff")}), el('select', {onchange: e => { S.softFalloff = e.target.value; }},
          Object.keys(M.SOFT_FALLOFFS).map(k => el('option', {value: k, text: t(`modeler.falloff.${k}`), selected: S.softFalloff === k})))]) : null,
        actions([[t("modeler.selectAll"), selectAll, 'A'], [t("modeler.selectLinked"), () => { S.verts = M.linkedVerts(mesh, S.verts); refresh(); }, 'Ctrl+L'],
          [t("modeler.grow"), () => { S.verts = M.growSelection(mesh, S.verts); refresh(); }, 'Ctrl++'],
          [t("modeler.flipNormals"), () => commit(() => { M.flipFaces(mesh, faces); S.cache.delete(p.id); })],
          [t("modeler.fixNormals"), () => commit(() => { M.recalculateNormals(mesh); S.cache.delete(p.id); }), 'Shift+N'],
          [t("modeler.symmetrize"), () => symmetrizePart(p), t("modeler.symmetrizeHint")],
          [t("modeler.mergeByDistance"), () => mergeAt('distance')]]),
        el('p', {class: 'modeler-hint', text: t("modeler.editHint")})]));
    } else if (S.mode === 'bones') {
      const bone = model.bones.find(b => S.bones.has(b.id) && S.bones.size === 1);
      blocks.push(section(t("modeler.skeleton"), [
        el('p', {class: 'modeler-hint', text: model.bones.length ? t("modeler.boneCount", {count: model.bones.length}) : t("modeler.noBonesHint")}),
        actions([[t("modeler.humanoidSkeleton"), addHumanoid, t("modeler.humanoidSkeletonHint")], [t("modeler.faceBones"), addFaceBones, t("modeler.faceBonesHint")], [t("modeler.addBone"), addSingleBone], [t("modeler.extrudeBone"), extrudeBone, 'E'],
          [t("modeler.deleteSelected"), deleteSelection, 'X'], [t("modeler.mirrorBones"), () => commit(() => symmetrizeBones(model)), t("modeler.mirrorBonesHint")]]),
        el('label', {class: 'modeler-check'}, [el('input', {type: 'checkbox', checked: S.weights, onchange: e => { S.weights = e.target.checked; refresh(); }}), t("modeler.showWeights")]),
        el('p', {class: 'modeler-hint', text: t("modeler.bonesHint")})]));
      if (bone) blocks.push(section(t("modeler.bone"), [
        el('label', {class: 'modeler-field modeler-wide'}, [el('span', {text: t("modeler.name")}), el('input', {type: 'text', value: bone.name, maxlength: '80', onchange: e => commit(() => { bone.name = e.target.value.trim() || bone.name; })})]),
        el('label', {class: 'modeler-field modeler-wide'}, [el('span', {text: t("modeler.parent")}), el('select', {onchange: e => commit(() => { bone.parent = Number(e.target.value); })},
          [el('option', {value: '0', text: t("modeler.none")}), ...model.bones.filter(b => b.id !== bone.id).map(b => el('option', {value: String(b.id), text: b.name, selected: bone.parent === b.id}))])]),
        vector(t("modeler.head"), bone.head, (k, v) => commit(() => { bone.head[k] = v; })), vector(t("modeler.tail"), bone.tail, (k, v) => commit(() => { bone.tail[k] = v; })),
        actions([[t("modeler.boneToSelection"), boneToSelection, t("modeler.boneToSelectionHint")]]),
        el('label', {class: 'modeler-check', title: t("modeler.faceBoneHint")}, [el('input', {type: 'checkbox', checked: Boolean(bone.face), onchange: e => commit(() => { setFace(bone, e.target.checked ? faceOf(bone) : null); S.cache.clear(); })}), t("modeler.faceBone")]),
        bone.face ? field(t("modeler.faceReach"), bone.reach, v => commit(() => { setFace(bone, {...faceOf(bone), reach: v}); S.cache.clear(); }), {step: .01, min: 0}) : null,
        bone.face ? el('label', {class: 'modeler-field modeler-wide', title: t("modeler.faceCutHint")}, [el('span', {text: t("modeler.faceCut")}), el('select', {onchange: e => commit(() => { setFace(bone, {...faceOf(bone), cut: e.target.value}); S.cache.clear(); })},
          ['', ...FACE_CUTS].map(c => el('option', {value: c, text: t(c ? `modeler.faceCut.${c}` : "modeler.faceCut.none"), selected: (bone.cut ?? '') === c})))]) : null,
        el('p', {class: 'modeler-hint', text: t("modeler.sideNamesHint")})]));
    }
    if (S.mode === 'object') blocks.push(section(t("modeler.toonLook"), toonLook()));
    blocks.push(section(t("modeler.view"), [
      el('label', {class: 'modeler-check'}, [el('input', {type: 'checkbox', checked: S.toonPreview, onchange: e => { S.toonPreview = e.target.checked; refresh(); }}), t("modeler.toonPreview")]),
      el('label', {class: 'modeler-check'}, [el('input', {type: 'checkbox', checked: S.wire, onchange: e => { S.wire = e.target.checked; refresh(); }}), t("modeler.wireframe")]),
      el('label', {class: 'modeler-check'}, [el('input', {type: 'checkbox', checked: S.xray, onchange: e => { S.xray = e.target.checked; refresh(); }}), t("modeler.xray")]),
      el('label', {class: 'modeler-check'}, [el('input', {type: 'checkbox', checked: S.showBones, onchange: e => { S.showBones = e.target.checked; refresh(); }}), t("modeler.showBones")]),
      el('label', {class: 'modeler-check'}, [el('input', {type: 'checkbox', checked: S.grid, onchange: e => { S.grid = e.target.checked; refresh(); }}), t("modeler.grid")])]));
    blocks.push(section(t("modeler.references"), [el('p', {class: 'modeler-hint', text: t("modeler.referencesHint")}),
      ...['front', 'side'].map(view => {
        const ref = model.references.find(r => r.view === view);
        return el('div', {class: 'modeler-ref'}, [el('span', {class: 'modeler-label', text: view === 'front' ? t("modeler.frontImage") : t("modeler.sideImage")}),
          button(ref ? t("modeler.replace") : t("modeler.load"), () => loadReference(view)),
          ref ? button(t("modeler.remove"), () => commit(() => { model.references = model.references.filter(r => r !== ref); syncRefs(); })) : null,
          ref ? field(t("modeler.opacity"), ref.opacity ?? .5, v => commit(() => { ref.opacity = Math.max(0, Math.min(1, v)); }), {step: .05, min: 0, max: 1}) : null,
          ref ? field(t("modeler.height"), ref.height ?? 2, v => commit(() => { ref.height = Math.max(.01, v); }), {step: .05}) : null,
          ref ? field(t("modeler.offsetX"), ref.offsetX ?? 0, v => commit(() => { ref.offsetX = v; }), {step: .01}) : null,
          ref ? field(t("modeler.offsetY"), ref.offsetY ?? 0, v => commit(() => { ref.offsetY = v; }), {step: .01}) : null,
          ref ? el('label', {class: 'modeler-check', title: t("modeler.flipImageHint")}, [el('input', {type: 'checkbox', checked: Boolean(ref.flip), onchange: e => commit(() => { if (e.target.checked) ref.flip = true; else delete ref.flip; })}), t("modeler.flipImage")]) : null]);
      })]));
    props.replaceChildren(...blocks);
  }

  // Messages show in the status line for a few seconds, then the current hint returns.
  let flash = null, flashTimer = 0;
  function toast(message) {
    flash = message; clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flash = null; setStatus(); }, 4500);
    setStatus();
  }
  function setStatus() {
    status.classList.toggle('modeler-status-flash', Boolean(flash));
    if (flash) { status.textContent = flash; return; }
    const m = S.modal;
    const text = m?.tweak ? t(S.mode !== 'bones' ? "modeler.dragStatus" : m.stretch ? "modeler.stretchStatus" : m.kind === 'rotate' ? "modeler.bendStatus" : "modeler.dragStatus")
      : TRANSFORMS.includes(m?.kind) ? t(m.kind === 'shear' ? "modeler.shearStatus" : "modeler.transformStatus") + (m.axisName ? ` · ${t("modeler.lockedTo", {axis: m.axisName})}` : '')
      : m?.kind === 'inset' ? t("modeler.insetStatus") : m?.kind === 'bevel' ? t("modeler.bevelStatus", {width: m.width.toFixed(3), segments: m.segments}) : m?.kind === 'knife' ? t("modeler.knifeStatus", {count: m.path.length}) : m?.kind === 'loopcut' ? t("modeler.loopCutStatus", {count: m.cuts}) : m?.kind === 'loopslide' ? t("modeler.loopSlideStatus") : m?.kind === 'slide' ? t("modeler.edgeSlideStatus")
      : S.mode === 'edit' ? t("modeler.editStatus") : S.mode === 'bones' ? t("modeler.bonesStatus") : t("modeler.objectStatus");
    // Soft select: its radius, which the scroll wheel changes while moving.
    status.textContent = m?.target?.soft ? `${text} · ${t("modeler.softStatus", {radius: fmt(S.softRadius)})}` : text;
  }

  let frameRequest = 0;
  function refresh() {
    renderHeader(); renderOutliner(); renderPalette(); renderProps(); setStatus(); draw();
  }
  function draw() {
    if (frameRequest) return;
    frameRequest = requestAnimationFrame(() => { frameRequest = 0; drawNow(); });
  }

  // ---------- drawing ----------
  let frame = null;
  function drawNow() {
    const box = stage.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, w = Math.max(10, box.width), h = Math.max(10, box.height);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); canvas.style.width = `${w}px`; canvas.style.height = `${h}px`; }
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    frame = cameraFrame(S.camera, w, h);
    const items = [];
    const showWeights = S.mode === 'bones' && S.weights && S.bones.size === 1 && model.bones.length;
    const bone = showWeights ? [...S.bones][0] : 0;
    for (const p of model.parts) {
      if (p.visible === false || !p.mesh.faces.length) continue;
      const mesh = evaluated(p);
      let weights = null;
      if (showWeights) {
        const key = `w${p.id}:${bone}`;
        weights = S.cache.get(key);
        if (!weights) {
          const skin = autoWeights(model, mesh, p);
          const vw = mesh.verts.map((_, v) => { let w = 0; for (let k = 0; k < 4; k++) if (skin.bones[v * 4 + k] === bone) w += skin.weights[v * 4 + k]; return w; });
          weights = mesh.faces.map(f => f.v.reduce((s, v) => s + vw[v], 0) / f.v.length);
          S.cache.set(key, weights);
        }
      }
      items.push({mesh, palette: model.palette, partId: p.id, weights, flat: p.shadows === false});
      // The outline shell (not pickable), in the toon preview.
      const hull = S.toonPreview && !weights ? hullOf(p) : null;
      if (hull) items.push({mesh: hull, palette: model.palette, partId: p.id, hull: true, flat: true, twoSided: false});
    }
    const look = toonSettings(model);
    const toon = S.toonPreview && !showWeights ? {shadows: look.shadows, turn: look.turn, height: look.height, size: look.size, strength: look.strength} : null;
    S.polys = paint(ctx, frame, items, {xray: S.xray, wire: S.wire, references: model.references, refImages: S.refImages, showGrid: S.grid, toon}).filter(poly => !poly.item.hull);
    drawAllWires(ctx);
    if (S.mode === 'object') drawObjectOutline(ctx);
    if (S.mode === 'edit') drawCage(ctx);
    if (S.mode === 'bones' || S.showBones) drawBones(ctx);
    if (S.modal?.kind === 'loopcut' && S.modal.ring) drawRing(ctx, S.modal.ring, S.modal.cuts);
    if (S.modal?.kind === 'knife') drawKnife(ctx);
    if (S.modal?.box) drawBox(ctx, S.modal.box);
    if (S.modal?.pivotScreen && [...TRANSFORMS, 'inset', 'bevel'].includes(S.modal.kind)) drawPivot(ctx, S.modal);
    if (S.modal?.target?.soft) drawSoftRadius(ctx, S.modal);
    drawAxes(ctx, w, h);
  }

  function drawObjectOutline(ctx) {
    ctx.strokeStyle = VIEW_COLORS.outline; ctx.lineWidth = 1.2; ctx.globalAlpha = .9;
    for (const id of S.parts) {
      const p = part(id); if (!p || p.visible === false) continue;
      const mesh = evaluated(p), pts = mesh.verts.map(frame.project), uses = M.edgeFaces(mesh);
      // Silhouette-ish: edges between a front and a back face, plus open borders.
      const facing = mesh.faces.map(f => M.dot(M.faceNormal(mesh, f), frame.toEye(mesh.verts[f.v[0]])) > 0);
      ctx.beginPath();
      for (const [key, fs] of uses) {
        if (fs.length === 2 && facing[fs[0]] === facing[fs[1]]) continue;
        const [a, b] = M.keyVerts(key); if (!pts[a].ok || !pts[b].ok) continue;
        ctx.moveTo(pts[a].x, pts[a].y); ctx.lineTo(pts[b].x, pts[b].y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** The active part's editable cage in world space, with which vertices face the camera. */
  function cage() {
    const p = activePart(); if (!p) return null;
    const transform = M.objectTransform(p), world = p.mesh.verts.map(transform), pts = world.map(frame.project);
    const visible = new Array(world.length).fill(S.xray);
    // An open mesh (a traced band, half a face) shows and edits from both sides, as in Blender.
    const twoSided = openOf(p.mesh);
    const front = p.mesh.faces.map(f => {
      if (twoSided) return true;
      let n = [0, 0, 0];
      for (let i = 0; i < f.v.length; i++) n = M.add(n, M.cross(world[f.v[i]], world[f.v[(i + 1) % f.v.length]]));
      const det = M.objectMirrors(p) ? -1 : 1;
      return M.dot(n, frame.toEye(world[f.v[0]])) * det > 0;
    });
    p.mesh.faces.forEach((f, i) => { if (front[i]) f.v.forEach(v => { visible[v] = true; }); });
    // Traced points (on wires or loose) are always shown: they have no face to hide behind.
    const onFaces = new Set(p.mesh.faces.flatMap(f => f.v));
    p.mesh.verts.forEach((_, v) => { if (!onFaces.has(v)) visible[v] = true; });
    return {p, world, pts, visible, front};
  }
  function drawCage(ctx) {
    const c = cage(); if (!c) return;
    const {p, pts, visible, front} = c, faces = M.facesFromVerts(p.mesh, S.verts);
    if (S.selectMode === 'face' || faces.size) {
      ctx.fillStyle = VIEW_COLORS.faceSelected;
      for (const fi of faces) { if (!front[fi] && !S.xray) continue; const f = p.mesh.faces[fi]; ctx.beginPath(); f.v.forEach((v, i) => i ? ctx.lineTo(pts[v].x, pts[v].y) : ctx.moveTo(pts[v].x, pts[v].y)); ctx.closePath(); ctx.fill(); }
    }
    for (const [key, fs] of M.edgeFaces(p.mesh)) {
      const [a, b] = M.keyVerts(key); if (!pts[a].ok || !pts[b].ok || (!S.xray && !fs.some(fi => front[fi]))) continue;
      const selected = S.verts.has(a) && S.verts.has(b);
      ctx.strokeStyle = selected ? VIEW_COLORS.selected : VIEW_COLORS.cage; ctx.lineWidth = selected ? 2 : 1;
      if (S.hover?.edge && M.edgeKey(...S.hover.edge) === key) { ctx.strokeStyle = VIEW_COLORS.hover; ctx.lineWidth = 2.5; }
      ctx.beginPath(); ctx.moveTo(pts[a].x, pts[a].y); ctx.lineTo(pts[b].x, pts[b].y); ctx.stroke();
    }
    drawWires(ctx, p, pts, true);
    if (S.selectMode === 'face') {
      p.mesh.faces.forEach((f, fi) => { if (!front[fi] && !S.xray) return; const c2 = f.v.reduce((s, v) => ({x: s.x + pts[v].x / f.v.length, y: s.y + pts[v].y / f.v.length}), {x: 0, y: 0});
        ctx.fillStyle = faces.has(fi) ? VIEW_COLORS.selected : VIEW_COLORS.vertex; ctx.fillRect(c2.x - 2, c2.y - 2, 4, 4); });
    } else if (S.selectMode === 'vert') {
      pts.forEach((q, v) => { if (!q.ok || !visible[v]) return; const on = S.verts.has(v); ctx.fillStyle = on ? VIEW_COLORS.selected : VIEW_COLORS.vertex; const r = on ? 3 : 2.2; ctx.fillRect(q.x - r, q.y - r, r * 2, r * 2); });
    }
  }
  /** Traced wires (lines with no face yet) and loose points; on mirrored parts the
   * other half shows faintly, as the mirror will build it once filled. */
  function drawWires(ctx, p, pts, editing) {
    const wires = p.mesh.edges ?? [];
    if (!wires.length && !p.mesh.loose?.length) return;
    ctx.save(); ctx.lineCap = 'round';
    if (p.mirror) {
      const transform = M.objectTransform(p), ghost = p.mesh.verts.map(v => { const w = transform(v); return frame.project([-w[0], w[1], w[2]]); });
      ctx.globalAlpha = .55; ctx.strokeStyle = VIEW_COLORS.cage; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]);
      for (const [a, b] of wires) { if (!ghost[a].ok || !ghost[b].ok) continue; ctx.beginPath(); ctx.moveTo(ghost[a].x, ghost[a].y); ctx.lineTo(ghost[b].x, ghost[b].y); ctx.stroke(); }
      ctx.setLineDash([]); ctx.fillStyle = VIEW_COLORS.cage;
      for (const i of p.mesh.loose ?? []) { const q = ghost[i]; if (q?.ok) ctx.fillRect(q.x - 2, q.y - 2, 4, 4); }
      ctx.globalAlpha = 1;
    }
    for (const [a, b] of wires) {
      if (!pts[a]?.ok || !pts[b]?.ok) continue;
      const selected = editing && S.verts.has(a) && S.verts.has(b), hover = editing && S.hover?.edge && M.edgeKey(...S.hover.edge) === M.edgeKey(a, b);
      ctx.strokeStyle = hover ? VIEW_COLORS.hover : selected ? VIEW_COLORS.selected : editing ? VIEW_COLORS.wireTrace : VIEW_COLORS.wire;
      ctx.lineWidth = selected || hover ? 2.5 : 1.6;
      ctx.beginPath(); ctx.moveTo(pts[a].x, pts[a].y); ctx.lineTo(pts[b].x, pts[b].y); ctx.stroke();
    }
    if (!editing) for (const i of p.mesh.loose ?? []) { const q = pts[i]; if (q?.ok) { ctx.fillStyle = VIEW_COLORS.wire; ctx.fillRect(q.x - 2, q.y - 2, 4, 4); } }
    ctx.restore();
  }
  /** Wires of every part outside Edit mode (the active part's are in its cage). */
  function drawAllWires(ctx) {
    for (const p of model.parts) {
      if (p.visible === false || (!p.mesh.edges?.length && !p.mesh.loose?.length) || (S.mode === 'edit' && p.id === S.active)) continue;
      const transform = M.objectTransform(p);
      drawWires(ctx, p, p.mesh.verts.map(v => frame.project(transform(v))), false);
    }
  }
  function drawBones(ctx) {
    for (const b of model.bones) {
      const a = frame.project(b.head), c = frame.project(b.tail); if (!a.ok || !c.ok) continue;
      const on = S.bones.has(b.id);
      ctx.strokeStyle = on ? VIEW_COLORS.boneSelected : VIEW_COLORS.bone; ctx.lineWidth = on ? 5 : 4; ctx.lineCap = 'round'; ctx.globalAlpha = S.mode === 'bones' ? 1 : .7;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke();
      for (const [q, end] of [[a, 'head'], [c, 'tail']]) {
        ctx.fillStyle = on && (S.boneEnd === end || !S.boneEnd) ? VIEW_COLORS.boneSelected : VIEW_COLORS.boneHead;
        ctx.beginPath(); ctx.arc(q.x, q.y, end === 'head' ? 4.5 : 3.5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }
  /** Preview of a loop cut: one line per cut across the ring. */
  function drawRing(ctx, ring, cuts = 1) {
    const p = activePart(); if (!p) return;
    const transform = M.objectTransform(p), closed = ring.length > 2 && M.edgeKey(...ring[0]) !== M.edgeKey(...ring.at(-1)) && sharesFace(p.mesh, ring[0], ring.at(-1));
    ctx.strokeStyle = VIEW_COLORS.ring; ctx.lineWidth = 2;
    for (let k = 1; k <= cuts; k++) {
      const f = k / (cuts + 1);
      ctx.beginPath();
      const pts = ring.map(([a, b]) => frame.project(transform(M.lerp(p.mesh.verts[a], p.mesh.verts[b], f))));
      pts.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y));
      if (closed) ctx.closePath();
      ctx.stroke();
    }
  }
  /** Whether two edges belong to one face (the two ends of a closed ring). */
  function sharesFace(mesh, e1, e2) { return mesh.faces.some(f => e1.every(v => f.v.includes(v)) && e2.every(v => f.v.includes(v))); }
  function drawBox(ctx, box) {
    ctx.strokeStyle = VIEW_COLORS.ring; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
    ctx.strokeRect(Math.min(box.x0, box.x1), Math.min(box.y0, box.y1), Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0)); ctx.setLineDash([]);
  }
  function drawPivot(ctx, m) {
    ctx.strokeStyle = VIEW_COLORS.ring; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(m.pivotScreen.x, m.pivotScreen.y); ctx.lineTo(m.mouse.x, m.mouse.y); ctx.stroke(); ctx.setLineDash([]);
    if (m.axis) {
      const a = frame.project(M.add(m.pivot, M.scale(m.axis, -50))), b = frame.project(M.add(m.pivot, M.scale(m.axis, 50)));
      if (a.ok && b.ok) { ctx.strokeStyle = m.axisColor; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    }
  }
  function drawAxes(ctx, w, h) {
    const o = {x: 46, y: h - 46}, s = 26;
    for (const [axis, color, label] of [[[1, 0, 0], VIEW_COLORS.axisX, 'X'], [[0, 1, 0], '#3fa34d', 'Y'], [[0, 0, 1], VIEW_COLORS.axisZ, 'Z']]) {
      const x = M.dot(axis, frame.right), y = M.dot(axis, frame.up);
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(o.x + x * s, o.y - y * s); ctx.stroke();
      ctx.fillStyle = color; ctx.font = '11px system-ui, sans-serif'; ctx.fillText(label, o.x + x * (s + 7) - 3, o.y - y * (s + 7) + 4);
    }
  }

  // ---------- modes and selection ----------
  function setMode(mode) {
    if (S.modal) cancelModal();
    if (mode === 'edit' && !activePart()) { toast(t("modeler.selectAPartToEdit")); return; }
    S.mode = mode; S.hover = null;
    if (mode === 'edit') S.verts = new Set();
    refresh();
  }
  function selectPart(id, extend = false) {
    if (extend) { if (S.parts.has(id)) S.parts.delete(id); else S.parts.add(id); } else S.parts = new Set([id]);
    S.active = S.parts.has(id) ? id : [...S.parts].at(-1) ?? null;
    if (S.mode === 'edit' && !extend) S.verts = new Set();
    refresh();
  }
  function selectAll() {
    if (S.mode === 'object') S.parts = S.parts.size === model.parts.length ? new Set() : new Set(model.parts.map(p => p.id));
    else if (S.mode === 'edit') { const p = activePart(); if (p) S.verts = S.verts.size === p.mesh.verts.length ? new Set() : new Set(p.mesh.verts.keys()); }
    else S.bones = S.bones.size === model.bones.length ? new Set() : new Set(model.bones.map(b => b.id));
    refresh();
  }

  /** Pick under the pointer in the current mode. Returns what was hit. */
  function pick(x, y) {
    if (S.mode === 'object') {
      const poly = pickPolygon(S.polys, x, y); if (poly) return {part: poly.item.partId};
      // Parts that are only traced lines so far: pick a line or point near the pointer.
      for (const p of model.parts) {
        if (p.visible === false || (!p.mesh.edges?.length && !p.mesh.loose?.length)) continue;
        const transform = M.objectTransform(p), q = p.mesh.verts.map(v => frame.project(transform(v)));
        if ((p.mesh.edges ?? []).some(([a, b]) => q[a].ok && q[b].ok && segmentPixelDistance({x, y}, q[a], q[b]) < 6) || (p.mesh.loose ?? []).some(i => q[i].ok && Math.hypot(q[i].x - x, q[i].y - y) < 8)) return {part: p.id};
      }
      return null;
    }
    if (S.mode === 'bones') {
      let best = null;
      for (const b of model.bones) {
        const a = frame.project(b.head), c = frame.project(b.tail); if (!a.ok || !c.ok) continue;
        for (const [q, end] of [[a, 'head'], [c, 'tail']]) { const d = Math.hypot(q.x - x, q.y - y); if (d < 9 && (!best || d < best.d)) best = {bone: b.id, end, d}; }
        const d = segmentPixelDistance({x, y}, a, c); if (d < 7 && (!best || d + 3 < best.d)) best = {bone: b.id, end: null, d: d + 3};
      }
      return best;
    }
    const c = cage(); if (!c) return null;
    const {p, pts, visible, front} = c;
    if (S.selectMode === 'vert') {
      let best = null; pts.forEach((q, v) => { if (!q.ok || !visible[v]) return; const d = Math.hypot(q.x - x, q.y - y); if (d < 12 && (!best || d < best.d)) best = {verts: [v], d}; });
      return best;
    }
    if (S.selectMode === 'edge') {
      let best = null;
      for (const [key, fs] of M.edgeFaces(p.mesh)) { if (!S.xray && !fs.some(fi => front[fi])) continue; const [a, b] = M.keyVerts(key); if (!pts[a].ok || !pts[b].ok) continue;
        const d = segmentPixelDistance({x, y}, pts[a], pts[b]); if (d < 8 && (!best || d < best.d)) best = {verts: [a, b], edge: [a, b], d}; }
      for (const [a, b] of p.mesh.edges ?? []) { if (!pts[a].ok || !pts[b].ok) continue;
        const d = segmentPixelDistance({x, y}, pts[a], pts[b]); if (d < 8 && (!best || d < best.d)) best = {verts: [a, b], edge: [a, b], d}; }
      return best;
    }
    // Faces: the front-most face of the cage under the pointer.
    let best = null;
    p.mesh.faces.forEach((f, fi) => {
      if (!front[fi] && !S.xray) return;
      const poly = f.v.map(v => pts[v]); if (poly.some(q => !q.ok) || !insidePolygon(poly, x, y)) return;
      const z = poly.reduce((s, q) => s + q.z, 0) / poly.length;
      if (!best || z > best.z) best = {verts: f.v.slice(), face: fi, z};
    });
    return best;
  }
  /** The cage edge nearest the pointer, for loop cuts and loop selection
   * (`wires`: traced lines count too). */
  function pickEdge(x, y, {wires = false} = {}) {
    const c = cage(); if (!c) return null;
    let best = null;
    const consider = (a, b) => { if (!c.pts[a]?.ok || !c.pts[b]?.ok) return;
      const d = segmentPixelDistance({x, y}, c.pts[a], c.pts[b]); if (d < 14 && (!best || d < best.d)) best = {edge: [a, b], d}; };
    for (const [key, fs] of M.edgeFaces(c.p.mesh)) { if (!S.xray && !fs.some(fi => c.front[fi])) continue; consider(...M.keyVerts(key)); }
    if (wires) for (const [a, b] of c.p.mesh.edges ?? []) consider(a, b);
    return best?.edge ?? null;
  }

  function clickSelect(x, y, e) {
    const hit = pick(x, y);
    if (S.mode === 'object') {
      if (hit) selectPart(hit.part, e.shiftKey); else if (!e.shiftKey) { S.parts = new Set(); refresh(); }
      return;
    }
    if (S.mode === 'bones') {
      if (!hit) { if (!e.shiftKey) { S.bones = new Set(); S.boneEnd = null; } refresh(); return; }
      if (e.shiftKey) { if (S.bones.has(hit.bone)) S.bones.delete(hit.bone); else S.bones.add(hit.bone); S.boneEnd = null; }
      else { S.bones = new Set([hit.bone]); S.boneEnd = hit.end; }
      refresh(); return;
    }
    if (e.altKey) { const edge = pickEdge(x, y, {wires: true}); if (edge) { const loop = M.edgeLoop(activePart().mesh, edge); S.verts = e.shiftKey ? new Set([...S.verts, ...loop]) : loop; refresh(); } return; }
    if (!hit) { if (!e.shiftKey) S.verts = new Set(); refresh(); return; }
    const all = hit.verts.every(v => S.verts.has(v));
    if (e.shiftKey) { for (const v of hit.verts) all ? S.verts.delete(v) : S.verts.add(v); }
    else S.verts = new Set(hit.verts);
    refresh();
  }
  function boxSelect(box, extend) {
    const x0 = Math.min(box.x0, box.x1), x1 = Math.max(box.x0, box.x1), y0 = Math.min(box.y0, box.y1), y1 = Math.max(box.y0, box.y1);
    const inside = q => q.ok && q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1;
    if (S.mode === 'edit') {
      const c = cage(); if (!c) return;
      const hits = new Set(); c.pts.forEach((q, v) => { if (inside(q) && c.visible[v]) hits.add(v); });
      if (S.selectMode === 'face') { const keep = M.facesFromVerts(c.p.mesh, hits); const verts = M.vertsFromFaces(c.p.mesh, keep); S.verts = extend ? new Set([...S.verts, ...verts]) : verts; }
      else S.verts = extend ? new Set([...S.verts, ...hits]) : hits;
    } else if (S.mode === 'object') {
      const hits = model.parts.filter(p => p.visible !== false && evaluated(p).verts.some(v => inside(frame.project(v)))).map(p => p.id);
      S.parts = extend ? new Set([...S.parts, ...hits]) : new Set(hits); S.active = hits[0] ?? S.active;
    } else {
      const hits = model.bones.filter(b => inside(frame.project(b.head)) || inside(frame.project(b.tail))).map(b => b.id);
      S.bones = extend ? new Set([...S.bones, ...hits]) : new Set(hits); S.boneEnd = null;
    }
    refresh();
  }

  // ---------- transforms ----------
  /** World positions the transform moves, how to read and write them, and the pivot. */
  function transformTarget() {
    if (S.mode === 'object') {
      const parts = [...S.parts].map(part).filter(Boolean); if (!parts.length) return null;
      const pivot = M.scale(parts.reduce((s, p) => M.add(s, p.position), [0, 0, 0]), 1 / parts.length);
      return {kind: 'parts', parts, start: parts.map(p => ({position: p.position.slice(), rotation: p.rotation.slice(), scale: p.scale.slice()})), pivot};
    }
    if (S.mode === 'edit') {
      const p = activePart(); if (!p || !S.verts.size) return null;
      const transform = M.objectTransform(p), verts = [...S.verts], world = verts.map(v => transform(p.mesh.verts[v]));
      const target = {kind: 'verts', part: p, verts, startMesh: p.mesh, objectMatrix: M.objectMatrix(p), pivot: M.scale(world.reduce((s, q) => M.add(s, q), [0, 0, 0]), 1 / world.length)};
      // Soft select: nearby points follow part of the way (measured in world space).
      if (S.soft) { target.points = p.mesh.verts.map(transform); target.selected = new Set(verts); target.soft = M.softWeights(target.points, target.selected, S.softRadius, S.softFalloff); }
      return target;
    }
    // Bones: a picked end moves alone; whole bones move both ends. Joints shared with
    // connected bones (a child's head on this tail) move together.
    const points = [];
    for (const b of model.bones.filter(b => S.bones.has(b.id))) {
      const ends = S.bones.size === 1 && S.boneEnd ? [S.boneEnd] : ['head', 'tail'];
      for (const end of ends) {
        points.push({bone: b, end});
        for (const other of model.bones) {
          if (other === b) continue;
          if (end === 'tail' && other.parent === b.id && M.length(M.sub(other.head, b.tail)) < 1e-6) points.push({bone: other, end: 'head'});
          if (end === 'head' && b.parent === other.id && M.length(M.sub(other.tail, b.head)) < 1e-6) points.push({bone: other, end: 'tail'});
        }
      }
    }
    if (!points.length) return null;
    const start = points.map(q => q.bone[q.end].slice());
    return {kind: 'bones', points, start, pivot: M.scale(start.reduce((s, q) => M.add(s, q), [0, 0, 0]), 1 / start.length)};
  }
  function startTransform(kind, {axis = null, axisName = '', mouse = S.pointer} = {}) {
    if (S.modal) return;
    const target = transformTarget();
    if (!target) { toast(S.mode === 'edit' ? t("modeler.selectSomethingFirst") : S.mode === 'bones' ? t("modeler.selectABoneFirst") : t("modeler.selectAPartFirst")); return; }
    const before = snapshot(), pivotScreen = frame.project(target.pivot);
    const m = mouse ?? {x: pivotScreen.x + 60, y: pivotScreen.y};
    S.modal = {kind, target, before, pivot: target.pivot, pivotScreen, start: {...m}, mouse: {...m}, axis, axisName, axisColor: VIEW_COLORS.ring};
    canvas.focus(); setStatus(); draw();
  }
  function startShear() {
    if (S.mode !== 'edit') { toast(t("modeler.shearEditOnly")); return; }
    startTransform('shear');
  }
  function drawSoftRadius(ctx, m) {
    const px = S.softRadius / frame.unitsPerPixel(m.pivot);
    if (!(px > 1) || !m.pivotScreen) return;
    ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = VIEW_COLORS.ring; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(m.pivotScreen.x, m.pivotScreen.y, px, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }
  function setAxis(name) {
    const m = S.modal; if (!m || !TRANSFORMS.includes(m.kind)) return;
    const axes = {X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1]}, colors = {X: VIEW_COLORS.axisX, Y: '#3fa34d', Z: VIEW_COLORS.axisZ};
    if (m.axisName === name) { m.axis = null; m.axisName = ''; } else { m.axis = axes[name]; m.axisName = name; m.axisColor = colors[name]; }
    applyTransform(); setStatus();
  }
  /** The world-space matrix of the current move, rotate or scale (pure). */
  function modalMatrix(m, w = 1) {
    const dx = m.mouse.x - m.start.x, dy = m.mouse.y - m.start.y;
    if (m.kind === 'shear') {
      // Slide along the locked axis (or the view's right) in proportion to height
      // in the view (or along the view's right when the axis is vertical).
      const along = m.axis ?? frame.right, by = Math.abs(M.dot(M.normalize(along), frame.up)) > .9 ? frame.right : frame.up;
      let k = dx / 120; if (m.snap) k = Math.round(k * 10) / 10;
      if (w === 1) m.factor = k;
      return X.about(m.pivot, X.shearing(along, by, k * w));
    }
    if (m.kind === 'grab') {
      let delta;
      if (m.axis) {
        const a = frame.project(m.pivot), b = frame.project(M.add(m.pivot, m.axis)), sx = b.x - a.x, sy = b.y - a.y, len2 = sx * sx + sy * sy;
        const u = frame.unitsPerPixel(m.pivot), full = 1 / u;
        // An axis pointing at the viewer barely moves on screen: drag up to push along it instead.
        if (Math.sqrt(len2) < full * .3) delta = M.scale(m.axis, (-dy + dx) * u * Math.sign(M.dot(m.axis, frame.back) || 1));
        else delta = M.scale(m.axis, (dx * sx + dy * sy) / len2);
      } else { const u = frame.unitsPerPixel(m.pivot); delta = M.add(M.scale(frame.right, dx * u), M.scale(frame.up, -dy * u)); }
      if (m.snap) delta = delta.map(v => Math.round(v / .05) * .05);
      return X.translation(M.scale(delta, w));
    }
    if (m.kind === 'rotate') {
      const a0 = Math.atan2(m.start.y - m.pivotScreen.y, m.start.x - m.pivotScreen.x), a1 = Math.atan2(m.mouse.y - m.pivotScreen.y, m.mouse.x - m.pivotScreen.x);
      let angle = -(a1 - a0);
      if (m.snap) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
      const axis = m.axis ? (M.dot(m.axis, frame.back) < 0 ? M.scale(m.axis, -1) : m.axis) : frame.back;
      if (w === 1) { m.angle = angle; m.rotationAxis = axis; }
      return X.about(m.pivot, X.rotationAxis(axis, angle * w));
    }
    const d0 = Math.max(4, Math.hypot(m.start.x - m.pivotScreen.x, m.start.y - m.pivotScreen.y)), d1 = Math.hypot(m.mouse.x - m.pivotScreen.x, m.mouse.y - m.pivotScreen.y);
    let f = d1 / d0; if (m.snap) f = Math.round(f * 10) / 10;
    if (w === 1) m.factor = f;
    f = 1 + (f - 1) * w;
    return X.about(m.pivot, m.axis ? X.scalingAlong(m.axis, f) : X.scaling([f, f, f]));
  }
  /** Apply the current move to what it acts on, always from the values it started with:
   * meshes get a new transformed copy (topology untouched), parts a new position,
   * rotation and size, bones new end points. */
  function applyTransform() {
    const m = S.modal, {target} = m, world = modalMatrix(m);
    if (target.kind === 'verts') {
      // Local edit matrix: into world, move, back into the part.
      const inverse = X.invert(target.objectMatrix), local = w => X.compose(inverse, w === 1 ? world : modalMatrix(m, w), target.objectMatrix);
      let mesh, moved = target.verts;
      if (target.soft?.size) {
        // Soft select: each nearby point gets the move scaled by its weight (weights rounded so matrices are shared).
        const full = local(1), shared = new Map(), matrices = new Map(target.verts.map(v => [v, full]));
        for (const [v, w] of target.soft) { const q = Math.round(w * 64) / 64; if (!q) continue; if (!shared.has(q)) shared.set(q, local(q)); matrices.set(v, shared.get(q)); }
        mesh = M.transformMeshEach(target.startMesh, matrices); moved = [...matrices.keys()];
      } else mesh = M.transformMesh(target.startMesh, local(1), target.verts);
      // Mirror clipping: the middle stays joined to the mirrored half.
      if (target.part.mirror && target.part.clip !== false) mesh = M.clipToMirror(target.startMesh, mesh, target.objectMatrix, moved);
      if (m.grown) M.faceViewerDuringMove(mesh, m.grown, localFacing(target.part));
      target.part.mesh = mesh;
      S.cache.delete(target.part.id);
    } else if (target.kind === 'bones') {
      target.points.forEach((q, i) => { q.bone[q.end] = [...X.transformPoint(world, target.start[i])]; });
    } else {
      target.parts.forEach((p, i) => {
        const s0 = target.start[i], before = X.fromTRS(s0.position, s0.rotation, s0.scale);
        if (m.kind === 'scale') {
          // Size stays in the part's own axes: the locked world axis picks the closest one.
          const local = m.axis ? [0, 1, 2].map(k => Math.abs(M.dot(X.transformDirection(X.eulerXYZ(s0.rotation), [0, 1, 2].map(j => j === k ? 1 : 0)), m.axis))) : null;
          const pick = local ? local.indexOf(Math.max(...local)) : -1;
          p.position = [...X.transformPoint(world, s0.position)];
          p.rotation = s0.rotation.slice();
          p.scale = s0.scale.map((v, k) => pick < 0 || k === pick ? v * m.factor : v);
        } else {
          const after = X.decomposeTRS(X.multiply(world, before));
          p.position = [...after.position]; p.rotation = [...after.rotation]; p.scale = s0.scale.slice();
        }
        S.cache.delete(p.id);
      });
    }
    draw();
  }
  function confirmModal() {
    const m = S.modal; if (!m) return;
    S.modal = null;
    if (m.kind === 'loopcut' || m.kind === 'box') { refresh(); return; }
    if (m.kind === 'knife') { S.modal = m; applyKnife(); return; }
    const edited = m.target?.part ?? m.part;
    if (edited) {
      try { m.after?.(); assertValidMesh(edited.mesh, m.kind === 'inset' ? 'Inset' : m.kind === 'bevel' ? 'Bevel' : 'This move'); }
      catch (error) { restore(m.before); refuse(error); return; }
    }
    S.undo.push(m.before); S.redo = []; S.cache.clear(); refresh();
  }
  /** Put what a transform acts on back where the transform found it. */
  function resetTarget(target) {
    if (target.kind === 'verts') { target.part.mesh = target.startMesh; S.cache.delete(target.part.id); }
    else if (target.kind === 'bones') target.points.forEach((q, i) => { q.bone[q.end] = target.start[i].slice(); });
    else target.parts.forEach((p, i) => { const s0 = target.start[i]; p.position = s0.position.slice(); p.rotation = s0.rotation.slice(); p.scale = s0.scale.slice(); S.cache.delete(p.id); });
  }
  /** G, R or S during a move, rotate or scale switches to that one, starting over from
   * where the selection began (as in Blender): E then S scales a fresh extrusion. */
  function switchTransform(kind) {
    const m = S.modal; if (!m || !TRANSFORMS.includes(m.kind) || m.tweak || m.kind === kind) return;
    resetTarget(m.target);
    S.modal = {...m, kind, start: {...m.mouse}, axis: null, axisName: '', snap: false, factor: undefined, angle: undefined};
    applyTransform(); setStatus();
  }
  function cancelModal() {
    const m = S.modal; if (!m) return;
    // Cancelling an extrusion's move keeps the new geometry where it was made (as in Blender).
    if (m.keep && m.target) { resetTarget(m.target); confirmModal(); toast(t("modeler.extrudeKept")); return; }
    // Cancelling the slide after a loop cut keeps the cut, in the middle (as in Blender).
    if (m.kind === 'loopslide') { m.t = .5; applyLoopSlide({follow: false}); confirmModal(); return; }
    S.modal = null;
    if (m.before) { const pointer = S.pointer; restore(m.before); S.pointer = pointer; }
    else refresh();
  }

  // ---------- edit operations ----------
  const editPart = () => { const p = activePart(); if (!p) toast(t("modeler.selectAPartToEdit")); return p; };
  function selectedFaces(p) { return M.facesFromVerts(p.mesh, S.verts); }
  function extrude() {
    if (S.mode === 'bones') return extrudeBone();
    const p = editPart(); if (!p || S.mode !== 'edit') return;
    const faces = selectedFaces(p), before = snapshot();
    let normal = null;
    let grown = null, traced = false;
    if (faces.size) { normal = M.regionNormal(p.mesh, faces); if (attempt(() => { S.verts = M.extrudeFaces(p.mesh, faces); return true; }) !== true) return; }
    else {
      // Open border edges and traced wires extrude into quads; an edge between two faces would get a third (rule H5).
      const uses = M.edgeFaces(p.mesh), edges = M.edgesFromVerts(p.mesh, S.verts).filter(([a, b]) => (uses.get(M.edgeKey(a, b))?.length ?? 0) <= 1);
      if (edges.length) {
        const count = p.mesh.faces.length;
        if (attempt(() => { S.verts = M.extrudeEdges(p.mesh, edges, {color: paintColor(p)}); return true; }) !== true) return;
        grown = new Set(p.mesh.faces.map((_, i) => i).filter(i => i >= count));
      } else if (S.verts.size) {
        // Single points (tracing): each pulls out a new point joined by a line.
        if (attempt(() => { S.verts = M.extrudePoints(p.mesh, S.verts); return true; }) !== true) return;
        traced = true;
      } else { toast(t("modeler.selectFacesOrEdgesToExtrude")); return; }
    }
    S.cache.delete(p.id);
    // Then move the new part along its normal (or freely for edges).
    const world = normal ? M.normalize(M.sub(M.objectTransform(p)(normal), M.objectTransform(p)([0, 0, 0]))) : null;
    startTransform('grab', {axis: world, axisName: world ? t("modeler.normal") : ''});
    if (S.modal) {
      // Faces and edges stay extruded if the move is cancelled (so E, right-click, S works as
      // in Blender); a traced point would sit on top of the old one, so that is undone instead.
      S.modal.before = before; S.modal.keep = !traced;
      // Quads grown from traced lines face the viewer once they have their shape.
      if (grown?.size) { S.modal.grown = grown; S.modal.after = () => M.orientWireFaces(p.mesh, grown, localFacing(p)); }
      // Faces pulled straight toward you don't change on screen: say how to grow a ring instead.
      if (world && Math.abs(M.dot(world, frame.back)) > .97) toast(t("modeler.extrudeTowardYou"));
    }
  }
  /** Toward the viewer, in a part's own space (flipped for mirrored parts, whose faces evaluate reversed). */
  function localFacing(p) {
    const transform = M.objectTransform(p), centre = transform(M.centroid(p.mesh, S.verts.size ? S.verts : new Set(p.mesh.verts.map((_, i) => i))));
    const dir = X.transformDirection(X.invert(M.objectMatrix(p)), frame.toEye(centre));
    return M.scale(M.normalize([...dir]), M.objectMirrors(p) ? -1 : 1);
  }
  /** New faces take the part's main colour. */
  const paintColor = p => p.mesh.faces[0]?.c ?? 0;
  /** The point under the screen position `pt`, on the plane facing the viewer through `through` (world). */
  function screenToWorld(pt, through) {
    const at = frame.project(through), u = frame.unitsPerPixel(through);
    return M.add(through, M.add(M.scale(frame.right, (pt.x - at.x) * u), M.scale(frame.up, -(pt.y - at.y) * u)));
  }
  /** Ctrl+click (Blender's extrude to cursor): a new point where you click, joined to the one selected point. */
  function addPointAt(pt) {
    const p = editPart(); if (!p || S.mode !== 'edit') return;
    if (S.verts.size > 1) { toast(t("modeler.ctrlClickFromOnePoint")); return; }
    const from = S.verts.size ? [...S.verts][0] : null, transform = M.objectTransform(p);
    const through = from !== null ? transform(p.mesh.verts[from]) : transform([0, 0, 0]);
    const local = M.objectInverse(p)(screenToWorld(pt, through));
    commit(() => {
      let at = local;
      // Mirrored parts: a point can't cross the middle line.
      if (p.mirror && p.clip !== false && M.objectTransform(p)(at)[0] < 0) at = M.objectInverse(p)([0, ...M.objectTransform(p)(at).slice(1)]);
      const k = M.addPoint(p.mesh, at, from);
      S.verts = new Set([k]); S.cache.delete(p.id);
    });
  }
  /** Bridge: fill between two selected lines of edges. */
  /** Grid Fill (Blender's Face > Grid Fill): fill the selected closed ring with
   * quads. Span and Offset can be changed afterwards in the Edit panel, which
   * redoes the fill (Blender's "adjust last operation"). */
  function gridFillSelected() {
    const p = editPart(); if (!p || S.mode !== 'edit') return;
    const sel = [...S.verts], before = snapshot();
    const done = commit(() => { const r = M.gridFill(p.mesh, new Set(sel), {color: paintColor(p), facing: localFacing(p)}); S.verts = r.verts; S.cache.delete(p.id); return r; });
    if (done) S.lastOp = {kind: 'grid', part: p.id, sel, before, span: done.span, offset: 0, max: Math.max(1, sel.length / 2 - 1)};
    renderProps();
  }
  function redoGridFill(span, offset) {
    const g = S.lastOp; if (g?.kind !== 'grid') return;
    const after = snapshot(); restore(g.before);
    const p = part(g.part);
    try {
      const r = M.gridFill(p.mesh, new Set(g.sel), {span, offset, color: paintColor(p), facing: localFacing(p)});
      S.verts = r.verts; g.span = r.span; g.offset = offset; S.cache.delete(p.id); S.redo = []; touch(p.id);
    } catch (error) { restore(after); refuse(error); }
    S.lastOp = g; renderProps();
  }
  function bridgeSelected() {
    const p = editPart(); if (!p || S.mode !== 'edit') return;
    commit(() => { const made = M.bridge(p.mesh, S.verts, {color: paintColor(p), facing: localFacing(p)}); S.cache.delete(p.id); toast(t("modeler.bridged", {count: made.size})); });
  }
  function startInset() {
    const p = editPart(); if (!p || S.mode !== 'edit') return;
    const faces = selectedFaces(p); if (!faces.size) { toast(t("modeler.selectFacesFirst")); return; }
    const before = snapshot(), original = M.cloneMesh(p.mesh), verts = new Set(S.verts);
    const pivot = M.objectTransform(p)(M.centroid(p.mesh, S.verts)), pivotScreen = frame.project(pivot), mouse = S.pointer ?? {x: pivotScreen.x + 80, y: pivotScreen.y};
    S.modal = {kind: 'inset', before, original, faces, verts, pivot, pivotScreen, start: {...mouse}, mouse: {...mouse}, part: p};
    applyInset(); setStatus();
  }
  function applyInset() {
    const m = S.modal, d0 = Math.max(4, Math.hypot(m.start.x - m.pivotScreen.x, m.start.y - m.pivotScreen.y)), d1 = Math.hypot(m.mouse.x - m.pivotScreen.x, m.mouse.y - m.pivotScreen.y);
    const amount = Math.max(.02, Math.min(.95, .25 + (1 - d1 / d0) * .7));
    // Each pointer move insets a fresh copy of the starting mesh.
    const mesh = M.cloneMesh(m.original);
    try { S.verts = M.insetFaces(mesh, m.faces, amount); }
    catch (error) { cancelModal(); refuse(error); return; }
    m.part.mesh = mesh; S.cache.delete(m.part.id); draw();
  }
  /** Ctrl+B (edges) or Ctrl+Shift+B (points), as in Blender: move the mouse away from
   * the selection to widen the bevel, scroll for more segments, click or Enter to keep. */
  function startBevel(points = false) {
    const p = editPart(); if (!p || S.mode !== 'edit') return;
    if (!S.verts.size) { toast(t(points ? "modeler.selectPointsToBevel" : "modeler.selectEdgesToBevel")); return; }
    const edges = M.edgesFromVerts(p.mesh, S.verts);
    if (!points && !edges.length) { toast(t("modeler.selectEdgesToBevel")); return; }
    const before = snapshot(), original = M.cloneMesh(p.mesh), verts = new Set(S.verts), tr = M.objectTransform(p);
    const pivot = tr(M.centroid(p.mesh, S.verts)), pivotScreen = frame.project(pivot), mouse = S.pointer ?? {x: pivotScreen.x + 80, y: pivotScreen.y};
    // Pixels per model unit at the selection, so the width follows the mouse at any zoom.
    const right = frame.project(M.add(pivot, M.scale(frame.right, .1)));
    const perUnit = Math.max(1, Math.hypot(right.x - pivotScreen.x, right.y - pivotScreen.y) / .1 / Math.max(1e-6, Math.abs(p.scale?.[0] ?? 1)));
    S.modal = {kind: 'bevel', points, edges, before, original, verts, pivot, pivotScreen, start: {...mouse}, mouse: {...mouse}, part: p, perUnit, segments: 1, width: 0};
    applyBevel(); setStatus();
  }
  function applyBevel() {
    const m = S.modal, d0 = Math.hypot(m.start.x - m.pivotScreen.x, m.start.y - m.pivotScreen.y), d1 = Math.hypot(m.mouse.x - m.pivotScreen.x, m.mouse.y - m.pivotScreen.y);
    m.width = Math.max(.002, (d1 - d0) / m.perUnit + .02);
    const mesh = M.cloneMesh(m.original);
    try { S.verts = m.points ? M.bevelVerts(mesh, m.verts, {width: m.width}) : M.bevelEdges(mesh, m.edges, {width: m.width, segments: m.segments}); }
    catch (error) { cancelModal(); refuse(error); return; }
    m.part.mesh = mesh; S.cache.delete(m.part.id); setStatus(); draw();
  }
  /** K (Blender's Knife): click points on edges or corners; the cut follows the line
   * between them across the faces. Ctrl snaps to the middle of an edge. Enter or
   * Space cuts, Esc or right-click cancels, Backspace removes the last point. */
  function startKnife() {
    const p = editPart(); if (!p || S.mode !== 'edit') return;
    if (!p.mesh.faces.length) { toast(t("modeler.knifeNeedsFaces")); return; }
    S.modal = {kind: 'knife', before: snapshot(), part: p, path: [], hover: null};
    setStatus(); draw();
  }
  function knifeSnap(x, y, middle = false) {
    const c = cage(); if (!c) return null;
    let best = null;
    c.pts.forEach((q, v) => { if (!q.ok || !c.visible[v] || !c.p.mesh.faces.some(f => f.v.includes(v))) return; const d = Math.hypot(q.x - x, q.y - y); if (d < 10 && (!best || d < best.d)) best = {v, d}; });
    if (best) return {v: best.v, local: c.p.mesh.verts[best.v].slice()};
    const edge = pickEdge(x, y); if (!edge) return null;
    const [a, b] = edge, A = c.pts[a], B = c.pts[b], L = (B.x - A.x) ** 2 + (B.y - A.y) ** 2;
    let t = L > 1e-9 ? Math.max(0, Math.min(1, ((x - A.x) * (B.x - A.x) + (y - A.y) * (B.y - A.y)) / L)) : .5;
    if (middle) t = .5;
    return {edge, t, local: M.lerp(c.p.mesh.verts[a], c.p.mesh.verts[b], t)};
  }
  function applyKnife() {
    const m = S.modal, p = m.part, tr = M.objectTransform(p);
    S.modal = null;
    if (m.path.length < 2) { restore(m.before); toast(t("modeler.knifeNeedsTwo")); return; }
    try { S.verts = M.knife(p.mesh, m.path.map(({v, edge, t: at}) => v !== undefined ? {v} : {edge, t: at}), v => frame.project(tr(v))); }
    catch (error) { restore(m.before); refuse(error); return; }
    S.selectMode = 'vert'; S.undo.push(m.before); S.redo = []; S.cache.delete(p.id); refresh();
  }
  function drawKnife(ctx) {
    const m = S.modal, tr = M.objectTransform(m.part), pts = m.path.map(q => frame.project(tr(q.local)));
    const end = m.hover ? frame.project(tr(m.hover.local)) : S.pointer;
    ctx.save(); ctx.lineWidth = 2; ctx.strokeStyle = '#d6336c'; ctx.fillStyle = '#d6336c';
    ctx.beginPath(); pts.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)); if (pts.length && end) ctx.lineTo(end.x, end.y); ctx.stroke();
    for (const q of pts) { ctx.beginPath(); ctx.arc(q.x, q.y, 4, 0, Math.PI * 2); ctx.fill(); }
    if (m.hover && end) { ctx.beginPath(); ctx.arc(end.x, end.y, 5, 0, Math.PI * 2); ctx.stroke(); }
    ctx.restore();
  }
  /** Click during Ctrl+R: cut, then (for a single cut) slide it until the next click. */
  function placeLoopCut(edge, cuts) {
    const part = activePart();
    S.modal = null; S.hover = null;
    if (!edge || !part) { refresh(); return; }
    if (cuts > 1) { commit(() => { S.verts = M.loopCut(part.mesh, edge, .5, cuts); S.cache.delete(part.id); }); return; }
    const before = snapshot(), original = M.cloneMesh(part.mesh);
    if (attempt(() => { S.verts = M.loopCut(part.mesh, edge, .5); return true; }) !== true) return;
    S.cache.delete(part.id);
    S.modal = {kind: 'loopslide', part, original, edge, before, t: .5, start: {...S.pointer}, mouse: {...S.pointer}};
    setStatus(); refresh();
  }
  /** Where along the cut edge the pointer is (0 at its first point, 1 at its second). */
  function edgeFraction(part, mesh, [a, b], mouse) {
    const transform = M.objectTransform(part), pa = frame.project(transform(mesh.verts[a])), pb = frame.project(transform(mesh.verts[b]));
    const dx = pb.x - pa.x, dy = pb.y - pa.y, len2 = dx * dx + dy * dy;
    return len2 < 1 ? .5 : ((mouse.x - pa.x) * dx + (mouse.y - pa.y) * dy) / len2;
  }
  /** Slide the new loop: it starts in the middle and follows the pointer along the edges. */
  function applyLoopSlide({follow = true} = {}) {
    const m = S.modal; if (!m) return;
    if (follow) m.t = Math.max(.02, Math.min(.98, .5 + edgeFraction(m.part, m.original, m.edge, m.mouse) - edgeFraction(m.part, m.original, m.edge, m.start)));
    const mesh = M.cloneMesh(m.original);
    try { S.verts = M.loopCut(mesh, m.edge, m.t); } catch (error) { cancelModal(); refuse(error); return; }
    m.part.mesh = mesh; S.cache.delete(m.part.id); setStatus(); draw();
  }
  /** G G: slide the selected points along their edges instead of moving them freely. */
  function startEdgeSlide() {
    const m = S.modal, {target} = m;
    resetTarget(target);
    const neighbours = M.slideNeighbours(target.startMesh, new Set(target.verts));
    if (![...neighbours.values()].some(list => list.length)) { toast(t("modeler.nothingToSlideAlong")); applyTransform(); return; }
    S.modal = {kind: 'slide', target, part: target.part, neighbours, before: m.before, after: m.after, keep: m.keep, start: {...m.mouse}, mouse: {...m.mouse}, f: 0};
    applyEdgeSlide(); setStatus();
  }
  /** Each point slides toward the neighbour lying most in the pointer's direction,
   * all by the same share of their edges. */
  function applyEdgeSlide() {
    const m = S.modal, {target} = m, mesh = target.startMesh, transform = M.objectTransform(target.part);
    const dx = m.mouse.x - m.start.x, dy = m.mouse.y - m.start.y, len = Math.hypot(dx, dy);
    const toward = new Map(); let along = 0, total = 0;
    if (len > 2) {
      const screen = new Map();
      const at = v => { if (!screen.has(v)) screen.set(v, frame.project(transform(mesh.verts[v]))); return screen.get(v); };
      for (const [v, list] of m.neighbours) {
        let best = null;
        for (const n of list) {
          const a = at(v), b = at(n), ex = b.x - a.x, ey = b.y - a.y, el = Math.hypot(ex, ey); if (el < 1) continue;
          const cos = (ex * dx + ey * dy) / (el * len);
          if (cos > 0 && (!best || cos > best.cos)) best = {n, cos, el};
        }
        if (best) { toward.set(v, best.n); along += best.cos * len; total += best.el; }
      }
    }
    m.f = total ? Math.max(0, Math.min(1, along / total)) : 0;
    let out = M.slideMesh(mesh, toward, m.f);
    if (target.part.mirror && target.part.clip !== false) out = M.clipToMirror(mesh, out, target.objectMatrix, [...toward.keys()]);
    target.part.mesh = out; S.cache.delete(target.part.id); setStatus(); draw();
  }
  function startLoopCut() {
    const p = editPart(); if (!p || S.mode !== 'edit') return;
    S.modal = {kind: 'loopcut', ring: null, cuts: 1}; setStatus(); draw();
  }
  function subdivide() { const p = editPart(); if (!p) return; const faces = selectedFaces(p); if (!faces.size) { toast(t("modeler.selectFacesFirst")); return; } commit(() => { S.verts = M.subdivideFaces(p.mesh, faces); S.cache.delete(p.id); }); }
  /** Blender's M menu: At Center, At First, At Last, Collapse, By Distance. */
  function merge(anchor = null) {
    const p = editPart(); if (!p) return;
    const item = (label, fn) => el('button', {type: 'button', class: 'modeler-menu-item', onclick: () => { closePopover(); fn(); }}, label);
    popover(anchor ?? pointerAnchor(), [
      item(t("modeler.mergeAtCenter"), () => mergeAt('center')), item(t("modeler.mergeAtFirst"), () => mergeAt('first')), item(t("modeler.mergeAtLast"), () => mergeAt('last')),
      item(t("modeler.mergeCollapse"), () => mergeAt('collapse')), item(t("modeler.mergeByDistance"), () => mergeAt('distance'))]);
  }
  function mergeAt(how) {
    const p = editPart(); if (!p) return;
    if (how === 'distance') { commit(() => { const n = M.mergeByDistance(p.mesh, .001, S.verts.size > 1 ? S.verts : null); S.verts = new Set(); S.cache.delete(p.id); toast(t("modeler.mergedCount", {count: n})); }); return; }
    if (S.verts.size < 2) { toast(t("modeler.selectTwoOrMoreVertices")); return; }
    const order = [...S.verts], at = how === 'first' ? p.mesh.verts[order[0]] : how === 'last' ? p.mesh.verts[order.at(-1)] : undefined;
    commit(() => { S.verts = how === 'collapse' ? M.collapseVerts(p.mesh, S.verts) : M.mergeVerts(p.mesh, S.verts, at?.slice()); S.cache.delete(p.id); });
  }
  /** A menu opened by a key shows up under the mouse, as in Blender. */
  function pointerAnchor() {
    const box = canvas.getBoundingClientRect(), x = box.left + (S.pointer?.x ?? box.width / 2), y = box.top + (S.pointer?.y ?? box.height / 2);
    return {getBoundingClientRect: () => ({left: x, right: x, top: y, bottom: y})};
  }
  /** Ctrl+X: dissolve what the select mode picks (points, edges or faces), keeping the surface. */
  function dissolve() {
    const p = editPart(); if (!p) return;
    if (!S.verts.size) { toast(t("modeler.selectSomethingToDissolve")); return; }
    const mesh = p.mesh, faces = selectedFaces(p);
    commit(() => {
      if (S.selectMode === 'face' && faces.size) S.verts = M.dissolveFaces(mesh, faces);
      else if (S.selectMode === 'edge') { M.dissolveEdges(mesh, M.edgesFromVerts(mesh, S.verts)); S.verts = new Set(); }
      else { M.dissolveVerts(mesh, S.verts); S.verts = new Set(); }
      S.cache.delete(p.id);
    });
  }
  function fill() {
    const p = editPart(); if (!p) return;
    if (S.verts.size < 2) { toast(t("modeler.selectTwoOrMorePoints")); return; }
    // Two points: a line between them. Three or more: a face (a traced ring keeps its order).
    commit(() => { M.fillVerts(p.mesh, S.verts, paintColor(p), {facing: localFacing(p)}); S.cache.delete(p.id); });
  }
  function duplicateSelected() {
    const p = editPart(); if (!p) return; const faces = selectedFaces(p);
    if (!faces.size && !S.verts.size) { toast(t("modeler.selectFacesFirst")); return; }
    const before = snapshot(); if (attempt(() => { S.verts = faces.size ? M.duplicateFaces(p.mesh, faces) : M.duplicatePoints(p.mesh, S.verts); return true; }) !== true) return;
    S.cache.delete(p.id); startTransform('grab'); if (S.modal) S.modal.before = before;
  }
  /** V (Blender's Rip): tear the surface open along the selected edges; the side
   * nearer the mouse comes away and follows the mouse. */
  function ripSelected() {
    const p = editPart(); if (!p || S.mode !== 'edit') return;
    const edges = M.edgesFromVerts(p.mesh, S.verts);
    if (!edges.length) { toast(t("modeler.ripHint")); return; }
    const sides = M.ripSides(p.mesh, edges), tr = M.objectTransform(p);
    let side = 'left';
    if (sides && S.pointer) {
      const near = set => { let best = Infinity; for (const fi of set) { const q = frame.project(tr(M.faceCenter(p.mesh, p.mesh.faces[fi]))); if (q.ok) best = Math.min(best, Math.hypot(q.x - S.pointer.x, q.y - S.pointer.y)); } return best; };
      side = near(sides.right) < near(sides.left) ? 'right' : 'left';
    }
    const before = snapshot();
    if (attempt(() => { S.verts = M.rip(p.mesh, edges, side); return true; }) !== true) return;
    S.cache.delete(p.id); startTransform('grab'); if (S.modal) S.modal.before = before;
  }
  function separate() {
    const p = editPart(); if (!p) return; const faces = selectedFaces(p); if (!faces.size) { toast(t("modeler.selectFacesFirst")); return; }
    commit(() => {
      const mesh = {verts: p.mesh.verts.map(v => v.slice()), faces: [...faces].map(fi => ({v: p.mesh.faces[fi].v.slice(), c: p.mesh.faces[fi].c}))};
      M.cleanup(mesh); assertValidMesh(mesh, 'Separate'); M.deleteFaces(p.mesh, faces);
      const created = addPart(model, {name: `${p.name} piece`, mesh, position: p.position, rotation: p.rotation, scale: p.scale, mirror: p.mirror, smooth: p.smooth});
      S.verts = new Set(); S.cache.clear(); toast(t("modeler.separatedInto", {name: created.name}));
    });
  }
  function deleteSelection() {
    if (S.mode === 'object') {
      if (!S.parts.size) return;
      commit(() => { model.parts = model.parts.filter(p => !S.parts.has(p.id)); S.parts = new Set(); S.active = model.parts[0]?.id ?? null; });
    } else if (S.mode === 'edit') {
      const p = activePart(); if (!p || !S.verts.size) return;
      commit(() => { const faces = selectedFaces(p); if (S.selectMode === 'face' && faces.size) M.deleteFaces(p.mesh, faces); else M.deleteVerts(p.mesh, S.verts); S.verts = new Set(); S.cache.delete(p.id); });
    } else if (S.bones.size) commit(() => { deleteBones(model, S.bones); S.bones = new Set(); });
  }
  function applyColor(index) {
    if (S.mode === 'edit') {
      const p = activePart(), faces = p ? selectedFaces(p) : new Set();
      if (!faces.size) { toast(t("modeler.selectFacesToColor")); return; }
      commit(() => { for (const fi of faces) p.mesh.faces[fi].c = index; S.cache.delete(p.id); });
    } else {
      if (!S.parts.size) { toast(t("modeler.selectAPartFirst")); return; }
      commit(() => { for (const id of S.parts) { const p = part(id); p.mesh.faces.forEach(f => { f.c = index; }); S.cache.delete(id); } });
    }
  }

  // ---------- parts ----------
  // New parts go on the middle (X = 0), where the mirror is, at the height and depth being looked at.
  const spawnPoint = () => { const ahead = S.camera.target.slice(); return [0, Math.max(0, Math.round(ahead[1] * 20) / 20), Math.round(ahead[2] * 20) / 20]; };
  function addPrimitive(kind) {
    commit(() => {
      const names = {cube: t("modeler.cube"), plane: t("modeler.plane"), circle: t("modeler.circle"), point: t("modeler.singlePoint"), sphere: t("modeler.sphere"), cylinder: t("modeler.cylinder"), cone: t("modeler.cone"), capsule: t("modeler.capsule"), torus: t("modeler.torus")};
      const p = addPart(model, {name: names[kind], mesh: PRIMITIVES[kind](), position: spawnPoint()});
      S.parts = new Set([p.id]); S.active = p.id; if (S.mode === 'bones') S.mode = 'object';
      // A single point is only useful in Edit mode, selected, ready to extrude.
      if (kind === 'point') { S.mode = 'edit'; S.selectMode = 'vert'; S.verts = new Set([0]); }
    });
    if (kind === 'point') toast(t("modeler.singlePointAdded"));
  }
  function addBaseCharacter() {
    commit(() => {
      for (const p of baseCharacter()) addPart(model, p);
      if (!model.bones.length) baseCharacterSkeleton(model);
      S.parts = new Set(); S.active = model.parts[0]?.id ?? null;
      S.camera = {...defaultCamera(), target: [0, 1, 0], dist: 4.2};
    });
    toast(t("modeler.baseCharacterAdded"));
  }
  function addMenu(anchor) {
    const items = [['baseCharacter', t("modeler.baseCharacter")], ['cube', t("modeler.cube")], ['sphere', t("modeler.sphere")], ['capsule', t("modeler.capsule")], ['cylinder', t("modeler.cylinder")],
      ['cone', t("modeler.cone")], ['torus', t("modeler.torus")], ['plane', t("modeler.plane")], ['circle', t("modeler.circle")], ['point', t("modeler.singlePoint")]];
    popover(anchor, items.map(([id, label]) => el('button', {type: 'button', class: 'modeler-menu-item', onclick: () => { closePopover(); id === 'baseCharacter' ? addBaseCharacter() : addPrimitive(id); }}, label)));
  }
  function duplicateParts() {
    if (S.mode === 'edit') return duplicateSelected();
    if (!S.parts.size) { toast(t("modeler.selectAPartFirst")); return; }
    const before = snapshot();
    const copies = [...S.parts].map(id => { const p = part(id); return addPart(model, {...structuredClone(p), name: `${p.name} copy`}); });
    S.parts = new Set(copies.map(p => p.id)); S.active = copies[0].id; S.cache.clear();
    startTransform('grab'); if (S.modal) S.modal.before = before;
  }
  function joinParts() {
    const list = [...S.parts].map(part).filter(Boolean); if (list.length < 2) return;
    commit(() => {
      const target = list[0], inverse = M.objectInverse(target);
      for (const other of list.slice(1)) {
        const transform = M.objectTransform(other), base = target.mesh.verts.length;
        target.mesh.verts.push(...other.mesh.verts.map(v => inverse(transform(v))));
        const flip = M.objectMirrors(other) !== M.objectMirrors(target);
        target.mesh.faces.push(...other.mesh.faces.map(f => ({v: (flip ? f.v.slice().reverse() : f.v).map(i => i + base), c: f.c})));
        if (other.mesh.edges?.length) target.mesh.edges = [...(target.mesh.edges ?? []), ...other.mesh.edges.map(e => e.map(i => i + base))];
        if (other.mesh.loose?.length) target.mesh.loose = [...(target.mesh.loose ?? []), ...other.mesh.loose.map(i => i + base)];
      }
      assertValidMesh(target.mesh, 'Join');
      model.parts = model.parts.filter(p => p === target || !S.parts.has(p.id));
      S.parts = new Set([target.id]); S.active = target.id; S.cache.clear();
    });
  }
  function rename(p) {
    const row = outliner.querySelector(`[data-part="${p.id}"] .modeler-name`); if (!row) return;
    const input = el('input', {type: 'text', class: 'modeler-rename', value: p.name, maxlength: '120'});
    const finish = ok => { if (ok && input.value.trim()) commit(() => { p.name = input.value.trim(); }); else refresh(); };
    input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
    row.replaceWith(input); input.select();
  }

  // ---------- bones ----------
  function addHumanoid() {
    const meshes = evaluateModel(model, {smooth: false}).map(x => x.mesh);
    if (model.bones.length) { askConfirm(t("modeler.replaceSkeleton"), () => commit(() => { humanoidSkeleton(model, meshes); S.bones = new Set(); S.cache.clear(); })); return; }
    commit(() => { humanoidSkeleton(model, meshes); S.bones = new Set(); S.cache.clear(); });
    if (S.mode !== 'bones') setMode('bones');
  }
  /** Face bones on the head (replacing any already there). */
  function addFaceBones() {
    const run = () => commit(() => { const meshes = evaluateModel(model, {smooth: false}).map(x => x.mesh); const added = faceSkeleton(model, meshes); S.bones = new Set(); S.cache.clear(); toast(t("modeler.faceBonesAdded", {count: added.length})); });
    if (model.bones.some(b => b.face)) { askConfirm(t("modeler.replaceFaceBones"), run); return; }
    run();
    if (S.mode !== 'bones') setMode('bones');
  }
  /** Move the selected bone (keeping its length and direction) so its head sits at
   * the centre of the points selected in Edit mode, or of the selected parts. */
  function boneToSelection() {
    const bone = model.bones.find(b => S.bones.has(b.id) && S.bones.size === 1);
    if (!bone) { toast(t("modeler.selectABoneFirst")); return; }
    let points = [];
    const p = activePart();
    if (p && S.verts.size) { const transform = M.objectTransform(p); points = [...S.verts].filter(v => p.mesh.verts[v]).map(v => transform(p.mesh.verts[v])); }
    if (!points.length) points = [...S.parts].map(part).filter(Boolean).flatMap(q => evaluated(q).verts);
    if (!points.length) { toast(t("modeler.boneToSelectionEmpty")); return; }
    // A side bone (Eye.L) goes to its own side of a mirrored selection (both eyeballs).
    const side = sideOf(bone.name), mine = points.filter(q => side === 'L' ? q[0] > 1e-4 : side === 'R' ? q[0] < -1e-4 : true);
    if (mine.length) points = mine;
    const box = M.bounds(points), centre = M.scale(M.add(box.min, box.max), .5), offset = M.sub(centre, bone.head);
    commit(() => { bone.head = centre; bone.tail = M.add(bone.tail, offset); S.cache.clear(); });
  }
  /** Where a part's points lie across the middle (world X = 0): counts on each side. */
  function sidesOf(p, verts = null) {
    const transform = M.objectTransform(p); let plus = 0, minus = 0;
    for (const i of verts ?? p.mesh.verts.keys()) { const x = transform(p.mesh.verts[i])[0]; if (x > 1e-4) plus++; else if (x < -1e-4) minus++; }
    return {plus, minus};
  }
  /** Mirror mode on or off. Turning it on with points on both sides of the middle says
   * so: the mirror would double them (Symmetrize, or deleting one half, fixes that). */
  function setMirror(p, on) {
    commit(() => { p.mirror = on; S.cache.delete(p.id); });
    if (!on) return;
    const {plus, minus} = sidesOf(p);
    if (plus && minus) toast(t("modeler.mirrorBothSides"));
    else if (!plus && !minus && p.mesh.verts.length) toast(t("modeler.mirrorAllMiddle"));
  }
  /** Symmetrize: copy one side over the other about the middle the mirror uses, keeping
   * the side the selection is on (or the side with more of the part). */
  function symmetrizePart(p) {
    const chosen = S.verts.size ? sidesOf(p, S.verts) : sidesOf(p);
    if (!chosen.plus && !chosen.minus) { toast(t("modeler.symmetrizeNothing")); return; }
    const keepPositive = chosen.plus >= chosen.minus;
    commit(() => { M.symmetrize(p.mesh, keepPositive, M.objectMatrix(p)); S.verts.clear(); S.cache.delete(p.id); });
    toast(t(keepPositive ? "modeler.symmetrizedFromPositive" : "modeler.symmetrizedFromNegative"));
  }
  function addSingleBone() {
    commit(() => { const at = spawnPoint(); const b = addBone(model, {name: 'Bone', head: at, tail: M.add(at, [0, .3, 0])}); S.bones = new Set([b.id]); S.boneEnd = null; S.cache.clear(); });
  }
  function extrudeBone() {
    const from = model.bones.find(b => S.bones.has(b.id));
    if (!from) { toast(t("modeler.selectABoneFirst")); return; }
    const before = snapshot();
    const dir = M.normalize(M.sub(from.tail, from.head)), len = M.length(M.sub(from.tail, from.head)) * .8;
    const b = addBone(model, {name: sideOf(from.name) ? `Bone.${sideOf(from.name)}` : 'Bone', head: from.tail, tail: M.add(from.tail, M.scale(dir, len)), parent: from.id});
    S.bones = new Set([b.id]); S.boneEnd = 'tail'; S.cache.clear();
    startTransform('grab'); if (S.modal) S.modal.before = before;
  }

  // ---------- view ----------
  function setView(name) { if (!VIEWS[name]) return; [S.camera.yaw, S.camera.pitch] = VIEWS[name]; if (name !== 'perspective') S.camera.ortho = true; refresh(); }
  function frameSelected() {
    let points = [];
    if (S.mode === 'edit' && S.verts.size) { const p = activePart(), tr = M.objectTransform(p); points = [...S.verts].map(v => tr(p.mesh.verts[v])); }
    else if (S.mode === 'bones' && S.bones.size) points = model.bones.filter(b => S.bones.has(b.id)).flatMap(b => [b.head, b.tail]);
    else { const parts = S.parts.size ? [...S.parts].map(part) : model.parts; points = parts.filter(Boolean).flatMap(p => evaluated(p).verts); }
    if (!points.length) return;
    const box = M.bounds(points), size = Math.max(.2, ...[0, 1, 2].map(k => box.max[k] - box.min[k]));
    S.camera.target = [0, 1, 2].map(k => (box.min[k] + box.max[k]) / 2); S.camera.dist = size * 2.2; draw();
  }

  // ---------- files ----------
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], {type})), a = el('a', {href: url, download: name});
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  function exportObjFile() {
    if (!model.parts.length) { toast(t("modeler.nothingToExport")); return; }
    const name = (model.name || 'model').replace(/[^\w-]+/g, '_'), {obj, mtl} = exportObj(model, {name});
    download(`${name}.obj`, obj, 'text/plain'); download(`${name}.mtl`, mtl, 'text/plain');
  }
  function importObjFile() {
    const input = el('input', {type: 'file', accept: '.obj,.mtl', multiple: true});
    input.addEventListener('change', async () => {
      const files = [...input.files], objFile = files.find(f => /\.obj$/i.test(f.name)), mtlFile = files.find(f => /\.mtl$/i.test(f.name));
      if (!objFile) { toast(t("modeler.chooseAnObjFile")); return; }
      try {
        const [text, mtl] = await Promise.all([objFile.text(), mtlFile ? mtlFile.text() : '']);
        commit(() => { const parts = importObj(text, {mtl, palette: model.palette}); for (const p of parts) addPart(model, {name: p.name, mesh: p.mesh}); S.parts = new Set(); });
        frameSelected(); toast(t("modeler.importedObj"));
      } catch (error) { toast(error.message); }
    });
    input.click();
  }
  function loadReference(view) {
    const input = el('input', {type: 'file', accept: 'image/*'});
    input.addEventListener('change', () => {
      const file = input.files[0]; if (!file) return;
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        // Stored downscaled (at most 1024 px) as JPEG so saved figures stay small.
        const k = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        const src = c.toDataURL('image/jpeg', .85);
        commit(() => { model.references = model.references.filter(r => r.view !== view); model.references.push({id: `${view}-${Date.now()}`, view, src, opacity: .5, height: 2, offsetX: 0, offsetY: 0}); syncRefs(); });
        setView(view === 'front' ? 'front' : 'right');
      };
      img.src = url;
    });
    input.click();
  }
  function syncRefs() {
    for (const ref of model.references) if (!S.refImages.has(ref.id)) { const img = new Image(); img.onload = draw; img.src = ref.src; S.refImages.set(ref.id, img); }
  }

  // ---------- small popovers ----------
  let pop = null;
  function popover(anchor, children) {
    closePopover();
    const box = anchor.getBoundingClientRect(), hostBox = root.getBoundingClientRect();
    pop = el('div', {class: 'modeler-popover', role: 'menu'}, children);
    pop.style.left = `${box.left - hostBox.left}px`; pop.style.top = `${box.bottom - hostBox.top + 4}px`;
    root.append(pop);
    // Keep it inside the window: open upward or leftward when it would run off an edge.
    const r = pop.getBoundingClientRect();
    if (r.right > hostBox.right - 8) pop.style.left = `${Math.max(8, hostBox.right - 8 - r.width - hostBox.left)}px`;
    if (r.bottom > hostBox.bottom - 8) pop.style.top = `${Math.max(8, box.top - hostBox.top - 4 - r.height)}px`;
  }
  function closePopover() { pop?.remove(); pop = null; }
  /** A question in the middle of the viewport (Enter answers yes, Esc no), so it can't
   * end up off screen or under a message along the bottom of the window. */
  let confirmBox = null;
  function askConfirm(message, yes, {yesLabel = t("modeler.replace"), noLabel = t("modeler.keep")} = {}) {
    closePopover(); closeConfirm();
    const ok = el('button', {type: 'button', class: 'modeler-button modeler-primary', onclick: () => { closeConfirm(); yes(); }}, yesLabel);
    const no = el('button', {type: 'button', class: 'modeler-button', onclick: closeConfirm}, noLabel);
    confirmBox = el('div', {class: 'modeler-controls modeler-confirm-layer', onpointerdown: e => { if (e.target === confirmBox) closeConfirm(); }},
      [el('div', {class: 'modeler-controls-card modeler-confirm', role: 'alertdialog', 'aria-label': message}, [el('p', {class: 'modeler-confirm-text', text: message}), el('div', {class: 'modeler-row modeler-confirm-row'}, [no, ok])])]);
    stage.append(confirmBox);
    ok.focus();
  }
  function closeConfirm() { if (!confirmBox) return; confirmBox.remove(); confirmBox = null; canvas.focus(); }
  /** Leaving never asks: an unfinished model is kept (onClose) and the Model tab carries on from it. */
  function requestClose(after) {
    if (S.modal) cancelModal();
    close(); if (typeof after === 'function') after();
  }
  /** Throw the unfinished model away and start again (File › Start over). */
  function startOver() {
    askConfirm(t("modeler.startOverAsk"), () => { setMode('object'); commit(() => { model.parts = []; model.bones = []; model.references = []; S.parts = new Set(); S.verts = new Set(); S.bones = new Set(); S.active = null; syncRefs(); }); },
      {yesLabel: t("modeler.startOver"), noLabel: t("modeler.keepModeling")});
  }
  // ---------- controls card ----------
  // Shown over the viewport when 3D Nowdz opens, until "Don't show this again";
  // the keyboard button in the bar brings it back.
  const CONTROLS_KEY = 'stykNowdz.modeler.hideControls';
  const controlsHidden = () => { try { return localStorage.getItem(CONTROLS_KEY) === '1'; } catch { return false; } };
  const setControlsHidden = hide => { try { if (hide) localStorage.setItem(CONTROLS_KEY, '1'); else localStorage.removeItem(CONTROLS_KEY); } catch { /* private mode: shows each time */ } };
  let controls = null;
  function showControls() {
    closeControls(); closePopover();
    const keys = text => el('dt', {}, String(text).split(' / ').map(k => el('span', {class: 'modeler-key', text: k})));
    const group = (title, rows) => el('section', {class: 'modeler-controls-group'}, [el('h3', {text: title}), el('dl', {}, rows.flatMap(([k, v]) => [keys(k), el('dd', {text: v})]))]);
    const hide = el('input', {type: 'checkbox', checked: controlsHidden(), onchange: e => setControlsHidden(e.target.checked)});
    const ok = el('button', {type: 'button', class: 'modeler-button modeler-primary', onclick: closeControls}, t("modeler.controlsOk"));
    const close = iconButton('close', t("modeler.close"), closeControls);
    const card = el('div', {class: 'modeler-controls-card', role: 'dialog', 'aria-label': t("modeler.controlsTitle")}, [
      el('div', {class: 'modeler-controls-head'}, [el('h2', {text: t("modeler.controlsTitle")}), close]),
      el('p', {class: 'modeler-controls-lede', text: t("modeler.controlsLede")}),
      el('div', {class: 'modeler-controls-grid'}, [
        group(t("modeler.controlsLook"), [[t("modeler.keysOrbitKeys"), t("modeler.keysOrbit")], [t("modeler.keysPanKeys"), t("modeler.keysPan")], [t("modeler.keysWheel"), t("modeler.keysZoom")], ['Numpad 1 / 3 / 7', t("modeler.keysViews")], ['Numpad .', t("modeler.frameSelected")]]),
        group(t("modeler.controlsSelect"), [[t("modeler.keysClickKeys"), t("modeler.keysClick")], ['Alt+click', t("modeler.keysLoopSelect")], ['A', t("modeler.selectAll")], ['L', t("modeler.selectLinked")], ['Tab', t("modeler.keysTab")], ['1 2 3', t("modeler.keysSelectMode")]]),
        group(t("modeler.controlsShape"), [['G / R / S', t("modeler.keysTransform")], ['G G', t("modeler.keysEdgeSlide")], ['X Y Z', t("modeler.keysAxis")], ['E', t("modeler.extrude")], ['Ctrl+click', t("modeler.keysAddPoint")], ['F', t("modeler.fill")], ['M', t("modeler.merge")], ['Ctrl+R', t("modeler.keysLoopCut")], ['O', t("modeler.softSelect")], ['X / Delete', t("modeler.deleteSelected")]]),
        group(t("modeler.controlsBones"), [[t("modeler.keysDragKeys"), t("modeler.keysDrag")], [t("modeler.keysStretchKeys"), t("modeler.keysStretch")], ['E', t("modeler.extrudeBone")], ['Ctrl+Z', t("modeler.undo")]])]),
      el('div', {class: 'modeler-controls-foot'}, [el('label', {class: 'modeler-check'}, [hide, t("modeler.controlsHide")]), ok])]);
    controls = el('div', {class: 'modeler-controls', onpointerdown: e => { if (e.target === controls) closeControls(); }}, [card]);
    stage.append(controls);
    ok.focus();
  }
  function closeControls() { if (!controls) return; controls.remove(); controls = null; canvas.focus(); }

  // ---------- click and drag (tweak) ----------
  // Dragging works like moving a node in the animation: in Bones mode a joint
  // swings its bone (and everything below it) around the bone's start, and
  // Ctrl+drag stretches it instead. Parts (Object mode) and the points under
  // the pointer (Edit mode) simply follow the pointer. G, R and S still work.
  function descendants(id) {
    const out = [], queue = [id];
    for (let i = 0; i < queue.length; i++) for (const b of model.bones) if (b.parent === queue[i]) { out.push(b); queue.push(b.id); }
    return out;
  }
  const connected = (b, parent) => parent && M.length(M.sub(parent.tail, b.head)) < 1e-6;
  /** The modal a drag starting on `hit` begins, or null. `stretch` is Ctrl. */
  function tweakModal(hit, start, stretch) {
    const before = snapshot();
    const modal = (kind, points, pivot) => {
      const target = {kind: 'bones', points, start: points.map(q => q.bone[q.end].slice()), pivot};
      return {kind, target, before, pivot, pivotScreen: frame.project(pivot), start: {...start}, mouse: {...start}, axis: null, axisName: '', axisColor: VIEW_COLORS.ring, tweak: true, stretch};
    };
    if (S.mode === 'bones') {
      let bone = model.bones.find(b => b.id === hit.bone), end = hit.end;
      if (!bone) return null;
      const parent = model.bones.find(b => b.id === bone.parent);
      // A joint shared with the parent belongs to the parent, as in a Pivot figure.
      if (end === 'head' && connected(bone, parent)) { bone = parent; end = 'tail'; }
      S.bones = new Set([bone.id]); S.boneEnd = end;
      const below = descendants(bone.id).flatMap(b => [{bone: b, end: 'head'}, {bone: b, end: 'tail'}]);
      if (end === 'tail') {
        const points = [{bone, end: 'tail'}, ...below];
        // Swing around the bone's start (length kept), or stretch: the end follows the pointer and the bones below ride along.
        return stretch ? modal('grab', points, bone.tail.slice()) : modal('rotate', points, bone.head.slice());
      }
      // The middle of a bone joined to its parent swings it like its end does, so the skeleton never comes apart.
      if (end === null && connected(bone, parent)) return modal('rotate', [{bone, end: 'tail'}, ...below], bone.head.slice());
      // A free start or the middle of a free bone moves the bone with everything below it; Ctrl+drag on the start moves the start alone.
      if (end === 'head' && stretch) return modal('grab', [{bone, end: 'head'}], bone.head.slice());
      return modal('grab', [{bone, end: 'head'}, {bone, end: 'tail'}, ...below], (end === 'head' ? bone.head : M.lerp(bone.head, bone.tail, .5)).slice());
    }
    if (S.mode === 'object') { if (!S.parts.has(hit.part)) { S.parts = new Set([hit.part]); S.active = hit.part; } }
    else if (!hit.verts.every(v => S.verts.has(v))) S.verts = new Set(hit.verts);
    const target = transformTarget(); if (!target) return null;
    return {kind: 'grab', target, before, pivot: target.pivot, pivotScreen: frame.project(target.pivot), start: {...start}, mouse: {...start}, axis: null, axisName: '', axisColor: VIEW_COLORS.ring, tweak: true};
  }

  // ---------- pointer ----------
  const local = e => { const box = canvas.getBoundingClientRect(); return {x: e.clientX - box.left, y: e.clientY - box.top}; };
  let drag = null;
  canvas.addEventListener('pointerdown', e => {
    closePopover(); canvas.focus();
    const p = local(e); S.pointer = p;
    if (S.modal && [...TRANSFORMS, 'inset', 'bevel', 'slide', 'loopslide'].includes(S.modal.kind)) { e.preventDefault(); if (e.button === 2) cancelModal(); else confirmModal(); return; }
    if (S.modal?.kind === 'knife') {
      e.preventDefault();
      if (e.button === 2) { cancelModal(); return; }
      if (e.button === 1) { drag = {kind: 'orbit', last: p}; canvas.setPointerCapture(e.pointerId); return; }
      const hit = knifeSnap(p.x, p.y, e.ctrlKey || e.metaKey);
      if (hit) { S.modal.path.push(hit); setStatus(); draw(); } else toast(t("modeler.knifeClickEdge"));
      return;
    }
    if (S.modal?.kind === 'loopcut') {
      e.preventDefault();
      if (e.button === 2) { cancelModal(); return; }
      placeLoopCut(pickEdge(p.x, p.y), S.modal.cuts);
      return;
    }
    const orbit = e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey && S.mode !== 'edit');
    canvas.setPointerCapture(e.pointerId);
    if (orbit) { drag = {kind: e.shiftKey ? 'pan' : 'orbit', last: p}; e.preventDefault(); return; }
    if (e.button === 0) drag = {kind: 'press', start: p, last: p, event: e, hit: e.shiftKey || (e.altKey && S.mode === 'edit') ? null : pick(p.x, p.y)};
  }, {signal});
  canvas.addEventListener('pointermove', e => {
    const p = local(e); S.pointer = p;
    if (S.modal && TRANSFORMS.includes(S.modal.kind)) { S.modal.mouse = p; S.modal.snap = S.modal.tweak ? e.shiftKey : e.ctrlKey; applyTransform(); return; }
    if (S.modal?.kind === 'inset') { S.modal.mouse = p; applyInset(); return; }
    if (S.modal?.kind === 'bevel') { S.modal.mouse = p; applyBevel(); return; }
    if (S.modal?.kind === 'loopcut') { const edge = pickEdge(p.x, p.y), part = activePart(); S.modal.ring = edge && part ? M.edgeRing(part.mesh, edge) : null; S.hover = edge ? {edge} : null; draw(); return; }
    if (S.modal?.kind === 'loopslide') { S.modal.mouse = p; applyLoopSlide(); return; }
    if (S.modal?.kind === 'knife' && !drag) { S.modal.hover = knifeSnap(p.x, p.y, e.ctrlKey || e.metaKey); draw(); return; }
    if (S.modal?.kind === 'slide') { S.modal.mouse = p; applyEdgeSlide(); return; }
    if (!drag) return;
    const dx = p.x - drag.last.x, dy = p.y - drag.last.y; drag.last = p;
    if (drag.kind === 'orbit') { S.camera.yaw -= dx * .008; S.camera.pitch = Math.max(-1.55, Math.min(1.55, S.camera.pitch + dy * .008)); S.camera.ortho = false; draw(); }
    else if (drag.kind === 'pan') { const u = frame.unitsPerPixel(S.camera.target); S.camera.target = M.add(S.camera.target, M.add(M.scale(frame.right, -dx * u), M.scale(frame.up, dy * u))); draw(); }
    else if (drag.kind === 'press' && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 4) {
      const tweak = drag.hit ? tweakModal(drag.hit, drag.start, e.ctrlKey || e.metaKey) : null;
      if (tweak) { drag.kind = 'tweak'; S.modal = tweak; S.modal.mouse = p; renderHeader(); renderOutliner(); renderProps(); setStatus(); applyTransform(); }
      else { drag.kind = 'box'; S.modal = {kind: 'box', box: {x0: drag.start.x, y0: drag.start.y, x1: p.x, y1: p.y}}; }
    }
    else if (drag.kind === 'box') { S.modal.box.x1 = p.x; S.modal.box.y1 = p.y; draw(); }
  }, {signal});
  canvas.addEventListener('pointerup', e => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.kind === 'press' && S.mode === 'edit' && (e.ctrlKey || e.metaKey)) addPointAt(d.start);
    else if (d.kind === 'press') clickSelect(d.start.x, d.start.y, e);
    else if (d.kind === 'box') { const box = S.modal?.box; S.modal = null; if (box) boxSelect(box, e.shiftKey); }
    else if (d.kind === 'tweak' && S.modal?.tweak) confirmModal();
  }, {signal});
  canvas.addEventListener('contextmenu', e => e.preventDefault(), {signal});
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    // While moving with soft select, the wheel grows or shrinks its circle (as in Blender).
    if (S.modal?.kind === 'bevel') { if (!S.modal.points) { S.modal.segments = Math.max(1, Math.min(12, S.modal.segments + (e.deltaY < 0 ? 1 : -1))); applyBevel(); } return; }
    if (S.modal?.kind === 'loopcut') {
      S.modal.cuts = Math.max(1, Math.min(M.LOOP_CUTS_MAX, S.modal.cuts + (e.deltaY < 0 ? 1 : -1))); setStatus(); draw(); return;
    }
    const target = S.modal?.target;
    if (target?.soft && TRANSFORMS.includes(S.modal.kind)) {
      S.softRadius = Math.max(.01, Math.min(10, S.softRadius * Math.exp(-Math.max(-1, Math.min(1, e.deltaY * .002)))));
      target.soft = M.softWeights(target.points, target.selected, S.softRadius, S.softFalloff); applyTransform(); setStatus(); return;
    }
    const k = Math.exp(Math.max(-1, Math.min(1, e.deltaY * (e.ctrlKey ? .01 : .0015))));
    S.camera.dist = Math.max(.15, Math.min(60, S.camera.dist * k)); draw();
  }, {signal, passive: false});

  // ---------- keyboard ----------
  const typing = e => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName ?? '') && e.target.type !== 'checkbox' && e.target.type !== 'range';
  window.addEventListener('keydown', e => {
    if (!root.isConnected) return;
    if (typing(e)) { if (e.key === 'Escape') e.target.blur(); e.stopPropagation(); return; }
    // The controls card takes the keyboard while it is open: Esc closes it, Tab and Enter work its buttons.
    if (controls) { if (e.key === 'Escape') { e.preventDefault(); closeControls(); } e.stopPropagation(); return; }
    if (confirmBox) {
      if (e.key === 'Escape') { e.preventDefault(); closeConfirm(); }
      else if (e.key === 'Enter') { e.preventDefault(); (confirmBox.contains(document.activeElement) && document.activeElement.tagName === 'BUTTON' ? document.activeElement : confirmBox.querySelector('.modeler-primary'))?.click(); }
      e.stopPropagation(); return;
    }
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key, ctrl = e.ctrlKey || e.metaKey;
    let handled = true;
    if (S.modal && TRANSFORMS.includes(S.modal.kind) && ['x', 'y', 'z'].includes(key) && !ctrl) setAxis(key.toUpperCase());
    else if (S.modal && (key === 'Enter' || key === ' ')) confirmModal();
    else if (S.modal && key === 'Escape') cancelModal();
    else if (S.modal?.kind === 'knife' && key !== 'Backspace') { /* other keys wait until the cut is done */ }
    else if (S.modal?.kind === 'grab' && !S.modal.tweak && S.modal.target?.kind === 'verts' && key === 'g' && !ctrl) startEdgeSlide();
    else if (S.modal && !ctrl && ['g', 'r', 's'].includes(key)) switchTransform({g: 'grab', r: 'rotate', s: 'scale'}[key]);
    else if (S.modal?.kind === 'loopcut' && ['+', '=', '-'].includes(key)) { S.modal.cuts = Math.max(1, Math.min(M.LOOP_CUTS_MAX, S.modal.cuts + (key === '-' ? -1 : 1))); setStatus(); draw(); }
    else if (S.modal) handled = false;
    else if (ctrl && key === 'z') e.shiftKey ? redo() : undo();
    else if (ctrl && key === 'y') redo();
    else if (ctrl && e.altKey && e.shiftKey && key === 's') startShear();
    else if (ctrl && key === 'e' && S.mode === 'edit') bridgeSelected();
    else if (ctrl && key === 'r') startLoopCut();
    else if (ctrl && key === 'b' && S.mode === 'edit') startBevel(e.shiftKey);
    else if (S.modal?.kind === 'knife' && key === 'Backspace') { S.modal.path.pop(); setStatus(); draw(); }
    else if (key === 'k' && !ctrl && S.mode === 'edit' && !S.modal) startKnife();
    else if (ctrl && key === 'l') { if (S.mode === 'edit' && activePart()) { S.verts = M.linkedVerts(activePart().mesh, S.verts); refresh(); } }
    else if (ctrl && (key === '+' || key === '=')) { if (S.mode === 'edit' && activePart()) { S.verts = M.growSelection(activePart().mesh, S.verts); refresh(); } }
    else if (ctrl) handled = false;
    else if (key === 'Tab') setMode(S.mode === 'edit' ? 'object' : 'edit');
    else if (key === 'g') startTransform('grab');
    else if (key === 'r') startTransform('rotate');
    else if (key === 's') startTransform('scale');
    else if (key === 'e') extrude();
    else if (key === 'i' && S.mode === 'edit') startInset();
    else if (key === 'o' && S.mode === 'edit') { S.soft = !S.soft; toast(t(S.soft ? "modeler.softOn" : "modeler.softOff")); renderProps(); }
    else if (key === 'm' && S.mode === 'edit') merge();
    else if (ctrl && key === 'x' && S.mode === 'edit') dissolve();
    else if (key === 'f' && S.mode === 'edit') fill();
    else if (key === 'p' && S.mode === 'edit') separate();
    else if (key === 'v' && !ctrl && S.mode === 'edit') ripSelected();
    else if (key === 'x' || key === 'Delete') deleteSelection();
    else if (key === 'd' && e.shiftKey) S.mode === 'edit' ? duplicateSelected() : duplicateParts();
    else if (key === 'a' && e.altKey) { S.verts = new Set(); S.parts = new Set(); S.bones = new Set(); refresh(); }
    else if (key === 'a') selectAll();
    else if (key === 'l' && S.mode === 'edit' && S.pointer) { const hit = pick(S.pointer.x, S.pointer.y); if (hit?.verts) { S.verts = new Set([...S.verts, ...M.linkedVerts(activePart().mesh, new Set(hit.verts))]); refresh(); } }
    else if (key === 'h' && S.mode === 'object') { if (S.parts.size) commit(() => { for (const id of S.parts) part(id).visible = false; }); else commit(() => model.parts.forEach(p => { p.visible = true; })); }
    else if (key === 'n' && e.shiftKey && S.mode === 'edit' && activePart()) commit(() => { M.recalculateNormals(activePart().mesh); S.cache.delete(S.active); });
    else if (['1', '2', '3'].includes(key) && S.mode === 'edit' && e.code?.startsWith('Digit')) { S.selectMode = {1: 'vert', 2: 'edge', 3: 'face'}[key]; refresh(); }
    else if (e.code === 'Numpad1') setView(ctrl ? 'back' : 'front');
    else if (e.code === 'Numpad3') setView(ctrl ? 'left' : 'right');
    else if (e.code === 'Numpad7') setView(ctrl ? 'bottom' : 'top');
    else if (e.code === 'Numpad5') { S.camera.ortho = !S.camera.ortho; refresh(); }
    else if (e.code === 'NumpadDecimal' || key === '.') frameSelected();
    else if (key === '?') showShortcuts(header.lastChild);
    else if (key === 'Escape') { if (pop) closePopover(); else if (S.mode !== 'object') setMode('object'); }
    else handled = false;
    // While the modeler is open the app underneath gets no shortcuts.
    if (handled) e.preventDefault();
    e.stopImmediatePropagation();
  }, {signal, capture: true});
  window.addEventListener('resize', draw, {signal});

  // ---------- lifecycle ----------
  function close() {
    listeners.abort(); cancelAnimationFrame(frameRequest); clearTimeout(flashTimer); root.remove();
    const changed = !finished && (S.undo.length > 0 || Boolean(draft?.model)) && (model.parts.length > 0 || model.references.length > 0 || model.bones.length > 0);
    // The draft remembers where you were (mode, part and selection), so coming back
    // from another tab carries straight on instead of dropping to Object mode.
    const where = {mode: S.mode, selectMode: S.selectMode, active: S.active, parts: [...S.parts], verts: [...S.verts]};
    onClose?.(changed ? {model: structuredClone(model), camera: structuredClone(S.camera), where} : null);
  }
  function done() {
    if (!model.parts.some(p => p.visible !== false && p.mesh.faces.length)) { toast(t("modeler.addAPartFirst")); return; }
    try { onDone?.(structuredClone(model)); finished = true; close(); }
    catch (error) { toast(error.modelerMessage ? error.message : (error.message || t("modeler.couldNotAdd"))); }
  }
  syncRefs();
  if (!model.parts.length) S.camera = defaultCamera();
  if (draft?.camera) S.camera = {...S.camera, ...draft.camera};
  if (draft?.where) {
    const w = draft.where, ids = new Set(model.parts.map(p => p.id));
    if (ids.has(w.active)) S.active = w.active;
    S.parts = new Set((w.parts ?? []).filter(id => ids.has(id)));
    if (['vert', 'edge', 'face'].includes(w.selectMode)) S.selectMode = w.selectMode;
    if (w.mode === 'edit' && activePart()) { S.mode = 'edit'; const n = activePart().mesh.verts.length; S.verts = new Set((w.verts ?? []).filter(v => Number.isInteger(v) && v >= 0 && v < n)); }
    else if (w.mode === 'bones') S.mode = 'bones';
  }
  // A draft with one part is ready to edit: select it so Tab works straight away.
  if (S.mode === 'object' && !S.parts.size && model.parts.length === 1) { S.parts = new Set([model.parts[0].id]); S.active = model.parts[0].id; }
  refresh();
  canvas.focus();
  if (!controlsHidden()) showControls();
  const api = {close, requestClose, element: root, get state() { return S; }, get model() { return model; }, setMode, startTransform, extrude, addBaseCharacter, addPrimitive, selectAll, setView, applyColor,
    /** Where a model-space point is on screen, in client coordinates (for tests and tours). */
    screenPoint(p) { const q = frame?.project(p), box = canvas.getBoundingClientRect(); return q?.ok ? {x: box.left + q.x, y: box.top + q.y} : null; },
    showControls, closeControls,
    /** Redraw after the model was changed from outside (tests). */
    refresh() { S.cache.clear(); refresh(); }};
  // Tests and tours reach the workspace through its element.
  Object.defineProperty(root, 'modeler', {value: api});
  return api;
}

export {DEFAULT_PALETTE, otherSide};
