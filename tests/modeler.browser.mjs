/**
 * Browser test of the 3D Nowdz workspace (src/modeler/modeler-ui.mjs): the
 * Start > Examples models, numbers typed during a move, rotate or scale (as in
 * Blender: G Z 0.5, R 90, S 1.5), and Inset and Bevel staying adjustable in the
 * Adjust Last Operation panel.
 * Serve the repository (node scripts/serve.mjs --port 47832) and run
 * `node tests/modeler.browser.mjs`; STYK_URL overrides the address.
 */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';

const base = process.env.STYK_URL || 'http://127.0.0.1:47832';
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1500, height: 900}});
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(15000);
const step = async (name, run) => {
  try { await run(); console.log(`ok ${name}`); } catch (error) { console.log(`not ok ${name}`); throw error; }
};

try {
  await page.goto(base);
  await page.waitForFunction(() => window.styk?.ready, null, {timeout: 60000});
  // Leave Home for the editor, then open the Model workspace (its controls card closed, no old draft).
  await page.evaluate(() => { [...document.querySelectorAll('#home button')].find(x => /Back to/.test(x.textContent))?.click(); });
  await page.evaluate(() => { localStorage.setItem('stykNowdz.modeler.hideControls', '1'); localStorage.removeItem('stykNowdz.modelDraft'); document.querySelector('[data-action="model-workspace"]').click(); });
  await page.waitForFunction(() => document.querySelector('.modeler')?.modeler);
  // Shared page helpers: keys go to the window, as the workspace listens there.
  await page.evaluate(async () => {
    window.wait = ms => new Promise(r => setTimeout(r, ms));
    window.press = (key, init = {}) => window.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, ...init}));
    window.keys = text => { for (const k of text) press(k); };
    window.T = await import('/src/modeler/topology.mjs');
    window.m = document.querySelector('.modeler').modeler;
    window.button = text => [...document.querySelectorAll('.modeler button')].find(x => x.textContent.trim() === text);
    window.allValid = () => m.model.parts.every(p => T.validateMesh(p.mesh, {print: false}).ok);
  });

  await step('Start > Examples open a whole model, ask before replacing one, and undo', async () => {
    const result = await page.evaluate(async () => {
      button('Juniper').click(); await wait(500);
      const juniper = [m.model.name, m.model.parts.length > 10, m.model.bones.length > 19, allValid(), Boolean(m.model.toon?.shadows)];
      m.setMode('object'); m.state.parts = new Set(); m.refresh(); await wait(50);
      button('Kettle').click(); await wait(100);
      const ask = button('Replace'); ask?.click(); await wait(500);
      const kettle = [m.model.name, m.model.parts.length > 10, m.model.bones.length === 19, allValid()];
      press('z', {ctrlKey: true}); await wait(150);
      return {juniper, asked: Boolean(ask), kettle, undone: m.model.name};
    });
    assert.deepEqual(result, {juniper: ['Juniper', true, true, true, true], asked: true, kettle: ['Kettle', true, true, true], undone: 'Juniper'});
  });

  await step('typed values: G Z 0.5, G X 1 then minus, R Z 90, S 2 Backspace 3', async () => {
    const result = await page.evaluate(async () => {
      m.setMode('object'); m.addPrimitive('cube'); await wait(50);
      const p = m.model.parts.at(-1), start = p.position.slice();
      press('g'); press('z'); keys('0.5'); press('Enter');
      press('g'); press('x'); keys('1'); press('-'); press('Enter');
      press('r'); press('z'); keys('90'); press('Enter');
      press('s'); keys('2'); press('Backspace'); keys('3'); press('Enter'); await wait(50);
      return {moved: p.position.map((v, k) => +(v - start[k]).toFixed(6)), rotation: p.rotation.map(v => +v.toFixed(6)), scale: p.scale};
    });
    assert.deepEqual(result, {moved: [-1, 0, .5], rotation: [0, 0, +(Math.PI / 2).toFixed(6)], scale: [3, 3, 3]});
  });

  await step('Inset and Bevel can be changed afterwards in the panel', async () => {
    const result = await page.evaluate(async () => {
      press('Tab'); await wait(50);
      const part = () => m.model.parts.find(q => q.id === m.state.active), field = () => [...document.querySelectorAll('.modeler-last-op input')];
      m.state.verts = new Set(part().mesh.verts.map((v, i) => v[2] > .499 ? i : -1).filter(i => i >= 0)); m.refresh();
      press('i'); press('Enter'); await wait(50);
      const width = () => Math.max(...[...m.state.verts].map(i => Math.abs(part().mesh.verts[i][0])));
      const inset = m.state.lastOp?.kind, wide = width();
      field()[0].value = '0.5'; field()[0].dispatchEvent(new Event('change')); await wait(50);
      const narrow = width();
      press('a'); press('b', {ctrlKey: true}); press('Enter'); await wait(50);
      const bevel = m.state.lastOp?.kind, faces = part().mesh.faces.length;
      field()[1].value = '3'; field()[1].dispatchEvent(new Event('change')); await wait(50);
      return {inset, thinner: narrow < wide - .05, bevel, more: part().mesh.faces.length > faces, valid: allValid()};
    });
    assert.deepEqual(result, {inset: 'inset', thinner: true, bevel: 'bevel', more: true, valid: true});
  });
  await step('Bones: Strength and Reach slide; painting takes a bone off the chest in one undo step', async () => {
    const setup = await page.evaluate(async () => {
      m.setMode('object'); m.state.parts = new Set(); m.refresh();
      button('Juniper').click(); await wait(200); button('Replace')?.click(); await wait(500);
      m.setMode('bones'); m.setView('front'); m.state.camera.target = [0, 1.2, 0]; m.state.camera.dist = 1.6;
      const shoulder = m.model.bones.find(b => b.name === 'Shoulder.L'); m.state.bones = new Set([shoulder.id]); m.refresh(); await wait(200);
      const sliders = [...document.querySelectorAll('.modeler-live input[type=range]')].length;
      const box = document.querySelector('.modeler canvas').getBoundingClientRect(), {cameraFrame} = await import('/src/modeler/viewport.mjs');
      const f = cameraFrame(m.state.camera, box.width, box.height), at = p => { const q = f.project(p); return [box.left + q.x, box.top + q.y]; };
      button('Paint weights').click(); await wait(50); button('Remove').click(); await wait(50);
      return {sliders, from: at([.05, 1.24, .13]), to: at([.15, 1.24, .13]), undo: m.state.undo.length};
    });
    await page.mouse.move(...setup.from); await page.mouse.down(); await page.mouse.move(...setup.to); await page.mouse.up();
    const result = await page.evaluate(async () => {
      await wait(100);
      const painted = () => m.model.parts.reduce((n, p) => n + Object.keys(p.mesh.vdata?.skin ?? {}).length, 0), torso = m.model.parts.find(p => p.name === 'Torso');
      const after = {painted: painted() > 0, onTorso: Object.keys(torso.mesh.vdata?.skin ?? {}).length > 0, steps: m.state.undo.length};
      press('z', {ctrlKey: true}); await wait(100);
      return {...after, undone: painted() === 0};
    });
    assert.deepEqual({...result, steps: result.steps - setup.undo}, {painted: true, onTorso: true, steps: 1, undone: true});
    assert.equal(setup.sliders, 2);
  });
  await step('Pose: dragging a bone bends the model, changes nothing, and Stop posing puts it back', async () => {
    const setup = await page.evaluate(async () => {
      if (m.state.brush?.on) { m.state.brush.on = false; m.refresh(); }
      m.state.camera.target = [0, 1, 0]; m.state.camera.dist = 2.6; m.refresh();
      const fore = m.model.bones.find(b => b.name === 'LowerArm.L'); window.restBones = JSON.stringify(m.model.bones);
      button('Pose').click(); await wait(100);
      const box = document.querySelector('.modeler canvas').getBoundingClientRect(), {cameraFrame} = await import('/src/modeler/viewport.mjs');
      const f = cameraFrame(m.state.camera, box.width, box.height), at = p => { const q = f.project(p); return [box.left + q.x, box.top + q.y]; };
      const head = at(fore.head), mid = at(fore.head.map((v, k) => (v + fore.tail[k]) / 2)), r = Math.hypot(mid[0] - head[0], mid[1] - head[1]);
      return {from: mid, to: [head[0] + r, head[1] - r * .2], undo: m.state.undo.length};
    });
    await page.mouse.move(...setup.from); await page.mouse.down(); await page.mouse.move(...setup.to, {steps: 8}); await page.mouse.up();
    const result = await page.evaluate(async () => {
      await wait(100);
      const {poseFrames, posedBy} = await import('/src/modeler/pose.mjs');
      const fore = m.model.bones.find(b => b.name === 'LowerArm.L'), end = posedBy(poseFrames(m.model, m.state.pose), fore.id, fore.tail);
      const swung = Math.hypot(end[0] - fore.tail[0], end[1] - fore.tail[1]) > .1;
      press('g'); await wait(50); const blocked = !m.state.modal;
      const unchanged = JSON.stringify(m.model.bones) === restBones, steps = m.state.undo.length;
      button('Stop posing').click(); await wait(100);
      return {swung, blocked, unchanged, steps, back: !m.state.posing && m.state.pose.size === 0};
    });
    assert.deepEqual({...result, steps: result.steps - setup.undo}, {swung: true, blocked: true, unchanged: true, steps: 0, back: true});
  });
  await step('Layers: new bones are loose, right-click groups and merges, a merged bone stays put, the origin drags', async () => {
    const result = await page.evaluate(async () => {
      if (m.state.posing) button('Stop posing')?.click();
      m.setMode('object'); m.state.parts = new Set(); m.refresh();
      button('Base character').click(); await wait(300);
      const layer = (kind, id) => document.querySelector(`.modeler-layer-${kind}[data-${kind}="${id}"]`);
      const menuItem = text => [...document.querySelectorAll('.modeler-popover button')].find(x => x.textContent.trim() === text);
      const rightClick = row => row.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, clientX: 120, clientY: 300}));
      // A folder from the + menu takes the selected parts (Ctrl+G does the same).
      m.state.parts = new Set(m.model.parts.slice(0, 2).map(q => q.id)); m.refresh();
      press('g', {ctrlKey: true}); await wait(100);
      const folder = m.model.folders?.[0], inFolder = m.model.parts.filter(q => q.folder === folder?.id).length;
      // Humanoid skeleton from the Skeleton layer's menu: every new bone is loose.
      rightClick(document.querySelector('.modeler-layer-skeleton')); await wait(50); menuItem('Humanoid skeleton').click(); await wait(500);
      button('Replace')?.click(); await wait(500);
      const loose = m.model.bones.every(b => b.state === 'loose');
      const shoulder = m.model.bones.find(b => b.name === 'Shoulder.L');
      rightClick(layer('bone', shoulder.id)); await wait(50); menuItem('Group to model').click(); await wait(200);
      const grouped = !('state' in shoulder);
      rightClick(layer('bone', shoulder.id)); await wait(50); menuItem('Merge to model').click(); await wait(200);
      const merged = shoulder.state === 'merged', head = shoulder.head.slice();
      m.state.bones = new Set([shoulder.id]); m.refresh(); press('g'); await wait(50);
      const locked = !m.state.modal && JSON.stringify(head) === JSON.stringify(shoulder.head);
      return {inFolder, loose, grouped, merged, locked, steps: m.state.undo.length};
    });
    assert.deepEqual({...result, steps: undefined}, {inFolder: 2, loose: true, grouped: true, merged: true, locked: true, steps: undefined});
    // Drag the orange origin dot in Front view.
    const dot = await page.evaluate(async () => {
      m.setView('front'); m.state.bones = new Set(); m.refresh(); await wait(100);
      const box = document.querySelector('.modeler canvas').getBoundingClientRect(), {cameraFrame} = await import('/src/modeler/viewport.mjs');
      const f = cameraFrame(m.state.camera, box.width, box.height), q = f.project([0, 0, 0]);
      return [box.left + q.x, box.top + q.y];
    });
    await page.mouse.move(...dot); await page.mouse.down(); await page.mouse.move(dot[0], dot[1] - 60, {steps: 6}); await page.mouse.up();
    const origin = await page.evaluate(async () => { await wait(100); const o = m.model.origin; press('z', {ctrlKey: true}); await wait(100); return {moved: o?.[1] > .1, undone: !m.model.origin}; });
    assert.deepEqual(origin, {moved: true, undone: true});
  });
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
