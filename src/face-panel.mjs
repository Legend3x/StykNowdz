/** The stage's face panel (docs/FACE-RIG.md): poses a figure's 2D face at the
 * playhead. Opened from the face badge on a 3D Nowdz figure with a 2D face.
 *
 *   Look      a pad: drag where the eyes look (double-click looks ahead)
 *   Eyes      each eye's states (Open, Half, Closed…); Blink closes the eyes
 *             here and opens them two frames later
 *   Brows     raise and tilt
 *   Mouth     its states (the lip-sync shapes)
 *   Extras    how much each shows (blush, sweat)
 *   Both sides together   left and right move as one (on by default)
 *
 * Every change is an editor command: a drag or slider is one undo step, and
 * with auto key on a change keys the playhead like any pose change. */
import {t as interfaceText} from './localization.mjs';
import {placeFloating} from './ui/anchor-position.mjs';
import {drawingsOf} from './face-rig.mjs';

const h = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v; else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
};

export class FacePanel {
  constructor({editor, changed = () => {}}) {
    Object.assign(this, {editor, changed, uid: null, linked: true});
    const panel = this.panel = h('div', {class: 'ui-popover face-panel', popover: 'auto', role: 'dialog', 'aria-label': interfaceText('spatialControls.face2d.title')});
    this.body = h('div', {class: 'ui-popover-body face-panel-body'});
    panel.append(h('header', {class: 'ui-popover-head'}, [h('strong', {class: 'ui-popover-title', text: interfaceText('spatialControls.face2d.title')}),
      h('button', {type: 'button', class: 'ui-icon-button face-panel-close', 'aria-label': interfaceText('spatialControls.face2d.close'), title: interfaceText('spatialControls.face2d.close'), text: '×', onclick: () => this.close()})]), this.body);
    panel.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') this.close(); });
    panel.addEventListener('toggle', e => { if (e.newState === 'closed') { this.finishDrag(); this.uid = null; } });
    document.body.append(panel);
  }
  get open() { return this.panel.matches(':popover-open'); }
  /** Open for a figure, beside a point on screen ({x, y} in client pixels). */
  show(uid, at) {
    this.uid = uid; this.render();
    if (!this.open) this.panel.showPopover();
    placeFloating(this.panel, new DOMRect(at.x, at.y, 1, 1), {side: 'right', align: 'start'});
  }
  close() { if (this.open) this.panel.hidePopover(); }
  /** Bring the panel in line with the playhead (after seeking, undo…). */
  sync() {
    if (!this.open || this.dragging) return;
    if (!this.editor.report?.figure_types || !this.editor.frame?.objects.some(o => o.unique_id === this.uid)) { this.close(); return; }
    this.render();
  }
  select() { if (this.editor.selectedUid !== this.uid) this.editor.select(this.uid, -1); return Boolean(this.editor.face); }
  /** Change values (linked sides follow) as a step, or as part of the drag in progress. */
  set(patch, label = 'Face') {
    if (!this.select()) return;
    if (this.editor.setFaceValues(patch, {label, linked: this.linked})) this.changed();
    if (!this.dragging) this.render();
  }
  startDrag(label) { if (this.dragging || !this.select()) return; this.editor.beginDrag(label); this.dragging = true; }
  finishDrag() { if (!this.dragging) return; this.dragging = false; this.editor.commitDrag(); this.changed(); this.render(); }

  render() {
    const editor = this.editor; if (!this.select()) { this.body.replaceChildren(h('p', {class: 'face-panel-hint', text: interfaceText('spatialControls.face2d.noFace')})); return; }
    const face = editor.face, values = editor.faceValues() ?? {}, of = kind => face.features.filter(f => f.kind === kind);
    const eyes = of('eye'), brows = of('brow'), mouths = of('mouth'), extras = of('extra');
    const parts = [];
    if (eyes.length) parts.push(this.lookPad(eyes, values));
    // Paired sides show once while linked (the side drawn first).
    const shown = list => this.linked ? list.filter(f => !f.mirrorOf || !list.some(g => g.id === f.mirrorOf)) : list;
    for (const f of shown(eyes)) parts.push(this.states(f, values[f.id], face, this.linked && eyes.length > 1 ? interfaceText('spatialControls.face2d.eyes') : f.name));
    if (eyes.length) parts.push(h('div', {class: 'face-panel-row'}, [h('button', {type: 'button', class: 'ui-button', 'data-size': 'sm', text: interfaceText('spatialControls.face2d.blink'), title: interfaceText('spatialControls.face2d.blinkHint'), onclick: () => this.blink(eyes)})]));
    for (const f of shown(brows)) {
      const name = this.linked && brows.length > 1 ? interfaceText('spatialControls.face2d.brows') : f.name, v = values[f.id];
      parts.push(h('div', {class: 'face-panel-group'}, [h('span', {class: 'face-panel-label', text: name}),
        this.slider(interfaceText('spatialControls.face2d.raise'), v.r, -1, 1, r => this.set({[f.id]: {r}}, 'Raise brows')),
        this.slider(interfaceText('spatialControls.face2d.tilt'), v.a, -1, 1, a => this.set({[f.id]: {a}}, 'Tilt brows'))]));
    }
    for (const f of mouths) parts.push(this.states(f, values[f.id], face, f.name));
    for (const f of extras) {
      const states = drawingsOf(face, f).states;
      parts.push(h('div', {class: 'face-panel-group'}, [h('span', {class: 'face-panel-label', text: f.name}),
        this.slider(interfaceText('spatialControls.face2d.shown'), values[f.id].o, 0, 1, o => this.set({[f.id]: {o}}, 'Show extra')),
        states.length > 1 ? this.chips(f, states, values[f.id].s) : null]));
    }
    parts.push(h('div', {class: 'face-panel-row'}, [
      h('label', {class: 'ui-switch-row face-panel-linked'}, [h('input', {type: 'checkbox', class: 'ui-switch', checked: this.linked, onchange: e => { this.linked = e.target.checked; this.render(); }}),
        h('span', {text: interfaceText('spatialControls.face2d.linked')})]),
      h('button', {type: 'button', class: 'ui-button', 'data-size': 'sm', 'data-variant': 'ghost', text: interfaceText('spatialControls.face2d.reset'), onclick: () => { if (this.select() && editor.resetFace()) { this.changed(); this.render(); } }})]));
    this.body.replaceChildren(...parts);
  }
  /** A feature's states as chips (the one showing pressed). */
  chips(f, states, current) {
    return h('div', {class: 'face-panel-chips'}, states.map((st, i) => h('button', {type: 'button', class: 'ui-chip', 'aria-pressed': String(i === current), text: st.name,
      onclick: () => this.set({[f.id]: {s: i}}, `${f.name}: ${st.name}`)})));
  }
  states(f, v, face, name) {
    const states = drawingsOf(face, f).states;
    return h('div', {class: 'face-panel-group'}, [h('span', {class: 'face-panel-label', text: name}), this.chips(f, states, v.s)]);
  }
  slider(label, value, min, max, apply) {
    const input = h('input', {type: 'range', class: 'ui-slider', min: String(min), max: String(max), step: '0.02', value: String(value), 'aria-label': label,
      onpointerdown: () => this.startDrag(label), oninput: e => { if (!this.dragging) this.startDrag(label); apply(Number(e.target.value)); }, onchange: () => this.finishDrag()});
    input.style.setProperty('--_p', `${(value - min) / (max - min) * 100}%`);
    input.addEventListener('input', () => input.style.setProperty('--_p', `${(input.value - min) / (max - min) * 100}%`));
    return h('label', {class: 'ui-slider-row'}, [h('span', {class: 'ui-slider-label', text: label}), input]);
  }
  /** Where the eyes look: drag in the pad; double-click looks straight ahead. */
  lookPad(eyes, values) {
    const v = values[eyes[0].id], dot = h('span', {class: 'face-panel-dot'}), pad = h('div', {class: 'face-panel-pad', role: 'slider', tabindex: '0', 'aria-label': interfaceText('spatialControls.face2d.look'), title: interfaceText('spatialControls.face2d.lookHint')}, [dot]);
    const place = (x, y) => { dot.style.left = `${(x + 1) * 50}%`; dot.style.top = `${(1 - y) * 50}%`; };
    place(v.x, v.y);
    const look = (x, y) => { const patch = {}; for (const f of eyes) patch[f.id] = {x, y}; this.set(patch, 'Look'); place(x, y); };
    const at = e => { const r = pad.getBoundingClientRect(); return [Math.max(-1, Math.min(1, (e.clientX - r.left) / r.width * 2 - 1)), Math.max(-1, Math.min(1, 1 - (e.clientY - r.top) / r.height * 2))]; };
    pad.addEventListener('pointerdown', e => { if (e.button !== 0) return; pad.setPointerCapture(e.pointerId); this.startDrag('Look'); look(...at(e)); });
    pad.addEventListener('pointermove', e => { if (this.dragging && pad.hasPointerCapture(e.pointerId)) look(...at(e)); });
    pad.addEventListener('pointerup', () => this.finishDrag());
    pad.addEventListener('lostpointercapture', () => this.finishDrag());
    pad.addEventListener('dblclick', () => look(0, 0));
    pad.addEventListener('keydown', e => {
      const step = {ArrowLeft: [-.1, 0], ArrowRight: [.1, 0], ArrowUp: [0, .1], ArrowDown: [0, -.1]}[e.key]; if (!step) return;
      e.preventDefault(); const c = this.editor.faceValues()?.[eyes[0].id] ?? v; look(Math.max(-1, Math.min(1, c.x + step[0])), Math.max(-1, Math.min(1, c.y + step[1])));
    });
    return h('div', {class: 'face-panel-group'}, [h('span', {class: 'face-panel-label', text: interfaceText('spatialControls.face2d.look')}), pad]);
  }
  /** Blink: the eyes closed at the playhead and back as they were two frames on. */
  blink(eyes) {
    if (!this.select()) return;
    // The state named Closed, else the first with no eye white (nothing for the pupil to show in).
    const face = this.editor.face, closed = f => { const states = drawingsOf(face, f).states, named = states.findIndex(st => /closed/i.test(st.name)); return named >= 0 ? named : states.findIndex(st => !st.under); };
    const list = eyes.map(f => [f.id, closed(f)]).filter(([, s]) => s >= 0);
    if (this.editor.blinkFace(list)) this.changed();
    this.render();
  }
}
