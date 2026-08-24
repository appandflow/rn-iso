import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { artifactIn, entryDir, resolveBuild, storeBuild } from '../src/build-cache.js';

let root;
let tmpHome;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rn-iso-bc-'));
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-bc-home-'));
  process.env.RN_ISO_HOME = tmpHome;
});
afterEach(() => {
  resetExecutor();
  rmSync(root, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

function seedEntry(platform, hash, name = 'MyApp.app') {
  const dir = entryDir(platform, hash, root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), 'binary');
  return join(dir, name);
}

test('artifactIn finds the .app or .apk and ignores anything else in the entry', () => {
  const dir = join(root, 'entry');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'notes.txt'), 'x');
  assert.equal(artifactIn(dir), null, 'a stray file is not an artifact');
  writeFileSync(join(dir, 'App.apk'), 'x');
  assert.equal(artifactIn(dir), join(dir, 'App.apk'));
});

test('resolveBuild returns null for a fingerprint nothing was built for', () => {
  assert.equal(resolveBuild('ios', 'nope', root), null);
});

// A hit reads the entry without rewriting it, so without an explicit touch the
// entries earning their keep look exactly like the ones nothing has used in
// months -- and age-based trimming would evict the wrong ones.
test('resolveBuild touches the entry it returns, so trimming can tell it is in use', () => {
  const app = seedEntry('ios', 'abc');
  const longAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  utimesSync(join(root, 'ios', 'abc'), longAgo, longAgo);

  const before = statSync(join(root, 'ios', 'abc')).mtimeMs;
  const hit = resolveBuild('ios', 'abc', root);
  const after = statSync(join(root, 'ios', 'abc')).mtimeMs;

  assert.equal(hit, app);
  assert.ok(after > before, 'a hit must refresh the entry timestamp');
});

// A copy interrupted halfway must never be readable as a complete entry by a
// worktree building in parallel, so the copy happens in a sibling and only the
// rename publishes it.
test('storeBuild stages elsewhere and renames, so a partial copy is never visible', () => {
  const build = join(root, 'build', 'MyApp.app');
  mkdirSync(build, { recursive: true });
  writeFileSync(join(build, 'bin'), 'x');

  const commands = [];
  setExecutor({
    run: (cmd) => {
      commands.push(cmd);
      // Stand in for `cp -R`: create the destination the real command would.
      const m = cmd.match(/^cp -R "(.+)" "(.+)"$/);
      if (m) {
        mkdirSync(m[2], { recursive: true });
        writeFileSync(join(m[2], 'bin'), 'x');
      }
      return '';
    },
    runQuiet: () => '',
    spawn: () => {},
  });

  const stored = storeBuild('ios', 'fp1', build, root);
  assert.ok(stored.endsWith('MyApp.app'));
  assert.equal(existsSync(stored), true);
  assert.match(commands[0], /^cp -R/);
  assert.match(commands[0], /\.staging-\d+/, 'the copy must land in a staging directory, not the final path');
  assert.equal(existsSync(`${entryDir('ios', 'fp1', root)}.staging-${process.pid}`), false, 'staging must not survive');
});

test('storeBuild is idempotent: an entry that already exists is returned, not recopied', () => {
  const existing = seedEntry('android', 'fp2', 'App.apk');
  setExecutor({
    run: () => {
      throw new Error('should not copy over an entry that already exists');
    },
    runQuiet: () => '',
    spawn: () => {},
  });
  assert.equal(storeBuild('android', 'fp2', existing, root), existing);
});

test('storeBuild refuses a path that is not there rather than creating an empty entry', () => {
  assert.throws(() => storeBuild('ios', 'fp3', join(root, 'missing.app'), root), /No build to store/);
  assert.equal(existsSync(entryDir('ios', 'fp3', root)), false);
});
