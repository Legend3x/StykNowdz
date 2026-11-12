/**
 * Browser test of the 3D Nowdz workspace (src/modeler/modeler-ui.mjs): the
 * Start > Examples models, numbers typed during a move, rotate or scale (as in
 * Blender: G Z 0.5, R 90, S 1.5), and building with 3D lines in Build mode.
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

  await step('Build mode: drag lines from joints, a ball, mirror, a piece attached, bones ready', async () => {
    const sp = w => page.evaluate(w => m.screenPoint(w), w);
    const drag = async (w0, w1) => { const a = await sp(w0), b = await sp(w1); await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2); await page.mouse.move(b.x, b.y); await page.mouse.up(); };
    await page.evaluate(async () => { m.setMode('object'); button('Start over')?.click(); await wait(50); button('Replace')?.click(); m.model.parts = []; m.model.bones = []; delete m.model.sticks; m.setMode('build'); m.setView('front'); Object.assign(m.state.camera, {target: [0, 1, 0], dist: 3}); m.refresh(); await wait(50); });
    await drag([0, 1, 0], [0, 1.4, 0]); // a new piece: the body
    await drag([0, 1.4, 0], [.25, 1.1, 0]); // an arm from the chest
    await page.evaluate(() => press('4')); await drag([0, 1.4, 0], [0, 1.8, 0]); // Ball tool: the head
    await page.evaluate(() => { const s = m.model.sticks; m.state.stick.line = s.lines[1].id; m.refresh(); press('m'); });
    await page.evaluate(() => press('5')); await drag([1, 1.8, 0], [1, 1.4, 0]); // a ribbon piece on the side
    const attach = await page.evaluate(async () => {
      const row = [...document.querySelectorAll('.modeler-piece-row')].at(-1); [...row.querySelectorAll('button')].find(x => x.textContent === 'Attach').click(); await wait(20);
      return m.screenPoint([0, 1.8, 0]);
    });
    await page.mouse.click(attach.x, attach.y);
    const result = await page.evaluate(() => {
      const s = m.model.sticks, bones = m.model.bones;
      const hair = s.pieces[1], head = s.lines.find(l => l.shape.kind === 'ball');
      return {lines: s.lines.length, pieces: s.pieces.length, kinds: s.lines.map(l => l.shape.kind).join(), mirrored: s.joints.some(j => Math.abs(j.at[0] + .25) < 1e-3 && Math.abs(j.at[1] - 1.1) < 1e-3),
        attached: hair.attach === head.to, hairBoneParent: bones.find(b => b.stick === s.lines.at(-1).id)?.parent === bones.find(b => b.stick === head.id)?.id,
        parts: m.model.parts.length, valid: allValid()};
    });
    assert.deepEqual(result, {lines: 5, pieces: 2, kinds: 'capsule,capsule,ball,capsule,ribbon', mirrored: true, attached: true, hairBoneParent: true, parts: 5, valid: true});
  });
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
