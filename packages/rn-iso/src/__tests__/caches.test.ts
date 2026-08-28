import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setExecutor, resetExecutor } from '../exec.ts';
import { declaredCachePaths, discoverCaches, pruneCache, sizeCaches } from '../caches.ts';
import { register } from '../cache-manifest.ts';
import { makeCacheDescriptor } from './_factories.ts';
import { setProjectSetting, upsertProject } from '../config.ts';
import assert from 'node:assert';

const LONG_AGO = new Date(Date.now() - 90 * 24 * 3600 * 1000);

function age(path: string, when = LONG_AGO) {
  utimesSync(path, when, when);
}

let tmpHome: string;
beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-home-'));
  process.env.RN_ISO_HOME = tmpHome;
});
afterEach(() => {
  resetExecutor();
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

test('discoverCaches includes declared paths and expands a leading ~', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-declared-'));
  try {
    setExecutor({ run: () => '', runQuiet: () => null, spawn: () => {} });
    const found = discoverCaches({ declared: [dir, '/definitely/not/here'] });
    const declared = found.filter((c) => c.note.includes('caches` setting'));
    expect(declared.length).toBe(1);
    assert(declared[0]);
    expect(declared[0].dir).toBe(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metro file maps are reported as an explicit file list, never as a directory to remove', () => {
  const stray = join(tmpdir(), `metro-file-map-rn-iso-test-${process.pid}`);
  writeFileSync(stray, 'x'.repeat(1024));
  try {
    setExecutor({ run: () => '', runQuiet: () => null, spawn: () => {} });
    const found = discoverCaches().find((c) => c.name === 'Metro file maps');
    expect(found).toBeTruthy();
    assert(found);
    assert(found.files);
    expect(Array.isArray(found.files) && found.files.length > 0).toBeTruthy();
    expect(found.files.includes(stray)).toBeTruthy();
    expect(found.files.every((f) => f.startsWith(tmpdir()))).toBeTruthy();
  } finally {
    rmSync(stray, { force: true });
  }
});

test('sizeCaches keeps a precounted size and measures the rest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-size-'));
  try {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'f'), 'y'.repeat(2048));
    const sized = sizeCaches([
      makeCacheDescriptor({ name: 'precounted', dir: '/nope', bytes: 42 }),
      makeCacheDescriptor({ name: 'walked', dir }),
    ]);
    assert(sized[0]);
    assert(sized[1]);
    expect(sized[0].bytes).toBe(42);
    const walkedBytes = sized[1].bytes;
    assert(walkedBytes !== undefined);
    expect(walkedBytes >= 2048).toBeTruthy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneCache keeps a recently READ entry whose mtime is old', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-prune-'));
  try {
    const old = join(dir, 'cold');
    const read = join(dir, 'hot');
    writeFileSync(old, 'a');
    writeFileSync(read, 'b');
    const longAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000);
    utimesSync(old, longAgo, longAgo);
    utimesSync(read, new Date(), longAgo);

    const r = pruneCache(makeCacheDescriptor({ dir, prune: 'entries' }), { olderThanDays: 30 });
    expect(r.removed).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(read)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneCache refuses to trim an index-backed cache, and says why', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-atomic-'));
  try {
    writeFileSync(join(dir, 'v9.1.leaf'), 'x');
    const veryOld = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    utimesSync(join(dir, 'v9.1.leaf'), veryOld, veryOld);

    const r = pruneCache(makeCacheDescriptor({ dir, prune: 'atomic' }), { olderThanDays: 1 });
    expect(r.removed).toBe(0);
    expect(r.skipped).toMatch(/whole/);
    expect(existsSync(join(dir, 'v9.1.leaf'))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneCache trims one build at a time in the real build-cache layout', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-bcprune-'));
  try {
    const cold = join(root, 'ios', 'aaaa-debug-sim');
    const hot = join(root, 'ios', 'bbbb-debug-sim');
    const android = join(root, 'android', 'cccc-debug-sim');
    for (const dir of [cold, hot, android]) {
      mkdirSync(join(dir, 'MyApp.app'), { recursive: true });
      writeFileSync(join(dir, 'MyApp.app', 'bin'), 'x');
    }
    age(cold);
    age(android);
    age(join(root, 'ios'));

    const r = pruneCache(makeCacheDescriptor({ dir: root, prune: 'entries', entriesDepth: 2 }), { olderThanDays: 30 });

    expect(r.removed).toBe(2);
    expect(existsSync(cold)).toBe(false);
    expect(existsSync(android)).toBe(false);
    expect(existsSync(hot)).toBe(true);
    expect(existsSync(join(root, 'ios'))).toBe(true);
    expect(existsSync(join(root, 'android'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pruneCache trims one transform at a time in a sharded FileStore tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-fsprune-'));
  try {
    mkdirSync(join(root, '0a'), { recursive: true });
    mkdirSync(join(root, '1f'), { recursive: true });
    const cold = join(root, '0a', 'deadbeef');
    const hot = join(root, '0a', 'cafebabe');
    const otherShard = join(root, '1f', 'abcdef01');
    for (const f of [cold, hot, otherShard]) writeFileSync(f, 'transform');
    age(cold);
    age(otherShard);
    age(join(root, '0a'));

    const r = pruneCache(makeCacheDescriptor({ dir: root, prune: 'entries', entriesDepth: 2 }), { olderThanDays: 30 });

    expect(r.removed).toBe(2);
    expect(existsSync(cold)).toBe(false);
    expect(existsSync(otherShard)).toBe(false);
    expect(existsSync(hot)).toBe(true);
    expect(existsSync(join(root, '0a'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pruneCache leaves a stray file sitting above the entry depth alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-strayprune-'));
  try {
    const stray = join(root, 'README');
    writeFileSync(stray, 'x');
    age(stray);
    const entry = join(root, 'ios', 'aaaa');
    mkdirSync(entry, { recursive: true });
    age(entry);

    const r = pruneCache(makeCacheDescriptor({ dir: root, prune: 'entries', entriesDepth: 2 }), { olderThanDays: 30 });

    expect(r.removed).toBe(1);
    expect(existsSync(entry)).toBe(false);
    expect(existsSync(stray)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pruneCache trims only the listed files when a cache does not own its directory', () => {
  const mine = join(tmpdir(), `metro-file-map-rn-iso-prunetest-${process.pid}`);
  const notMine = join(tmpdir(), `rn-iso-bystander-${process.pid}`);
  writeFileSync(mine, 'x');
  writeFileSync(notMine, 'y');
  const longAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  utimesSync(mine, longAgo, longAgo);
  utimesSync(notMine, longAgo, longAgo);
  try {
    const r = pruneCache(makeCacheDescriptor({ dir: tmpdir(), files: [mine], prune: 'entries' }), {
      olderThanDays: 30,
    });
    expect(r.removed).toBe(1);
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(notMine)).toBe(true);
  } finally {
    rmSync(mine, { force: true });
    rmSync(notMine, { force: true });
  }
});

test('declaredCachePaths reads the caches setting of the project it is run in', () => {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'rn-iso-declproj-')));
  const declared = mkdtempSync(join(tmpdir(), 'rn-iso-declcache-'));
  try {
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name: 'demo' }));
    upsertProject(projectRoot, {});
    setProjectSetting(projectRoot, 'caches', [declared]);
    setExecutor({ run: () => '', runQuiet: () => null, spawn: () => {} });

    expect(declaredCachePaths(projectRoot)).toEqual([declared]);

    const found = discoverCaches({ declared: declaredCachePaths(projectRoot) });
    expect(found.some((c) => c.dir === declared)).toBeTruthy();
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(declared, { recursive: true, force: true });
  }
});

test('declaredCachePaths is empty outside a project rather than an error', () => {
  const notAProject = mkdtempSync(join(tmpdir(), 'rn-iso-noproj-'));
  try {
    setExecutor({ run: () => '', runQuiet: () => null, spawn: () => {} });
    expect(declaredCachePaths(notAProject)).toEqual([]);
  } finally {
    rmSync(notAProject, { recursive: true, force: true });
  }
});

test('discoverCaches says of each cache whether a project registered it', () => {
  const registeredDir = mkdtempSync(join(tmpdir(), 'rn-iso-src-reg-'));
  const declaredDir = mkdtempSync(join(tmpdir(), 'rn-iso-src-decl-'));
  try {
    setExecutor({ run: () => '', runQuiet: () => null, spawn: () => {} });
    register({ dir: registeredDir, name: 'Registered one' });

    const found = discoverCaches({ declared: [declaredDir] });
    const registered = found.find((c) => c.dir === registeredDir);
    const detected = found.find((c) => c.dir === declaredDir);
    assert(registered);
    assert(detected);
    expect(registered.source).toBe('registered');
    expect(detected.source).toBe('detected');
  } finally {
    rmSync(registeredDir, { recursive: true, force: true });
    rmSync(declaredDir, { recursive: true, force: true });
  }
});

test('a declared path that only differs in spelling dedups against the registration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-dedup-'));
  try {
    setExecutor({ run: () => '', runQuiet: () => null, spawn: () => {} });
    register({ dir, name: 'Registered one' });

    const found = discoverCaches({ declared: [join(dir, 'sub', '..')] });
    expect(found.filter((c) => c.dir === dir).length).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
