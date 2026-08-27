// src/engine/apk-swap.js -- fresh JS into a cached release APK.
//
// The Android half of what engine/js-swap.js does for iOS, and it exists for
// exactly the same reason: the build cache is keyed on the NATIVE
// fingerprint, which is right for a Debug artifact (its JS comes from Metro
// at runtime) and WRONG for a release one (its JS is baked in at build time).
// A native-keyed cache hit on a release variant is an APK carrying whatever
// JS the workspace that built it had, so installing it as-is silently runs
// someone else's code. This module makes the release cache honest: copy the
// cached APK aside, regenerate the bundle from THIS workspace's tree with the
// project's own tools, compile it with the project's own hermesc, replace the
// bundle entry inside the copy, re-align it and re-sign it, and hand the copy
// back for install.
//
// An .app is a DIRECTORY, so js-swap can `cp` files into it. An APK is a ZIP,
// so this one does zip surgery -- `zip -d` the old bundle entry out, `zip -0
// -r` the new one in from a staging directory that mirrors the archive
// layout. `-0` (store, no compression) is MANDATORY: AGP stores
// assets/index.android.bundle uncompressed so the Hermes runtime can mmap it,
// and a deflated bundle fails to load. Then zipalign BEFORE apksigner, in
// that order, because a v2/v3 signature covers the whole file and aligning
// after signing invalidates it. `zip` is spawned rather than a zip library
// added: rn-iso is macOS/Linux-only by charter and shelling through the
// executor wrapper is what the rest of the codebase does.
//
// Reimplementation, not reconstruction (CLAUDE.md item 3): the bundle command
// is a FIXED argument list this file composes -- `expo export:embed` for an
// Expo project, `react-native bundle` for a bare one, exactly what AGP's
// bundle task runs -- never a package.json script it inferred.
//
// THE ASSET GATE is the deliberate divergence from Rock (which re-injects
// only the bundle and discards the freshly emitted assets, so a new
// `require('./new.png')` 404s at runtime in its re-signed builds). It does
// NOT read the APK: engine/asset-manifest.ts explains why the res/ table is
// unusable (AGP shortens every resource path on a release build, and the
// drawables that survive are mostly AndroidX's). It compares what THIS
// workspace just emitted against the manifest the build behind the cache
// entry recorded of what IT emitted -- same producer, same layout, hashed --
// so an added, removed OR REPLACED asset all refuse the swap, and an entry
// with no manifest is never swapped at all.
//
// Nothing here throws on a tool failure. Every outcome is a return value --
// { ok, apkPath }, { assetMismatch }, or { failed, step, reason } -- because
// the caller's answer to all of them is the same and always safe: fall back
// to a full gradle build. Stale JS is never installed.
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { getExecutor, type Executor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import type { SettingsObject } from '../types.ts';
import { findBuildTool, type BuildToolsEntry } from '../sim/android.ts';
import { cleanLine, createLineReader } from '../supervisor/server-expo.ts';
import {
  assetDiffReason,
  compareAssetManifests,
  readAssetManifest,
  type AssetManifest,
  type AssetManifestDiff,
} from './asset-manifest.ts';
import { waitForChild } from './deps.ts';
import { detectEntryFile } from './js-swap.ts';
import { HEARTBEAT_INTERVAL_MS, startBuildHeartbeat, tailLines } from './xcode.ts';

// The bundle entry AGP packages and the runtime loads. Fixed by
// ReactNativeHost#getBundleAssetName's default and by the bundle task alike.
export const ANDROID_BUNDLE_NAME = 'index.android.bundle';
export const ANDROID_BUNDLE_ENTRY: string = `assets/${ANDROID_BUNDLE_NAME}`;

// How many transcript lines a failed bundle step carries back for the caller
// to print; the full transcript is in the build log.
const LAST_LINES = 5;

// --- hermes ---------------------------------------------------------------

// PURE. Whether this project builds its JS for Hermes, from the text of
// android/gradle.properties. That file is how Expo prebuild records the
// choice and how react-native-gradle-plugin reads it back; the ONLY value
// that disables Hermes is the literal `false`, and an absent key, an absent
// file or an unreadable one all mean the default: enabled.
//
// A .properties file may set a key more than once and the LAST assignment
// wins (java.util.Properties loads top to bottom), so this reads them all.
export function hermesEnabledFromGradleProperties(text: unknown): boolean {
  if (typeof text !== 'string') return true;
  let value: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    const match = /^hermesEnabled\s*[=:]\s*(.*)$/.exec(line);
    if (match) value = match[1]!.trim();
  }
  return value === null || value.toLowerCase() !== 'false';
}

// Thin. The file the pure decision reads.
export function readAndroidHermesEnabled(root: string): boolean {
  try {
    return hermesEnabledFromGradleProperties(readFileSync(join(root, 'android', 'gradle.properties'), 'utf-8'));
  } catch {
    return true;
  }
}

// PURE. The host directory name inside a hermesc distribution. macOS and
// Linux are the only platforms rn-iso supports (charter), and those are the
// only two names the packages ship.
export function hermescBinDir(platform: string = process.platform): string {
  return platform === 'darwin' ? 'osx-bin' : 'linux64-bin';
}

// PURE. Every place the project's own hermesc can be, newest layout first.
//
// The compiler MUST be the one that matches the react-native the app is built
// from: a bundle compiled by a different hermesc version aborts at load with a
// bytecode version mismatch. Rock's trick, adopted here, is the first
// candidate: hermes-compiler is a SIBLING of the react-native package the
// project actually resolves, so deriving it from react-native's own directory
// finds it in a pnpm store or a monorepo where the project root's
// node_modules holds neither. The remaining legs are the pre-0.8x locations,
// and the last one is hermes built from source in the react-native checkout.
export function hermescCandidates(
  root: string,
  { platform = process.platform, reactNativePath = null }: { platform?: string; reactNativePath?: string | null } = {},
): string[] {
  const bin = hermescBinDir(platform);
  const rn = reactNativePath ?? join(root, 'node_modules', 'react-native');
  return [
    ...new Set([
      join(dirname(rn), 'hermes-compiler', 'hermesc', bin, 'hermesc'),
      join(root, 'node_modules', 'hermes-compiler', 'hermesc', bin, 'hermesc'),
      join(root, 'node_modules', 'react-native', 'sdks', 'hermesc', bin, 'hermesc'),
      join(root, 'node_modules', 'react-native', 'sdks', 'hermes', 'build', 'bin', 'hermesc'),
    ]),
  ];
}

// The first candidate that exists, or the last one so the caller's own
// existence guard has a path to name in its note.
export function androidHermescPath(
  root: string,
  {
    exists = existsSync,
    platform = process.platform,
    reactNativePath = null,
  }: { exists?: (p: string) => boolean; platform?: string; reactNativePath?: string | null } = {},
): string {
  const candidates = hermescCandidates(root, { platform, reactNativePath });
  return candidates.find(exists) ?? candidates[candidates.length - 1]!;
}

// PURE. hermesc's argv for an Android release bundle: optimized (-O),
// warnings suppressed (-w, because a release export's warnings are noise on
// stderr that the build task itself discards), bytecode out, JS in. AGP's
// own hermesFlags default is exactly `-O -w`.
export function androidHermescArgs({ bundle, out }: { bundle: string; out: string }): string[] {
  return ['-emit-binary', '-O', '-w', '-out', out, bundle];
}

// --- the bundle command ---------------------------------------------------

// PURE. The exact bundle invocation, as data, so a test asserts the argv
// without running Metro. Both are `npx` of the PROJECT's own CLI, resolved
// from its node_modules by npx's local-first rule, with the same fixed flags
// AGP's bundle task passes: --dev false is what makes this a release bundle.
export function androidBundleCommand({
  isExpo,
  entryFile,
  bundleOutput,
  assetsDest,
}: {
  isExpo: boolean;
  entryFile: string;
  bundleOutput: string;
  assetsDest: string;
}): { file: string; args: string[] } {
  if (isExpo) {
    return {
      file: 'npx',
      args: [
        'expo',
        'export:embed',
        '--platform',
        'android',
        '--dev',
        'false',
        '--bundle-output',
        bundleOutput,
        '--assets-dest',
        assetsDest,
      ],
    };
  }
  return {
    file: 'npx',
    args: [
      'react-native',
      'bundle',
      '--platform',
      'android',
      '--dev',
      'false',
      '--entry-file',
      entryFile,
      '--bundle-output',
      bundleOutput,
      '--assets-dest',
      assetsDest,
    ],
  };
}

// --- zip surgery, alignment, signing --------------------------------------

// PURE. `zip -d` on an archive that does not carry the entry exits non-zero
// with "Nothing to do!" -- which is not a failure here: a cached APK built
// without an embedded bundle (or one this run already stripped) is fine to
// add the fresh bundle to. Every OTHER zip failure is real.
export function isNothingToDelete(text: unknown): boolean {
  return /nothing to do|name not matched|no matches found/i.test(String(text ?? ''));
}

// PURE. zipalign's argv, in the order it takes them.
//
// `-p` page-aligns uncompressed .so files to 4KB. Build-tools 35 replaced it
// with `-P <kb>`, and 16 is what a 16KB-page device (every arm64 Android 15+
// device) requires -- an APK whose .so segments are 4KB-aligned will not load
// there at all. Both spellings exist because the flag a machine's zipalign
// accepts depends on which build-tools it has installed.
// `-f` overwrites the output, `-v` prints the verification, `4` is the
// alignment in bytes, and the paths are in then out (zipalign refuses to
// align in place).
export function zipalignArgs({
  buildToolsMajor,
  input,
  output,
}: {
  buildToolsMajor: number;
  input: string;
  output: string;
}): string[] {
  return [...(buildToolsMajor >= 35 ? ['-P', '16'] : ['-p']), '-f', '-v', '4', input, output];
}

// The keystore a re-packed APK is signed with, and the --ks-pass argument
// that opens it.
export interface KeystoreConfig {
  path: string;
  pass: string;
}

// PURE. apksigner's --ks-pass takes a SCHEMED value (`pass:`, `file:`, `env:`,
// `stdin`). A setting that already names a scheme is passed through -- so a
// repo can keep its password in an env var rather than in a committed JSON
// file -- and a bare string is treated as the literal password.
export function keystorePassArg(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return 'pass:android';
  if (/^(?:pass|file|env):/.test(text) || text === 'stdin') return text;
  return `pass:${text}`;
}

// The keystore for THIS project. The default is the debug keystore every RN
// and Expo Android project carries, with its fixed password -- which is the
// right default because what this signs is a locally re-packed APK for an
// emulator, never anything distributed. `android.keystore` (absolute, or
// relative to the project root) and `android.keystorePassword` override it
// for a repo whose release variant must be signed with its own key.
export function resolveKeystore(root: string, settings: SettingsObject | null | undefined): KeystoreConfig {
  const android = settings?.['android'];
  const bag = android && typeof android === 'object' && !Array.isArray(android) ? (android as SettingsObject) : {};
  const configured = bag['keystore'];
  const path =
    typeof configured === 'string' && configured.trim() !== ''
      ? configured.trim().startsWith('/')
        ? configured.trim()
        : join(root, configured.trim())
      : join(root, 'android', 'app', 'debug.keystore');
  return { path, pass: keystorePassArg(bag['keystorePassword']) };
}

// PURE. apksigner's argv. NEVER jarsigner: jarsigner writes a v1 (JAR)
// signature only, and Android 11+ refuses to install an APK with no v2
// signature whose minSdk is 30 or higher.
export function apksignerArgs({ keystore, apkPath }: { keystore: KeystoreConfig; apkPath: string }): string[] {
  return ['sign', '--ks', keystore.path, '--ks-pass', keystore.pass, apkPath];
}

// --- the swap -------------------------------------------------------------

type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess;

// The all-optional view of swapApkBundle's outcomes.
export type ApkSwapResult = {
  ok?: boolean;
  // The re-packed, re-aligned, re-signed copy to install, and the temp dir it
  // lives in (the caller may remove it once the install is done).
  apkPath?: string;
  tmpDir?: string;
  // Whether the embedded bundle is Hermes bytecode. false + note when the
  // project wants Hermes but its hermesc is missing.
  hermes?: boolean;
  note?: string;
  durationMs?: number;
  // The ASSET GATE refused. NOT an error -- the caller builds fresh, which is
  // the only way to get an APK whose res/ matches the fresh bundle. assetDiff
  // is absent when the refusal was "this entry has no manifest to compare
  // against"; `reason` says which of the two it was either way.
  assetMismatch?: boolean;
  assetDiff?: AssetManifestDiff;
  failed?: boolean;
  // Which step died: 'copy' | 'bundle' | 'hermesc' | 'assets' | 'zip' |
  // 'zipalign' | 'apksigner'.
  step?: string;
  reason?: string;
  lastLines?: string[];
};

/**
 * Copy the cached release APK, regenerate this workspace's JS into it, and
 * re-align and re-sign the copy. Resolves to { ok, apkPath, tmpDir, hermes },
 * { assetMismatch, assetDiff } or { failed, step, reason } -- never throws on
 * a tool failure, because every one of them has the same safe answer: build
 * fresh instead.
 */
export async function swapApkBundle({
  root,
  isExpo,
  cachedApkPath,
  keystore,
  logWriter = null,
  exec = null,
  spawnFn = null,
  mkdtemp = () => mkdtempSync(join(tmpdir(), 'rn-iso-apk-swap-')),
  exists = existsSync,
  hermesEnabled = null,
  buildTools = null,
  findTool = findBuildTool,
  storedAssets = null,
  readManifest = readAssetManifest,
  now = Date.now,
  heartbeatMs = HEARTBEAT_INTERVAL_MS,
  onHeartbeat = (line: string) => console.error(line),
}: {
  root: string;
  isExpo: boolean;
  cachedApkPath: string;
  keystore: KeystoreConfig;
  logWriter?: NdjsonWriter | null;
  exec?: Executor | null;
  spawnFn?: SpawnFn | null;
  mkdtemp?: () => string;
  exists?: (p: string) => boolean;
  hermesEnabled?: boolean | null;
  buildTools?: BuildToolsEntry | null;
  findTool?: typeof findBuildTool;
  // The manifest the build behind this cache entry recorded of the assets IT
  // emitted (build-cache.ts's storedAssetManifest). Null means the entry
  // predates asset tracking, and such an entry is never swapped.
  storedAssets?: AssetManifest | null;
  readManifest?: typeof readAssetManifest;
  now?: () => number;
  heartbeatMs?: number;
  onHeartbeat?: (line: string) => void;
}): Promise<ApkSwapResult> {
  const e = exec || getExecutor();
  const startedAt = now();
  const elapsed = () => now() - startedAt;
  const fail = (step: string, reason: string, lastLines: string[] = []): ApkSwapResult => {
    logWriter?.write?.({
      src: 'build',
      level: 'error',
      msg: `APK swap failed at ${step}: ${reason}`,
      event: 'apk_swap',
    });
    return { failed: true, step, reason, lastLines, durationMs: elapsed() };
  };

  // ---- copy the cached APK aside ----
  // The cache entry itself is never modified: it stays the pristine native
  // shell every workspace's swap starts from. Clone first (APFS
  // copy-on-write makes a several-hundred-MB APK cost milliseconds), plain
  // copy where clones cannot work. Two names, because zipalign refuses to
  // align an archive in place: the surgery happens on `work`, and `final` is
  // what zipalign writes and apksigner signs.
  let tmp: string;
  let work: string;
  let final: string;
  try {
    tmp = mkdtemp();
    const base = basename(cachedApkPath);
    work = join(tmp, `unaligned-${base}`);
    final = join(tmp, base);
    try {
      e.runFile('cp', ['-c', cachedApkPath, work]);
    } catch {
      e.runFile('cp', [cachedApkPath, work]);
    }
  } catch (err) {
    return fail('copy', `could not copy ${cachedApkPath} aside: ${describe(err)}`);
  }

  // ---- regenerate the JS bundle from THIS tree ----
  // The staging directory MIRRORS THE ARCHIVE LAYOUT (`<stage>/assets/...`,
  // `<stage>/res/...`), which is what lets `zip -0 -r <apk> assets` from
  // inside it write entries at the paths the runtime loads them from.
  const stage = join(tmp, 'stage');
  const bundleOutput = join(stage, 'assets', ANDROID_BUNDLE_NAME);
  const assetsDest = join(stage, 'res');
  const entryFile = isExpo ? 'index.js' : detectEntryFile(root);
  const command = androidBundleCommand({ isExpo, entryFile, bundleOutput, assetsDest });
  try {
    mkdirSync(join(stage, 'assets'), { recursive: true });
    mkdirSync(assetsDest, { recursive: true });
  } catch (err) {
    return fail('bundle', `could not create ${stage}: ${describe(err)}`);
  }

  logWriter?.write?.({
    src: 'build',
    level: 'info',
    msg: `${command.file} ${command.args.join(' ')}`,
    event: 'apk_swap',
  });

  // Streamed like every other long-running child here: a release export on a
  // big graph runs minutes, and the heartbeat is what separates that from a
  // hang.
  const spawn: SpawnFn = spawnFn || ((cmd, args, opts) => e.spawn(cmd, args, opts));
  const transcript: string[] = [];
  const push = (line: unknown) => {
    const msg = cleanLine(line);
    if (msg.trim() === '') return;
    transcript.push(msg);
    logWriter?.write?.({ src: 'build', level: 'debug', msg, raw: true, event: 'apk_swap' });
  };
  let child: ChildProcess;
  try {
    child = spawn(command.file, command.args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
  } catch (err) {
    return fail('bundle', `could not run ${command.file} ${command.args[0]}: ${describe(err)}`);
  }
  const reader = { out: createLineReader(push), err: createLineReader(push) };
  child.stdout?.setEncoding?.('utf-8');
  child.stderr?.setEncoding?.('utf-8');
  child.stdout?.on('data', (chunk) => reader.out.push(chunk));
  child.stderr?.on('data', (chunk) => reader.err.push(chunk));
  const stopHeartbeat = startBuildHeartbeat({
    intervalMs: heartbeatMs,
    elapsed,
    lastLine: () => transcript.at(-1) ?? '',
    emit: onHeartbeat,
    label: 'apk swap',
  });
  let outcome: Awaited<ReturnType<typeof waitForChild>>;
  try {
    outcome = await waitForChild(child);
  } finally {
    stopHeartbeat();
  }
  reader.out.flush();
  reader.err.flush();
  if (outcome.error) {
    return fail('bundle', `could not run ${command.file} ${command.args[0]}: ${describe(outcome.error)}`);
  }
  if (outcome.code !== 0) {
    const how = outcome.signal ? `signal ${outcome.signal}` : `exit code ${outcome.code}`;
    return fail(
      'bundle',
      `\`${command.args.slice(0, 2).join(' ')}\` failed (${how})`,
      tailLines(transcript, LAST_LINES),
    );
  }
  if (!exists(bundleOutput)) {
    return fail('bundle', `the bundle command exited 0 but wrote no ${ANDROID_BUNDLE_NAME} at ${bundleOutput}`);
  }

  // ---- hermes, with the project's own compiler ----
  let hermes = false;
  let note: string | undefined;
  const wantsHermes = hermesEnabled ?? readAndroidHermesEnabled(root);
  if (wantsHermes) {
    const hermesc = androidHermescPath(root);
    if (!exists(hermesc)) {
      // The guard, not a failure: the plain JS bundle still runs under Hermes
      // (it interprets JS source), it just loads slower than bytecode would.
      note = `hermesc not found at ${hermesc}; embedding the plain JS bundle instead of Hermes bytecode`;
    } else {
      const hbc = `${bundleOutput}.hbc`;
      try {
        e.runFile(hermesc, androidHermescArgs({ bundle: bundleOutput, out: hbc }));
        e.runFile('mv', [hbc, bundleOutput]);
        hermes = true;
      } catch (err) {
        return fail('hermesc', `hermesc failed on ${bundleOutput}: ${describe(err)}`);
      }
    }
  }

  // ---- THE ASSET GATE ----
  // Before anything is written into the archive. An Android drawable is not
  // just a file in the zip -- it has a row in resources.arsc that only AAPT
  // can write -- so an APK cannot be made to carry an asset it was not built
  // with, and the honest answer to any asset difference is not to swap.
  //
  // The comparison is emitted-now against emitted-then, NOT against the APK's
  // res/ table (engine/asset-manifest.ts records why that table cannot be
  // read). Two refusals, and the caller's answer to both is a full build:
  // no manifest to compare against, or a manifest that does not match.
  const refuse = (reason: string, assetDiff?: AssetManifestDiff): ApkSwapResult => {
    logWriter?.write?.({ src: 'build', level: 'warn', msg: `APK swap refused: ${reason}`, event: 'apk_swap' });
    const result: ApkSwapResult = { assetMismatch: true, reason, durationMs: elapsed() };
    if (assetDiff) result.assetDiff = assetDiff;
    return result;
  };
  if (!storedAssets) {
    return refuse(
      'this cache entry predates asset tracking (no assets-manifest.json beside the artifact), ' +
        'so its asset set cannot be proven to match this one',
    );
  }
  const fresh = readManifest(assetsDest);
  if (!fresh) {
    return fail('assets', `could not hash the assets emitted into ${assetsDest}, so the asset set cannot be verified`);
  }
  const diff = compareAssetManifests(fresh, storedAssets);
  if (!diff.same) return refuse(assetDiffReason(diff), diff);

  // ---- zip surgery ----
  // Delete the old entry first: `zip -0` would otherwise REPLACE it in place
  // and keep its original compression method, which for a bundle AGP stored
  // is fine but for one it deflated is not.
  try {
    e.runFile('zip', ['-d', work, ANDROID_BUNDLE_ENTRY]);
  } catch (err) {
    if (!isNothingToDelete(describe(err))) {
      return fail('zip', `zip -d ${ANDROID_BUNDLE_ENTRY} failed on ${work}: ${describe(err)}`);
    }
  }
  try {
    // -0 is STORE, and it is mandatory: AGP packages the bundle uncompressed
    // so the Hermes runtime can mmap it straight out of the APK, and a
    // deflated entry fails to load. cwd is the staging dir so `assets` names
    // the archive path.
    e.runFile('zip', ['-0', '-r', work, 'assets'], { cwd: stage });
  } catch (err) {
    return fail('zip', `zip -0 -r ${work} assets failed: ${describe(err)}`);
  }

  // ---- align, THEN sign ----
  // In that order, always: a v2/v3 signature covers the whole file, so
  // aligning a signed APK invalidates the signature it just verified.
  const tools = buildTools ?? findTool(['zipalign']);
  if (!tools) {
    return fail(
      'zipalign',
      'no zipalign found under the Android SDK build-tools; install one with `sdkmanager "build-tools;36.0.0"`',
    );
  }
  try {
    e.runFile(tools.path, zipalignArgs({ buildToolsMajor: tools.major, input: work, output: final }));
  } catch (err) {
    return fail('zipalign', `zipalign failed on ${work}: ${describe(err)}`);
  }

  const signer = buildTools
    ? { ...buildTools, path: join(dirname(buildTools.path), 'apksigner') }
    : findTool(['apksigner']);
  if (!signer) {
    return fail(
      'apksigner',
      'no apksigner found under the Android SDK build-tools; install one with `sdkmanager "build-tools;36.0.0"`',
    );
  }
  try {
    e.runFile(signer.path, apksignerArgs({ keystore, apkPath: final }));
  } catch (err) {
    return fail('apksigner', `apksigner sign failed on ${final} with ${keystore.path}: ${describe(err)}`);
  }

  logWriter?.write?.({
    src: 'build',
    level: 'info',
    msg: `APK swap done: ${hermes ? 'hermes bytecode' : 'plain JS'} into ${final} in ${elapsed()}ms`,
    event: 'apk_swap',
  });
  const result: ApkSwapResult = { ok: true, apkPath: final, tmpDir: tmp, hermes, durationMs: elapsed() };
  if (note) result.note = note;
  return result;
}

function describe(err: unknown): string {
  // execFileSync's thrown error carries the child's stderr, which is the
  // actual diagnostic ("Nothing to do!", "keystore password was incorrect")
  // while err.message alone is just the command line.
  const e = err as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const streams = [e?.stdout, e?.stderr]
    .map((s) => (s ? String(s).trim() : ''))
    .filter(Boolean)
    .join('\n');
  const message = e?.message ? String(e.message).trim() : String(err);
  return streams ? `${message}: ${streams}` : message;
}
