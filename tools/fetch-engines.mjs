#!/usr/bin/env node
// Downloads engine binaries into .local/engines (never committed) and verifies them.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = JSON.parse(readFileSync(join(ROOT, 'engines.lock.json'), 'utf8'));
const ENGINES = join(ROOT, '.local/engines');
const CACHE = join(ROOT, '.local/downloads');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const wanted = argv.filter((a) => !a.startsWith('--'));
const CHECK = flags.has('--check');

async function download(url, dest, label) {
  if (existsSync(dest)) {
    console.log(`  cached ${label}`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  console.log(`  fetching ${label}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  let got = 0;
  let lastPct = -1;
  const progress = new Transform({
    transform(chunk, _enc, cb) {
      got += chunk.length;
      if (total) {
        const pct = Math.floor((got / total) * 20) * 5;
        if (pct !== lastPct) {
          lastPct = pct;
          process.stdout.write(`\r    ${pct}%  ${(got / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} MB   `);
        }
      }
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), progress, createWriteStream(dest));
  if (total) process.stdout.write(`\r    ${(got / 1e6).toFixed(1)} MB downloaded            \n`);
}

function sha256(path) {
  const h = createHash('sha256');
  h.update(readFileSync(path));
  return h.digest('hex');
}

function verify(path, expected, label) {
  const got = sha256(path);
  if (expected && expected !== got) throw new Error(`${label} sha256 mismatch\n    expected ${expected}\n    got      ${got}`);
  if (!expected) console.log(`  UNPINNED ${label} sha256=${got}  — write it into engines.lock.json`);
  return got;
}

// Git Bash's GNU tar reads "C:\path" as a remote host, so prefer Windows' own bsdtar.
const TAR = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

function extractZip(zip, into) {
  mkdirSync(into, { recursive: true });
  const bins = [TAR, 'tar'];
  let last;
  for (const bin of bins) {
    const r = spawnSync(bin, ['-xf', zip.replace(/\\/g, '/'), '-C', into.replace(/\\/g, '/')], { stdio: 'pipe', encoding: 'utf8' });
    if (!r.error && r.status === 0) return;
    last = r.error || new Error(`${bin} exit ${r.status}: ${r.stderr}`);
  }
  throw new Error(`extracting ${zip} failed: ${last.message}`);
}

function findByName(dir, entry, acc = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) findByName(p, entry, acc);
    else if (f === entry) acc.push(p);
  }
  return acc;
}

async function installOne(name) {
  const spec = LOCK[name];
  if (!spec) throw new Error(`unknown engine "${name}" (have: ${Object.keys(LOCK).join(', ')})`);
  const dir = join(ENGINES, name, spec.version);
  const manifestPath = join(dir, 'manifest.json');
  const report = { name, version: spec.version, files: {} };

  if (spec.exe) {
    const exe = join(dir, spec.exe.entry);
    if (CHECK) {
      if (!existsSync(exe)) throw new Error(`missing ${spec.exe.entry}`);
    } else if (!flags.has('--force') && existsSync(exe)) {
      console.log(`${name} ${spec.version} binary present (use --force to refetch)`);
    } else {
      const zip = join(CACHE, `${name}-${spec.version}.zip`);
      await download(spec.exe.url, zip, `${name} binary archive`);
      verify(zip, spec.exe.sha256, `${name} zip`);
      extractZip(zip, dir);
      const found = findByName(dir, spec.exe.entry);
      if (!found.length) throw new Error(`${spec.exe.entry} not found in archive; archive contains: ${readdirSync(dir).join(', ')}`);
      if (found[0] !== exe) copyFileSync(found[0], exe);
    }
    report.files.exe = existsSync(join(dir, spec.exe.entry)) ? join(dir, spec.exe.entry) : null;
  }

  if (spec.net) {
    const net = join(dir, spec.net.name);
    if (!existsSync(net)) {
      if (CHECK) throw new Error(`missing network ${spec.net.name}`);
      mkdirSync(dir, { recursive: true });
      await download(spec.net.url, net, `${name} network`);
      verify(net, spec.net.sha256, `${name} net`);
    }
    report.files.net = existsSync(net) ? net : null;
  }

  if (!CHECK) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({ ...report, installedAt: new Date().toISOString() }, null, 2));
  }
  console.log(`${name} ${spec.version} OK`);
  return report;
}

const names = wanted.length ? wanted : Object.keys(LOCK).filter((k) => !LOCK[k].optional);
mkdirSync(ENGINES, { recursive: true });
for (const name of names) {
  try {
    await installOne(name);
  } catch (e) {
    console.error(`\n${name}: FAILED — ${e.message}`);
    process.exitCode = 1;
  }
}
if (!process.exitCode) console.log(`\n${CHECK ? 'all requested engines present' : 'engines ready'}`);
