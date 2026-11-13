#!/usr/bin/env node
// Builds build/blender-engine: the Python and Blender module (bpy) that run 3D
// Nowdz's Blender tools with no Blender window (docs/BLENDER-LITE.md, "Blender
// tools"). The Windows installer ships it as resources/blender-engine.
//
//   PYTHON=<python 3.13> node scripts/build-blender-engine.mjs [--bpy 5.3.0]
//
// Windows: Python's own embeddable build of the same 3.13 release as PYTHON,
// with bpy installed beside it (Lib/site-packages, named in its ._pth file so
// nothing outside the folder is ever read). Elsewhere: a venv of PYTHON (for
// development; those builds use the person's own Blender instead).
// bpy only supports one Python release line per Blender version (5.3: 3.13).
import {execFileSync} from 'node:child_process';
import {mkdir, rm, readdir, readFile, writeFile, stat} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build', 'blender-engine');
const bpyVersion = process.argv.includes('--bpy') ? process.argv[process.argv.indexOf('--bpy') + 1] : '5.3.0';
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const run = (file, args, options = {}) => execFileSync(file, args, {stdio: 'inherit', ...options});
const ask = (file, args) => execFileSync(file, args, {encoding: 'utf8'}).trim();

const version = ask(python, ['-c', 'import platform; print(platform.python_version())']);
const [major, minor] = version.split('.');
if (`${major}.${minor}` !== '3.13') throw new Error(`bpy ${bpyVersion} needs Python 3.13; ${python} is ${version}.`);
await rm(out, {recursive: true, force: true});
await mkdir(out, {recursive: true});

if (process.platform === 'win32') {
  const zip = path.join(root, 'build', `python-${version}-embed-amd64.zip`);
  const url = `https://www.python.org/ftp/python/${version}/python-${version}-embed-amd64.zip`;
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(zip));
  // Python unpacks it (Git's tar on Windows reads "D:" as a network host).
  run(python, ['-c', 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, out]);
  await rm(zip, {force: true});
  const site = path.join(out, 'Lib', 'site-packages');
  // bpy for exactly this Python and Windows x64, binary wheels only.
  run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-compile', '--only-binary=:all:', '--target', site,
    '--python-version', `${major}.${minor}`, '--platform', 'win_amd64', '--implementation', 'cp', `bpy==${bpyVersion}`]);
  // The embeddable Python reads only what its ._pth file lists: add site-packages.
  const pth = (await readdir(out)).find(name => /^python\d+\._pth$/.test(name));
  if (!pth) throw new Error('The embeddable Python has no ._pth file.');
  const lines = (await readFile(path.join(out, pth), 'utf8')).split(/\r?\n/).filter(Boolean);
  if (!lines.includes('Lib\\site-packages')) lines.splice(lines.length - (lines.at(-1)?.includes('import site') ? 1 : 0), 0, 'Lib\\site-packages');
  await writeFile(path.join(out, pth), lines.join('\r\n') + '\r\n');
} else {
  run(python, ['-m', 'venv', out]);
  run(path.join(out, 'bin', 'python'), ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', `bpy==${bpyVersion}`]);
}

// Nothing the engine needs: pip's own copies of wheels' scripts and caches.
async function sweep(dir) {
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name === '__pycache__') await rm(full, {recursive: true, force: true}); else await sweep(full); }
  }
}
await sweep(out);

let files = 0, bytes = 0;
const sizes = new Map();
async function measure(dir) {
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { await measure(full); continue; }
    // Sizes by folder, four levels down (Lib/site-packages/bpy/<part>), to see what is large.
    const size = (await stat(full)).size, key = path.relative(out, full).split(path.sep).slice(0, 4).join('/');
    files++; bytes += size; sizes.set(key, (sizes.get(key) ?? 0) + size);
  }
}
await measure(out);
const python_ = process.platform === 'win32' ? path.join(out, 'python.exe') : path.join(out, 'bin', 'python3');
const blender = ask(python_, ['-I', '-c', 'import bpy; print(bpy.app.version_string)']);
await writeFile(path.join(out, 'build-info.json'), JSON.stringify({python: version, bpy: bpyVersion, blender, files, bytes}, null, 2) + '\n');
console.log(`Blender engine: Python ${version}, bpy ${bpyVersion} (Blender ${blender}), ${files} files, ${(bytes / 1048576).toFixed(0)} MiB`);
for (const [name, size] of [...sizes].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${(size / 1048576).toFixed(0).padStart(5)} MiB  ${name}`);
