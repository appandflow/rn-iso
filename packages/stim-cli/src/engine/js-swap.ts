import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { getExecutor, type Executor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { createLineReader, waitForChild } from '../process-output.ts';
import { cleanLine } from '../supervisor/server-expo.ts';
import { HEARTBEAT_INTERVAL_MS, startBuildHeartbeat, tailLines } from './xcode.ts';

export const JS_BUNDLE_NAME = 'main.jsbundle';

const LAST_LINES = 5;

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

export function readHermesEnabled(root: string): boolean {
  try {
    return hermesEnabledFromProperties(readFileSync(join(root, 'ios', 'Podfile.properties.json'), 'utf-8'));
  } catch {
    return true;
  }
}

const ENTRY_CANDIDATES = ['index.js', 'index.ts', 'index.tsx', 'index.jsx'];

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

export function hermescPath(root: string, { exists = existsSync }: { exists?: (p: string) => boolean } = {}): string {
  const candidates = [
    join(root, 'node_modules', 'hermes-compiler', 'hermesc', 'osx-bin', 'hermesc'),
    join(root, 'ios', 'Pods', 'hermes-engine', 'destroot', 'bin', 'hermesc'),
    join(root, 'node_modules', 'react-native', 'sdks', 'hermesc', 'osx-bin', 'hermesc'),
  ];
  return candidates.find(exists) ?? candidates[candidates.length - 1]!;
}

export function hermescArgs({ bundle, out }: { bundle: string; out: string }): string[] {
  return ['-emit-binary', '-out', out, bundle];
}

type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess;

export type JsSwapResult = {
  ok?: boolean;
  appPath?: string;
  tmpDir?: string;
  hermes?: boolean;
  note?: string;
  durationMs?: number;
  failed?: boolean;
  step?: string;
  reason?: string;
  lastLines?: string[];
};

export async function swapJsBundle({
  root,
  isExpo,
  cachedAppPath,
  logWriter = null,
  exec = null,
  spawnFn = null,
  mkdtemp = () => mkdtempSync(join(tmpdir(), 'stim-js-swap-')),
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
    emit: onHeartbeat,
    label: 'swap',
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

  let hermes = false;
  let note: string | undefined;
  const wantsHermes = hermesEnabled ?? readHermesEnabled(root);
  if (wantsHermes) {
    const hermesc = hermescPath(root);
    if (!exists(hermesc)) {
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

  try {
    e.runFile('cp', [bundleOutput, join(appCopy, JS_BUNDLE_NAME)]);
    e.runFile('cp', ['-R', `${assetsDest}/.`, `${appCopy}/`]);
  } catch (err) {
    return fail('replace', `could not replace the JS bundle inside ${appCopy}: ${describe(err)}`);
  }

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
