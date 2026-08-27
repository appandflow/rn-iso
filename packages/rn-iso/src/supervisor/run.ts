// src/supervisor/run.js -- the detached per-workspace supervisor.
//
// Invoked as `node run.js --root <abs path> --port <n>`, normally by
// `rn-iso start`, which spawns it detached with its stdio pointed at
// <root>/.rn-iso/logs/supervisor.log.
//
// It hosts ONE dev server for ONE workspace and nothing else. There is no
// machine-wide daemon: no cross-project state, no IPC beyond this workspace,
// nothing to install or upgrade.
//
// Two rules shape everything below.
//
// 1. THE RECORD IS WRITTEN BEFORE THE SERVER STARTS. The pid file, the
//    workspace state.json and the global registration all land first, exactly
//    the way `ios` records a device before booting it. A supervisor that dies
//    during startup must still be findable -- an unrecorded process holding a
//    port is what nothing will ever clean up. The cost of the other order is
//    not symmetric: a stale record is cheap to detect (the pid is not alive,
//    or it is alive and its recorded root does not match) while an unrecorded
//    process is not detectable at all.
// 2. NO EXIT PATH IS SILENT. Every way out of here -- a signal, a server that
//    failed to start, a dev server that died on its own -- writes a final
//    NDJSON record, clears the registration, and removes the pid/state files.
//    A supervisor must never linger with a dead server, and a dead supervisor
//    must never leave a record claiming it is alive.
import { existsSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearSupervisor, setSupervisor } from '../config.ts';
import { type NdjsonWriter, createNdjsonWriter } from '../ndjson.ts';
import { supervisorPidFile, workspaceLogsDir } from '../paths.ts';
import { detectIsExpo } from '../project.ts';
import { describeError } from './errors.ts';
import { MODE_BARE, MODE_EXPO, clearWorkspaceSupervisor, writePidFile, writeWorkspaceState } from './state.ts';

// The state + pid helpers now live in a guard-free module (state.ts) so the CLI
// commands can import them without dragging this daemon entry in. Re-exported
// here for callers -- and tests -- that still reach for them on run.ts.
export {
  MODE_BARE,
  MODE_EXPO,
  clearWorkspaceSupervisor,
  readPidFile,
  readWorkspaceState,
  withWorkspaceStateLock,
  writePidFile,
  writeWorkspaceState,
} from './state.ts';
export type { WorkspaceState } from './state.ts';

interface ParsedSupervisorArgs {
  root?: string;
  port?: number;
  tunnel?: boolean;
  error?: string;
}

export function parseArgs(argv: string[]): ParsedSupervisorArgs {
  let root: string | undefined;
  let port: string | undefined;
  let tunnel = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') {
      root = argv[++i];
      continue;
    }
    if (arg === '--port') {
      port = argv[++i];
      continue;
    }
    // `start` decided the Expo dev server should tunnel itself
    // (metro.tunnel resolved to expo/auto-on-Expo); see server-expo.ts.
    if (arg === '--tunnel') {
      tunnel = true;
      continue;
    }
    return { error: `Unknown supervisor argument "${arg}". Usage: run.js --root <path> --port <n> [--tunnel]` };
  }
  if (!root) return { error: 'Missing --root. Usage: run.js --root <path> --port <n> [--tunnel]' };
  if (!isAbsolute(root)) return { error: `--root must be an absolute path, got "${root}".` };
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
    return { error: `--port must be a TCP port number, got "${port}".` };
  }
  return { root: resolve(root), port: parsedPort, tunnel };
}

// --- the supervisor itself ------------------------------------------------

// What a signal or an unexpected exit reports back through onExit -- the same
// shape whether the source is the expo child's exit event or the bare path's
// Metro http server closing.
export interface ServerExitInfo {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  reason?: string;
  error?: Error;
}

// The seam server-bare.ts and server-expo.ts both hand back: their actual
// return values carry more (httpServer, child, mode), which a caller here
// never touches -- only the lifecycle surface below is shared.
export interface ServerHandle {
  close(): Promise<void> | void;
  onExit?(cb: (info?: ServerExitInfo | null) => void): void;
  serverPid?: number | null;
}

type ServerStarter = (opts: {
  root: string;
  port: number;
  logsDir: string;
  writer?: NdjsonWriter | null;
  // Expo-only; startBareServer ignores both (a bare workspace has no dev
  // server of its own to hand a `--tunnel` flag to).
  tunnel?: boolean;
  onTunnelUrl?: ((url: string) => void) | null;
}) => Promise<ServerHandle>;

export interface RunSupervisorOptions {
  root: string;
  port: number;
  // `start` decided the Expo dev server should tunnel itself; see
  // server-expo.ts's `tunnel` option. No effect on the bare path.
  tunnel?: boolean;
  isExpo?: (projectRoot: string) => boolean;
  startBare?: ServerStarter | null;
  startExpo?: ServerStarter | null;
  now?: () => number;
  onExit?: (code: number) => void;
  attachSignals?: boolean;
  stderr?: (line: string) => void;
}

// Seams, all defaulted to the real thing:
//   isExpo      ecosystem detection (project.js)
//   startBare / startExpo   the two server modules, imported lazily so that
//                           importing this file (as `start` does, for the
//                           state helpers) never loads Metro
//   onExit      process.exit
//   attachSignals  whether to register SIGTERM/SIGINT handlers
export async function runSupervisor({
  root,
  port,
  tunnel = false,
  isExpo = detectIsExpo,
  startBare = null,
  startExpo = null,
  now = Date.now,
  onExit = (code: number) => process.exit(code),
  attachSignals = true,
  stderr = (line: string) => console.error(line),
}: RunSupervisorOptions): Promise<{
  mode: string;
  server: ServerHandle | undefined;
  shutdown: (code: number, event: string, msg: string) => Promise<void>;
  startedAt: string;
} | null> {
  const logsDir = workspaceLogsDir(root);
  const writer = createNdjsonWriter(join(logsDir, 'metro.ndjson'));
  const mode = isExpo(root) ? MODE_EXPO : MODE_BARE;
  const startedAt = new Date(now()).toISOString();
  const record = { pid: process.pid, port, mode, startedAt };

  // ---- the record, first (rule 1) ----
  writePidFile(root, process.pid);
  writeWorkspaceState(root, { supervisor: record });
  try {
    setSupervisor(root, { pid: process.pid, port, startedAt });
  } catch (err) {
    // The global registration is the copy that survives the workspace being
    // deleted; the workspace copy above is the one `stop` reads first. Losing
    // the global one degrades `status`, and is not worth refusing to
    // serve a dev server over.
    writer.write({
      src: 'metro',
      level: 'warn',
      event: 'supervisor_registration_failed',
      msg: `Could not record the supervisor in the global config: ${describeError(err)}`,
    });
    stderr(`rn-iso supervisor: global registration failed: ${describeError(err)}`);
  }

  writer.write({
    src: 'metro',
    level: 'info',
    event: 'supervisor_started',
    msg: `supervisor pid ${process.pid} starting the ${mode} dev server on port ${port} for ${root}`,
  });

  let stopping = false;
  const finish = (code: number, event: string, level: string, msg: string) => {
    writer.write({ src: 'metro', level, event, msg });
    try {
      clearSupervisor(root);
    } catch {
      /* the registry is best-effort at exit */
    }
    try {
      clearWorkspaceSupervisor(root);
    } catch {
      /* same */
    }
    try {
      rmSync(supervisorPidFile(root), { force: true });
    } catch {
      /* same */
    }
    const closed = writer.close();
    if (closed.dropped > 0) {
      stderr(
        `rn-iso supervisor: dropped ${closed.dropped} log record(s); last error: ${describeError(closed.lastError)}`,
      );
    }
    onExit(code);
  };

  let server: ServerHandle | undefined;
  try {
    const start: ServerStarter =
      mode === MODE_EXPO
        ? startExpo || (await import('./server-expo.ts')).startExpoServer
        : startBare || (await import('./server-bare.ts')).startBareServer;
    server = await start({
      root,
      port,
      logsDir,
      writer,
      tunnel,
      onTunnelUrl: (url: string) => {
        try {
          writeWorkspaceState(root, { metroTunnel: { kind: 'expo', url } });
        } catch (err) {
          stderr(`rn-iso supervisor: could not record the Expo tunnel URL: ${describeError(err)}`);
        }
        writer.write({ src: 'metro', level: 'info', event: 'expo_tunnel_ready', msg: `Expo tunnel ready: ${url}` });
      },
    });
  } catch (err) {
    // The message is the whole output: `start` shows the tail of
    // supervisor.log when a supervisor never answers, so a bare stack there
    // is a worse answer than a named package and a remedy.
    stderr(`rn-iso supervisor: failed to start the ${mode} dev server: ${describeError(err)}`);
    finish(1, 'supervisor_failed', 'fatal', `failed to start the ${mode} dev server: ${describeError(err)}`);
    return null;
  }

  // Narrowed once into a const: `server` is definitely assigned past the
  // try/catch above (the catch branch returns), but a `let` does not keep
  // that narrowing inside the closures below.
  const readyServer: ServerHandle = server;

  if (readyServer.serverPid) {
    writeWorkspaceState(root, { supervisor: { ...record, serverPid: readyServer.serverPid } });
  }
  writer.write({
    src: 'metro',
    level: 'info',
    event: 'server_started',
    msg: `${mode} dev server listening on port ${port}`,
  });

  const shutdown = async (code: number, event: string, msg: string) => {
    if (stopping) return;
    stopping = true;
    try {
      await readyServer.close();
    } catch (err) {
      writer.write({ src: 'metro', level: 'warn', event: 'server_close_failed', msg: describeError(err) });
    }
    finish(code, event, code === 0 ? 'info' : 'error', msg);
  };

  // A dev server that dies on its own takes the supervisor with it. The
  // alternative -- a supervisor still registered, still holding a pid file,
  // with nothing serving -- is the state every other command would read as
  // healthy.
  readyServer.onExit?.((info) => {
    if (stopping) return;
    const detail = info?.signal ? `signal ${info.signal}` : `exit code ${info?.code ?? 'unknown'}`;
    shutdown(
      1,
      'supervisor_stopped',
      `the ${mode} dev server exited unexpectedly (${detail}); shutting the supervisor down`,
    );
  });

  if (attachSignals) {
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.on(signal, () => {
        shutdown(0, 'supervisor_stopped', `received ${signal}; stopping the ${mode} dev server`);
      });
    }
  }

  return { mode, server, shutdown, startedAt };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(`rn-iso supervisor: ${parsed.error}`);
    process.exit(2);
    return;
  }
  const root = parsed.root as string;
  if (!existsSync(root)) {
    console.error(`rn-iso supervisor: --root ${root} does not exist.`);
    process.exit(2);
    return;
  }
  // The identity check every other command uses reads the cwd of whatever
  // holds the port (resolveProjectMetro), so the process holding it has to run
  // from inside the project. `start` already spawns us with this cwd; doing it
  // again here is what makes a hand-run `node run.js --root X` identify the
  // same way.
  try {
    process.chdir(root);
  } catch {
    /* keep the inherited cwd */
  }
  process.title = 'rn-iso-supervisor';
  await runSupervisor({ root, port: parsed.port as number, tunnel: parsed.tunnel ?? false });
}

// Only when executed as a program. `start` imports this module for the state
// helpers, and that must never launch a dev server.
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  // NOT awaited. A top-level await here would hold this module in the
  // "evaluating" state for the whole life of the supervisor, and any module
  // that imports run.js while it is in that state blocks -- which is how the
  // first live run deadlocked (see src/supervisor/errors.js). The daemon is
  // kept alive by the server it starts, not by this promise.
  main().catch((err) => {
    console.error(`rn-iso supervisor: ${describeError(err)}`);
    process.exit(1);
  });
}
