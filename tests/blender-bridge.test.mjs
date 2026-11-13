import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, mkdir, writeFile, readFile, rm, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import bridgeModule from '../desktop/blender-bridge.cjs';

const {BlenderBridge, blenderCandidates} = bridgeModule;
const memoryStore = () => { let value = {}; return {get: async () => value, set: async v => { value = v; return {saved: true}; }}; };

test('Blender is found in its usual Windows folders, newest version first', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'styk-blender-find-'));
  try {
    const programs = path.join(root, 'Program Files');
    for (const v of ['Blender 3.6', 'Blender 4.2', 'Blender 4.10']) { await mkdir(path.join(programs, 'Blender Foundation', v), {recursive: true}); await writeFile(path.join(programs, 'Blender Foundation', v, 'blender.exe'), ''); }
    const env = {ProgramFiles: programs, PATH: ''};
    const list = blenderCandidates({platform: 'win32', env});
    assert.match(list[0], /Blender 4\.10/);
    const bridge = new BlenderBridge({store: memoryStore(), tempRoot: root, notify() {}, platform: 'win32', env});
    assert.match((await bridge.find()).path, /Blender 4\.10/);
    // A Blender chosen by hand wins while it exists.
    const own = path.join(root, 'portable', 'blender.exe'); await mkdir(path.dirname(own)); await writeFile(own, '');
    await bridge.choose(own);
    assert.deepEqual(await bridge.find(), {path: own, chosen: true});
    await assert.rejects(bridge.choose(path.join(root, 'Program Files')), /isn't Blender/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('a Blender session hands over the model and announces each save', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'styk-blender-session-'));
  const events = [];
  let child, args;
  const spawnProcess = (file, list) => { args = [file, ...list]; child = new EventEmitter(); queueMicrotask(() => child.emit('spawn')); return child; };
  const bridge = new BlenderBridge({store: memoryStore(), tempRoot: root, notify: e => events.push(e), spawnProcess});
  try {
    const {token} = await bridge.open('/opt/blender/blender', '{"format":"styk-blender-link"}', {name: 'Hero'});
    const folder = args[args.indexOf('--styk-session') + 1];
    assert.equal(args[0], '/opt/blender/blender');
    assert.equal(await readFile(path.join(folder, 'outgoing.json'), 'utf8'), '{"format":"styk-blender-link"}');
    assert.match(await readFile(path.join(folder, 'styk_link.py'), 'utf8'), /def collect\(\)/, 'the script is copied next to the model');
    // Blender saves twice.
    for (const seq of [1, 2]) {
      await writeFile(path.join(folder, 'incoming.json'), JSON.stringify({seq}));
      await writeFile(path.join(folder, 'incoming.seq'), String(seq));
      const end = Date.now() + 4000; while (!events.some(e => e.seq === seq)) { if (Date.now() > end) throw new Error(`save ${seq} was not announced`); await delay(20); }
      assert.equal(JSON.parse(await bridge.read(token)).seq, seq);
    }
    assert.equal(events.filter(e => e.seq).length, 2, 'each save is announced once');
    // A launcher that exits at once doesn't end the link; Blender quitting later does.
    child.emit('exit', 0);
    await delay(50);
    assert.ok(!events.some(e => e.closed));
  } finally { bridge.dispose(); await rm(root, {recursive: true, force: true}); }
});

test('old session folders are swept, recent ones stay', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'styk-blender-sweep-'));
  try {
    const old = path.join(root, `styknowdz-blender-${'a'.repeat(24)}`), fresh = path.join(root, `styknowdz-blender-${'b'.repeat(24)}`);
    await mkdir(old); await mkdir(fresh);
    const bridge = new BlenderBridge({store: memoryStore(), tempRoot: root, notify() {}});
    await bridge.sweep(Date.now() + 3 * 86400_000 - 1000 * 60);
    await assert.rejects(stat(old)); await assert.rejects(stat(fresh));
    await mkdir(fresh); await bridge.sweep();
    await stat(fresh);
  } finally { await rm(root, {recursive: true, force: true}); }
});
