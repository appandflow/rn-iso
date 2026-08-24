import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { discoverCaches, sizeCaches } from '../src/caches.js';

afterEach(() => resetExecutor());

// ccache is asked for its own config rather than guessed at: CCACHE_DIR, a
// config file and the compiled-in default all resolve inside ccache.
test('discoverCaches reads ccache config instead of guessing a path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-ccache-'));
  try {
    setExecutor({
      run: () => '',
      runQuiet: (cmd) => {
        if (cmd.includes('--get-config cache_dir')) return dir;
        if (cmd.includes('--get-config max_size')) return '5.0 GB';
        return null;
      },
      spawn: () => {},
    });
    const found = discoverCaches().filter(c => c.name === 'ccache');
    assert.equal(found.length, 1);
    assert.equal(found[0].dir, dir);
    assert.equal(found[0].bounded, true, 'ccache caps itself, so it is not the one to warn about');
    assert.match(found[0].note, /5\.0 GB/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverCaches omits ccache entirely when it is not installed', () => {
  setExecutor({ run: () => '', runQuiet: () => null, spawn: () => {} });
  assert.equal(discoverCaches().some(c => c.name === 'ccache'), false);
});

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
    assert.equal(found.bounded, false, 'nothing ever removes these');
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
