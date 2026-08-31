import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { getExecutor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { createLineReader, stripAnsi, waitForChild } from '../process-output.ts';
import { bundlerPin } from './bundler.ts';
import { HEARTBEAT_INTERVAL_MS, startBuildHeartbeat } from './xcode.ts';

type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess;

export const DEPS_ERROR = 'STIM_DEPS_FAILED';

const LAST_LINES = 20;

const MAX_POD_DIAGNOSTIC_LINES = 15;

const POD_MARKER = /^\[!\]/;
const POD_CONTINUATION = /^\s+\S/;

const RUBY_HEAD = /^\S.*\.rb:\d+:in\s+(?:`[^']*'|'[^']*'):\s*\S/;
const RUBY_FRAME = /^\s*from\s+\S/;

const RUBY_CONTEXT_BEFORE = 4;

const BUNDLER_FROZEN = /frozen mode|lockfile can't be updated|in deployment mode after changing/i;
const BUNDLER_NO_COCOAPODS = /cocoapods is not currently included in the bundle|command not found: pod\b/i;

export interface PodDiagnostics {
  source: 'cocoapods' | 'ruby';
  lines: string[];
}

export function extractPodDiagnostics(transcript: string): PodDiagnostics | null {
  if (typeof transcript !== 'string' || transcript === '') return null;
  const lines = transcript.split('\n').map((line) => line.replace(/\r$/, ''));
  return extractPodBangBlocks(lines) || extractRubyHead(lines);
}

function extractPodBangBlocks(lines: string[]): PodDiagnostics | null {
  const blocks: string[][] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || !POD_MARKER.test(line)) continue;
    const block = [line];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const next = lines[j];
      if (next === undefined || !POD_CONTINUATION.test(next)) break;
      block.push(next);
    }
    blocks.push(block);
    i = j - 1;
  }
  if (blocks.length === 0) return null;

  const out: string[] = [];
  let dropped = 0;
  for (const block of blocks) {
    const room = MAX_POD_DIAGNOSTIC_LINES - out.length;
    if (room <= 0) {
      dropped += block.length;
      continue;
    }
    out.push(...block.slice(0, room));
    dropped += Math.max(0, block.length - room);
  }
  if (dropped > 0) out.push(`(+${dropped} more [!] lines in the build log)`);
  return { source: 'cocoapods', lines: out };
}

function extractRubyHead(lines: string[]): PodDiagnostics | null {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || !RUBY_HEAD.test(line) || RUBY_FRAME.test(line)) continue;
    let start = i;
    while (start > 0 && i - start < RUBY_CONTEXT_BEFORE) {
      const prev = lines[start - 1];
      if (prev === undefined || prev.trim() === '' || RUBY_FRAME.test(prev) || POD_MARKER.test(prev)) break;
      start -= 1;
    }
    let end = i + 1;
    while (end < lines.length) {
      const next = lines[end];
      if (next === undefined || next.trim() === '' || RUBY_FRAME.test(next)) break;
      end += 1;
    }
    const out = lines.slice(start, end).filter((entry) => entry.trim() !== '');
    return { source: 'ruby', lines: out.slice(0, MAX_POD_DIAGNOSTIC_LINES) };
  }
  return null;
}

export function podsAreStale(
  lockText: unknown,
  manifestText: unknown,
): { noPods?: boolean; stale: boolean; reason?: string } {
  const lock = normalize(lockText);
  const manifest = normalize(manifestText);
  if (lock === null && manifest === null) return { noPods: true, stale: false };
  if (lock === null) {
    return { stale: true, reason: 'ios/Podfile.lock is missing but ios/Pods exists' };
  }
  if (manifest === null) {
    return { stale: true, reason: 'ios/Pods/Manifest.lock is missing (pods have never been installed here)' };
  }
  if (lock !== manifest) {
    return { stale: true, reason: 'ios/Podfile.lock and ios/Pods/Manifest.lock differ' };
  }
  return { stale: false };
}

function normalize(text: unknown) {
  if (typeof text !== 'string') return null;
  return text.replace(/\r\n/g, '\n').trimEnd();
}

function podfilePath(root: string) {
  return join(root, 'ios', 'Podfile');
}

export function readPodState(root: string): {
  hasPodfile: boolean;
  lockText: string | null;
  manifestText: string | null;
} {
  return {
    hasPodfile: existsSync(podfilePath(root)),
    lockText: readOrNull(join(root, 'ios', 'Podfile.lock')),
    manifestText: readOrNull(join(root, 'ios', 'Pods', 'Manifest.lock')),
  };
}

function readOrNull(file: string) {
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

export function podEnv(
  root: string,
  {
    env = process.env,
    home = homedir(),
    exists = existsSync,
  }: { env?: NodeJS.ProcessEnv; home?: string; exists?: (p: string) => boolean } = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...env,
    FORCE_COLOR: '0',
    CLICOLOR: '0',
    LANG: env.LANG ?? 'en_US.UTF-8',
    LC_ALL: env.LC_ALL ?? env.LANG ?? 'en_US.UTF-8',
  };
  const version = readRubyVersion(root);
  if (!version) return out;
  const candidates: Array<{ bin: string; gems?: string }> = [
    { bin: join(home, '.rbenv', 'versions', version, 'bin') },
    {
      bin: join(home, '.rvm', 'rubies', `ruby-${version}`, 'bin'),
      gems: join(home, '.rvm', 'gems', `ruby-${version}`),
    },
    { bin: join(home, '.asdf', 'installs', 'ruby', version, 'bin') },
    { bin: join(home, '.local', 'share', 'mise', 'installs', 'ruby', version, 'bin') },
  ];
  for (const c of candidates) {
    if (!exists(c.bin)) continue;
    out.PATH = `${c.bin}:${out.PATH ?? ''}`;
    if (c.gems && exists(c.gems)) {
      out.GEM_HOME = c.gems;
      out.GEM_PATH = c.gems;
    }
    break;
  }
  return out;
}

export function readRubyVersion(
  root: string,
  { read = readFileSync }: { read?: typeof readFileSync } = {},
): string | null {
  try {
    const first = String(read(join(root, '.ruby-version'), 'utf-8'))
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'));
    if (!first) return null;
    return first.replace(/^ruby-/, '');
  } catch {
    return null;
  }
}

export type PodInstallResult = {
  ok?: boolean;
  failed?: boolean;
  code?: string;
  reason?: string;
  remedy?: string;
  command?: string;
  notes?: string[];
  diagnosticSource?: string;
  diagnosticLines?: string[];
  lastLines?: string[];
  durationMs?: number;
};

// Bundler writes Gemfile.lock whenever it resolves: `bundle check`, `bundle install`,
// and even `bundle exec` rewrite the lockfile when it does not match the Gemfile.
// `--dry-run` and BUNDLE_FROZEN make bundler report instead of write, so the tracked
// lockfile is never edited. Gems still land wherever the project's own bundler config
// points BUNDLE_PATH (the React Native template ships `.bundle/config` with
// vendor/bundle), which is the project's dependency state, not Stim's (#137).
function bundlerEnv(root: string, gemfile: string): NodeJS.ProcessEnv {
  return { ...podEnv(root), BUNDLE_GEMFILE: gemfile, BUNDLE_FROZEN: 'true' };
}

const BUNDLE_PATH_SETTING = /^BUNDLE_PATH:[ \t]*["']?([^"'\r\n]+?)["']?[ \t]*$/m;

function bundlePathInsideProject(root: string, env: NodeJS.ProcessEnv): { path: string; where: string } | null {
  const fromEnv = env.BUNDLE_PATH;
  const configured = fromEnv || BUNDLE_PATH_SETTING.exec(readOrNull(join(root, '.bundle', 'config')) ?? '')?.[1];
  // Bundler expands a leading ~ to $HOME, which resolve() would instead read as a
  // directory named "~" under the project.
  if (!configured || configured.startsWith('~')) return null;
  const resolved = resolve(root, configured);
  if (resolved !== root && !resolved.startsWith(root + sep)) return null;
  return {
    path: relative(root, resolved) || '.',
    where: fromEnv
      ? 'where the BUNDLE_PATH environment variable points'
      : 'where its own .bundle/config points BUNDLE_PATH',
  };
}

type RunContext = {
  logWriter: NdjsonWriter | null | undefined;
  spawn: SpawnFn;
  now: () => number;
  heartbeatMs: number;
  onHeartbeat: (line: string) => void;
};

type CapturedRun = {
  transcript: string[];
  code: number | null;
  signal: NodeJS.Signals | null;
  error: unknown;
  durationMs: number;
};

async function runCaptured(
  ctx: RunContext & {
    cmd: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    event: string;
    label?: string | null;
  },
): Promise<CapturedRun> {
  const startedAt = ctx.now();
  const transcript: string[] = [];
  const push = (line: unknown) => {
    const msg = stripAnsi(String(line)).trimEnd();
    if (!msg.trim()) return;
    transcript.push(msg);
    ctx.logWriter?.write?.({ src: 'build', level: 'debug', msg, raw: true, event: ctx.event });
  };

  let child: ChildProcess;
  try {
    child = ctx.spawn(ctx.cmd, ctx.args, {
      cwd: ctx.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: ctx.env,
    });
  } catch (error) {
    return { transcript, code: null, signal: null, error, durationMs: ctx.now() - startedAt };
  }

  const reader = { out: createLineReader(push), err: createLineReader(push) };
  child.stdout?.setEncoding?.('utf-8');
  child.stderr?.setEncoding?.('utf-8');
  child.stdout?.on('data', (chunk) => reader.out.push(chunk));
  child.stderr?.on('data', (chunk) => reader.err.push(chunk));

  const stopHeartbeat = ctx.label
    ? startBuildHeartbeat({
        intervalMs: ctx.heartbeatMs,
        elapsed: () => ctx.now() - startedAt,
        lastLine: () => transcript.at(-1) ?? '',
        emit: ctx.onHeartbeat,
        label: ctx.label,
      })
    : () => {};

  let result: Awaited<ReturnType<typeof waitForChild>>;
  try {
    result = await waitForChild(child);
  } finally {
    stopHeartbeat();
  }
  reader.out.flush();
  reader.err.flush();
  return {
    transcript,
    code: result.code ?? null,
    signal: result.signal ?? null,
    error: result.error ?? null,
    durationMs: ctx.now() - startedAt,
  };
}

type GemsResult = { bundler: boolean; note?: string; failure?: PodInstallResult };

async function ensureBundledGems(
  root: string,
  pin: { gemfile: string; lockfile: string },
  ctx: RunContext,
): Promise<GemsResult> {
  const env = bundlerEnv(root, pin.gemfile);
  const cwd = dirname(pin.gemfile);

  const check = await runCaptured({
    ...ctx,
    cmd: 'bundle',
    args: ['check', '--dry-run'],
    cwd,
    env,
    event: 'bundle_check',
    label: 'gems',
  });
  if (check.error) return bundlerSpawnFailure('bundle check', check, pin);
  if (check.code === 0) return { bundler: true };

  const install = await runCaptured({
    ...ctx,
    cmd: 'bundle',
    args: ['install'],
    cwd,
    env,
    event: 'bundle_install',
    label: 'gems',
  });
  if (install.error) return bundlerSpawnFailure('bundle install', install, pin);
  const inProject = bundlePathInsideProject(cwd, env);
  const note = inProject
    ? `\`bundle install\` put this project's gems in ${inProject.path}/, ${inProject.where}; ` +
      'Gemfile.lock itself is never written.'
    : undefined;
  if (install.code === 0) return { bundler: true, note };

  const how = install.signal ? `signal ${install.signal}` : `exit code ${install.code}`;
  const transcript = install.transcript.join('\n');
  const extracted = extractPodDiagnostics(transcript);
  return {
    bundler: false,
    failure: {
      failed: true,
      code: DEPS_ERROR,
      reason: `\`bundle install\` failed (${how}).`,
      remedy: frozenRemedy(root, pin, transcript) || gemInstallRemedy(root, pin),
      diagnosticSource: extracted ? extracted.source : 'tail',
      diagnosticLines: extracted ? extracted.lines : [],
      lastLines: install.transcript.slice(-LAST_LINES),
      durationMs: install.durationMs,
    },
  };
}

function bundlerSpawnFailure(
  command: string,
  run: CapturedRun,
  pin: { gemfile: string; lockfile: string },
): GemsResult {
  if (isMissingBinary(run.error)) return { bundler: false, note: missingBundlerNote(pin) };
  return {
    bundler: false,
    failure: {
      failed: true,
      code: DEPS_ERROR,
      reason: `Could not run \`${command}\`: ${(run.error as Error)?.message || run.error}`,
      remedy: `Bundler is how this project pins its CocoaPods (${pin.lockfile}). Check that \`bundle\` runs in ${dirname(pin.gemfile)}, then run again.`,
      lastLines: run.transcript.slice(-LAST_LINES),
      durationMs: run.durationMs,
    },
  };
}

function missingBundlerNote(pin: { gemfile: string; lockfile: string }): string {
  return (
    `${pin.lockfile} pins this project's CocoaPods, but \`bundle\` is not on PATH, ` +
    'so pods run as plain `pod install` with whatever CocoaPods PATH resolves to (`gem install bundler` to use the pin).'
  );
}

function frozenRemedy(
  root: string,
  pin: { gemfile: string; lockfile: string },
  transcript: string,
): string | undefined {
  if (!BUNDLER_FROZEN.test(transcript)) return undefined;
  return (
    `Stim runs bundler with BUNDLE_FROZEN so it can never write into your checkout, and ${pin.gemfile} no longer ` +
    `matches ${pin.lockfile}. Run \`cd ${root} && bundle install\` yourself, keep the updated Gemfile.lock, then run again.`
  );
}

function gemInstallRemedy(root: string, pin: { gemfile: string; lockfile: string }): string {
  const version = readRubyVersion(root);
  const ruby = version
    ? `This repo pins ruby ${version} (.ruby-version), so put that ruby on PATH (rbenv/rvm/asdf/mise) first. `
    : '';
  return (
    `${ruby}Bundler could not install the gems ${pin.lockfile} pins, so \`bundle exec pod install\` cannot run. ` +
    `Run \`cd ${root} && bundle install\` and fix what it reports, then run again.`
  );
}

export async function runPodInstall(
  root: string,
  logWriter: NdjsonWriter | null | undefined,
  {
    spawnFn = null,
    now = Date.now,
    heartbeatMs = HEARTBEAT_INTERVAL_MS,
    onHeartbeat = (line: string) => console.error(line),
  }: {
    spawnFn?: SpawnFn | null;
    now?: () => number;
    heartbeatMs?: number;
    onHeartbeat?: (line: string) => void;
  } = {},
): Promise<PodInstallResult> {
  const iosDir = join(root, 'ios');
  if (!existsSync(iosDir)) {
    return {
      failed: true,
      code: DEPS_ERROR,
      reason: `No ios/ directory in ${root}, so there is nothing to pod install.`,
      remedy: 'Run `stim ios` on a project with native iOS sources, or let prebuild generate them.',
      lastLines: [] as string[],
    };
  }

  const ctx: RunContext = {
    logWriter,
    spawn: spawnFn || ((cmd, args, opts) => getExecutor().spawn(cmd, args, opts)),
    now,
    heartbeatMs,
    onHeartbeat,
  };

  const notes: string[] = [];
  const pin = bundlerPin(root);
  let bundler = false;
  if (pin) {
    const gems = await ensureBundledGems(root, pin, ctx);
    if (gems.failure) return { ...gems.failure, notes };
    if (gems.note) notes.push(gems.note);
    bundler = gems.bundler;
  }

  const args = bundler ? ['bundle', 'exec', 'pod', 'install'] : ['pod', 'install'];
  const command = args.join(' ');
  const run = await runCaptured({
    ...ctx,
    cmd: args[0] as string,
    args: args.slice(1),
    cwd: iosDir,
    env: bundler && pin ? bundlerEnv(root, pin.gemfile) : podEnv(root),
    event: 'pod_install',
    label: 'pods',
  });

  if (run.error) {
    const missing = bundler ? missingBundle(run.error, pin) : missingPod(run.error);
    return {
      ...(missing || {
        failed: true,
        code: DEPS_ERROR,
        reason: `Could not run \`${command}\`: ${(run.error as Error)?.message || run.error}`,
        lastLines: run.transcript.slice(-LAST_LINES),
        durationMs: run.durationMs,
      }),
      command,
      notes,
    };
  }
  if (run.code !== 0) {
    const how = run.signal ? `signal ${run.signal}` : `exit code ${run.code}`;
    const transcript = run.transcript.join('\n');
    const extracted = extractPodDiagnostics(transcript);
    return {
      failed: true,
      code: DEPS_ERROR,
      reason: `\`${command}\` failed (${how}).`,
      remedy: podFailureRemedy(root, pin, transcript),
      command,
      notes,
      diagnosticSource: extracted ? extracted.source : ('tail' as const),
      diagnosticLines: extracted ? extracted.lines : ([] as string[]),
      lastLines: run.transcript.slice(-LAST_LINES),
      durationMs: run.durationMs,
    };
  }
  return { ok: true, command, notes, durationMs: run.durationMs };
}

function podFailureRemedy(
  root: string,
  pin: { gemfile: string; lockfile: string } | null,
  transcript: string,
): string | undefined {
  if (pin) {
    const frozen = frozenRemedy(root, pin, transcript);
    if (frozen) return frozen;
    if (BUNDLER_NO_COCOAPODS.test(transcript)) {
      return (
        `${pin.lockfile} resolves cocoapods, but bundler found no \`pod\` executable in the bundle it loaded: ` +
        `the installed gems belong to a different Gemfile than ${pin.gemfile}, or that Gemfile's bundle was never ` +
        `installed. Run \`cd ${root} && bundle install && bundle exec pod --version\` and make that work, then run again.`
      );
    }
  }
  const pinned = /Could not find proper version of cocoapods/.test(transcript) ? readRubyVersion(root) : null;
  if (!pinned) return undefined;
  return (
    `This repo pins ruby ${pinned} (.ruby-version) and its Gemfile's cocoapods was installed under it; ` +
    `the shell's ruby is likely a different version, so bundler looks in the wrong gem home. ` +
    `Put ruby ${pinned} on PATH (rbenv/rvm/asdf/mise) -- \`bundle install\` will NOT fix this.`
  );
}

function isMissingBinary(err: unknown): boolean {
  const nodeErr = err as NodeJS.ErrnoException;
  const message = String(nodeErr?.message || err || '');
  return nodeErr?.code === 'ENOENT' || /ENOENT|not found/i.test(message);
}

function missingBundle(err: unknown, pin: { gemfile: string; lockfile: string } | null) {
  if (!isMissingBinary(err)) return null;
  return {
    failed: true,
    code: DEPS_ERROR,
    reason: 'Bundler is not installed: no `bundle` executable on PATH.',
    remedy:
      `${pin?.lockfile ?? 'Gemfile.lock'} pins this project's CocoaPods, so pods run through bundler. ` +
      'Install bundler (`gem install bundler`) and run again.',
    lastLines: [] as string[],
  };
}

function missingPod(err: unknown) {
  if (!isMissingBinary(err)) return null;
  return {
    failed: true,
    code: DEPS_ERROR,
    reason: 'CocoaPods is not installed: no `pod` executable on PATH.',
    remedy: 'Install CocoaPods (`brew install cocoapods`, or `gem install cocoapods`) and run again.',
    lastLines: [] as string[],
  };
}
