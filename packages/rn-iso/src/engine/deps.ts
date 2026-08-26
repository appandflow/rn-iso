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

// How many transcript lines a failure carries back for the caller to print.
// The whole transcript is in the build log; this is the extract that goes on
// stdout (design principle 2).
const LAST_LINES = 20;

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
  { spawnFn = null, now = Date.now }: { spawnFn?: SpawnFn | null; now?: () => number } = {},
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
  const tail: string[] = [];
  const push = (line: unknown) => {
    const msg = stripAnsi(String(line)).trimEnd();
    if (!msg.trim()) return;
    tail.push(msg);
    if (tail.length > LAST_LINES) tail.shift();
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

  const result = await waitForChild(child);
  reader.out.flush();
  reader.err.flush();
  const durationMs = now() - startedAt;

  if (result.error) {
    return (
      missingPod(result.error) || {
        failed: true,
        code: DEPS_ERROR,
        reason: `Could not run \`pod install\`: ${result.error?.message || result.error}`,
        lastLines: tail.slice(),
        durationMs,
      }
    );
  }
  if (result.code !== 0) {
    const how = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`;
    return {
      failed: true,
      code: DEPS_ERROR,
      reason: `\`pod install\` failed (${how}).`,
      lastLines: tail.slice(),
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
