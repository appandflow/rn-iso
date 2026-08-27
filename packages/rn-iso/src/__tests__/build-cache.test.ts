import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
import { setExecutor, resetExecutor } from '../exec.ts';
import {
  artifactIn,
  buildCacheKey,
  compareSourceLists,
  describeFingerprintMiss,
  diffFingerprintSources,
  entryDir,
  fingerprintDiffRecord,
  fingerprintDiffSuffix,
  fingerprintProject,
  resolveBuild,
  storeBuild,
  storedAssetManifest,
  storedSources,
} from '../build-cache.ts';
import { ASSET_MANIFEST_VERSION, type AssetManifest } from '../engine/asset-manifest.ts';
import { buildCacheKey as providerKey } from '../../../expo-build-cache/index.js';

let root: string;
let tmpHome: string;
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

function seedEntry(platform: string, hash: string, name = 'MyApp.app') {
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

  const calls: { file: string; args: string[] }[] = [];
  setExecutor({
    run: () => {
      throw new Error('the copy must not go through a shell');
    },
    runFile: (file, args) => {
      calls.push({ file, args });
      // Stand in for `cp -c -R`: create the destination the real command would.
      const dest = args[args.length - 1];
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, 'bin'), 'x');
      return '';
    },
    runQuiet: () => '',
    spawn: () => {},
  });

  const stored = storeBuild('ios', 'fp1', build, root);
  assert(stored);
  expect(stored.endsWith('MyApp.app')).toBeTruthy();
  expect(existsSync(stored)).toBe(true);
  const call = calls[0];
  assert(call);
  expect(call.file).toBe('cp');
  // -c first (APFS clone; the mock accepts it, standing in for same-volume APFS).
  expect(call.args.slice(0, 3)).toEqual(['-c', '-R', build]);
  expect(call.args[3]).toMatch(/\.staging-\d+/);
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
    run: () => {
      throw new Error('the copy must not go through a shell');
    },
    runFile: (_file, args) => {
      // Stand in for `cp -R`, which copies a file here.
      writeFileSync(args[2], readFileSync(args[1], 'utf-8'));
      return '';
    },
    runQuiet: () => '',
    spawn: () => {},
  });

  const stored = storeBuild('ios', 'fp-overwrite', fresh, { root, overwrite: true });
  assert(stored);
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

  let seen: string[] | null = null;
  setExecutor({
    run: () => {
      throw new Error('the copy must not go through a shell');
    },
    runFile: (_file, args) => {
      seen = args;
      mkdirSync(args[3], { recursive: true });
      writeFileSync(join(args[3], 'bin'), 'x');
      return '';
    },
    runQuiet: () => '',
    spawn: () => {},
  });

  storeBuild('ios', 'fp4', build, root);
  assert(seen);
  expect(seen[2]).toBe(build);
});

// Against the real `cp`, not a mock: a mock proves the argument list was built,
// never that cp accepts it.
test('storeBuild copies a real .app whose name contains a space', () => {
  resetExecutor();
  const build = join(root, 'build real', 'My App.app');
  mkdirSync(join(build, 'Contents'), { recursive: true });
  writeFileSync(join(build, 'Contents', 'bin'), 'x');

  const stored = storeBuild('ios', 'fp5', build, root);
  assert(stored);
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
  expect(buildCacheKey('ios', hash, { configuration: 'Release' })).not.toBe(
    buildCacheKey('ios', hash, { configuration: 'Release', device: 'Janic iPhone' }),
  );
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
  ] as [string, Record<string, unknown>][]) {
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
  const record = registeredCaches().find((c) => c.dir === root);
  assert(record);
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
  const seen: { dir: string; options: { platforms: string[] } | undefined }[] = [];
  const load = () => ({
    createFingerprintAsync: async (dir: string, options?: { platforms: string[] }) => {
      seen.push({ dir, options });
      return { hash: `hash-${options?.platforms?.join('+')}` };
    },
  });
  expect((await fingerprintProject(root, { platform: 'ios', load }))?.hash).toBe('hash-ios');
  expect((await fingerprintProject(root, { platform: 'android', load }))?.hash).toBe('hash-android');
  expect(seen.map((s) => s.options?.platforms)).toEqual([['ios'], ['android']]);
});

// No platform means no scoping: the option is omitted entirely rather than
// passed as an empty array, which @expo/fingerprint would read as "hash
// nothing native".
test('fingerprintProject without a platform passes no platforms option', async () => {
  let options: { platforms: string[] } | undefined | 'unset' = 'unset';
  const load = () => ({
    createFingerprintAsync: async (_dir: string, opts?: { platforms: string[] }) => {
      options = opts;
      return { hash: 'h' };
    },
  });
  expect((await fingerprintProject(root, { load }))?.hash).toBe('h');
  const seen = options as { platforms?: string[] } | undefined | 'unset';
  expect(typeof seen === 'object' ? seen?.platforms : undefined).toBe(undefined);
});

// An unknown platform is not silently turned into a scope: `platforms: ['web']`
// would hash nothing and produce one key for every project on the machine.
test('fingerprintProject ignores a platform it does not know', async () => {
  let options: { platforms: string[] } | undefined | 'unset' = 'unset';
  const load = () => ({
    createFingerprintAsync: async (_dir: string, opts?: { platforms: string[] }) => {
      options = opts;
      return { hash: 'h' };
    },
  });
  await fingerprintProject(root, { platform: 'web', load });
  const seen = options as { platforms?: string[] } | undefined | 'unset';
  expect(typeof seen === 'object' ? seen?.platforms : undefined).toBe(undefined);
});

// --- fingerprint sources: stored on store, read back, diffed on a miss ------

test('storeBuild writes fingerprint-sources.json beside the artifact, and storedSources reads it back', () => {
  resetExecutor();
  const build = join(root, 'build', 'MyApp.app');
  mkdirSync(build, { recursive: true });
  writeFileSync(join(build, 'bin'), 'x');

  const sources = [{ type: 'file', filePath: 'ios/Podfile.lock', hash: 'aa' }];
  storeBuild('ios', 'k1', build, { root, sources });

  expect(storedSources('ios', 'k1', root)).toEqual(sources);
  // The artifact lookup is unaffected: the JSON is never mistaken for the app.
  expect(artifactIn(entryDir('ios', 'k1', root))).toBe(join(entryDir('ios', 'k1', root), 'MyApp.app'));
});

test('storedSources is null for an entry stored without sources, or with unreadable JSON', () => {
  resetExecutor();
  const build = join(root, 'build', 'MyApp.app');
  mkdirSync(build, { recursive: true });
  writeFileSync(join(build, 'bin'), 'x');
  storeBuild('ios', 'k2', build, { root });
  expect(storedSources('ios', 'k2', root)).toBe(null);

  writeFileSync(join(entryDir('ios', 'k2', root), 'fingerprint-sources.json'), 'not json');
  expect(storedSources('ios', 'k2', root)).toBe(null);
  // An object where an array belongs is a shape this refuses, not a crash.
  writeFileSync(join(entryDir('ios', 'k2', root), 'fingerprint-sources.json'), '{"hash":"x"}');
  expect(storedSources('ios', 'k2', root)).toBe(null);
});

// --- the asset manifest: the RELEASE gate's stored side ---------------------

test('storeBuild writes assets-manifest.json beside the artifact, and storedAssetManifest reads it back', () => {
  resetExecutor();
  const build = join(root, 'build', 'App.apk');
  mkdirSync(join(root, 'build'), { recursive: true });
  writeFileSync(build, 'apk');

  const assetManifest: AssetManifest = {
    version: ASSET_MANIFEST_VERSION,
    assets: [{ path: 'drawable-mdpi/logo.png', sha256: 'a'.repeat(64) }],
  };
  storeBuild('android', 'ak1', build, { root, assetManifest });

  expect(storedAssetManifest('android', 'ak1', root)).toEqual(assetManifest);
  // One mechanism, two files: both land in the same entry, and neither is
  // ever mistaken for the artifact.
  expect(artifactIn(entryDir('android', 'ak1', root))).toBe(join(entryDir('android', 'ak1', root), 'App.apk'));
});

test('storeBuild carries the sources AND the asset manifest in the same store', () => {
  resetExecutor();
  const build = join(root, 'build2', 'App.apk');
  mkdirSync(join(root, 'build2'), { recursive: true });
  writeFileSync(build, 'apk');

  const sources = [{ type: 'file', filePath: 'android/app/build.gradle', hash: 'aa' }];
  const assetManifest: AssetManifest = { version: ASSET_MANIFEST_VERSION, assets: [] };
  storeBuild('android', 'ak2', build, { root, sources, assetManifest });

  expect(storedSources('android', 'ak2', root)).toEqual(sources);
  expect(storedAssetManifest('android', 'ak2', root)).toEqual(assetManifest);
});

test('storedAssetManifest is null for an entry stored without one, or with unreadable JSON', () => {
  resetExecutor();
  const build = join(root, 'build3', 'App.apk');
  mkdirSync(join(root, 'build3'), { recursive: true });
  writeFileSync(build, 'apk');
  // The pre-#62 entry: stored before asset tracking existed. Null here is
  // what makes the release gate refuse to swap it.
  storeBuild('android', 'ak3', build, { root });
  expect(storedAssetManifest('android', 'ak3', root)).toBe(null);

  writeFileSync(join(entryDir('android', 'ak3', root), 'assets-manifest.json'), 'not json');
  expect(storedAssetManifest('android', 'ak3', root)).toBe(null);
  // A version this build does not understand reads as no manifest, never as
  // an empty asset set.
  writeFileSync(join(entryDir('android', 'ak3', root), 'assets-manifest.json'), '{"version":99,"assets":[]}');
  expect(storedAssetManifest('android', 'ak3', root)).toBe(null);
});

test('{ overwrite } REPLACES the manifest too, so a refusing entry stops refusing', () => {
  resetExecutor();
  const build = join(root, 'build4', 'App.apk');
  mkdirSync(join(root, 'build4'), { recursive: true });
  writeFileSync(build, 'apk');
  // The entry that caused a swap refusal: no manifest at all.
  storeBuild('android', 'ak4', build, { root });
  expect(storedAssetManifest('android', 'ak4', root)).toBe(null);

  const assetManifest: AssetManifest = {
    version: ASSET_MANIFEST_VERSION,
    assets: [{ path: 'raw/sound.mp3', sha256: 'b'.repeat(64) }],
  };
  storeBuild('android', 'ak4', build, { root, overwrite: true, assetManifest });
  expect(storedAssetManifest('android', 'ak4', root)).toEqual(assetManifest);
});

test('compareSourceLists reports changed, added and removed names, current order first', () => {
  const previous = [
    { type: 'file', filePath: 'ios/Podfile.lock', hash: 'aa' },
    { type: 'contents', id: 'expoConfig', hash: 'bb' },
    { type: 'dir', filePath: 'ios/App', hash: 'cc' },
  ];
  const current = [
    { type: 'file', filePath: 'ios/Podfile.lock', hash: 'a2' }, // changed
    { type: 'contents', id: 'expoConfig', hash: 'bb' }, // same
    { type: 'file', filePath: 'ios/New.swift', hash: 'dd' }, // added
  ];
  expect(compareSourceLists(previous, current)).toEqual(['ios/Podfile.lock', 'ios/New.swift', 'ios/App']);
});

test('compareSourceLists is empty when nothing moved, and ignores unnamed sources', () => {
  const sources = [{ filePath: 'a', hash: '1' }, { hash: 'anonymous' }];
  expect(compareSourceLists(sources, sources)).toEqual([]);
});

test('diffFingerprintSources prefers the project differ and falls back when it throws or misbehaves', () => {
  const previous = [{ filePath: 'a', hash: '1' }];
  const current = { hash: 'h2', sources: [{ filePath: 'a', hash: '2' }] };

  // The project's own diffFingerprints answers, in the new item shape.
  const seen: unknown[] = [];
  const differ = (fp1: unknown, fp2: unknown) => {
    seen.push([fp1, fp2]);
    return [{ op: 'changed', beforeSource: { filePath: 'a' }, afterSource: { filePath: 'a' } }];
  };
  expect(diffFingerprintSources({ previous, previousHash: 'h1', current, differ })).toEqual(['a']);
  expect(seen.length).toBe(1);

  // A differ that throws (or returns garbage) falls back to the comparison.
  const throwing = () => {
    throw new Error('old @expo/fingerprint');
  };
  expect(diffFingerprintSources({ previous, previousHash: 'h1', current, differ: throwing })).toEqual(['a']);
  expect(diffFingerprintSources({ previous, previousHash: 'h1', current, differ: null })).toEqual(['a']);
});

test('fingerprintDiffSuffix caps the line at three names and counts the rest', () => {
  expect(fingerprintDiffSuffix([])).toBe('');
  expect(fingerprintDiffSuffix(['a'])).toBe(' -- 1 source changed: a');
  expect(fingerprintDiffSuffix(['a', 'b', 'c', 'd', 'e'])).toBe(' -- 5 sources changed: a, b, c');
});

test('fingerprintDiffRecord caps the logged list at 20 names and carries the total count', () => {
  const changed = Array.from({ length: 25 }, (_, i) => `src/file-${i}`);
  const record = fingerprintDiffRecord({ changed, previousHash: 'aaa', hash: 'bbb' });
  expect(record.src).toBe('build');
  expect(record.level).toBe('info');
  expect(record.event).toBe('fingerprint_diff');
  expect(record.changed).toBe(25);
  expect((record.sources as string[]).length).toBe(20);
  expect(record.msg).toMatch(/25 sources changed/);
  expect(record.msg).toMatch(/and 5 more/);
  expect(String(record.msg)).not.toContain('src/file-20');
});

test('describeFingerprintMiss only speaks for the same platform, a different hash, and a stored entry', () => {
  resetExecutor();
  const build = join(root, 'build', 'MyApp.app');
  mkdirSync(build, { recursive: true });
  writeFileSync(join(build, 'bin'), 'x');
  storeBuild('ios', 'old-key', build, {
    root,
    sources: [{ type: 'file', filePath: 'ios/Podfile.lock', hash: 'aa' }],
  });

  const current = { hash: 'new-hash', sources: [{ type: 'file', filePath: 'ios/Podfile.lock', hash: 'a2' }] };
  const lastBuild = { platform: 'ios', fingerprint: 'old-hash', cacheKey: 'old-key' };
  const load = () => null; // no project @expo/fingerprint: the fallback diff decides

  const miss = describeFingerprintMiss({ projectRoot: root, platform: 'ios', current, lastBuild, root, load });
  assert(miss);
  expect(miss.previousHash).toBe('old-hash');
  expect(miss.changed).toEqual(['ios/Podfile.lock']);

  // Wrong platform, same hash, no record, no stored sources: all null.
  expect(describeFingerprintMiss({ projectRoot: root, platform: 'android', current, lastBuild, root, load })).toBe(
    null,
  );
  expect(
    describeFingerprintMiss({
      projectRoot: root,
      platform: 'ios',
      current: { ...current, hash: 'old-hash' },
      lastBuild,
      root,
      load,
    }),
  ).toBe(null);
  expect(describeFingerprintMiss({ projectRoot: root, platform: 'ios', current, lastBuild: null, root, load })).toBe(
    null,
  );
  expect(
    describeFingerprintMiss({
      projectRoot: root,
      platform: 'ios',
      current,
      lastBuild: { ...lastBuild, cacheKey: 'never-stored' },
      root,
      load,
    }),
  ).toBe(null);
});
