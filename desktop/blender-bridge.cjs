'use strict';
// "Open in Blender" for 3D Nowdz (docs/BLENDER-LITE.md). Finds the person's own
// Blender, starts it on a session folder holding the model (outgoing.json) and
// the link script, and tells the window each time Blender saves new changes
// (incoming.json, announced by incoming.seq). The renderer reads the changes and
// merges them (src/modeler/blender-link.mjs). Nothing leaves this computer.
const { messageError } = require('./localization.cjs');
const fs = require('node:fs/promises');
const { watch, statSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');

const MAX_MODEL_BYTES = 512 * 1024 * 1024;
const MAX_REPLY_BYTES = 1024 * 1024 * 1024;
const SCRIPT = path.join(__dirname, 'blender', 'styk_link.py');
const versionOf = text => (String(text).match(/(\d+)\.(\d+)(?:\.(\d+))?/) ?? []).slice(1).map(v => Number(v) || 0);
const newer = (a, b) => { for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); return false; };
const isFile = file => { try { return statSync(file).isFile(); } catch { return false; } };

/** Where Blender usually lives: the official installer's folders (newest
 * version first), Steam, the Microsoft Store alias, the Applications folder,
 * Snap, and anything named blender on PATH. */
function blenderCandidates({ platform = process.platform, env = process.env } = {}) {
  const found = [];
  const exe = platform === 'win32' ? 'blender.exe' : 'blender';
  if (platform === 'win32') {
    for (const root of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean)) {
      const foundation = path.join(root, 'Blender Foundation');
      let versions = [];
      try { versions = readdirSync(foundation).filter(name => /^Blender/i.test(name)); } catch { /* not installed here */ }
      versions.sort((a, b) => newer(versionOf(a), versionOf(b)) ? -1 : 1);
      for (const name of versions) found.push(path.join(foundation, name, exe));
    }
    for (const steam of [env['ProgramFiles(x86)'], env.ProgramFiles].filter(Boolean)) found.push(path.join(steam, 'Steam', 'steamapps', 'common', 'Blender', exe));
    if (env.LOCALAPPDATA) found.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', exe));
  } else if (platform === 'darwin') {
    found.push('/Applications/Blender.app/Contents/MacOS/Blender');
    if (env.HOME) found.push(path.join(env.HOME, 'Applications', 'Blender.app', 'Contents', 'MacOS', 'Blender'));
  } else {
    found.push('/snap/bin/blender', '/usr/bin/blender', '/usr/local/bin/blender');
  }
  for (const dir of String(env.PATH ?? '').split(path.delimiter).filter(Boolean)) found.push(path.join(dir, exe));
  return [...new Set(found)];
}

class BlenderBridge {
  /** @param {{store: {get(): Promise<object>, set(value: object): Promise<unknown>}, tempRoot: string, notify(event: object): void}} options */
  constructor({ store, tempRoot, notify, platform = process.platform, env = process.env, spawnProcess = spawn }) {
    this.store = store; this.tempRoot = tempRoot; this.notify = notify;
    this.platform = platform; this.env = env; this.spawnProcess = spawnProcess;
    this.sessions = new Map();
  }

  /** The Blender to use: the one chosen before (if it is still there), else the first found. */
  async find() {
    const chosen = (await this.store.get().catch(() => ({}))).path;
    if (typeof chosen === 'string' && isFile(chosen)) return { path: chosen, chosen: true };
    const first = blenderCandidates({ platform: this.platform, env: this.env }).find(isFile);
    return first ? { path: first, chosen: false } : null;
  }

  /** Remember a Blender the person picked by hand. */
  async choose(file) {
    if (typeof file !== 'string' || !isFile(file) || !/blender(\.exe)?$/i.test(path.basename(file)))
      throw messageError(new Error(''), 'desktop.blender.errors.thatIsNotBlender', {});
    await this.store.set({ path: file });
    return { path: file, chosen: true };
  }

  /** Start Blender on a model (the link document as JSON text). */
  async open(blender, text, { name = 'model' } = {}) {
    if (typeof text !== 'string' || !text.length || Buffer.byteLength(text, 'utf8') > MAX_MODEL_BYTES)
      throw messageError(new Error(''), 'desktop.blender.errors.modelTooLarge', {});
    const token = randomBytes(12).toString('hex');
    const folder = path.join(this.tempRoot, `styknowdz-blender-${token}`);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'outgoing.json'), text, 'utf8');
    // The script is copied out because Blender can't read inside the app archive.
    const script = path.join(folder, 'styk_link.py');
    await fs.writeFile(script, await fs.readFile(SCRIPT, 'utf8'), 'utf8');
    const session = { token, folder, seq: 0, watcher: null, child: null, poll: null, closed: false, name: String(name).slice(0, 120) };
    this.sessions.set(token, session);
    const child = this.spawnProcess(blender, ['--python', script, '--', '--styk-session', folder], { stdio: 'ignore', windowsHide: false, detached: false });
    session.child = child;
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', error => { this.end(token); reject(messageError(new Error('', { cause: error }), 'desktop.blender.errors.couldNotStart', { reason: error.message })); });
    });
    const started = Date.now();
    child.once('exit', code => {
      // Some installs (the Microsoft Store alias) start Blender through a launcher that
      // exits at once: keep watching then; the folder is still Blender's.
      if (code === 0 && Date.now() - started < 10_000) return;
      this.check(token).finally(() => { this.notify({ token, closed: true }); this.end(token, 30_000); });
    });
    // A file watcher where it works, and a light poll in case the folder's events are missed.
    try { session.watcher = watch(folder, (_type, file) => { if (!file || file === 'incoming.seq') this.check(token); }); }
    catch { session.watcher = null; }
    session.poll = setInterval(() => this.check(token), 1500);
    return { token };
  }

  /** Tell the window when Blender has written a newer reply. */
  async check(token) {
    const session = this.sessions.get(token);
    if (!session || session.closed) return;
    let seq = 0;
    try { seq = Number((await fs.readFile(path.join(session.folder, 'incoming.seq'), 'utf8')).trim()) || 0; }
    catch { return; }
    if (seq > session.seq) { session.seq = seq; this.notify({ token, seq }); }
  }

  /** Blender's latest reply as JSON text. */
  async read(token) {
    const session = this.sessions.get(token);
    if (!session) throw messageError(new Error(''), 'desktop.blender.errors.sessionEnded', {});
    const file = path.join(session.folder, 'incoming.json'), stat = await fs.stat(file);
    if (stat.size > MAX_REPLY_BYTES) throw messageError(new Error(''), 'desktop.blender.errors.replyTooLarge', {});
    return fs.readFile(file, 'utf8');
  }

  /** Stop watching (after `delay`, so a last save can still be read) and remove the folder. */
  end(token, delay = 0) {
    const session = this.sessions.get(token);
    if (!session || session.closed) return;
    session.closed = true;
    session.watcher?.close(); clearInterval(session.poll);
    setTimeout(() => {
      this.sessions.delete(token);
      fs.rm(session.folder, { recursive: true, force: true }).catch(() => {});
    }, delay).unref?.();
  }

  /** On quit: Blender keeps running with its file, but the folder is no longer watched. */
  dispose() {
    for (const session of this.sessions.values()) { session.closed = true; session.watcher?.close(); clearInterval(session.poll); }
    this.sessions.clear();
  }

  /** Remove session folders left by earlier runs (older than two days). */
  async sweep(now = Date.now()) {
    let names = [];
    try { names = await fs.readdir(this.tempRoot); } catch { return; }
    await Promise.all(names.filter(name => /^styknowdz-blender-[0-9a-f]{24}$/.test(name)).map(async name => {
      const folder = path.join(this.tempRoot, name);
      try { if (now - (await fs.stat(folder)).mtimeMs > 2 * 86400_000) await fs.rm(folder, { recursive: true, force: true }); } catch { /* in use or gone */ }
    }));
  }
}

module.exports = { BlenderBridge, blenderCandidates, SCRIPT };
