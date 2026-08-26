import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setExecutor, resetExecutor } from '../src/exec.ts';
import { artifactIn, buildCacheKey, entryDir, fingerprintProject, resolveBuild, storeBuild } from '../src/build-cache.ts';
import { buildCacheKey as providerKey } from '../../expo-build-cache/index.js';

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

  const calls = [];
  setExecutor({
    run: () => { throw new Error('the copy must not go through a shell'); },
    runFile: (file, args) => {
      calls.push({ file, args });
      // Stand in for `cp -R`: create the destination the real command would.
      mkdirSync(args[2], { recursive: true });
      writeFileSync(join(args[2], 'bin'), 'x');
      return '';
    },
    runQuiet: () => '',
    spawn: () => {},
  });

  const stored = storeBuild('ios', 'fp1', build, root);
  assert.ok(stored.endsWith('MyApp.app'));
  assert.equal(existsSync(stored), true);
  assert.equal(calls[0].file, 'cp');
  assert.deepEqual(calls[0].args.slice(0, 2), ['-R', build]);
  assert.match(calls[0].args[2], /\.staging-\d+/, 'the copy must land in a staging directory, not the final path');
  assert.equal(existsSync(`${entryDir('ios', 'fp1', root)}.staging-${process.pid}`), false, 'staging must not survive');
});

test('storeBuild is idempotent: an entry that already exists is returned, not recopied', () => {
  const existing = seedEntry('android', 'fp2', 'App.apk');
  setExecutor({
    run: () => {
      throw new Error('should not copy over an entry that already exists');
    },
    runFile: () => {
      throw new Error('should not copy over an entry that already exists');
    },
    runQuiet: () => '',
    spawn: () => {},
  });
  assert.equal(storeBuild('android', 'fp2', existing, root), existing);
});

// `--no-build-cache` exists for an entry you no longer trust, and keeping the
// old one would mean the very next run trusts it again. The replacement is
// atomic for the same reason the first write is: staging directory, then
// rename over the destination.
test('storeBuild with { overwrite } REPLACES an existing entry, so a poisoned one can be got rid of', () => {
  const existing = seedEntry('ios', 'fp-overwrite', 'MyApp.app');
  assert.equal(readFileSync(existing, 'utf-8'), 'binary');

  const fresh = join(root, 'fresh', 'MyApp.app');
  mkdirSync(join(root, 'fresh'), { recursive: true });
  writeFileSync(fresh, 'rebuilt');
  setExecutor({
    run: () => { throw new Error('the copy must not go through a shell'); },
    runFile: (file, args) => {
      // Stand in for `cp -R`, which copies a file here.
      writeFileSync(args[2], readFileSync(args[1], 'utf-8'));
      return '';
    },
    runQuiet: () => '',
    spawn: () => {},
  });

  const stored = storeBuild('ios', 'fp-overwrite', fresh, { root, overwrite: true });
  assert.equal(readFileSync(stored, 'utf-8'), 'rebuilt', 'the entry now holds the fresh build');
  assert.equal(existsSync(`${entryDir('ios', 'fp-overwrite', root)}.staging-${process.pid}`), false, 'staging must not survive');
});

// The fourth argument stayed a plain root string for every caller that already
// passed one; options are the new form. Both must address the same directory.
test('storeBuild accepts the cache root as a string or as { root }', () => {
  const existing = seedEntry('android', 'fp-root-form', 'App.apk');
  assert.equal(storeBuild('android', 'fp-root-form', existing, root), existing);
  assert.equal(storeBuild('android', 'fp-root-form', existing, { root }), existing);
});

test('storeBuild refuses a path that is not there rather than creating an empty entry', () => {
  assert.throws(() => storeBuild('ios', 'fp3', join(root, 'missing.app'), root), /No build to store/);
  assert.equal(existsSync(entryDir('ios', 'fp3', root)), false);
});

// A path the caller chose can contain a space or a quote. Through a shell
// string, `cp -R "/tmp/My App.app" ...` was fine but `cp -R "/tmp/a"b.app"` was
// not, and the failure mode is an entry copied to the wrong place rather than
// an error.
test('storeBuild passes the build path as one argument, never through a shell', () => {
  const build = join(root, 'build', 'My App "quoted".app');
  mkdirSync(build, { recursive: true });
  writeFileSync(join(build, 'bin'), 'x');

  let seen = null;
  setExecutor({
    run: () => { throw new Error('the copy must not go through a shell'); },
    runFile: (file, args) => {
      seen = args;
      mkdirSync(args[2], { recursive: true });
      writeFileSync(join(args[2], 'bin'), 'x');
      return '';
    },
    runQuiet: () => '',
    spawn: () => {},
  });

  storeBuild('ios', 'fp4', build, root);
  assert.equal(seen[1], build, 'the path arrives whole, quotes and spaces included');
});

// Against the real `cp`, not a mock: a mock proves the argument list was built,
// never that cp accepts it.
test('storeBuild copies a real .app whose name contains a space', () => {
  resetExecutor();
  const build = join(root, 'build real', 'My App.app');
  mkdirSync(join(build, 'Contents'), { recursive: true });
  writeFileSync(join(build, 'Contents', 'bin'), 'x');

  const stored = storeBuild('ios', 'fp5', build, root);
  assert.equal(stored, join(entryDir('ios', 'fp5', root), 'My App.app'));
  assert.equal(existsSync(join(stored, 'Contents', 'bin')), true, 'the copy has to be recursive');
});

// The fingerprint describes the project, not the build. Keying on it alone let a
// Release build answer a Debug resolve, which installs a binary that is not the
// one that was asked for.
test('the cache key separates Debug from Release and a simulator from real hardware', () => {
  const hash = 'abc123';
  const debugSim = buildCacheKey('ios', hash, {});
  assert.equal(debugSim, `${hash}-debug-sim`, 'the CLI defaults are Debug and a simulator');
  assert.notEqual(buildCacheKey('ios', hash, { configuration: 'Release' }), debugSim);
  assert.equal(buildCacheKey('ios', hash, { configuration: 'Debug' }), debugSim, 'the default spelled out is the default');
  assert.notEqual(buildCacheKey('ios', hash, { device: 'Janic iPhone' }), debugSim);
  assert.notEqual(
    buildCacheKey('ios', hash, { configuration: 'Release' }),
    buildCacheKey('ios', hash, { configuration: 'Release', device: 'Janic iPhone' })
  );
});

// rn-iso hands `expo run:ios` the udid of the simulator it owns, so a udid must
// classify as a simulator. Bucketing on the identifier instead would give every
// worktree its own entry and there would be no shared cache left.
test('two workspaces on different owned simulators share one entry', () => {
  const hash = 'abc123';
  const a = buildCacheKey('ios', hash, { device: 'A1B2C3D4-1111-2222-3333-444455556666' });
  const b = buildCacheKey('ios', hash, { device: 'F9E8D7C6-9999-8888-7777-666655554444' });
  assert.equal(a, b);
  assert.equal(a, buildCacheKey('ios', hash, {}), 'and with a workspace that named no device at all');
  assert.equal(
    buildCacheKey('android', hash, { device: 'emulator-5554' }),
    buildCacheKey('android', hash, {}),
    'an emulator serial is the Android form of the same thing'
  );
});

test('android keys on the gradle variant rather than the Xcode configuration', () => {
  const hash = 'abc123';
  assert.equal(buildCacheKey('android', hash, {}), `${hash}-debug-sim`);
  assert.equal(buildCacheKey('android', hash, { variant: 'stagingRelease' }), `${hash}-stagingrelease-sim`);
  assert.equal(
    buildCacheKey('android', hash, { configuration: 'Release' }),
    `${hash}-debug-sim`,
    'an iOS-only option must not silently rename an Android entry'
  );
});

// Both entry points write into the same directory tree, so a project that moves
// from the CLI to the Expo provider (or runs both) has to keep hitting the
// entries it already has.
test('the CLI and the Expo provider compute the same key', () => {
  for (const [platform, options] of [
    ['ios', {}],
    ['ios', { configuration: 'Release' }],
    ['ios', { device: 'generic' }],
    ['ios', { device: 'Janic iPhone' }],
    ['ios', { device: true }],
    ['android', { variant: 'release', device: 'emulator-5554' }],
  ]) {
    assert.equal(
      buildCacheKey(platform, 'hash', options),
      providerKey(platform, 'hash', options),
      `${platform} ${JSON.stringify(options)}`
    );
  }
});

// gc reads the depth from the manifest, so the registration is where the build
// cache says its entries are two levels down. Registered at depth 1, one `gc`
// removal would take every iOS build on the machine.
test('storing a build registers the cache root at the depth its entries actually sit', async () => {
  const build = join(root, 'depth', 'MyApp.app');
  mkdirSync(build, { recursive: true });
  writeFileSync(join(build, 'bin'), 'x');
  resetExecutor();

  storeBuild('ios', 'fp6', build, root);

  const { registeredCaches } = await import('../src/cache-manifest.ts');
  const record = registeredCaches().find(c => c.dir === root);
  assert.ok(record, 'storing has to register the root');
  assert.equal(record.entriesDepth, 2);
});

// --- the fingerprint is platform-scoped -------------------------------------
//
// Gate provenance (2026-08-24): `rn-iso android` NEVER hit the shared cache
// across two worktrees of th3rdwave/tlon-apps, while `ios` did. The cause was
// not Android at all -- th3rdwave's hermes-engine podspec bakes the absolute
// worktree path into ios/Podfile.lock, so the iOS tree differs between
// worktrees by construction, and an UNSCOPED fingerprint hashes ios/ into the
// android key. With platforms scoped to the platform being built, both
// worktrees fingerprinted identically (b5a268e6...).
test('fingerprintProject scopes the hash to the platform being built', async () => {
  const seen = [];
  const load = () => ({
    createFingerprintAsync: async (dir, options) => {
      seen.push({ dir, options });
      return { hash: `hash-${options?.platforms?.join('+')}` };
    },
  });
  assert.equal(await fingerprintProject(root, { platform: 'ios', load }), 'hash-ios');
  assert.equal(await fingerprintProject(root, { platform: 'android', load }), 'hash-android');
  assert.deepEqual(seen.map((s) => s.options.platforms), [['ios'], ['android']]);
});

// No platform means no scoping: the option is omitted entirely rather than
// passed as an empty array, which @expo/fingerprint would read as "hash
// nothing native".
test('fingerprintProject without a platform passes no platforms option', async () => {
  let options = 'unset';
  const load = () => ({ createFingerprintAsync: async (_dir, opts) => { options = opts; return { hash: 'h' }; } });
  assert.equal(await fingerprintProject(root, { load }), 'h');
  assert.equal(options?.platforms, undefined);
});

// An unknown platform is not silently turned into a scope: `platforms: ['web']`
// would hash nothing and produce one key for every project on the machine.
test('fingerprintProject ignores a platform it does not know', async () => {
  let options = 'unset';
  const load = () => ({ createFingerprintAsync: async (_dir, opts) => { options = opts; return { hash: 'h' }; } });
  await fingerprintProject(root, { platform: 'web', load });
  assert.equal(options?.platforms, undefined);
});
