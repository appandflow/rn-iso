import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setExecutor, resetExecutor } from '../exec.ts';
import { artifactIn, buildCacheKey, entryDir, fingerprintProject, resolveBuild, storeBuild } from '../build-cache.ts';
import { buildCacheKey as providerKey } from '../../../expo-build-cache/index.js';

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
  expect(artifactIn(dir)).toBe(null);
  writeFileSync(join(dir, 'App.apk'), 'x');
  expect(artifactIn(dir)).toBe(join(dir, 'App.apk'));
});

test('resolveBuild returns null for a fingerprint nothing was built for', () => {
  expect(resolveBuild('ios', 'nope', root)).toBe(null);
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

  expect(hit).toBe(app);
  expect(after > before).toBeTruthy();
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
  expect(stored.endsWith('MyApp.app')).toBeTruthy();
  expect(existsSync(stored)).toBe(true);
  expect(calls[0].file).toBe('cp');
  expect(calls[0].args.slice(0, 2)).toEqual(['-R', build]);
  expect(calls[0].args[2]).toMatch(/\.staging-\d+/);
  expect(existsSync(`${entryDir('ios', 'fp1', root)}.staging-${process.pid}`)).toBe(false);
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
  expect(storeBuild('android', 'fp2', existing, root)).toBe(existing);
});

// `--no-build-cache` exists for an entry you no longer trust, and keeping the
// old one would mean the very next run trusts it again. The replacement is
// atomic for the same reason the first write is: staging directory, then
// rename over the destination.
test('storeBuild with { overwrite } REPLACES an existing entry, so a poisoned one can be got rid of', () => {
  const existing = seedEntry('ios', 'fp-overwrite', 'MyApp.app');
  expect(readFileSync(existing, 'utf-8')).toBe('binary');

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
  expect(readFileSync(stored, 'utf-8')).toBe('rebuilt');
  expect(existsSync(`${entryDir('ios', 'fp-overwrite', root)}.staging-${process.pid}`)).toBe(false);
});

// The fourth argument stayed a plain root string for every caller that already
// passed one; options are the new form. Both must address the same directory.
test('storeBuild accepts the cache root as a string or as { root }', () => {
  const existing = seedEntry('android', 'fp-root-form', 'App.apk');
  expect(storeBuild('android', 'fp-root-form', existing, root)).toBe(existing);
  expect(storeBuild('android', 'fp-root-form', existing, { root })).toBe(existing);
});

test('storeBuild refuses a path that is not there rather than creating an empty entry', () => {
  expect(() => storeBuild('ios', 'fp3', join(root, 'missing.app'), root)).toThrow(/No build to store/);
  expect(existsSync(entryDir('ios', 'fp3', root))).toBe(false);
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
  expect(seen[1]).toBe(build);
});

// Against the real `cp`, not a mock: a mock proves the argument list was built,
// never that cp accepts it.
test('storeBuild copies a real .app whose name contains a space', () => {
  resetExecutor();
  const build = join(root, 'build real', 'My App.app');
  mkdirSync(join(build, 'Contents'), { recursive: true });
  writeFileSync(join(build, 'Contents', 'bin'), 'x');

  const stored = storeBuild('ios', 'fp5', build, root);
  expect(stored).toBe(join(entryDir('ios', 'fp5', root), 'My App.app'));
  expect(existsSync(join(stored, 'Contents', 'bin'))).toBe(true);
});

// The fingerprint describes the project, not the build. Keying on it alone let a
// Release build answer a Debug resolve, which installs a binary that is not the
// one that was asked for.
test('the cache key separates Debug from Release and a simulator from real hardware', () => {
  const hash = 'abc123';
  const debugSim = buildCacheKey('ios', hash, {});
  expect(debugSim).toBe(`${hash}-debug-sim`);
  expect(buildCacheKey('ios', hash, { configuration: 'Release' })).not.toBe(debugSim);
  expect(buildCacheKey('ios', hash, { configuration: 'Debug' })).toBe(debugSim);
  expect(buildCacheKey('ios', hash, { device: 'Janic iPhone' })).not.toBe(debugSim);
  expect(buildCacheKey('ios', hash, { configuration: 'Release' })).not.toBe(buildCacheKey('ios', hash, { configuration: 'Release', device: 'Janic iPhone' }));
});

// rn-iso hands `expo run:ios` the udid of the simulator it owns, so a udid must
// classify as a simulator. Bucketing on the identifier instead would give every
// worktree its own entry and there would be no shared cache left.
test('two workspaces on different owned simulators share one entry', () => {
  const hash = 'abc123';
  const a = buildCacheKey('ios', hash, { device: 'A1B2C3D4-1111-2222-3333-444455556666' });
  const b = buildCacheKey('ios', hash, { device: 'F9E8D7C6-9999-8888-7777-666655554444' });
  expect(a).toBe(b);
  expect(a).toBe(buildCacheKey('ios', hash, {}));
  expect(buildCacheKey('android', hash, { device: 'emulator-5554' })).toBe(buildCacheKey('android', hash, {}));
});

test('android keys on the gradle variant rather than the Xcode configuration', () => {
  const hash = 'abc123';
  expect(buildCacheKey('android', hash, {})).toBe(`${hash}-debug-sim`);
  expect(buildCacheKey('android', hash, { variant: 'stagingRelease' })).toBe(`${hash}-stagingrelease-sim`);
  expect(buildCacheKey('android', hash, { configuration: 'Release' })).toBe(`${hash}-debug-sim`);
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
  ] as [string, any][]) {
    expect(buildCacheKey(platform, 'hash', options)).toBe(providerKey(platform, 'hash', options));
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

  const { registeredCaches } = await import('../cache-manifest.ts');
  const record = registeredCaches().find(c => c.dir === root);
  expect(record).toBeTruthy();
  expect(record.entriesDepth).toBe(2);
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
  expect(await fingerprintProject(root, { platform: 'ios', load })).toBe('hash-ios');
  expect(await fingerprintProject(root, { platform: 'android', load })).toBe('hash-android');
  expect(seen.map((s) => s.options.platforms)).toEqual([['ios'], ['android']]);
});

// No platform means no scoping: the option is omitted entirely rather than
// passed as an empty array, which @expo/fingerprint would read as "hash
// nothing native".
test('fingerprintProject without a platform passes no platforms option', async () => {
  let options = 'unset';
  const load = () => ({ createFingerprintAsync: async (_dir, opts) => { options = opts; return { hash: 'h' }; } });
  expect(await fingerprintProject(root, { load })).toBe('h');
  expect((options as any)?.platforms).toBe(undefined);
});

// An unknown platform is not silently turned into a scope: `platforms: ['web']`
// would hash nothing and produce one key for every project on the machine.
test('fingerprintProject ignores a platform it does not know', async () => {
  let options = 'unset';
  const load = () => ({ createFingerprintAsync: async (_dir, opts) => { options = opts; return { hash: 'h' }; } });
  await fingerprintProject(root, { platform: 'web', load });
  expect((options as any)?.platforms).toBe(undefined);
});
