// src/engine/deps.js -- "are the installed Pods the ones the lockfile
// describes, and if not, install them".
//
// The staleness question is decided the way CocoaPods itself decides it:
// `ios/Podfile.lock` is what the resolver produced, and `ios/Pods/
// Manifest.lock` is a copy of that file made by the last successful `pod
// install`. Identical means the sandbox matches the lock; different (or a
// missing Manifest.lock, i.e. no Pods directory at all) means it does not.
// This is the same comparison the "[CP] Check Pods Manifest.lock" build phase
// Xcode runs makes, which is why a stale sandbox otherwise surfaces as the
// famously unhelpful "The sandbox is not in sync with the Podfile.lock".
//
// The decision is pure and takes the two file CONTENTS, not a root: a
// comparison that reads the disk itself cannot be tested against the case
// that matters (a one-character difference), and `readPodState` is the thin
// wrapper that gets them.
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getExecutor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { createLineReader, stripAnsi } from '../supervisor/server-expo.ts';
import { HEARTBEAT_INTERVAL_MS, startBuildHeartbeat } from './xcode.ts';

// The signature every spawnFn injection seam in this module (and gradle.js /
// prebuild.js, which share the pattern) accepts: getExecutor().spawn's shape,
// loosened to a plain options bag so callers do not have to import SpawnOptions.
type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess;

// The shape waitForChild resolves to: either ending a spawned child has.
interface ChildResult {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
}

export const DEPS_ERROR = 'RN_ISO_DEPS_FAILED';

// How many transcript lines a failure carries back for the caller to print
// when no anchored diagnostic matched. The whole transcript is in the build
// log; this is the extract that goes on stdout (design principle 2).
const LAST_LINES = 20;

// --- pod-install diagnostics ----------------------------------------------
//
// `pod install` is two tools stacked on top of each other, and each puts its
// actionable line somewhere the tail is not:
//
// - CocoaPods flags every line it wants a human to read with a column-0
//   `[!]`, detail indented under it. The fatal `[!]` is printed where the
//   run DIES -- often mid-transcript -- and Pod::UI then flushes its
//   DEFERRED warnings after it, so the tail of a failing log is routinely
//   twenty warnings and no error.
// - A Ruby/Bundler crash prints `path.rb:LINE:in 'method': <message>
//   (<ErrorClass>)` FIRST and the `from ...` caller frames after it, so the
//   tail is pure stack frames with no message at all.
//
// Same contract as errors-xcode.ts: pure text in, extraction out, and an
// unrecognized transcript returns null -- explicitly -- so the caller falls
// back to the tail rather than print a guess.

// How many extracted lines a failure carries. Enough for a whole
// version-conflict block plus a warning or two; the full set is in the log.
const MAX_POD_DIAGNOSTIC_LINES = 15;

// CocoaPods anchors its actionable lines at column 0 with `[!]`; everything
// it indents under one is that line's detail (the resolver's conflict blocks
// above all). Anchoring at column 0 is what keeps an indented transcript
// line that happens to contain "[!]" from being promoted.
const POD_MARKER = /^\[!\]/;
const POD_CONTINUATION = /^\s+\S/;

// A Ruby exception head: `path.rb:LINE:in 'method': <message>`, in both
// quoting styles Ruby has used (`method' before 3.4, 'method' after). The
// caller frames underneath are `from path.rb:LINE:in 'method'` -- same shape,
// no message -- and are excluded by RUBY_FRAME wherever they appear.
const RUBY_HEAD = /^\S.*\.rb:\d+:in\s+(?:`[^']*'|'[^']*'):\s*\S/;
const RUBY_FRAME = /^\s*from\s+\S/;

// Bundler prints its own message and its `Run \`bundle install\`` hint
// immediately ABOVE the raise; this is how many of those contiguous lines
// ride along with the head.
const RUBY_CONTEXT_BEFORE = 4;

export interface PodDiagnostics {
  source: 'cocoapods' | 'ruby';
  lines: string[];
}

// PURE. The transcript of a failed `pod install` in, the actionable lines
// out; null when neither tool's failure shape is recognized, so the caller
// can fall back to the tail instead of printing a guess.
export function extractPodDiagnostics(transcript: string): PodDiagnostics | null {
  if (typeof transcript !== 'string' || transcript === '') return null;
  const lines = transcript.split('\n').map((line) => line.replace(/\r$/, ''));
  return extractPodBangBlocks(lines) || extractRubyHead(lines);
}

// Every `[!]` block, in transcript order, with the FIRST blocks winning the
// budget: CocoaPods prints the fatal `[!]` at the point of death and flushes
// deferred warnings after it, so when a cap has to fall it falls on the
// warning pile at the end, never on the error above it.
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

// The FIRST exception head in the transcript, with Bundler's prologue above
// it and any message continuation below it -- and none of the `from` frames,
// which carry no fact an agent can act on.
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

// PURE. Three outcomes, not two:
//   { noPods: true, stale: false }  neither file exists -- this project has
//                                   no CocoaPods at all (an Expo prebuild
//                                   that has not run yet, or a project on
//                                   Swift Package Manager). NOT stale: there
//                                   is nothing to install, and reporting it
//                                   as stale would make every such build run
//                                   a pod install that fails for want of a
//                                   Podfile.
//   { stale: true, reason }         the sandbox does not match the lock.
//   { stale: false }                it matches.
export function podsAreStale(lockText: unknown, manifestText: unknown) {
  const lock = normalize(lockText);
  const manifest = normalize(manifestText);
  if (lock === null && manifest === null) return { noPods: true, stale: false };
  if (lock === null) {
    // Pods/ exists but Podfile.lock does not. Nothing describes what SHOULD
    // be installed, so the sandbox cannot be trusted.
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

// Trailing whitespace differences are not a dependency change. CocoaPods
// writes both files itself so they normally match byte for byte, but a
// checkout with a different line ending would otherwise read as permanently
// stale and reinstall the sandbox on every single build.
function normalize(text: unknown) {
  if (typeof text !== 'string') return null;
  return text.replace(/\r\n/g, '\n').trimEnd();
}

function podfilePath(root: string) {
  return join(root, 'ios', 'Podfile');
}

// Thin. Reads the two files podsAreStale compares; an unreadable one is null,
// which is the same as absent for this decision.
export function readPodState(root: string) {
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

// `pod install` with cwd ios/, every transcript line streamed to the build
// log as a Contract-1 record with src "build" and level debug (the raw
// transcript is debug by contract; only extracted diagnostics are errors).
//
// Never throws: a missing `pod`, a non-zero exit and a spawn error all come
// back as { failed, reason } so the command layer prints one diagnostic and
// a log path instead of a stack.
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
) {
  const iosDir = join(root, 'ios');
  if (!existsSync(iosDir)) {
    return {
      failed: true,
      code: DEPS_ERROR,
      reason: `No ios/ directory in ${root}, so there is nothing to pod install.`,
      remedy: 'Run `rn-iso ios` on a project with native iOS sources, or let prebuild generate them.',
      lastLines: [] as string[],
    };
  }

  const spawn: SpawnFn = spawnFn || ((cmd, args, opts) => getExecutor().spawn(cmd, args, opts));
  const startedAt = now();
  // The whole transcript, not a rolling tail: the fatal `[!]` of a failed
  // install is routinely mid-transcript with deferred warnings after it (see
  // extractPodDiagnostics), so a tail kept at write time has already thrown
  // the error away by the time the exit code says to go looking for it.
  // Same trade xcode.ts makes, on a far smaller transcript.
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
      // CocoaPods paints progress in colour; an escape sequence inside a JSON
      // string is unreadable in the log and unmatchable by `logs --grep`.
      env: { ...process.env, FORCE_COLOR: '0', CLICOLOR: '0' },
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

  // The build heartbeat, one phase earlier: a cold `pod install` runs minutes
  // and the silence before xcodebuild's own heartbeat read as a hang (#26).
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
    // The anchored extraction is what the caller prints; the tail survives
    // beside it as the fallback for a transcript neither pattern matched.
    const extracted = extractPodDiagnostics(transcript.join('\n'));
    return {
      failed: true,
      code: DEPS_ERROR,
      reason: `\`pod install\` failed (${how}).`,
      diagnosticSource: extracted ? extracted.source : ('tail' as const),
      diagnosticLines: extracted ? extracted.lines : ([] as string[]),
      lastLines: transcript.slice(-LAST_LINES),
      durationMs,
    };
  }
  return { ok: true, durationMs };
}

// A machine with no CocoaPods installed is the single most common cause of
// this failing, and it looks like a bare ENOENT unless it is named. The
// remedy is the whole point: an agent that reads "spawn pod ENOENT" retries,
// while one that reads "install CocoaPods" stops.
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

// Resolves for BOTH endings a spawn has. A child that never starts emits
// `error` and never `exit`, so awaiting `exit` alone hangs forever on the
// exact failure this module most needs to report.
export function waitForChild(child: ChildProcess): Promise<ChildResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: ChildResult) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    child.on('exit', (code, signal) => done({ code, signal }));
    child.on('error', (error) => done({ error }));
  });
}
