import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANDROID_BUNDLE_ENTRY,
  ANDROID_BUNDLE_NAME,
  androidBundleCommand,
  androidHermescArgs,
  androidHermescPath,
  apksignerArgs,
  hermesEnabledFromGradleProperties,
  hermescBinDir,
  hermescCandidates,
  isNothingToDelete,
  keystorePassArg,
  readAndroidHermesEnabled,
  resolveKeystore,
  swapApkBundle,
  zipalignArgs,
} from '../engine/apk-swap.ts';
import { ASSET_MANIFEST_VERSION, type AssetManifest } from '../engine/asset-manifest.ts';
import type { BuildToolsEntry } from '../sim/android.ts';
import { makeChildProcess, makeExecutor, makeWriter } from './_factories.ts';

describe('hermesEnabledFromGradleProperties', () => {
  test('default is enabled: no file, no key, an unrelated file', () => {
    expect(hermesEnabledFromGradleProperties(null)).toBe(true);
    expect(hermesEnabledFromGradleProperties('')).toBe(true);
    expect(hermesEnabledFromGradleProperties('newArchEnabled=true\n')).toBe(true);
    expect(hermesEnabledFromGradleProperties('hermesEnabled=true\n')).toBe(true);
  });

  test('only the literal false disables it, comments and blanks are skipped', () => {
    expect(hermesEnabledFromGradleProperties('# hermesEnabled=false\nhermesEnabled=true\n')).toBe(true);
    expect(hermesEnabledFromGradleProperties('\n\nhermesEnabled=false\n')).toBe(false);
    expect(hermesEnabledFromGradleProperties('hermesEnabled = FALSE')).toBe(false);
    expect(hermesEnabledFromGradleProperties('hermesEnabled:false')).toBe(false);
  });

  test('the LAST assignment wins, exactly as java.util.Properties loads it', () => {
    expect(hermesEnabledFromGradleProperties('hermesEnabled=false\nhermesEnabled=true\n')).toBe(true);
    expect(hermesEnabledFromGradleProperties('hermesEnabled=true\nhermesEnabled=false\n')).toBe(false);
  });

  test('readAndroidHermesEnabled defaults to enabled when gradle.properties is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stim-apk-swap-'));
    try {
      expect(readAndroidHermesEnabled(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the hermesc probe order', () => {
  const root = '/proj';
  const sibling = '/w/monorepo/node_modules/hermes-compiler/hermesc/osx-bin/hermesc';
  const local = '/proj/node_modules/hermes-compiler/hermesc/osx-bin/hermesc';
  const sdks = '/proj/node_modules/react-native/sdks/hermesc/osx-bin/hermesc';
  const built = '/proj/node_modules/react-native/sdks/hermes/build/bin/hermesc';

  test('the host directory is the only platform-dependent piece', () => {
    expect(hermescBinDir('darwin')).toBe('osx-bin');
    expect(hermescBinDir('linux')).toBe('linux64-bin');
  });

  test("Rock's trick first: hermes-compiler beside the react-native the project resolves", () => {
    const candidates = hermescCandidates(root, {
      platform: 'darwin',
      reactNativePath: '/w/monorepo/node_modules/react-native',
    });
    expect(candidates).toEqual([sibling, local, sdks, built]);
  });

  test('without a resolved react-native the sibling leg collapses into the project-local one', () => {
    expect(hermescCandidates(root, { platform: 'darwin' })).toEqual([local, sdks, built]);
  });

  test('the first candidate that exists wins, newest layout first', () => {
    const opts = { platform: 'darwin', reactNativePath: '/w/monorepo/node_modules/react-native' };
    expect(androidHermescPath(root, { ...opts, exists: (p) => p === sibling || p === sdks })).toBe(sibling);
    expect(androidHermescPath(root, { ...opts, exists: (p) => p === local || p === built })).toBe(local);
    expect(androidHermescPath(root, { ...opts, exists: (p) => p === sdks || p === built })).toBe(sdks);
    expect(androidHermescPath(root, { ...opts, exists: (p) => p === built })).toBe(built);
  });

  test('nothing found answers the last path, whose absence the caller already guards', () => {
    expect(androidHermescPath(root, { platform: 'darwin', exists: () => false })).toBe(built);
  });

  test("the argv is AGP's own hermesFlags: -emit-binary -O -w -out", () => {
    expect(androidHermescArgs({ bundle: '/t/index.android.bundle', out: '/t/index.android.bundle.hbc' })).toEqual([
      '-emit-binary',
      '-O',
      '-w',
      '-out',
      '/t/index.android.bundle.hbc',
      '/t/index.android.bundle',
    ]);
  });
});

describe('androidBundleCommand', () => {
  test("expo: the project's own `expo export:embed`, fixed argv, --platform android --dev false", () => {
    expect(
      androidBundleCommand({
        isExpo: true,
        entryFile: 'index.js',
        bundleOutput: '/t/assets/index.android.bundle',
        assetsDest: '/t/res',
      }),
    ).toEqual({
      file: 'npx',
      args: [
        'expo',
        'export:embed',
        '--platform',
        'android',
        '--dev',
        'false',
        '--bundle-output',
        '/t/assets/index.android.bundle',
        '--assets-dest',
        '/t/res',
      ],
    });
  });

  test("bare: the project's own `react-native bundle` with the detected entry file", () => {
    expect(
      androidBundleCommand({
        isExpo: false,
        entryFile: 'index.ts',
        bundleOutput: '/t/assets/index.android.bundle',
        assetsDest: '/t/res',
      }),
    ).toEqual({
      file: 'npx',
      args: [
        'react-native',
        'bundle',
        '--platform',
        'android',
        '--dev',
        'false',
        '--entry-file',
        'index.ts',
        '--bundle-output',
        '/t/assets/index.android.bundle',
        '--assets-dest',
        '/t/res',
      ],
    });
  });

  test('the bundle entry is the one the runtime loads', () => {
    expect(ANDROID_BUNDLE_NAME).toBe('index.android.bundle');
    expect(ANDROID_BUNDLE_ENTRY).toBe('assets/index.android.bundle');
  });
});

describe('zip surgery, alignment and signing', () => {
  test('"nothing to do" from zip -d is tolerated, every other zip failure is not', () => {
    expect(isNothingToDelete('zip error: Nothing to do! (app.apk)')).toBe(true);
    expect(isNothingToDelete('\tzip warning: name not matched: assets/index.android.bundle')).toBe(true);
    expect(isNothingToDelete('zip I/O error: No space left on device')).toBe(false);
    expect(isNothingToDelete(null)).toBe(false);
  });

  test('zipalign takes -P 16 from build-tools 35 (16KB pages) and -p before it', () => {
    expect(zipalignArgs({ buildToolsMajor: 36, input: '/t/in.apk', output: '/t/out.apk' })).toEqual([
      '-P',
      '16',
      '-f',
      '-v',
      '4',
      '/t/in.apk',
      '/t/out.apk',
    ]);
    expect(zipalignArgs({ buildToolsMajor: 35, input: '/t/in.apk', output: '/t/out.apk' })[0]).toBe('-P');
    expect(zipalignArgs({ buildToolsMajor: 34, input: '/t/in.apk', output: '/t/out.apk' })).toEqual([
      '-p',
      '-f',
      '-v',
      '4',
      '/t/in.apk',
      '/t/out.apk',
    ]);
    expect(zipalignArgs({ buildToolsMajor: 0, input: '/t/in.apk', output: '/t/out.apk' })[0]).toBe('-p');
  });

  test('apksigner, never jarsigner, and the keystore argv is the signed one', () => {
    expect(
      apksignerArgs({ keystore: { path: '/p/debug.keystore', pass: 'pass:android' }, apkPath: '/t/out.apk' }),
    ).toEqual(['sign', '--ks', '/p/debug.keystore', '--ks-pass', 'pass:android', '/t/out.apk']);
  });
});

describe('keystore resolution', () => {
  test('the default is the debug keystore every RN/Expo android project carries', () => {
    expect(resolveKeystore('/w/app', null)).toEqual({
      path: '/w/app/android/app/debug.keystore',
      pass: 'pass:android',
    });
    expect(resolveKeystore('/w/app', {})).toEqual({
      path: '/w/app/android/app/debug.keystore',
      pass: 'pass:android',
    });
    expect(resolveKeystore('/w/app', { android: [] }).path).toBe('/w/app/android/app/debug.keystore');
  });

  test('android.keystore is absolute as given, relative to the project root otherwise', () => {
    expect(resolveKeystore('/w/app', { android: { keystore: '/keys/release.jks' } }).path).toBe('/keys/release.jks');
    expect(resolveKeystore('/w/app', { android: { keystore: ' android/app/release.jks ' } }).path).toBe(
      '/w/app/android/app/release.jks',
    );
    expect(resolveKeystore('/w/app', { android: { keystore: '' } }).path).toBe('/w/app/android/app/debug.keystore');
  });

  test('android.keystorePassword is schemed for apksigner, and an explicit scheme passes through', () => {
    expect(keystorePassArg(undefined)).toBe('pass:android');
    expect(keystorePassArg('   ')).toBe('pass:android');
    expect(keystorePassArg('hunter2')).toBe('pass:hunter2');
    expect(keystorePassArg('env:MY_KS_PASS')).toBe('env:MY_KS_PASS');
    expect(keystorePassArg('file:/keys/pw.txt')).toBe('file:/keys/pw.txt');
    expect(keystorePassArg('stdin')).toBe('stdin');
    expect(resolveKeystore('/w/app', { android: { keystorePassword: 'env:KS' } }).pass).toBe('env:KS');
  });
});

let root: string;
let tmp: string;
const cachedApk = '/cache/android/k-productionrelease-sim/app-production-release.apk';
const keystore = { path: '/w/app/android/app/debug.keystore', pass: 'pass:android' };
const buildTools: BuildToolsEntry = {
  path: '/sdk/build-tools/36.0.0/zipalign',
  tool: 'zipalign',
  version: '36.0.0',
  major: 36,
};
const apksigner = '/sdk/build-tools/36.0.0/apksigner';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-apk-root-'));
  tmp = mkdtempSync(join(tmpdir(), 'stim-apk-tmp-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

function makeBundleChild(code = 0): ChildProcess {
  const child = makeChildProcess();
  setImmediate(() => {
    child.stdout?.emit('data', 'Writing bundle output...\n');
    child.emit('exit', code, null);
  });
  return child;
}

interface Call {
  op: string;
  file?: string;
  args?: string[];
  opts?: Record<string, unknown>;
}

function manifest(assets: Record<string, string>): AssetManifest {
  return {
    version: ASSET_MANIFEST_VERSION,
    assets: Object.entries(assets)
      .map(([path, sha256]) => ({ path, sha256 }))
      .toSorted((a, b) => a.path.localeCompare(b.path)),
  };
}

const LOGO = 'a'.repeat(64);
const SOUND = 'b'.repeat(64);
const STORED = manifest({ 'drawable-mdpi/logo.png': LOGO, 'raw/sound.mp3': SOUND });

function harness({
  bundleExit = 0,
  failOn = null as string | null,
  hermescExists = true,
  bundleWritten = true,
  fresh = STORED as AssetManifest | null,
  stored = STORED as AssetManifest | null,
} = {}) {
  const calls: Call[] = [];
  const base = 'app-production-release.apk';
  const work = join(tmp, `unaligned-${base}`);
  const final = join(tmp, base);
  const stage = join(tmp, 'stage');
  const bundleOutput = join(stage, 'assets', ANDROID_BUNDLE_NAME);
  const hermesc = androidHermescPath(root, { exists: () => false });
  const exec = makeExecutor({
    runFile: (file: string, args: string[] = [], opts: Record<string, unknown> = {}) => {
      calls.push({ op: 'runFile', file, args, opts });
      if (failOn && (file === failOn || args[0] === failOn)) throw new Error(`${failOn} blew up`);
      return '';
    },
  });
  const spawnFn = (cmd: string, args: string[], _opts: Record<string, unknown>) => {
    calls.push({ op: 'spawn', file: cmd, args });
    return makeBundleChild(bundleExit);
  };
  const exists = (p: string) => {
    if (p === hermesc) return hermescExists;
    if (p === bundleOutput) return bundleWritten;
    return existsSync(p);
  };
  const writer = makeWriter();
  const run = (overrides: Record<string, unknown> = {}) =>
    swapApkBundle({
      root,
      isExpo: true,
      cachedApkPath: cachedApk,
      keystore,
      logWriter: writer,
      exec,
      spawnFn,
      mkdtemp: () => tmp,
      exists,
      buildTools,
      storedAssets: stored,
      readManifest: () => fresh,
      heartbeatMs: 0,
      ...overrides,
    });
  return { calls, run, work, final, stage, bundleOutput, hermesc, writer };
}

describe('swapApkBundle', () => {
  test('the order IS the product: copy aside, bundle, hermesc, asset gate, zip -d, zip -0, zipalign, apksigner -- and the cache entry is never written', async () => {
    const { calls, run, work, final, stage, hermesc } = harness();
    const result = await run();
    expect(result.ok).toBe(true);
    expect(result.apkPath).toBe(final);
    expect(result.tmpDir).toBe(tmp);
    expect(result.hermes).toBe(true);

    expect(calls.map((c) => c.file)).toEqual(['cp', 'npx', hermesc, 'mv', 'zip', 'zip', buildTools.path, apksigner]);

    expect(calls[0]?.args).toEqual(['-c', cachedApk, work]);
    for (const call of calls.slice(1)) expect(call.args ?? []).not.toContain(cachedApk);

    const bundle = calls[1];
    expect(bundle?.args?.slice(0, 4)).toEqual(['expo', 'export:embed', '--platform', 'android']);
    expect(bundle?.args).toContain(join(stage, 'assets', ANDROID_BUNDLE_NAME));
    expect(bundle?.args).toContain(join(stage, 'res'));

    expect(calls.some((c) => c.file === 'unzip')).toBe(false);

    expect(calls[4]?.args).toEqual(['-d', work, ANDROID_BUNDLE_ENTRY]);
    expect(calls[5]?.args).toEqual(['-0', '-r', work, 'assets']);
    expect(calls[5]?.opts).toEqual({ cwd: stage });

    expect(calls[6]?.args).toEqual(['-P', '16', '-f', '-v', '4', work, final]);
    expect(calls[7]?.args).toEqual(['sign', '--ks', keystore.path, '--ks-pass', 'pass:android', final]);
  });

  test('bare project: the bundle step is `react-native bundle` with the detected entry file', async () => {
    const { calls, run } = harness();
    const result = await run({ isExpo: false });
    expect(result.ok).toBe(true);
    const bundle = calls.find((c) => c.op === 'spawn');
    expect(bundle?.args?.slice(0, 2)).toEqual(['react-native', 'bundle']);
    expect(bundle?.args).toContain('--entry-file');
  });

  test('hermes off (gradle.properties says false) skips hermesc entirely', async () => {
    const { calls, run, hermesc } = harness();
    const result = await run({ hermesEnabled: false });
    expect(result.ok).toBe(true);
    expect(result.hermes).toBe(false);
    expect(calls.some((c) => c.file === hermesc)).toBe(false);
  });

  test('hermesc missing is the GUARD, not a failure: plain JS bundle plus a note', async () => {
    const { calls, run, hermesc } = harness({ hermescExists: false });
    const result = await run();
    expect(result.ok).toBe(true);
    expect(result.hermes).toBe(false);
    expect(result.note).toMatch(/hermesc not found/);
    expect(calls.some((c) => c.file === hermesc)).toBe(false);
    expect(calls.at(-1)?.file).toBe(apksigner);
  });

  test('THE ASSET GATE: an asset this run emits and the cached build did not refuses the swap and names it -- nothing is repacked', async () => {
    const { calls, run } = harness({
      fresh: manifest({
        'drawable-mdpi/logo.png': LOGO,
        'raw/sound.mp3': SOUND,
        'drawable-mdpi/brand_new.png': 'c'.repeat(64),
      }),
    });
    const result = await run();
    expect(result.ok).toBeUndefined();
    expect(result.failed).toBeUndefined();
    expect(result.assetMismatch).toBe(true);
    expect(result.assetDiff?.added).toEqual(['drawable-mdpi/brand_new.png']);
    expect(result.reason).toMatch(/added drawable-mdpi\/brand_new\.png/);
    expect(calls.some((c) => c.file === 'zip')).toBe(false);
    expect(calls.some((c) => c.file === buildTools.path)).toBe(false);
    expect(calls.some((c) => c.file === apksigner)).toBe(false);
  });

  test('an asset the cached build emitted and this one no longer does refuses the swap too', async () => {
    const { run } = harness({ fresh: manifest({ 'drawable-mdpi/logo.png': LOGO }) });
    const result = await run();
    expect(result.assetMismatch).toBe(true);
    expect(result.assetDiff?.removed).toEqual(['raw/sound.mp3']);
  });

  test('CONTENT: a REPLACED image under an unchanged filename refuses the swap -- the old blind spot', async () => {
    const { calls, run } = harness({
      fresh: manifest({ 'drawable-mdpi/logo.png': 'd'.repeat(64), 'raw/sound.mp3': SOUND }),
    });
    const result = await run();
    expect(result.assetMismatch).toBe(true);
    expect(result.assetDiff?.added).toEqual([]);
    expect(result.assetDiff?.removed).toEqual([]);
    expect(result.assetDiff?.changed).toEqual(['drawable-mdpi/logo.png']);
    expect(result.reason).toMatch(/changed drawable-mdpi\/logo\.png/);
    expect(calls.some((c) => c.file === apksigner)).toBe(false);
  });

  test('an entry with NO manifest is never swapped, and says so distinctly', async () => {
    const { calls, run } = harness({ stored: null });
    const result = await run();
    expect(result.assetMismatch).toBe(true);
    expect(result.assetDiff).toBeUndefined();
    expect(result.reason).toMatch(/predates asset tracking/);
    expect(calls.some((c) => c.file === 'zip')).toBe(false);
    expect(calls.some((c) => c.file === apksigner)).toBe(false);
  });

  test('emitted assets that cannot be hashed fail the gate rather than swapping blind', async () => {
    const { run } = harness({ fresh: null });
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.step).toBe('assets');
  });

  test('a failed bundle command is a return value naming the step, and nothing downstream runs', async () => {
    const { calls, run } = harness({ bundleExit: 1 });
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.step).toBe('bundle');
    expect(result.lastLines).toEqual(['Writing bundle output...']);
    expect(calls.some((c) => c.file === apksigner)).toBe(false);
  });

  test('a bundle that exits 0 without writing the file is still a bundle failure', async () => {
    const { run } = harness({ bundleWritten: false });
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.step).toBe('bundle');
    expect(result.reason).toMatch(/wrote no index\.android\.bundle/);
  });

  test('a hermesc crash fails at the hermesc step', async () => {
    const hermesc = androidHermescPath(root, { exists: () => false });
    const { run } = harness({ failOn: hermesc });
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.step).toBe('hermesc');
  });

  test('zip -d on an archive with no bundle entry is tolerated, and the swap continues', async () => {
    const calls: Call[] = [];
    const exec = makeExecutor({
      runFile: (file: string, args: string[] = []) => {
        calls.push({ op: 'runFile', file, args });
        if (file === 'zip' && args[0] === '-d') throw new Error('zip error: Nothing to do! (app.apk)');
        return '';
      },
    });
    const { run } = harness();
    const result = await run({ exec });
    expect(result.ok).toBe(true);
    expect(calls.at(-1)?.file).toBe(apksigner);
  });

  test('any OTHER zip failure fails at the zip step', async () => {
    const calls: Call[] = [];
    const exec = makeExecutor({
      runFile: (file: string, args: string[] = []) => {
        calls.push({ op: 'runFile', file, args });
        if (file === 'zip' && args[0] === '-0') throw new Error('zip I/O error: No space left on device');
        return '';
      },
    });
    const { run } = harness();
    const result = await run({ exec });
    expect(result.failed).toBe(true);
    expect(result.step).toBe('zip');
  });

  test('a zipalign failure fails at the zipalign step, and nothing is signed', async () => {
    const { calls, run } = harness({ failOn: buildTools.path });
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.step).toBe('zipalign');
    expect(calls.some((c) => c.file === apksigner)).toBe(false);
  });

  test('an apksigner failure fails at the apksigner step -- an unsigned APK is never handed back', async () => {
    const { run } = harness({ failOn: apksigner });
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.step).toBe('apksigner');
    expect(result.apkPath).toBeUndefined();
  });

  test('no zipalign under build-tools is a named failure, not a crash', async () => {
    const { run } = harness();
    const result = await run({ buildTools: null, findTool: () => null });
    expect(result.failed).toBe(true);
    expect(result.step).toBe('zipalign');
    expect(result.reason).toMatch(/sdkmanager/);
  });

  test('the clone-first copy falls back to a plain cp when -c is refused', async () => {
    const calls: Call[] = [];
    let first = true;
    const exec = makeExecutor({
      runFile: (file: string, args: string[] = []) => {
        calls.push({ op: 'runFile', file, args });
        if (file === 'cp' && first) {
          first = false;
          throw new Error('cp: -c not supported');
        }
        return '';
      },
    });
    const { run, work } = harness();
    const result = await run({ exec });
    expect(result.ok).toBe(true);
    expect(calls[0]?.args?.[0]).toBe('-c');
    expect(calls[1]?.args).toEqual([cachedApk, work]);
  });
});
