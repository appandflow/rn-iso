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
//    the way `up` records a device before booting it. A supervisor that dies
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
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearSupervisor, setSupervisor } from '../config.js';
import { createNdjsonWriter } from '../ndjson.js';
import { supervisorPidFile, workspaceLogsDir, workspaceStateFile } from '../paths.js';
import { detectIsExpo } from '../project.js';
import { describeError } from './errors.js';

export const MODE_BARE = 'bare-inproc';
export const MODE_EXPO = 'expo-child';

export function parseArgs(argv) {
  let root = null;
  let port = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') { root = argv[++i]; continue; }
    if (arg === '--port') { port = argv[++i]; continue; }
    return { error: `Unknown supervisor argument "${arg}". Usage: run.js --root <path> --port <n>` };
  }
  if (!root) return { error: 'Missing --root. Usage: run.js --root <path> --port <n>' };
  if (!isAbsolute(root)) return { error: `--root must be an absolute path, got "${root}".` };
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
    return { error: `--port must be a TCP port number, got "${port}".` };
  }
  return { root: resolve(root), port: parsedPort };
}

// --- Contract 2: the workspace state file --------------------------------
//
// <root>/.rn-iso/state.json, written temp+rename so a reader never sees half a
// file. Merged rather than overwritten: later steps put `lastBuild` beside
// `supervisor`, and a supervisor shutting down must not take it with it.

export function readWorkspaceState(root) {
  try {
    const parsed = JSON.parse(readFileSync(workspaceStateFile(root), 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // Absent, unreadable, or half-written: the file is a cache of facts that
    // are also in the config, so an unusable one reads as "no state".
    return null;
  }
}

export function writeWorkspaceState(root, patch) {
  return replaceWorkspaceState(root, { ...(readWorkspaceState(root) || {}), ...patch });
}

// The whole file, not a merge. Kept separate because clearing a key through
// the merging writer above would read the key back in and write it out again
// -- the state would never actually clear.
function replaceWorkspaceState(root, state) {
  const file = workspaceStateFile(root);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
  return state;
}

// Removes only OUR key. The file goes when nothing else is left in it, so a
// stopped workspace has no state.json rather than an empty one -- but a
// workspace that has recorded something else keeps it.
export function clearWorkspaceSupervisor(root) {
  const state = readWorkspaceState(root);
  if (!state || !('supervisor' in state)) return;
  delete state.supervisor;
  const file = workspaceStateFile(root);
  if (Object.keys(state).length === 0) {
    try { rmSync(file, { force: true }); } catch { /* already gone */ }
    return;
  }
  replaceWorkspaceState(root, state);
}

export function writePidFile(root, pid) {
  const file = supervisorPidFile(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${pid}\n`);
  return file;
}

export function readPidFile(root) {
  try {
    const pid = parseInt(readFileSync(supervisorPidFile(root), 'utf-8').trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

// --- the supervisor itself ------------------------------------------------

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
  isExpo = detectIsExpo,
  startBare = null,
  startExpo = null,
  now = Date.now,
  onExit = (code) => process.exit(code),
  attachSignals = true,
  stderr = (line) => console.error(line),
} = {}) {
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
    // the global one degrades `status --all`, and is not worth refusing to
    // serve a dev server over.
    writer.write({ src: 'metro', level: 'warn', event: 'supervisor_registration_failed', msg: `Could not record the supervisor in the global config: ${describeError(err)}` });
    stderr(`rn-iso supervisor: global registration failed: ${describeError(err)}`);
  }

  writer.write({
    src: 'metro',
    level: 'info',
    event: 'supervisor_started',
    msg: `supervisor pid ${process.pid} starting the ${mode} dev server on port ${port} for ${root}`,
  });

  let stopping = false;
  const finish = (code, event, level, msg) => {
    writer.write({ src: 'metro', level, event, msg });
    try { clearSupervisor(root); } catch { /* the registry is best-effort at exit */ }
    try { clearWorkspaceSupervisor(root); } catch { /* same */ }
    try { rmSync(supervisorPidFile(root), { force: true }); } catch { /* same */ }
    const closed = writer.close();
    if (closed.dropped > 0) {
      stderr(`rn-iso supervisor: dropped ${closed.dropped} log record(s); last error: ${describeError(closed.lastError)}`);
    }
    onExit(code);
  };

  let server;
  try {
    const start = mode === MODE_EXPO
      ? (startExpo || (await import('./server-expo.js')).startExpoServer)
      : (startBare || (await import('./server-bare.js')).startBareServer);
    server = await start({ root, port, logsDir, writer });
  } catch (err) {
    // The message is the whole output: `start` shows the tail of
    // supervisor.log when a supervisor never answers, so a bare stack there
    // is a worse answer than a named package and a remedy.
    stderr(`rn-iso supervisor: failed to start the ${mode} dev server: ${describeError(err)}`);
    finish(1, 'supervisor_failed', 'fatal', `failed to start the ${mode} dev server: ${describeError(err)}`);
    return null;
  }

  if (server?.serverPid) {
    writeWorkspaceState(root, { supervisor: { ...record, serverPid: server.serverPid } });
  }
  writer.write({
    src: 'metro',
    level: 'info',
    event: 'server_started',
    msg: `${mode} dev server listening on port ${port}`,
  });

  const shutdown = async (code, event, msg) => {
    if (stopping) return;
    stopping = true;
    try {
      await server.close();
    } catch (err) {
      writer.write({ src: 'metro', level: 'warn', event: 'server_close_failed', msg: describeError(err) });
    }
    finish(code, event, code === 0 ? 'info' : 'error', msg);
  };

  // A dev server that dies on its own takes the supervisor with it. The
  // alternative -- a supervisor still registered, still holding a pid file,
  // with nothing serving -- is the state every other command would read as
  // healthy.
  server.onExit?.((info) => {
    if (stopping) return;
    const detail = info?.signal ? `signal ${info.signal}` : `exit code ${info?.code ?? 'unknown'}`;
    shutdown(1, 'supervisor_stopped', `the ${mode} dev server exited unexpectedly (${detail}); shutting the supervisor down`);
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

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(`rn-iso supervisor: ${parsed.error}`);
    process.exit(2);
    return;
  }
  if (!existsSync(parsed.root)) {
    console.error(`rn-iso supervisor: --root ${parsed.root} does not exist.`);
    process.exit(2);
    return;
  }
  // The identity check every other command uses reads the cwd of whatever
  // holds the port (resolveProjectMetro), so the process holding it has to run
  // from inside the project. `start` already spawns us with this cwd; doing it
  // again here is what makes a hand-run `node run.js --root X` identify the
  // same way.
  try { process.chdir(parsed.root); } catch { /* keep the inherited cwd */ }
  process.title = 'rn-iso-supervisor';
  await runSupervisor(parsed);
}

// Only when executed as a program. `start` imports this module for the state
// helpers, and that must never launch a dev server.
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
