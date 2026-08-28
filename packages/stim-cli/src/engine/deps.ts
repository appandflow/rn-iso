import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getExecutor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { createLineReader, stripAnsi, waitForChild } from '../process-output.ts';
import { HEARTBEAT_INTERVAL_MS, startBuildHeartbeat } from './xcode.ts';

type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess;

export const DEPS_ERROR = 'STIM_CLI_DEPS_FAILED';

const LAST_LINES = 20;

const MAX_POD_DIAGNOSTIC_LINES = 15;

const POD_MARKER = /^\[!\]/;
const POD_CONTINUATION = /^\s+\S/;

const RUBY_HEAD = /^\S.*\.rb:\d+:in\s+(?:`[^']*'|'[^']*'):\s*\S/;
const RUBY_FRAME = /^\s*from\s+\S/;

const RUBY_CONTEXT_BEFORE = 4;

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
  diagnosticSource?: string;
  diagnosticLines?: string[];
  lastLines?: string[];
  durationMs?: number;
};

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
      remedy: 'Run `stim-cli ios` on a project with native iOS sources, or let prebuild generate them.',
      lastLines: [] as string[],
    };
  }

  const spawn: SpawnFn = spawnFn || ((cmd, args, opts) => getExecutor().spawn(cmd, args, opts));
  const startedAt = now();
  const transcript: string[] = [];
  const push = (line: unknown) => {
    const msg = stripAnsi(String(line)).trimEnd();
    if (!msg.trim()) return;
    transcript.push(msg);
    logWriter?.write?.({ src: 'build', level: 'debug', msg, raw: true, event: 'pod_install' });
  };

  let child: ChildProcess;
  try {
    child = spawn('pod', ['install'], {
      cwd: iosDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: podEnv(root),
    });
  } catch (err) {
    return (
      missingPod(err) || {
        failed: true,
        code: DEPS_ERROR,
        reason: `Could not run \`pod install\`: ${(err as Error)?.message || err}`,
        lastLines: [] as string[],
      }
    );
  }

  const reader = { out: createLineReader(push), err: createLineReader(push) };
  child.stdout?.setEncoding?.('utf-8');
  child.stderr?.setEncoding?.('utf-8');
  child.stdout?.on('data', (chunk) => reader.out.push(chunk));
  child.stderr?.on('data', (chunk) => reader.err.push(chunk));

  const stopHeartbeat = startBuildHeartbeat({
    intervalMs: heartbeatMs,
    elapsed: () => now() - startedAt,
    lastLine: () => transcript.at(-1) ?? '',
    emit: onHeartbeat,
    label: 'pods',
  });

  let result: Awaited<ReturnType<typeof waitForChild>>;
  try {
    result = await waitForChild(child);
  } finally {
    stopHeartbeat();
  }
  reader.out.flush();
  reader.err.flush();
  const durationMs = now() - startedAt;

  if (result.error) {
    return (
      missingPod(result.error) || {
        failed: true,
        code: DEPS_ERROR,
        reason: `Could not run \`pod install\`: ${result.error?.message || result.error}`,
        lastLines: transcript.slice(-LAST_LINES),
        durationMs,
      }
    );
  }
  if (result.code !== 0) {
    const how = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`;
    const extracted = extractPodDiagnostics(transcript.join('\n'));
    const pinned = /Could not find proper version of cocoapods/.test(transcript.join('\n'))
      ? readRubyVersion(root)
      : null;
    return {
      failed: true,
      code: DEPS_ERROR,
      reason: `\`pod install\` failed (${how}).`,
      remedy: pinned
        ? `This repo pins ruby ${pinned} (.ruby-version) and its Gemfile's cocoapods was installed under it; ` +
          `the shell's ruby is likely a different version, so bundler looks in the wrong gem home. ` +
          `Put ruby ${pinned} on PATH (rbenv/rvm/asdf/mise) -- \`bundle install\` will NOT fix this.`
        : undefined,
      diagnosticSource: extracted ? extracted.source : ('tail' as const),
      diagnosticLines: extracted ? extracted.lines : ([] as string[]),
      lastLines: transcript.slice(-LAST_LINES),
      durationMs,
    };
  }
  return { ok: true, durationMs };
}

function missingPod(err: unknown) {
  const nodeErr = err as NodeJS.ErrnoException;
  const message = String(nodeErr?.message || err || '');
  if (nodeErr?.code !== 'ENOENT' && !/ENOENT|not found/i.test(message)) return null;
  return {
    failed: true,
    code: DEPS_ERROR,
    reason: 'CocoaPods is not installed: no `pod` executable on PATH.',
    remedy: 'Install CocoaPods (`brew install cocoapods`, or `gem install cocoapods`) and run again.',
    lastLines: [] as string[],
  };
}
