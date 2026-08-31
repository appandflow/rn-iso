import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { register, readManifest, registeredCaches, unregister, manifestPath } from '../cache-manifest.ts';
import type { CacheEntry } from '../cache-manifest.ts';

const CORE_URL = new URL('../../../core/index.ts', import.meta.url).href;
const CLI_URL = new URL('../cache-manifest.ts', import.meta.url).href;
const CORE_WRITER_SCRIPT = `
import fs from 'node:fs';
const { updateCacheManifest } = await import(process.argv[1]);
updateCacheManifest(process.argv[2], (caches) => {
  fs.writeFileSync(process.argv[3], '');
  while (!fs.existsSync(process.argv[4])) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  caches.push({ dir: process.argv[5], name: 'core-cache' });
  return caches;
});
`;
const CLI_WRITER_SCRIPT = `
const { register } = await import(process.argv[1]);
register({ dir: process.argv[3], name: 'cli-cache' }, process.argv[2]);
`;

let tmpHome: string;
let cacheDir: string;
beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-manifest-'));
  process.env.STIM_HOME = tmpHome;
  cacheDir = mkdtempSync(join(tmpdir(), 'stim-cachedir-'));
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(file: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await delay(5);
  }
}

function runChild(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], {
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`manifest child failed (${signal || code}): ${stderr}`));
    });
  });
}

test('registering the same directory twice updates it instead of duplicating it', () => {
  register({ dir: cacheDir, name: 'first' });
  register({ dir: cacheDir, name: 'second', note: 'changed my mind' });
  const caches = readManifest().caches;
  expect(caches.length).toBe(1);
  expect(caches[0]?.name).toBe('second');
  expect(caches[0]?.note).toBe('changed my mind');
});

test('prune defaults to entries and only accepts atomic as the alternative', () => {
  register({ dir: cacheDir });
  expect(readManifest().caches[0]?.prune).toBe('entries');

  register({ dir: cacheDir, prune: 'atomic' });
  expect(readManifest().caches[0]?.prune).toBe('atomic');

  register({ dir: cacheDir, prune: 'something-else' as CacheEntry['prune'] });
  expect(readManifest().caches[0]?.prune).toBe('entries');
});

test('a leading ~ is expanded, so a registration made from any cwd resolves the same', () => {
  register({ dir: '~/.stim-tilde-test' });
  expect(readManifest().caches[0]?.dir).toBe(join(homedir(), '.stim-tilde-test'));
});

test('registeredCaches hides a directory that is gone but keeps it on file', () => {
  register({ dir: cacheDir, name: 'real' });
  register({ dir: join(tmpdir(), 'stim-never-existed'), name: 'ghost' });
  const live = registeredCaches();
  expect(live.map((c) => c.name)).toEqual(['real']);
  expect(readManifest().caches.length).toBe(2);
});

test('unregister reports whether it removed anything', () => {
  register({ dir: cacheDir });
  expect(unregister(cacheDir)).toBe(true);
  expect(unregister(cacheDir)).toBe(false);
});

test('a corrupt manifest reads as empty rather than throwing', () => {
  mkdirSync(tmpHome, { recursive: true });
  writeFileSync(manifestPath(), '{ this is not json');
  expect(readManifest().caches).toEqual([]);
  expect(registeredCaches()).toEqual([]);
});

test('a registration needs a directory', () => {
  expect(() => register({ name: 'nameless' } as CacheEntry)).toThrow(/needs a `dir`/);
});

test('entriesDepth defaults to 1 and rejects anything that is not a usable depth', () => {
  register({ dir: cacheDir });
  expect(readManifest().caches[0]?.entriesDepth).toBe(1);

  register({ dir: cacheDir, entriesDepth: 2 });
  expect(readManifest().caches[0]?.entriesDepth).toBe(2);
  expect(registeredCaches()[0]?.entriesDepth).toBe(2);

  for (const bad of [0, -1, 1.5, 'two', null]) {
    register({ dir: cacheDir, entriesDepth: bad as number });
    expect(readManifest().caches[0]?.entriesDepth).toBe(1);
  }
});

test('a registration replaces the manifest atomically and leaves no temp file', () => {
  register({ dir: cacheDir, name: 'first' });
  register({ dir: join(tmpdir(), 'stim-second'), name: 'second' });
  unregister(cacheDir);

  const leftovers = readdirSync(dirname(manifestPath())).filter((n) => n.includes('tmp'));
  expect(leftovers).toEqual([]);
  expect(readManifest().caches.map((c) => c.name)).toEqual(['second']);
});

test('CLI and core registrations use the same manifest transaction', async () => {
  const manifest = manifestPath();
  const ready = join(tmpHome, 'core-ready');
  const go = join(tmpHome, 'core-go');
  const coreDir = join(tmpHome, 'core-cache');
  const cliDir = join(tmpHome, 'cli-cache');
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(manifest, JSON.stringify({ version: 1, caches: [] }));

  const coreWriter = runChild(CORE_WRITER_SCRIPT, [CORE_URL, manifest, ready, go, coreDir]);
  await waitForFile(ready);
  const cliWriter = runChild(CLI_WRITER_SCRIPT, [CLI_URL, manifest, cliDir]);

  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    const names = (JSON.parse(readFileSync(manifest, 'utf-8')) as { caches: CacheEntry[] }).caches.map(
      (entry) => entry.name,
    );
    if (names.includes('cli-cache')) break;
    await delay(5);
  }

  writeFileSync(go, '');
  await Promise.all([coreWriter, cliWriter]);

  expect(new Set(readManifest().caches.map((entry) => entry.name))).toEqual(new Set(['core-cache', 'cli-cache']));
});
