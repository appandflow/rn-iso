// engine/apk-swap: fresh JS into a cached release APK.
//
// The pure pieces (the hermes decision, the hermesc probe order, the bundle
// argv, the zip listing parse, the ASSET GATE, zipalign's version-gated argv,
// keystore resolution) are asserted as data. swapApkBundle itself is asserted
// for ORDER through injected seams -- copy aside, bundle, hermesc, asset
// gate, zip -d, zip -0, zipalign, apksigner -- and for the guarantee every
// non-ok shape shares: a return value naming what happened, never a throw,
// because the caller's answer to all of them is the same safe fallback
// (build fresh).
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANDROID_BUNDLE_ENTRY,
  ANDROID_BUNDLE_NAME,
  androidBundleCommand,
  androidHermescArgs,
  androidHermescPath,
  apksignerArgs,
  compareAssetSets,
  hermesEnabledFromGradleProperties,
  hermescBinDir,
  hermescCandidates,
  isBundledAssetEntry,
  isNothingToDelete,
  keystorePassArg,
  listApkEntries,
  listStagedAssets,
  normalizeResEntryName,
  parseZipListing,
  readAndroidHermesEnabled,
  resolveKeystore,
  sizeIsComparable,
  swapApkBundle,
  zipalignArgs,
  type AssetEntry,
} from '../engine/apk-swap.ts';
import type { BuildToolsEntry } from '../sim/android.ts';
import { makeChildProcess, makeExecutor, makeWriter } from './_factories.ts';

// --- hermes ----------------------------------------------------------------

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
    const dir = mkdtempSync(join(tmpdir(), 'rn-iso-apk-swap-'));
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

// --- the bundle command ----------------------------------------------------

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

// --- the archive listing ---------------------------------------------------

describe('parseZipListing', () => {
  const verbose = [
    'Archive:  app-release.apk',
    ' Length   Method    Size  Cmpr    Date    Time   CRC-32   Name',
    '--------  ------  ------- ---- ---------- ----- --------  ----',
    '    4108  Defl:N     1234  70% 2026-08-27 10:11 1a2b3c4d  res/drawable-mdpi-v4/node_modules_logo.png',
    '  912344  Stored   912344   0% 2026-08-27 10:11 aabbccdd  assets/index.android.bundle',
    '       0  Stored        0   0% 2026-08-27 10:11 00000000  res/raw/',
    '--------          ------- ---                            -------',
    '  916452           913578   0%                            3 files',
  ].join('\n');

  test('unzip -v gives the name, the uncompressed length and the CRC', () => {
    expect(parseZipListing(verbose)).toEqual([
      { name: 'res/drawable-mdpi-v4/node_modules_logo.png', size: 4108, crc: '1a2b3c4d' },
      { name: 'assets/index.android.bundle', size: 912344, crc: 'aabbccdd' },
    ]);
  });

  test('unzip -l is parsed too, with no CRC to report', () => {
    const short = [
      'Archive:  app-release.apk',
      '  Length      Date    Time    Name',
      '---------  ---------- -----   ----',
      '     4108  2026-08-27 10:11   res/drawable-mdpi-v4/my logo.png',
      '---------                     -------',
      '     4108                     1 file',
    ].join('\n');
    expect(parseZipListing(short)).toEqual([{ name: 'res/drawable-mdpi-v4/my logo.png', size: 4108, crc: null }]);
  });

  test('a listing that cannot be taken at all is null, not an empty archive', () => {
    const exec = makeExecutor({
      runFile: () => {
        throw new Error('unzip: cannot find or open /nope.apk');
      },
    });
    expect(listApkEntries('/nope.apk', { exec })).toBe(null);
    expect(parseZipListing(null)).toEqual([]);
  });
});

// --- THE ASSET GATE --------------------------------------------------------

describe('the asset gate', () => {
  test("AAPT's API-level qualifier on a resource directory is normalized away, not counted as a change", () => {
    expect(normalizeResEntryName('res/drawable-mdpi-v4/logo.png')).toBe('res/drawable-mdpi/logo.png');
    expect(normalizeResEntryName('res/drawable-xxhdpi-v4/logo.png')).toBe('res/drawable-xxhdpi/logo.png');
    expect(normalizeResEntryName('res/raw/sound.mp3')).toBe('res/raw/sound.mp3');
    // Not a resource directory qualifier: a file that merely ends in -v4.
    expect(normalizeResEntryName('res/raw/clip-v4.mp3')).toBe('res/raw/clip-v4.mp3');
  });

  test('the APK side is scoped to the directories --assets-dest writes into', () => {
    expect(isBundledAssetEntry('res/drawable-mdpi-v4/logo.png')).toBe(true);
    expect(isBundledAssetEntry('res/raw/sound.mp3')).toBe(true);
    // The app's OWN resources, which the emitted tree never produces: counting
    // them would report every launcher icon and layout as "removed".
    expect(isBundledAssetEntry('res/mipmap-hdpi-v4/ic_launcher.png')).toBe(false);
    expect(isBundledAssetEntry('res/layout/main.xml')).toBe(false);
    expect(isBundledAssetEntry('res/drawable/rn_edit_text_material.xml')).toBe(false);
    expect(isBundledAssetEntry('assets/index.android.bundle')).toBe(false);
  });

  test('sizes are comparable only where AAPT stores the file verbatim', () => {
    // res/raw is stored byte for byte; a drawable is re-encoded by AAPT's PNG
    // cruncher on a release build, so its packaged length is the length of a
    // different file and comparing it would reject every cache hit.
    expect(sizeIsComparable('res/raw/sound.mp3')).toBe(true);
    expect(sizeIsComparable('res/drawable-mdpi-v4/logo.png')).toBe(false);
  });

  const emitted: AssetEntry[] = [
    { name: 'res/drawable-mdpi/logo.png', size: 100 },
    { name: 'res/raw/sound.mp3', size: 200 },
  ];
  const packaged: AssetEntry[] = [
    { name: 'res/drawable-mdpi-v4/logo.png', size: 88 },
    { name: 'res/raw/sound.mp3', size: 200 },
  ];

  test('the unchanged case: the same set, modulo the AAPT qualifier and the PNG cruncher', () => {
    const diff = compareAssetSets(emitted, packaged);
    expect(diff).toEqual({ same: true, added: [], removed: [], changed: [], example: null });
  });

  test('ADDED -- a fresh require() the cached APK cannot serve. THE case this gate exists for', () => {
    const diff = compareAssetSets([...emitted, { name: 'res/drawable-mdpi/new.png', size: 50 }], packaged);
    expect(diff.same).toBe(false);
    expect(diff.added).toEqual(['res/drawable-mdpi/new.png']);
    expect(diff.example).toBe('res/drawable-mdpi/new.png');
  });

  test('REMOVED -- an asset the cached APK carries and this bundle no longer emits', () => {
    const diff = compareAssetSets([emitted[0]!], packaged);
    expect(diff.same).toBe(false);
    expect(diff.removed).toEqual(['res/raw/sound.mp3']);
    expect(diff.added).toEqual([]);
    expect(diff.example).toBe('res/raw/sound.mp3');
  });

  test('CHANGED -- same name, different bytes, where the size is comparable', () => {
    const diff = compareAssetSets([emitted[0]!, { name: 'res/raw/sound.mp3', size: 999 }], packaged);
    expect(diff.same).toBe(false);
    expect(diff.changed).toEqual(['res/raw/sound.mp3']);
    expect(diff.example).toBe('res/raw/sound.mp3');
  });

  test('a size difference on a drawable is NOT a change: AAPT re-encoded it', () => {
    expect(compareAssetSets(emitted, packaged).same).toBe(true);
    // ... and the comparability rule is injectable, so a caller that knows the
    // packaging kept the bytes can compare everything.
    const strict = compareAssetSets(emitted, packaged, { comparableSize: () => true });
    expect(strict.changed).toEqual(['res/drawable-mdpi/logo.png']);
  });

  test('listStagedAssets walks the emitted tree into archive-relative entries', () => {
    const stage = mkdtempSync(join(tmpdir(), 'rn-iso-apk-stage-'));
    try {
      mkdirSync(join(stage, 'res', 'drawable-mdpi'), { recursive: true });
      mkdirSync(join(stage, 'res', 'raw'), { recursive: true });
      writeFileSync(join(stage, 'res', 'drawable-mdpi', 'logo.png'), 'png');
      writeFileSync(join(stage, 'res', 'raw', 'sound.mp3'), 'mp3!!');
      expect(listStagedAssets(join(stage, 'res'))).toEqual([
        { name: 'res/drawable-mdpi/logo.png', size: 3 },
        { name: 'res/raw/sound.mp3', size: 5 },
      ]);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
    expect(listStagedAssets('/nope/never/here')).toEqual([]);
  });
});

// --- zip, align, sign ------------------------------------------------------

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
    // An unparseable version takes the older branch, which every zipalign has.
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

// --- swapApkBundle orchestration -------------------------------------------

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
  root = mkdtempSync(join(tmpdir(), 'rn-iso-apk-root-'));
  tmp = mkdtempSync(join(tmpdir(), 'rn-iso-apk-tmp-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

// A bundle child that streams a line and exits with `code`.
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

// The APK's own listing, as `unzip -v` prints it. The drawable carries the
// AAPT `-v4` qualifier and a crunched length, which is exactly the pair the
// gate has to see through.
const APK_LISTING = [
  ' Length   Method    Size  Cmpr    Date    Time   CRC-32   Name',
  '--------  ------  ------- ---- ---------- ----- --------  ----',
  '      88  Defl:N       40  55% 2026-08-27 10:11 1a2b3c4d  res/drawable-mdpi-v4/logo.png',
  '  912344  Stored   912344   0% 2026-08-27 10:11 aabbccdd  assets/index.android.bundle',
  '   12000  Defl:N     6000  50% 2026-08-27 10:11 99887766  res/mipmap-hdpi-v4/ic_launcher.png',
].join('\n');

function harness({
  bundleExit = 0,
  failOn = null as string | null,
  hermescExists = true,
  bundleWritten = true,
  listing = APK_LISTING,
  staged = [{ name: 'res/drawable-mdpi/logo.png', size: 100 }] as AssetEntry[],
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
      if (file === 'unzip') return listing;
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
      listAssets: () => staged,
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

    expect(calls.map((c) => c.file)).toEqual([
      'cp',
      'npx',
      hermesc,
      'mv',
      'unzip',
      'zip',
      'zip',
      buildTools.path,
      apksigner,
    ]);

    // The copy aside clones first, and it is the ONLY call that names the
    // cache entry: everything after it works on the temp copy.
    expect(calls[0]?.args).toEqual(['-c', cachedApk, work]);
    for (const call of calls.slice(1)) expect(call.args ?? []).not.toContain(cachedApk);

    // The bundle is this workspace's, exported for android, staged in the
    // ARCHIVE LAYOUT so `zip -r assets` puts it back where the runtime looks.
    const bundle = calls[1];
    expect(bundle?.args?.slice(0, 4)).toEqual(['expo', 'export:embed', '--platform', 'android']);
    expect(bundle?.args).toContain(join(stage, 'assets', ANDROID_BUNDLE_NAME));
    expect(bundle?.args).toContain(join(stage, 'res'));

    // The gate reads the copy, not the cache entry.
    expect(calls[4]?.args).toEqual(['-v', work]);

    // zip -d out, then zip -0 (STORE, mandatory) in from the staging dir.
    expect(calls[5]?.args).toEqual(['-d', work, ANDROID_BUNDLE_ENTRY]);
    expect(calls[6]?.args).toEqual(['-0', '-r', work, 'assets']);
    expect(calls[6]?.opts).toEqual({ cwd: stage });

    // Align BEFORE sign, and the signature covers the aligned file.
    expect(calls[7]?.args).toEqual(['-P', '16', '-f', '-v', '4', work, final]);
    expect(calls[8]?.args).toEqual(['sign', '--ks', keystore.path, '--ks-pass', 'pass:android', final]);
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
    // The plain bundle still lands in the copy and the copy is still signed.
    expect(calls.at(-1)?.file).toBe(apksigner);
  });

  test('THE ASSET GATE: a fresh asset the APK lacks refuses the swap and names it -- nothing is repacked', async () => {
    const { calls, run } = harness({
      staged: [
        { name: 'res/drawable-mdpi/logo.png', size: 100 },
        { name: 'res/drawable-mdpi/brand_new.png', size: 40 },
      ],
    });
    const result = await run();
    expect(result.ok).toBeUndefined();
    expect(result.failed).toBeUndefined();
    expect(result.assetMismatch).toBe(true);
    expect(result.assetDiff?.added).toEqual(['res/drawable-mdpi/brand_new.png']);
    expect(result.reason).toMatch(/added res\/drawable-mdpi\/brand_new\.png/);
    // Not one byte was written into the archive.
    expect(calls.some((c) => c.file === 'zip')).toBe(false);
    expect(calls.some((c) => c.file === buildTools.path)).toBe(false);
    expect(calls.some((c) => c.file === apksigner)).toBe(false);
  });

  test('an asset the APK carries and this bundle no longer emits refuses the swap too', async () => {
    const { run } = harness({ staged: [] });
    const result = await run();
    expect(result.assetMismatch).toBe(true);
    expect(result.assetDiff?.removed).toEqual(['res/drawable-mdpi/logo.png']);
    // The app's own launcher icon is NOT counted: it is outside the
    // directories --assets-dest writes into.
    expect(result.assetDiff?.removed).not.toContain('res/mipmap-hdpi/ic_launcher.png');
  });

  test('an APK whose entries cannot be listed fails the gate rather than swapping blind', async () => {
    const { run } = harness();
    const result = await run({ listEntries: () => null });
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
        if (file === 'unzip') return APK_LISTING;
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
        if (file === 'unzip') return APK_LISTING;
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
        if (file === 'unzip') return APK_LISTING;
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
