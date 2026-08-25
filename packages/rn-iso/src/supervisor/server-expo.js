// src/supervisor/server-expo.js -- hosting an Expo dev server by spawning the
// project's own `expo start` as a child, and parsing its stdout into the same
// NDJSON timeline the bare path produces from a reporter.
//
// Why a child rather than in-process hosting, when bare RN is hosted directly:
// Expo's dev server is protocol-bearing. It serves ManifestMiddleware,
// ExpoGoManifestHandlerMiddleware, InterstitialPageMiddleware,
// DevToolsPluginMiddleware, expo-router route serving and DOM components --
// those ARE the protocol expo-dev-client speaks, so reimplementing them is
// forking Expo rather than trimming it. Expo also exposes no
// reporter-injection hook (no customLogReporterPath equivalent) and
// force-overrides config.reporter in instantiateMetro.ts, so a reporter set in
// metro.config.js would be discarded anyway.
//
// The cost is structure: levels are INFERRED from the line rather than read
// from an event, and every record carries `raw: true` to say so. Hosting Expo
// in-process by deep-importing MetroBundlerDevServer is the recorded upgrade
// path, and is deferred because those are unversioned build artifacts of an
// internal TS module.
//
// `expo start --port <n>` and NOTHING else, ever. Which flags a project needs
// is the project's judgment, the same reason rn-iso stopped wrapping builds.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getExecutor } from '../exec.js';
import { createNdjsonWriter } from '../ndjson.js';
import { supervisorError } from './errors.js';

export function expoBinPath(root) {
  return join(root, 'node_modules', '.bin', 'expo');
}

// CSI sequences (colour, cursor moves) and OSC sequences (window titles,
// hyperlinks). Expo colours nearly every line, and an escape sequence inside a
// JSON string is unreadable in a log and unmatchable by `logs --grep`.
const ANSI = /\u001B\[[0-9;?]*[ -\/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;

export function stripAnsi(text) {
  return String(text).replace(ANSI, '');
}

// Expo marks errors and warnings with symbols as often as with words, so both
// are recognized. Anything else is info: over-reporting a line as an error is
// worse than under-reporting it, because `logs --errors` is the query an agent
// loop branches on.
const CROSS = '\u2716';        // heavy multiplication x, Expo's error bullet
const CROSS_MARK = '\u274C';   // cross mark emoji
const WARNING_SIGN = '\u26A0'; // warning sign

export function inferLevel(line) {
  const text = String(line).trimStart();
  if (!text) return 'info';
  const first = text[0];
  if (first === CROSS || first === CROSS_MARK) return 'error';
  if (first === WARNING_SIGN) return 'warn';
  const word = /^([A-Za-z]+)/.exec(text);
  const lead = word ? word[1].toLowerCase() : '';
  if (lead === 'error' || lead === 'fatal') return 'error';
  if (lead === 'warn' || lead === 'warning') return 'warn';
  return 'info';
}

// The marker resets the window `logs --errors` reports over. The bare path
// gets it from the reporter's bundle_build_done event; the only equivalent
// here is the line Expo prints when a bundle finishes ("iOS Bundled 812ms
// index.js (1150 modules)"). Without it an Expo workspace's error window would
// never reset, and an error fixed three builds ago would keep being reported
// as current.
export function isBundleMarker(line) {
  return /\bBundled\b/.test(String(line));
}

// A terminal shows only what follows the last carriage return, which is how
// progress lines redraw in place. Doing the same here keeps a spinner from
// arriving as one record containing thirty copies of itself.
export function cleanLine(line) {
  const parts = stripAnsi(line).split('\r');
  return parts[parts.length - 1].trimEnd();
}

export function recordFromLine(line, { stream = 'stdout' } = {}) {
  const msg = cleanLine(line);
  if (!msg.trim()) return null;
  const record = {
    src: 'metro',
    level: inferLevel(msg),
    msg,
    // Contract 1: the structure was inferred from stdout, not reported.
    raw: true,
    event: stream === 'stderr' ? 'expo_stderr' : 'expo_stdout',
  };
  if (isBundleMarker(msg)) record.marker = true;
  return record;
}

export function createLineReader(onLine) {
  let buffered = '';
  return {
    push(chunk) {
      buffered += String(chunk);
      const parts = buffered.split('\n');
      buffered = parts.pop() ?? '';
      for (const part of parts) onLine(part);
    },
    // The last line of a child's output has no trailing newline when the child
    // dies mid-line, and that line is usually the interesting one.
    flush() {
      if (!buffered) return;
      const rest = buffered;
      buffered = '';
      onLine(rest);
    },
  };
}

export async function startExpoServer({
  root,
  port,
  logsDir,
  writer = null,
  spawnFn = null,
  killTimeoutMs = 5000,
}) {
  const bin = expoBinPath(root);
  if (!existsSync(bin)) {
    throw supervisorError(
      'RN_ISO_EXPO_BIN',
      `Cannot start an Expo dev server for ${root}: ${bin} does not exist.`,
      'Run `npm install` in the project so the `expo` package installs its binary.'
    );
  }

  const log = writer || createNdjsonWriter(join(logsDir, 'metro.ndjson'));
  const spawn = spawnFn || ((cmd, args, opts) => getExecutor().spawn(cmd, args, opts));

  const child = spawn(bin, ['start', '--port', String(port)], {
    cwd: root,
    // stdin is ignored on purpose: a detached supervisor has no terminal, and
    // an Expo waiting on keypresses would look hung.
    stdio: ['ignore', 'pipe', 'pipe'],
    // NOT detached: the child stays in the supervisor's process group, so
    // signalling that group takes the dev server with it and no orphan can
    // outlive us.
    detached: false,
    // Colour only makes the log harder to read; it is stripped either way.
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  const emit = (stream) => (chunk) => {
    const record = recordFromLine(chunk, { stream });
    if (record) log.write(record);
  };
  const outReader = createLineReader(emit('stdout'));
  const errReader = createLineReader(emit('stderr'));
  child.stdout?.setEncoding?.('utf-8');
  child.stderr?.setEncoding?.('utf-8');
  child.stdout?.on('data', (chunk) => outReader.push(chunk));
  child.stderr?.on('data', (chunk) => errReader.push(chunk));

  let exited = false;
  let exitInfo = null;
  const listeners = [];
  child.on('exit', (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
    outReader.flush();
    errReader.flush();
    for (const cb of listeners) cb(exitInfo);
  });
  // A spawn that fails (ENOENT, EACCES) emits `error` and never `exit`.
  child.on('error', (err) => {
    if (exited) return;
    exited = true;
    exitInfo = { code: null, signal: null, error: err };
    for (const cb of listeners) cb(exitInfo);
  });

  return {
    mode: 'expo-child',
    serverPid: child.pid ?? null,
    child,
    onExit(cb) {
      if (exited) { cb(exitInfo); return; }
      listeners.push(cb);
    },
    async close() {
      if (exited || !child.pid) return;
      const dead = new Promise((resolve) => {
        child.once('exit', () => resolve());
      });
      const expire = (ms) => new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        if (typeof t.unref === 'function') t.unref();
      });
      // The child pid, not its group: detached:false means it shares the
      // supervisor's group, so a group signal would kill the supervisor before
      // it could write its final record and clear its registration.
      try { process.kill(child.pid, 'SIGTERM'); } catch { return; }
      await Promise.race([dead, expire(killTimeoutMs)]);
      if (!exited) {
        // An Expo that ignored SIGTERM would otherwise keep the port and
        // outlive the supervisor that is supposed to own it.
        try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
        await Promise.race([dead, expire(killTimeoutMs)]);
      }
    },
  };
}
