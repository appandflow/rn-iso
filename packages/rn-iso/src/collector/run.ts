// src/collector/run.js -- the detached per-platform device-log collector.
//
// Invoked as
//   node run.js --platform ios     --root <abs> --udid <udid>  --bundle <id>
//   node run.js --platform android --root <abs> --serial <s>   --package <pkg>
// normally by `rn-iso ios` / `rn-iso android`, spawned detached right after
// the app is launched.
//
// It converts ONE device's output for ONE app into Contract-1 records in
// <root>/.rn-iso/logs/device.ndjson, and does nothing else. It is separate
// from the supervisor on purpose: the supervisor's life is the dev server's,
// while a collector's is a particular install of a particular app, and a
// fresh `ios` run replaces the collector without touching Metro.
//
// The lifecycle rules mirror the supervisor's, for the same reasons:
//
// 1. THE REGISTRATION IS WRITTEN BEFORE THE STREAM STARTS (Contract 5:
//    state.json.collectors.<platform> = {pid, startedAt}). A collector that
//    dies during startup must still be findable -- an unrecorded `log stream`
//    holding a simulator is what nothing will ever clean up.
// 2. NO EXIT PATH IS SILENT. A signal, a stream that ended because the app
//    was killed, a pid that never appeared: each writes a final record and
//    clears the registration. A dead collector must never leave a record
//    claiming it is alive, because the next `ios` run kills the recorded pid.
// 3. AN APP RESTART IS NOT AN EXIT (android). The logcat stream is pinned to
//    a pid, so a restart -- the most ordinary thing a developer does -- left
//    it collecting for a process that no longer exists, silently and
//    forever. The pid is watched, and a new one REATTACHES the stream with a
//    `collector_reattached` record in the timeline. See watchAppPid.
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Executor } from '../exec.ts';
import { type NdjsonWriter, createNdjsonWriter } from '../ndjson.ts';
import { workspaceLogsDir } from '../paths.ts';
import { createLineReader } from '../supervisor/server-expo.ts';
import { appNameFromBundleId, parseLogStreamLine, startIosLogStream } from './ios.ts';
import {
  type PidResolution,
  type PidWatcher,
  parseLogcatLine,
  startAndroidLogcat,
  waitForAppPid,
  watchAppPid,
} from './android.ts';

export const PLATFORMS: string[] = ['ios', 'android'];

// The seam's return, and parseArgs' return, are both a flat all-optional bag
// rather than a discriminated union: every field a platform might need is
// present-or-not, and `error` is just one more optional field a caller checks
// first.
export interface ParsedCollectorArgs {
  platform?: string;
  root?: string;
  udid?: string;
  bundleId?: string;
  appName?: string;
  serial?: string | null;
  packageName?: string | null;
  error?: string;
}

export function parseArgs(argv: string[]): ParsedCollectorArgs {
  let platform: string | undefined;
  let root: string | undefined;
  let udid: string | undefined;
  let bundleId: string | undefined;
  let appName: string | undefined;
  let serial: string | null = null;
  let packageName: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--platform') {
      platform = argv[++i];
      continue;
    }
    if (arg === '--root') {
      root = argv[++i];
      continue;
    }
    if (arg === '--udid') {
      udid = argv[++i];
      continue;
    }
    if (arg === '--bundle') {
      bundleId = argv[++i];
      continue;
    }
    if (arg === '--app-name') {
      appName = argv[++i];
      continue;
    }
    if (arg === '--serial') {
      serial = argv[++i] ?? null;
      continue;
    }
    if (arg === '--package') {
      packageName = argv[++i] ?? null;
      continue;
    }
    return { error: `Unknown collector argument "${arg}".` };
  }
  if (!platform || !PLATFORMS.includes(platform)) {
    return { error: `--platform must be one of ${PLATFORMS.join(', ')}, got "${platform}".` };
  }
  if (!root) return { error: 'Missing --root.' };
  if (!isAbsolute(root)) return { error: `--root must be an absolute path, got "${root}".` };
  root = resolve(root);
  if (platform === 'ios') {
    if (!udid) return { error: 'Missing --udid (required for --platform ios).' };
    if (!bundleId) return { error: 'Missing --bundle (required for --platform ios).' };
    // The predicate matches the executable name in processImagePath, which is
    // the product name. The caller knows it from the .app path and should
    // pass it; the bundle id's last segment is the fallback.
    if (!appName) appName = appNameFromBundleId(bundleId);
  } else {
    if (!serial) return { error: 'Missing --serial (required for --platform android).' };
    if (!packageName) return { error: 'Missing --package (required for --platform android).' };
  }
  return { platform, root, udid, bundleId, appName, serial, packageName };
}

// --- Contract 5: the collector registration -------------------------------
//
// The Contract-5 collector state helpers now live in a guard-free module
// (collector/state.ts) so `android` can import them without dragging this
// spawnable daemon entry into the CLI bundle. Re-exported here for callers --
// and tests -- that still reach for them on run.ts.
import { readCollectors, registerCollector, unregisterCollector } from './state.ts';
export { readCollectors, registerCollector, unregisterCollector };

// --- the collector itself -------------------------------------------------

export interface RunCollectorOptions {
  platform: string;
  root: string;
  udid?: string | null;
  appName?: string | null;
  bundleId?: string | null;
  serial?: string | null;
  packageName?: string | null;
  startStream?:
    | ((opts: {
        platform: string;
        udid?: string | null;
        appName?: string | null;
        serial?: string | null;
        pid?: number | null;
      }) => ChildProcess)
    | null;
  resolvePid?:
    | ((opts: { serial?: string | null; packageName?: string | null; timeoutMs: number }) => Promise<PidResolution>)
    | null;
  pidTimeoutMs?: number;
  pidOf?: ((serial: string, packageName: string, opts: { exec?: Executor | null }) => number | null) | null;
  pidWatchMs?: number | null;
  watchPid?: typeof watchAppPid;
  now?: () => number;
  onExit?: (code: number) => void;
  attachSignals?: boolean;
  stderr?: (line: string) => void;
}

export interface RunCollectorHandle {
  child: ChildProcess | null;
  writer: NdjsonWriter;
  finish: (code: number, level: string, msg: string, event: string) => void;
  startedAt: string;
  pid: number | null;
}

// Seams, all defaulted to the real thing, so the whole lifecycle is testable
// without a device: startStream returns something with .stdout/.stderr and an
// 'exit' event, exactly like a spawned child.
export async function runCollector({
  platform,
  root,
  udid = null,
  appName = null,
  serial = null,
  packageName = null,
  startStream = null,
  resolvePid = null,
  pidTimeoutMs = 30000,
  // The android restart watch (rule 3). `pidOf` is the single call it makes;
  // pidWatchMs is only ever set by a test, since the collector normally runs
  // as its own process (RN_ISO_PID_WATCH_MS is the redirect for that case).
  pidOf = null,
  pidWatchMs = null,
  watchPid = watchAppPid,
  now = Date.now,
  onExit = (code: number) => process.exit(code),
  attachSignals = true,
  stderr = (line: string) => console.error(line),
}: RunCollectorOptions): Promise<RunCollectorHandle | null> {
  const writer = createNdjsonWriter(join(workspaceLogsDir(root), 'device.ndjson'));
  const startedAt = new Date(now()).toISOString();

  let finished = false;
  let watcher: PidWatcher | null = null;
  const finish = (code: number, level: string, msg: string, event: string) => {
    if (finished) return;
    finished = true;
    // Before anything else: an unstopped interval keeps this process alive
    // long after its last record.
    watcher?.stop();
    writer.write({ src: 'device', level, event, msg });
    try {
      unregisterCollector(root, platform);
    } catch {
      /* best effort at exit */
    }
    const closed = writer.close();
    if (closed.dropped > 0) {
      stderr(`rn-iso collector: dropped ${closed.dropped} record(s); last error: ${describe(closed.lastError)}`);
    }
    onExit(code);
  };

  // Signals are handled BEFORE the registration, not after the stream starts.
  // The android path can sit in the pid wait for half a minute, and a `stop`
  // that arrived during it would otherwise kill this process at the default
  // disposition -- leaving behind exactly the registration that was written to
  // make us findable, pointing at a pid that no longer exists.
  //
  // The ordering is the invariant: once a collector is REGISTERED it can
  // always clean up after itself. Registering first left a window -- small,
  // but a `stop` racing a just-spawned collector lands in it, and CI found it.
  let child: ChildProcess | null = null;
  let flushReaders = () => {};
  if (attachSignals) {
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.on(signal, () => {
        flushReaders();
        killChild(child);
        finish(0, 'info', `device log collector received ${signal}; detaching`, 'collector_stopped');
      });
    }
  }

  // ---- the record, once we can survive being told to stop (rule 1) ----
  try {
    registerCollector(root, platform, { pid: process.pid, startedAt });
  } catch (err) {
    // Losing the registration degrades `stop` (it cannot kill us by pid) but
    // does not make the capture wrong, and refusing to collect over it would
    // trade a small problem for a total one.
    stderr(`rn-iso collector: could not record the collector in ${root}: ${describe(err)}`);
  }

  // ---- android: the pid has to exist before logcat can filter on it ----
  let pid: number | null = null;
  if (platform === 'android') {
    const resolved = resolvePid
      ? await resolvePid({ serial, packageName, timeoutMs: pidTimeoutMs })
      : await waitForAppPid({ serial: serial as string, packageName: packageName as string, timeoutMs: pidTimeoutMs });
    if (!resolved.ok) {
      finish(1, 'error', `device log collector could not attach: ${resolved.reason}`, 'collector_failed');
      return null;
    }
    pid = resolved.pid ?? null;
  }

  writer.write({
    src: 'device',
    level: 'info',
    event: 'collector_started',
    msg:
      platform === 'ios'
        ? `device log collector pid ${process.pid} streaming ${appName} on ${udid}`
        : `device log collector pid ${process.pid} streaming ${packageName} (pid ${pid}) on ${serial}`,
  });

  const parse = platform === 'ios' ? parseLogStreamLine : parseLogcatLine;
  const onLine = (line: string) => {
    const record = parse(line, { now });
    if (record) writer.write(record);
  };

  // One stream attachment: spawn, wire the readers, and own the exit. Called
  // again for every reattach, which is why it is a function -- the reattach
  // path used to not exist at all, and there is no second copy of this.
  const attach = (streamPid: number | null): ChildProcess => {
    const spawned = startStream
      ? startStream({ platform, udid, appName, serial, pid: streamPid })
      : platform === 'ios'
        ? startIosLogStream({ udid: udid as string, appName: appName as string })
        : startAndroidLogcat({ serial: serial as string, pid: streamPid as number });
    const outReader = createLineReader(onLine);
    // stderr of the stream tool is not app output: `log stream` writes its
    // filter banner and simctl's getpwuid warning there, and adb writes
    // connection notices. Kept at debug so a genuine "device offline" is still
    // recoverable from the log without drowning the timeline.
    const errReader = createLineReader((line: string) => {
      const text = String(line).trimEnd();
      if (text.trim()) writer.write({ src: 'device', level: 'debug', raw: true, event: 'collector_stderr', msg: text });
    });
    flushReaders = () => {
      outReader.flush();
      errReader.flush();
    };
    spawned.stdout?.setEncoding?.('utf-8');
    spawned.stderr?.setEncoding?.('utf-8');
    spawned.stdout?.on('data', (chunk) => outReader.push(chunk));
    spawned.stderr?.on('data', (chunk) => errReader.push(chunk));

    // The stream ending is the NORMAL end of a collector's life: the app was
    // killed, the sim shut down, the emulator went away. That is not a failure
    // of the collector, so it exits 0 -- with a record saying why, or `logs`
    // would just stop having device lines with no explanation.
    //
    // `spawned !== child` means this exit is one WE caused by reattaching, and
    // the collector is very much alive. Identity rather than a flag: the old
    // child's exit event arrives whenever it arrives, which can be after the
    // new one is already streaming.
    spawned.on('exit', (code, signal) => {
      if (spawned !== child) return;
      flushReaders();
      // logcat does keep running across a restart, but it does not have to:
      // if the stream ended AND the app is back under a new pid, that is a
      // restart this collector should follow rather than a device that went
      // away.
      const next = platform === 'android' ? watcher?.probe() : null;
      if (next && next !== pid) {
        reattach(next, 'the log stream ended');
        return;
      }
      const how = signal ? `signal ${signal}` : `exit code ${code}`;
      finish(0, 'info', `device log stream ended (${how}); the app or device is gone`, 'collector_stopped');
    });
    spawned.on('error', (err) => {
      if (spawned !== child) return;
      finish(1, 'error', `device log stream failed: ${describe(err)}`, 'collector_failed');
    });
    return spawned;
  };

  // Rule 3. The old stream is killed first: two logcats on one device write
  // every line twice, and the old one is filtering on a dead pid anyway.
  const reattach = (nextPid: number, why = 'the app restarted') => {
    if (finished) return;
    const previous = pid;
    flushReaders();
    killChild(child);
    child = null;
    writer.write({
      src: 'device',
      level: 'info',
      event: 'collector_reattached',
      msg: `${why}: ${packageName} is now pid ${nextPid} on ${serial} (was ${previous}); reattaching the log stream`,
    });
    pid = nextPid;
    try {
      child = attach(nextPid);
    } catch (err) {
      finish(
        1,
        'error',
        `device log collector could not reattach to pid ${nextPid}: ${describe(err)}`,
        'collector_failed',
      );
    }
  };

  try {
    child = attach(pid);
  } catch (err) {
    finish(1, 'error', `device log collector could not start: ${describe(err)}`, 'collector_failed');
    return null;
  }

  if (platform === 'android' && !finished) {
    watcher = watchPid({
      serial: serial as string,
      packageName: packageName as string,
      pid,
      intervalMs: pidWatchMs,
      resolve: pidOf || undefined,
      onChange: (nextPid) => reattach(nextPid),
    });
  }

  return { child, writer, finish, startedAt, pid };
}

// The stream tool is not detached, so it shares this process group;
// signalling its pid directly is still what makes it exit promptly, and its
// own exit handler is then pre-empted (by finish()'s guard on the way out, or
// by the `spawned !== child` check on a reattach).
function killChild(child: ChildProcess | null): void {
  try {
    if (child?.pid) process.kill(child.pid, 'SIGTERM');
    else child?.kill?.('SIGTERM');
  } catch {
    /* already gone */
  }
}

function describe(err: unknown): string {
  if (!err) return 'unknown error';
  return (err as Error).message || String(err);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(`rn-iso collector: ${parsed.error}`);
    process.exit(2);
    return;
  }
  const root = parsed.root as string;
  if (!existsSync(root)) {
    console.error(`rn-iso collector: --root ${root} does not exist.`);
    process.exit(2);
    return;
  }
  process.title = `rn-iso-collector-${parsed.platform}`;
  await runCollector(parsed as RunCollectorOptions);
}

// Only when executed as a program: `ios` / `android` and `stop` import this
// module for the Contract-5 helpers, and that must never start a log stream.
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  // NOT awaited, for the reason recorded in supervisor/run.js: a top-level
  // await holds this module in the "evaluating" state for the life of the
  // process, and anything importing it then blocks.
  main().catch((err) => {
    console.error(`rn-iso collector: ${describe(err)}`);
    process.exit(1);
  });
}
