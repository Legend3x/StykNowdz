import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import engineModule from '../desktop/blender-engine.cjs';

const {BlenderEngine, bundledPython, MARK} = engineModule;

/** A stand-in for Python + bpy: answers each request line by writing a result file. */
function fakeEngine({answer = request => ({ok: true, reply: {echo: request.op}}), noise = true} = {}) {
  const started = [];
  const spawnProcess = (file, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { if (!child.killed) { child.killed = true; setImmediate(() => child.emit('exit', null)); } };
    child.stdin = new Writable({write(chunk, _enc, done) {
      (async () => {
        const message = JSON.parse(String(chunk));
        if (message.quit) return;
        const request = JSON.parse(await readFile(message.request, 'utf8'));
        const out = answer(request);
        if (out.ok) await writeFile(message.result, JSON.stringify(out.reply));
        if (noise) child.stdout.write('Blender says something unrelated\n');
        child.stdout.write(MARK + JSON.stringify({id: message.id, ok: out.ok, error: out.error, seconds: .01}) + '\n');
      })();
      done();
    }});
    started.push({file, args, child});
    setImmediate(() => child.stdout.write(MARK + JSON.stringify({ready: true, blender: '5.3.0'}) + '\n'));
    return child;
  };
  return {spawnProcess, started};
}

async function withTemp(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'styk-engine-'));
  try { await run(root); } finally { await rm(root, {recursive: true, force: true}); }
}

test('the bundled engine is used when this build has one, else an installed Blender', () => withTemp(async root => {
  const bundled = path.join(root, 'blender-engine');
  const none = new BlenderEngine({bundledRoot: bundled, tempRoot: root, findBlender: async () => null, platform: 'win32'});
  assert.deepEqual(await none.status(), {available: false, runtime: null});
  await assert.rejects(none.command('x.py'), /aren't part of this copy/);
  const installed = new BlenderEngine({bundledRoot: bundled, tempRoot: root, findBlender: async () => ({path: path.join(root, 'Blender 5.3', 'blender.exe')}), platform: 'win32'});
  assert.equal((await installed.status()).runtime, 'installed');
  assert.deepEqual((await installed.command('x.py')).args, ['-b', '--factory-startup', '--python', 'x.py', '--', '--styk-engine']);
  await mkdir(bundled); await writeFile(path.join(bundled, 'python.exe'), '');
  assert.equal(bundledPython(bundled, 'win32'), path.join(bundled, 'python.exe'));
  assert.deepEqual(await installed.status(), {available: true, runtime: 'bundled'});
  assert.deepEqual(await installed.command('x.py'), {file: path.join(bundled, 'python.exe'), args: ['-I', 'x.py']});
}));

test('one engine answers requests in turn, ignoring what else Blender prints, and cleans up', () => withTemp(async root => {
  const bundled = path.join(root, 'blender-engine'); await mkdir(bundled); await writeFile(path.join(bundled, 'python.exe'), '');
  const fake = fakeEngine();
  const engine = new BlenderEngine({bundledRoot: bundled, tempRoot: root, findBlender: async () => null, platform: 'win32', spawnProcess: fake.spawnProcess});
  const results = await Promise.all(['remesh', 'decimate', 'text'].map(op => engine.run(JSON.stringify({op}))));
  assert.deepEqual(results.map(r => JSON.parse(r.text).echo), ['remesh', 'decimate', 'text']);
  assert.equal(results[0].blender, '5.3.0');
  assert.equal(fake.started.length, 1, 'the engine starts once and stays');
  // The scripts were copied out of the app archive next to the request files, which are gone.
  const left = await readdir(engine.folder);
  assert.deepEqual(left.sort(), ['styk_engine.py', 'styk_link.py']);
  engine.dispose();
}));

test('a tool that fails says why; an engine that stops is started again for the next tool', () => withTemp(async root => {
  const bundled = path.join(root, 'blender-engine'); await mkdir(bundled); await writeFile(path.join(bundled, 'python.exe'), '');
  const fake = fakeEngine({answer: request => request.op === 'boolean' ? {ok: false, error: 'the part to work on is missing'} : {ok: true, reply: {echo: request.op}}});
  const engine = new BlenderEngine({bundledRoot: bundled, tempRoot: root, findBlender: async () => null, platform: 'win32', spawnProcess: fake.spawnProcess});
  await assert.rejects(engine.run(JSON.stringify({op: 'boolean'})), /couldn't do that: the part to work on is missing/);
  assert.equal(JSON.parse((await engine.run(JSON.stringify({op: 'remesh'}))).text).echo, 'remesh');
  fake.started[0].child.kill();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(JSON.parse((await engine.run(JSON.stringify({op: 'smooth'}))).text).echo, 'smooth');
  assert.equal(fake.started.length, 2);
  engine.dispose();
}));

test('a stuck tool is stopped after the time limit', () => withTemp(async root => {
  const bundled = path.join(root, 'blender-engine'); await mkdir(bundled); await writeFile(path.join(bundled, 'python.exe'), '');
  const silent = fakeEngine();
  const spawnProcess = (file, args) => { const child = silent.spawnProcess(file, args); child.stdin = new Writable({write(_c, _e, done) { done(); }}); return child; };
  const engine = new BlenderEngine({bundledRoot: bundled, tempRoot: root, findBlender: async () => null, platform: 'win32', spawnProcess, runTimeout: 50});
  await assert.rejects(engine.run(JSON.stringify({op: 'remesh'})), /took too long/);
  assert.ok(silent.started[0].child.killed);
  engine.dispose();
}));
