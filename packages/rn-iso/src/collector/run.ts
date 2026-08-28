import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Executor } from '../exec.ts';
import { type NdjsonWriter, createNdjsonWriter } from '../ndjson.ts';
import { workspaceLogsDir } from '../paths.ts';
import { createLineReader } from '../process-output.ts';
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
    if (!appName) appName = appNameFromBundleId(bundleId);
  } else {
    if (!serial) return { error: 'Missing --serial (required for --platform android).' };
    if (!packageName) return { error: 'Missing --package (required for --platform android).' };
  }
  return { platform, root, udid, bundleId, appName, serial, packageName };
}

import { readCollectors, registerCollector, unregisterCollector } from './state.ts';
export { readCollectors, registerCollector, unregisterCollector };

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

const noopFlush = () => {};

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
    watcher?.stop();
    writer.write({ src: 'device', level, event, msg });
    try {
      unregisterCollector(root, platform);
    } catch {}
    const closed = writer.close();
    if (closed.dropped > 0) {
      stderr(`rn-iso collector: dropped ${closed.dropped} record(s); last error: ${describe(closed.lastError)}`);
    }
    onExit(code);
  };

  let child: ChildProcess | null = null;
  let flushReaders = noopFlush;
  if (attachSignals) {
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.on(signal, () => {
        flushReaders();
        killChild(child);
        finish(0, 'info', `device log collector received ${signal}; detaching`, 'collector_stopped');
      });
    }
  }

  try {
    registerCollector(root, platform, { pid: process.pid, startedAt });
  } catch (err) {
    stderr(`rn-iso collector: could not record the collector in ${root}: ${describe(err)}`);
  }

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

  const attach = (streamPid: number | null): ChildProcess => {
    const spawned = startStream
      ? startStream({ platform, udid, appName, serial, pid: streamPid })
      : platform === 'ios'
        ? startIosLogStream({ udid: udid as string, appName: appName as string })
        : startAndroidLogcat({ serial: serial as string, pid: streamPid as number });
    const outReader = createLineReader(onLine);
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

    spawned.on('exit', (code, signal) => {
      if (spawned !== child) return;
      flushReaders();
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

function killChild(child: ChildProcess | null): void {
  try {
    if (child?.pid) process.kill(child.pid, 'SIGTERM');
    else child?.kill?.('SIGTERM');
  } catch {}
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
  main().catch((err) => {
    console.error(`rn-iso collector: ${describe(err)}`);
    process.exit(1);
  });
}
