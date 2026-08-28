import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { getExecutor, type Executor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { createLineReader, waitForChild } from '../process-output.ts';
import type { SettingsObject } from '../types.ts';
import { findBuildTool, type BuildToolsEntry } from '../sim/android.ts';
import { cleanLine } from '../supervisor/server-expo.ts';
import {
  assetDiffReason,
  compareAssetManifests,
  readAssetManifest,
  type AssetManifest,
  type AssetManifestDiff,
} from './asset-manifest.ts';
import { detectEntryFile } from './js-swap.ts';
import { HEARTBEAT_INTERVAL_MS, startBuildHeartbeat, tailLines } from './xcode.ts';

export const ANDROID_BUNDLE_NAME = 'index.android.bundle';
export const ANDROID_BUNDLE_ENTRY: string = `assets/${ANDROID_BUNDLE_NAME}`;

const LAST_LINES = 5;

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

export function readAndroidHermesEnabled(root: string): boolean {
  try {
    return hermesEnabledFromGradleProperties(readFileSync(join(root, 'android', 'gradle.properties'), 'utf-8'));
  } catch {
    return true;
  }
}

export function hermescBinDir(platform: string = process.platform): string {
  return platform === 'darwin' ? 'osx-bin' : 'linux64-bin';
}

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

export function androidHermescArgs({ bundle, out }: { bundle: string; out: string }): string[] {
  return ['-emit-binary', '-O', '-w', '-out', out, bundle];
}

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

export function isNothingToDelete(text: unknown): boolean {
  return /nothing to do|name not matched|no matches found/i.test(String(text ?? ''));
}

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

export interface KeystoreConfig {
  path: string;
  pass: string;
}

export function keystorePassArg(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return 'pass:android';
  if (/^(?:pass|file|env):/.test(text) || text === 'stdin') return text;
  return `pass:${text}`;
}

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

export function apksignerArgs({ keystore, apkPath }: { keystore: KeystoreConfig; apkPath: string }): string[] {
  return ['sign', '--ks', keystore.path, '--ks-pass', keystore.pass, apkPath];
}

type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess;

export type ApkSwapResult = {
  ok?: boolean;
  apkPath?: string;
  tmpDir?: string;
  hermes?: boolean;
  note?: string;
  durationMs?: number;
  assetMismatch?: boolean;
  assetDiff?: AssetManifestDiff;
  failed?: boolean;
  step?: string;
  reason?: string;
  lastLines?: string[];
};

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

  let hermes = false;
  let note: string | undefined;
  const wantsHermes = hermesEnabled ?? readAndroidHermesEnabled(root);
  if (wantsHermes) {
    const hermesc = androidHermescPath(root);
    if (!exists(hermesc)) {
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
  const e = err as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const streams = [e?.stdout, e?.stderr]
    .map((s) => (s ? String(s).trim() : ''))
    .filter(Boolean)
    .join('\n');
  const message = e?.message ? String(e.message).trim() : String(err);
  return streams ? `${message}: ${streams}` : message;
}
