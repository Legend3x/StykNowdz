/**
 * Browser test of the 3D Nowdz workspace (src/modeler/modeler-ui.mjs): the
 * Start > Examples models, numbers typed during a move, rotate or scale (as in
 * Blender: G Z 0.5, R 90, S 1.5), and building with 3D lines in Build mode (its tool rail,
 * bending by right-drag, sliders, Split and poly fill).
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

  await step('Build mode: the tool rail, lines from joints, a circle, mirror, a plane piece attached, bones ready', async () => {
    const sp = w => page.evaluate(w => m.screenPoint(w), w);
    const drag = async (w0, w1, button = 'left') => { const a = await sp(w0), b = await sp(w1); await page.mouse.move(a.x, a.y); await page.mouse.down({button}); await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2); await page.mouse.move(b.x, b.y); await page.mouse.up({button}); };
    await page.evaluate(async () => { m.setMode('object'); button('Start over')?.click(); await wait(50); button('Replace')?.click(); m.model.parts = []; m.model.bones = []; delete m.model.sticks; m.setMode('build'); m.setView('front'); Object.assign(m.state.camera, {target: [0, 1, 0], dist: 3}); m.refresh(); await wait(50); });
    const rail = await page.evaluate(() => ({shown: !document.querySelector('.modeler-rail').hidden, tools: [...document.querySelectorAll('.modeler-rail [data-tool]')].map(b => b.dataset.tool).join(), actions: [...document.querySelectorAll('.modeler-rail [data-action]')].map(b => b.dataset.action).join()}));
    assert.deepEqual(rail, {shown: true, tools: 'select,line,circle,polygon,hand', actions: 'split,duplicate,flipH,flipV,delete'});
    await drag([0, 1, 0], [0, 1.4, 0]); // a new piece: the body
    await drag([0, 1.4, 0], [.25, 1.1, 0]); // an arm from the chest
    await page.click('.modeler-rail [data-tool="circle"]'); await drag([0, 1.4, 0], [0, 1.8, 0]); // the head
    await page.evaluate(() => { const s = m.model.sticks; m.state.stick.line = s.lines[1].id; m.refresh(); press('m'); press('l'); });
    await drag([1, 1.8, 0], [1, 1.4, 0]); // a piece on the side, made a plane for hair
    await page.evaluate(async () => { const select = [...document.querySelectorAll('.modeler-side select')].find(x => [...x.options].some(o => o.value === 'plane')); select.value = 'plane'; select.dispatchEvent(new Event('change')); await wait(20); });
    const attach = await page.evaluate(async () => {
      const row = [...document.querySelectorAll('.modeler-piece-row')].at(-1); [...row.querySelectorAll('button')].find(x => x.textContent === 'Attach').click(); await wait(20);
      return m.screenPoint([0, 1.8, 0]);
    });
    await page.mouse.click(attach.x, attach.y);
    const result = await page.evaluate(() => {
      const s = m.model.sticks, bones = m.model.bones;
      const hair = s.pieces[1], head = s.lines.find(l => l.shape.kind === 'circleFill');
      return {lines: s.lines.length, pieces: s.pieces.length, kinds: s.lines.map(l => l.shape.kind).join(), mirrored: s.joints.some(j => Math.abs(j.at[0] + .25) < 1e-3 && Math.abs(j.at[1] - 1.1) < 1e-3),
        attached: hair.attach === head.to, hairBoneParent: bones.find(b => b.stick === s.lines.at(-1).id)?.parent === bones.find(b => b.stick === head.id)?.id,
        parts: m.model.parts.length, valid: allValid()};
    });
    assert.deepEqual(result, {lines: 5, pieces: 2, kinds: 'line,line,circleFill,line,plane', mirrored: true, attached: true, hairBoneParent: true, parts: 5, valid: true});
  });

  await step('Build mode: right-drag bends a line, sliders change it in one undo step, Split, poly fill', async () => {
    const sp = w => page.evaluate(w => m.screenPoint(w), w);
    // Right-drag the arm's middle off to the side: it bows through the pointer.
    const a = await sp([.125, 1.25, 0]), b = await sp([.2, 1.35, 0]);
    await page.mouse.move(a.x, a.y); await page.mouse.down({button: 'right'}); await page.mouse.move(b.x, b.y, {steps: 3}); await page.mouse.up({button: 'right'});
    const bent = await page.evaluate(() => { const arm = m.model.sticks.lines[1]; return {picked: m.state.stick.line === arm.id, curve: +arm.shape.curve.toFixed(2), valid: allValid()}; });
    assert.equal(bent.picked, true); assert.ok(bent.curve > .05, `curve ${bent.curve}`); assert.equal(bent.valid, true);
    const slid = await page.evaluate(async () => {
      const undo = m.state.undo.length, row = [...document.querySelectorAll('.modeler-slider')].find(x => x.textContent.startsWith('Width'));
      const input = row.querySelector('input');
      for (const v of ['1.5', '2']) { input.value = v; input.dispatchEvent(new Event('input')); }
      input.dispatchEvent(new Event('change')); await wait(20);
      const arm = m.model.sticks.lines[1];
      return {width: arm.shape.width, steps: m.state.undo.length - undo, shown: row.querySelector('output').textContent};
    });
    assert.deepEqual(slid, {width: 2, steps: 1, shown: '2×'});
    const split = await page.evaluate(async () => { document.querySelector('.modeler-rail [data-action="split"]').click(); await wait(20); return {lines: m.model.sticks.lines.length, valid: allValid()}; });
    assert.deepEqual(split, {lines: 6, valid: true});
    // Poly fill, as Pivot's: chest, arm's hand, hips, then the chest again.
    await page.click('.modeler-rail [data-tool="polygon"]');
    for (const w of [[0, 1.4, 0], [.25, 1.1, 0], [0, 1, 0], [0, 1.4, 0]]) { const q = await sp(w); await page.mouse.click(q.x, q.y); }
    const fill = await page.evaluate(() => { const s = m.model.sticks, f = s.fills[0]; return {fills: s.fills.length, joints: f?.joints.length, part: m.model.parts.some(p => p.stick === f?.id), picked: m.state.stick.fill === f?.id, valid: allValid()}; });
    assert.deepEqual(fill, {fills: 1, joints: 3, part: true, picked: true, valid: true});
    const gone = await page.evaluate(async () => { press('x'); await wait(20); press('z', {ctrlKey: true}); await wait(50); const back = m.model.sticks.fills.length; m.setMode('object'); await wait(20); return {back, railHidden: document.querySelector('.modeler-rail').hidden}; });
    assert.deepEqual(gone, {back: 1, railHidden: true});
  });
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
