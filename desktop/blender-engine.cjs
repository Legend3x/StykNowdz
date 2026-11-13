'use strict';
// Blender's engine for 3D Nowdz's Blender tools (docs/BLENDER-LITE.md). Runs
// desktop/blender/styk_engine.py with no window: on the Python and Blender
// module (bpy) shipped with the Windows app, or else in the person's own Blender
// (blender -b). One process is kept running and answers one request at a time;
// requests and results travel as files in a private temp folder, and each
// answer is announced by one "@@styk-engine {...}" line on stdout. Nothing
// leaves this computer.
const { messageError } = require('./localization.cjs');
const fs = require('node:fs/promises');
const { statSync } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');

const MARK = '@@styk-engine ';
const SCRIPTS = ['styk_engine.py', 'styk_link.py'];
const MAX_REQUEST_BYTES = 512 * 1024 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024 * 1024;
const isFile = file => { try { return statSync(file).isFile(); } catch { return false; } };

/** The bundled engine's Python, if this build has one. */
function bundledPython(root, platform = process.platform) {
  if (!root) return null;
  const file = path.join(root, platform === 'win32' ? 'python.exe' : path.join('bin', 'python3'));
  return isFile(file) ? file : null;
}

class BlenderEngine {
  /** @param {{bundledRoot?: string, tempRoot: string, findBlender(): Promise<{path: string}|null>, scriptsRoot?: string, startTimeout?: number, runTimeout?: number}} options */
  constructor({ bundledRoot, tempRoot, findBlender, scriptsRoot = path.join(__dirname, 'blender'), platform = process.platform,
    spawnProcess = spawn, startTimeout = 180_000, runTimeout = 600_000 }) {
    Object.assign(this, { bundledRoot, tempRoot, findBlender, scriptsRoot, platform, spawnProcess, startTimeout, runTimeout });
    this.process = null; this.starting = null; this.queue = Promise.resolve(); this.waiting = new Map(); this.folder = null; this.counter = 0;
  }

  /** Which engine 3D Nowdz would use: the bundled one, else an installed Blender. */
  async status() {
    if (bundledPython(this.bundledRoot, this.platform)) return { available: true, runtime: 'bundled' };
    const found = await this.findBlender().catch(() => null);
    return found ? { available: true, runtime: 'installed', blender: path.basename(path.dirname(found.path)) } : { available: false, runtime: null };
  }

  /** The command that starts the engine. */
  async command(script) {
    const python = bundledPython(this.bundledRoot, this.platform);
    if (python) return { file: python, args: ['-I', script] };
    const found = await this.findBlender().catch(() => null);
    if (found) return { file: found.path, args: ['-b', '--factory-startup', '--python', script, '--', '--styk-engine'] };
    throw messageError(new Error(''), 'desktop.blenderEngine.errors.noEngine', {});
  }

  async start() {
    if (this.process) return this.process;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.folder = path.join(this.tempRoot, `styknowdz-engine-${randomBytes(12).toString('hex')}`);
      await fs.mkdir(this.folder, { recursive: true });
      // Python can't read inside the app archive: the scripts are copied out.
      for (const name of SCRIPTS) await fs.writeFile(path.join(this.folder, name), await fs.readFile(path.join(this.scriptsRoot, name), 'utf8'), 'utf8');
      const { file, args } = await this.command(path.join(this.folder, 'styk_engine.py'));
      const child = this.spawnProcess(file, args, {
        cwd: this.folder, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      });
      const engine = { child, ready: null, log: '' };
      let buffer = '';
      const keep = text => { engine.log = (engine.log + text).slice(-4000); };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buffer += chunk;
        for (let at; (at = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, at).replace(/\r$/, ''); buffer = buffer.slice(at + 1);
          if (!line.startsWith(MARK)) { keep(line + '\n'); continue; }
          let message; try { message = JSON.parse(line.slice(MARK.length)); } catch { continue; }
          if (message.ready) { engine.blender = message.blender; engine.ready?.(message); continue; }
          const wait = this.waiting.get(message.id);
          if (wait) { this.waiting.delete(message.id); wait(message); }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', keep);
      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(messageError(new Error(''), 'desktop.blenderEngine.errors.didNotStart', { reason: 'timed out' })), this.startTimeout);
        child.once('error', error => { clearTimeout(timer); reject(messageError(new Error('', { cause: error }), 'desktop.blenderEngine.errors.didNotStart', { reason: error.message })); });
        child.once('exit', code => { clearTimeout(timer); reject(messageError(new Error(''), 'desktop.blenderEngine.errors.didNotStart', { reason: lastLine(engine.log) || `exit code ${code}` })); });
        engine.ready = message => { clearTimeout(timer); resolve(message); };
      });
      child.once('exit', () => {
        if (this.process === engine) this.process = null;
        // Anything still waiting fails: the next request starts a new engine.
        for (const [id, wait] of this.waiting) { this.waiting.delete(id); wait({ id, ok: false, error: lastLine(engine.log) || 'Blender stopped' }); }
      });
      try { await ready; } catch (error) { child.kill(); throw error; }
      this.process = engine;
      return engine;
    })();
    try { return await this.starting; } finally { this.starting = null; }
  }

  /** Run one tool: `text` is the request JSON ({op, params, doc}); resolves with the result JSON text. */
  run(text) {
    if (typeof text !== 'string' || !text.length || Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BYTES)
      throw messageError(new Error(''), 'desktop.blenderEngine.errors.requestTooLarge', {});
    const job = this.queue.then(() => this.runNow(text));
    this.queue = job.catch(() => {});
    return job;
  }

  async runNow(text) {
    const engine = await this.start();
    const id = `r${++this.counter}`, request = path.join(this.folder, `${id}-request.json`), result = path.join(this.folder, `${id}-result.json`);
    await fs.writeFile(request, text, 'utf8');
    try {
      const answer = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiting.delete(id);
          // A tool that runs this long is stuck (or far too big): stop it; the next request starts afresh.
          engine.child.kill();
          reject(messageError(new Error(''), 'desktop.blenderEngine.errors.tookTooLong', {}));
        }, this.runTimeout);
        this.waiting.set(id, message => { clearTimeout(timer); resolve(message); });
        engine.child.stdin.write(JSON.stringify({ id, request, result }) + '\n');
      });
      if (!answer.ok) throw messageError(new Error(''), 'desktop.blenderEngine.errors.toolFailed', { reason: String(answer.error || 'unknown error').slice(0, 300) });
      const size = (await fs.stat(result)).size;
      if (size > MAX_RESULT_BYTES) throw messageError(new Error(''), 'desktop.blenderEngine.errors.resultTooLarge', {});
      return { text: await fs.readFile(result, 'utf8'), seconds: answer.seconds, blender: engine.blender };
    } finally {
      await Promise.all([request, result].map(file => fs.rm(file, { force: true }).catch(() => {})));
    }
  }

  dispose() {
    const engine = this.process; this.process = null;
    if (engine) { try { engine.child.stdin.write(JSON.stringify({ quit: true }) + '\n'); } catch { /* already gone */ } setTimeout(() => engine.child.kill(), 2000).unref?.(); }
    if (this.folder) fs.rm(this.folder, { recursive: true, force: true }).catch(() => {});
  }
}

const lastLine = text => String(text).trim().split('\n').filter(l => /error|Error|Traceback|failed/i.test(l)).at(-1)?.trim().slice(0, 300) || '';

module.exports = { BlenderEngine, bundledPython, MARK };
