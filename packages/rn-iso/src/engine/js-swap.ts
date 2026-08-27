// src/engine/js-swap.js -- fresh JS into a cached Release .app.
//
// The build cache is keyed on the NATIVE fingerprint, which is the right key
// for a Debug artifact: its JS comes from Metro at runtime, so any workspace
// on the same native inputs can install it. A Release artifact BAKES ITS JS
// IN at build time, so a native-keyed cache hit is an app carrying whatever
// JS the workspace that built it had -- installing it as-is would silently
// run stale code. This module is what makes the Release cache honest: copy
// the cached .app aside, regenerate the JS bundle from THIS workspace's tree
// with the project's own tools, compile it with the project's own hermesc
// when Hermes is enabled, replace main.jsbundle and the assets inside the
// copy, re-sign it, and hand the copy back for install.
//
// Reimplementation, not reconstruction (CLAUDE.md item 3): the bundle command
// is a FIXED argument list this file composes -- `expo export:embed` for an
// Expo project, `react-native bundle` for a bare one, exactly what the Xcode
// "Bundle React Native code and images" phase runs -- never a package.json
// script it inferred. hermesc is version-matched by construction: it is the
// binary inside the project's own node_modules/react-native, the same one the
// build phase would have used.
//
// Nothing here throws on a tool failure. Every outcome is a return value --
// { ok, appPath } or { failed, reason, step } -- because the caller's answer
// to ANY failure is the same and always safe: fall back to a full build.
// Stale JS must never be installed silently, and neither must a swap failure
// turn a cache hit into a dead run.
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { getExecutor, type Executor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { cleanLine, createLineReader } from '../supervisor/server-expo.ts';
import { waitForChild } from './deps.ts';
import { HEARTBEAT_INTERVAL_MS, startBuildHeartbeat, tailLines } from './xcode.ts';

// The bundle the app loads. One name on iOS, fixed by RCTBundleURLProvider's
// jsBundleURLForBundleRoot fallback and by the Xcode build phase alike.
export const JS_BUNDLE_NAME = 'main.jsbundle';

// How many transcript lines a failed bundle step carries back for the caller
// to print; the full transcript is in the build log.
const LAST_LINES = 5;

// PURE. Whether this project builds its JS for Hermes, from the text of
// ios/Podfile.properties.json. The file is how Expo prebuild records the
// choice and how the Podfile reads it back; the ONLY value that disables
// Hermes there is the string "false" (a boolean false is honoured too, for a
// hand-edited file), and an absent key, an absent file or unparseable JSON
// all mean the default: enabled.
export function hermesEnabledFromProperties(text: unknown): boolean {
  if (typeof text !== 'string') return true;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return true;
  }
  if (!data || typeof data !== 'object') return true;
  const raw = (data as { hermesEnabled?: unknown }).hermesEnabled;
  return raw !== 'false' && raw !== false;
}

// Thin. The file the pure decision reads.
export function readHermesEnabled(root: string): boolean {
  try {
    return hermesEnabledFromProperties(readFileSync(join(root, 'ios', 'Podfile.properties.json'), 'utf-8'));
  } catch {
    return true;
  }
}

// The entry files a bare RN project can have, in the order the community
// CLI's own default resolution prefers them. index.js is both the first
// choice and the fallback: it is what `react-native bundle` would default to
// anyway.
const ENTRY_CANDIDATES = ['index.js', 'index.ts', 'index.tsx', 'index.jsx'];

// PURE. Which entry file `react-native bundle --entry-file` is told about,
// given a listing of the project root.
export function pickEntryFile(entries: unknown): string {
  const names = new Set((Array.isArray(entries) ? entries : []).filter((e) => typeof e === 'string'));
  return ENTRY_CANDIDATES.find((c) => names.has(c)) ?? 'index.js';
}

export function detectEntryFile(root: string): string {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 'index.js';
  }
  return pickEntryFile(entries);
}

// PURE. The exact bundle invocation, as data, so a test asserts the argv
// without running Metro. Both are `npx` of the PROJECT's own CLI, resolved
// from its node_modules by npx's local-first rule, with the same fixed flags
// the Xcode build phase passes: --dev false is what makes this a release
// bundle.
export function bundleCommand({
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
        'ios',
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
      'ios',
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

// The project's own hermesc: the one react-native ships for the host, which
// is by construction the version the app's Hermes runtime expects. A bundle
// compiled by a different hermesc version aborts at load with a bytecode
// version mismatch, which is why this is never resolved from anywhere else.
// hermesc moved twice across RN's history; probe newest-first. Live-verified
// on RN 0.86: the compiler ships in the hermes-compiler package (and a copy
// lands in Pods); the react-native/sdks path is the pre-0.8x legacy location.
export function hermescPath(root: string, { exists = existsSync }: { exists?: (p: string) => boolean } = {}): string {
  const candidates = [
    join(root, 'node_modules', 'hermes-compiler', 'hermesc', 'osx-bin', 'hermesc'),
    join(root, 'ios', 'Pods', 'hermes-engine', 'destroot', 'bin', 'hermesc'),
    join(root, 'node_modules', 'react-native', 'sdks', 'hermesc', 'osx-bin', 'hermesc'),
  ];
  return candidates.find(exists) ?? candidates[candidates.length - 1]!;
}

// PURE. hermesc's argv: bytecode out, JS in. The output replaces the JS
// bundle under the SAME name -- the app loads main.jsbundle whichever format
// it is, exactly as the Xcode phase ships it.
export function hermescArgs({ bundle, out }: { bundle: string; out: string }): string[] {
  return ['-emit-binary', '-out', out, bundle];
}

type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess;

// The all-optional view of swapJsBundle's outcomes.
export type JsSwapResult = {
  ok?: boolean;
  // The re-signed copy to install, and the temp dir it lives in (the caller
  // may remove it once the install is done).
  appPath?: string;
  tmpDir?: string;
  // Whether the embedded bundle is Hermes bytecode. false + note when the
  // project wants Hermes but its hermesc is missing.
  hermes?: boolean;
  note?: string;
  durationMs?: number;
  failed?: boolean;
  // Which step died: 'copy' | 'bundle' | 'hermesc' | 'replace' | 'codesign'.
  step?: string;
  reason?: string;
  lastLines?: string[];
};

/**
 * Copy the cached Release .app, regenerate this workspace's JS into it, and
 * re-sign the copy. Resolves to { ok, appPath, tmpDir, hermes } or
 * { failed, step, reason } -- never throws on a tool failure, because every
 * failure has the same safe answer: build fresh instead.
 */
export async function swapJsBundle({
  root,
  isExpo,
  cachedAppPath,
  logWriter = null,
  exec = null,
  spawnFn = null,
  mkdtemp = () => mkdtempSync(join(tmpdir(), 'rn-iso-js-swap-')),
  exists = existsSync,
  hermesEnabled = null,
  now = Date.now,
  heartbeatMs = HEARTBEAT_INTERVAL_MS,
  onHeartbeat = (line: string) => console.error(line),
}: {
  root: string;
  isExpo: boolean;
  cachedAppPath: string;
  logWriter?: NdjsonWriter | null;
  exec?: Executor | null;
  spawnFn?: SpawnFn | null;
  mkdtemp?: () => string;
  exists?: (p: string) => boolean;
  hermesEnabled?: boolean | null;
  now?: () => number;
  heartbeatMs?: number;
  onHeartbeat?: (line: string) => void;
}): Promise<JsSwapResult> {
  const e = exec || getExecutor();
  const startedAt = now();
  const elapsed = () => now() - startedAt;
  const fail = (step: string, reason: string, lastLines: string[] = []): JsSwapResult => {
    logWriter?.write?.({ src: 'build', level: 'error', msg: `JS swap failed at ${step}: ${reason}`, event: 'js_swap' });
    return { failed: true, step, reason, lastLines, durationMs: elapsed() };
  };

  // ---- copy the cached app aside ----
  // The cache entry itself is never modified: it stays the pristine native
  // shell every workspace's swap starts from. Same cp as storeBuild, clone
  // first (APFS copy-on-write makes a several-hundred-MB .app cost
  // milliseconds), plain copy where clones cannot work.
  let tmp: string;
  let appCopy: string;
  try {
    tmp = mkdtemp();
    appCopy = join(tmp, basename(cachedAppPath));
    try {
      e.runFile('cp', ['-c', '-R', cachedAppPath, appCopy]);
    } catch {
      e.runFile('cp', ['-R', cachedAppPath, appCopy]);
    }
  } catch (err) {
    return fail('copy', `could not copy ${cachedAppPath} aside: ${describe(err)}`);
  }

  // ---- regenerate the JS bundle from THIS tree ----
  const bundleOutput = join(tmp, JS_BUNDLE_NAME);
  const assetsDest = join(tmp, 'assets');
  const entryFile = isExpo ? 'index.js' : detectEntryFile(root);
  const command = bundleCommand({ isExpo, entryFile, bundleOutput, assetsDest });
  try {
    mkdirSync(assetsDest, { recursive: true });
  } catch (err) {
    return fail('bundle', `could not create ${assetsDest}: ${describe(err)}`);
  }

  logWriter?.write?.({
    src: 'build',
    level: 'info',
    msg: `${command.file} ${command.args.join(' ')}`,
    event: 'js_swap',
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
    logWriter?.write?.({ src: 'build', level: 'debug', msg, raw: true, event: 'js_swap' });
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
    label: 'js swap',
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
    return fail('bundle', `the bundle command exited 0 but wrote no ${JS_BUNDLE_NAME} at ${bundleOutput}`);
  }

  // ---- hermes, with the project's own compiler ----
  let hermes = false;
  let note: string | undefined;
  const wantsHermes = hermesEnabled ?? readHermesEnabled(root);
  if (wantsHermes) {
    const hermesc = hermescPath(root);
    if (!exists(hermesc)) {
      // The guard, not a failure: the plain JS bundle still runs under Hermes
      // (it interprets JS source), it just loads slower than bytecode would.
      note = `hermesc not found at ${hermesc}; embedding the plain JS bundle instead of Hermes bytecode`;
    } else {
      const hbc = join(tmp, `${JS_BUNDLE_NAME}.hbc`);
      try {
        e.runFile(hermesc, hermescArgs({ bundle: bundleOutput, out: hbc }));
        e.runFile('mv', [hbc, bundleOutput]);
        hermes = true;
      } catch (err) {
        return fail('hermesc', `hermesc failed on ${bundleOutput}: ${describe(err)}`);
      }
    }
  }

  // ---- replace the bundle and assets inside the copy ----
  try {
    e.runFile('cp', [bundleOutput, join(appCopy, JS_BUNDLE_NAME)]);
    // `dir/.` copies the CONTENTS of assetsDest into the bundle root, which
    // is where the build phase puts them (assets/... paths inside the .app).
    e.runFile('cp', ['-R', `${assetsDest}/.`, `${appCopy}/`]);
  } catch (err) {
    return fail('replace', `could not replace the JS bundle inside ${appCopy}: ${describe(err)}`);
  }

  // ---- re-sign ----
  // Replacing a file inside a signed bundle invalidates its signature, and
  // the simulator still verifies enough of it to refuse the install. Ad-hoc
  // (`--sign -`) is what simulator builds are signed with in the first place.
  try {
    e.runFile('codesign', ['--force', '--sign', '-', appCopy]);
  } catch (err) {
    return fail('codesign', `codesign --force --sign - ${appCopy} failed: ${describe(err)}`);
  }

  logWriter?.write?.({
    src: 'build',
    level: 'info',
    msg: `JS swap done: ${hermes ? 'hermes bytecode' : 'plain JS'} into ${appCopy} in ${elapsed()}ms`,
    event: 'js_swap',
  });
  const result: JsSwapResult = { ok: true, appPath: appCopy, tmpDir: tmp, hermes, durationMs: elapsed() };
  if (note) result.note = note;
  return result;
}

function describe(err: unknown): string {
  return String((err as Error)?.message || err);
}
