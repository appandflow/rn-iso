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
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNdjsonWriter } from '../ndjson.ts';
import { workspaceLogsDir } from '../paths.ts';
import { createLineReader } from '../supervisor/server-expo.js';
import { readWorkspaceState, withWorkspaceStateLock, writeWorkspaceState } from '../supervisor/run.js';
import { appNameFromBundleId, parseLogStreamLine, startIosLogStream } from './ios.js';
import { parseLogcatLine, startAndroidLogcat, waitForAppPid, watchAppPid } from './android.js';

export const PLATFORMS = ['ios', 'android'];

export function parseArgs(argv) {
  const out = { platform: null, root: null, udid: null, bundleId: null, appName: null, serial: null, packageName: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--platform') { out.platform = argv[++i]; continue; }
    if (arg === '--root') { out.root = argv[++i]; continue; }
    if (arg === '--udid') { out.udid = argv[++i]; continue; }
    if (arg === '--bundle') { out.bundleId = argv[++i]; continue; }
    if (arg === '--app-name') { out.appName = argv[++i]; continue; }
    if (arg === '--serial') { out.serial = argv[++i]; continue; }
    if (arg === '--package') { out.packageName = argv[++i]; continue; }
    return { error: `Unknown collector argument "${arg}".` };
  }
  if (!PLATFORMS.includes(out.platform)) {
    return { error: `--platform must be one of ${PLATFORMS.join(', ')}, got "${out.platform}".` };
  }
  if (!out.root) return { error: 'Missing --root.' };
  if (!isAbsolute(out.root)) return { error: `--root must be an absolute path, got "${out.root}".` };
  out.root = resolve(out.root);
  if (out.platform === 'ios') {
    if (!out.udid) return { error: 'Missing --udid (required for --platform ios).' };
    if (!out.bundleId) return { error: 'Missing --bundle (required for --platform ios).' };
    // The predicate matches the executable name in processImagePath, which is
    // the product name. The caller knows it from the .app path and should
    // pass it; the bundle id's last segment is the fallback.
    if (!out.appName) out.appName = appNameFromBundleId(out.bundleId);
  } else {
    if (!out.serial) return { error: 'Missing --serial (required for --platform android).' };
    if (!out.packageName) return { error: 'Missing --package (required for --platform android).' };
  }
  return out;
}

// --- Contract 5: the collector registration -------------------------------
//
// Merged into the SAME state.json the supervisor writes, under its own
// `collectors` key, so `stop` and `status` read one file. Both writers
// read-modify-write, which is why each only ever touches its own key: a
// collector exiting must never take `supervisor` or the other platform's
// entry with it.

// The collectors merge (read `collectors`, add or drop this platform, write)
// is itself a read-modify-write, so it runs inside the state lock -- two
// collectors (ios + android) registering at once would otherwise each read the
// other's absence and drop it. The nested writeWorkspaceState re-acquires the
// same lock, which is reentrant, so this does not deadlock.
export function registerCollector(root, platform, record) {
  return withWorkspaceStateLock(root, () => {
    const collectors = { ...(readWorkspaceState(root)?.collectors || {}), [platform]: record };
    writeWorkspaceState(root, { collectors });
    return collectors;
  });
}

export function unregisterCollector(root, platform) {
  return withWorkspaceStateLock(root, () => {
    const state = readWorkspaceState(root);
    const collectors = { ...(state?.collectors || {}) };
    if (!(platform in collectors)) return collectors;
    delete collectors[platform];
    // JSON.stringify drops an undefined value, so passing undefined REMOVES the
    // key rather than leaving an empty object behind -- and it does so through
    // the same merging writer, instead of a second copy of the atomic write.
    writeWorkspaceState(root, { collectors: Object.keys(collectors).length ? collectors : undefined });
    return collectors;
  });
}

export function readCollectors(root) {
  return readWorkspaceState(root)?.collectors || {};
}

// --- the collector itself -------------------------------------------------

// Seams, all defaulted to the real thing, so the whole lifecycle is testable
// without a device: startStream returns something with .stdout/.stderr and an
// 'exit' event, exactly like a spawned child.
export async function runCollector({
  platform,
  root,
  udid = null,
  appName = null,
  bundleId = null,
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
  onExit = (code) => process.exit(code),
  attachSignals = true,
  stderr = (line) => console.error(line),
} = {}) {
  const writer = createNdjsonWriter(join(workspaceLogsDir(root), 'device.ndjson'));
  const startedAt = new Date(now()).toISOString();

  // ---- the record, first (rule 1) ----
  try {
    registerCollector(root, platform, { pid: process.pid, startedAt });
  } catch (err) {
    // Losing the registration degrades `stop` (it cannot kill us by pid) but
    // does not make the capture wrong, and refusing to collect over it would
    // trade a small problem for a total one.
    stderr(`rn-iso collector: could not record the collector in ${root}: ${describe(err)}`);
  }

  let finished = false;
  let watcher = null;
  const finish = (code, level, msg, event) => {
    if (finished) return;
    finished = true;
    // Before anything else: an unstopped interval keeps this process alive
    // long after its last record.
    watcher?.stop();
    writer.write({ src: 'device', level, event, msg });
    try { unregisterCollector(root, platform); } catch { /* best effort at exit */ }
    const closed = writer.close();
    if (closed.dropped > 0) {
      stderr(`rn-iso collector: dropped ${closed.dropped} record(s); last error: ${describe(closed.lastError)}`);
    }
    onExit(code);
  };

  // Signals are handled from HERE, not after the stream starts. The android
  // path can sit in the pid wait for half a minute, and a `stop` that arrived
  // during it would otherwise kill this process at the default disposition --
  // leaving behind exactly the registration rule 1 wrote to make us findable,
  // pointing at a pid that no longer exists.
  let child = null;
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

  // ---- android: the pid has to exist before logcat can filter on it ----
  let pid = null;
  if (platform === 'android') {
    const resolved = resolvePid
      ? await resolvePid({ serial, packageName, timeoutMs: pidTimeoutMs })
      : await waitForAppPid({ serial, packageName, timeoutMs: pidTimeoutMs });
    if (!resolved.ok) {
      finish(1, 'error', `device log collector could not attach: ${resolved.reason}`, 'collector_failed');
      return null;
    }
    pid = resolved.pid;
  }

  writer.write({
    src: 'device',
    level: 'info',
    event: 'collector_started',
    msg: platform === 'ios'
      ? `device log collector pid ${process.pid} streaming ${appName} on ${udid}`
      : `device log collector pid ${process.pid} streaming ${packageName} (pid ${pid}) on ${serial}`,
  });

  const parse = platform === 'ios' ? parseLogStreamLine : parseLogcatLine;
  const onLine = (line) => {
    const record = parse(line, { now });
    if (record) writer.write(record);
  };

  // One stream attachment: spawn, wire the readers, and own the exit. Called
  // again for every reattach, which is why it is a function -- the reattach
  // path used to not exist at all, and there is no second copy of this.
  const attach = (streamPid) => {
    const spawned = startStream
      ? startStream({ platform, udid, appName, serial, pid: streamPid })
      : (platform === 'ios'
        ? startIosLogStream({ udid, appName })
        : startAndroidLogcat({ serial, pid: streamPid }));
    const outReader = createLineReader(onLine);
    // stderr of the stream tool is not app output: `log stream` writes its
    // filter banner and simctl's getpwuid warning there, and adb writes
    // connection notices. Kept at debug so a genuine "device offline" is still
    // recoverable from the log without drowning the timeline.
    const errReader = createLineReader((line) => {
      const text = String(line).trimEnd();
      if (text.trim()) writer.write({ src: 'device', level: 'debug', raw: true, event: 'collector_stderr', msg: text });
    });
    flushReaders = () => { outReader.flush(); errReader.flush(); };
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
  const reattach = (nextPid, why = 'the app restarted') => {
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
      finish(1, 'error', `device log collector could not reattach to pid ${nextPid}: ${describe(err)}`, 'collector_failed');
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
      serial,
      packageName,
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
function killChild(child) {
  try {
    if (child?.pid) process.kill(child.pid, 'SIGTERM');
    else child?.kill?.('SIGTERM');
  } catch { /* already gone */ }
}

function describe(err) {
  if (!err) return 'unknown error';
  return err.message || String(err);
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(`rn-iso collector: ${parsed.error}`);
    process.exit(2);
    return;
  }
  if (!existsSync(parsed.root)) {
    console.error(`rn-iso collector: --root ${parsed.root} does not exist.`);
    process.exit(2);
    return;
  }
  process.title = `rn-iso-collector-${parsed.platform}`;
  await runCollector(parsed);
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
