import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { discoverCaches, pruneCache, sizeCaches } from '../src/caches.js';

afterEach(() => resetExecutor());

// Declared caches are the ones rn-iso cannot detect: a Metro FileStore or an
// Expo build-cache directory is chosen by a project's own config.
test('discoverCaches includes declared paths and expands a leading ~', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-declared-'));
  try {
    setExecutor({ run: () => '', runQuiet: () => null, spawn: () => {} });
    const found = discoverCaches({ declared: [dir, '/definitely/not/here'] });
    const declared = found.filter(c => c.note.includes('caches` setting'));
    assert.equal(declared.length, 1, 'a declared path that does not exist is dropped, not reported as empty');
    assert.equal(declared[0].dir, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The Metro entry's `dir` is the SYSTEM TEMP DIRECTORY, which this cache does
// not own. It must carry an explicit file list so a caller deleting it can
// never recurse into the directory itself.
test('metro file maps are reported as an explicit file list, never as a directory to remove', () => {
  const stray = join(tmpdir(), `metro-file-map-rn-iso-test-${process.pid}`);
  writeFileSync(stray, 'x'.repeat(1024));
  try {
    setExecutor({ run: () => '', runQuiet: () => null, spawn: () => {} });
    const found = discoverCaches().find(c => c.name === 'Metro file maps');
    assert.ok(found, 'expected the metro file maps entry');
    assert.ok(Array.isArray(found.files) && found.files.length > 0);
    assert.ok(found.files.includes(stray));
    assert.ok(found.files.every(f => f.startsWith(tmpdir())));
  } finally {
    rmSync(stray, { force: true });
  }
});

// sizeCaches must not re-walk an entry that already counted itself, and must
// measure the ones that did not.
test('sizeCaches keeps a precounted size and measures the rest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-size-'));
  try {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'f'), 'y'.repeat(2048));
    const sized = sizeCaches([
      { name: 'precounted', dir: '/nope', bytes: 42 },
      { name: 'walked', dir },
    ]);
    assert.equal(sized[0].bytes, 42, 'an entry that counted itself is left alone');
    assert.ok(sized[1].bytes >= 2048, 'an entry without a size is measured');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// "Used" has to mean read-or-written. A cache hit reads an entry without
// rewriting it, so pruning on mtime alone would evict exactly the entries that
// are earning their keep.
test('pruneCache keeps a recently READ entry whose mtime is old', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-prune-'));
  try {
    const old = join(dir, 'cold');
    const read = join(dir, 'hot');
    writeFileSync(old, 'a');
    writeFileSync(read, 'b');
    const longAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000);
    utimesSync(old, longAgo, longAgo);
    // Written long ago, read just now -- a cache hit looks exactly like this.
    utimesSync(read, new Date(), longAgo);

    const r = pruneCache({ dir, prune: 'entries' }, { olderThanDays: 30 });
    assert.equal(r.removed, 1);
    assert.equal(existsSync(old), false, 'untouched entry should go');
    assert.equal(existsSync(read), true, 'recently read entry must survive');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The CAS indexes its own data files; removing leaves would leave the index
// pointing at data that no longer exists.
test('pruneCache refuses to trim an index-backed cache, and says why', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-atomic-'));
  try {
    writeFileSync(join(dir, 'v9.1.leaf'), 'x');
    const veryOld = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    utimesSync(join(dir, 'v9.1.leaf'), veryOld, veryOld);

    const r = pruneCache({ dir, prune: 'atomic' }, { olderThanDays: 1 });
    assert.equal(r.removed, 0);
    assert.match(r.skipped, /whole/);
    assert.equal(existsSync(join(dir, 'v9.1.leaf')), true, 'nothing may be removed piecemeal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Metro's file maps live loose in the system temp dir, so pruning must walk the
// explicit list and never the directory.
test('pruneCache trims only the listed files when a cache does not own its directory', () => {
  const mine = join(tmpdir(), `metro-file-map-rn-iso-prunetest-${process.pid}`);
  const notMine = join(tmpdir(), `rn-iso-bystander-${process.pid}`);
  writeFileSync(mine, 'x');
  writeFileSync(notMine, 'y');
  const longAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  utimesSync(mine, longAgo, longAgo);
  utimesSync(notMine, longAgo, longAgo);
  try {
    const r = pruneCache({ dir: tmpdir(), files: [mine], prune: 'entries' }, { olderThanDays: 30 });
    assert.equal(r.removed, 1);
    assert.equal(existsSync(mine), false);
    assert.equal(existsSync(notMine), true, 'a file the cache does not own must survive');
  } finally {
    rmSync(mine, { force: true });
    rmSync(notMine, { force: true });
  }
});
