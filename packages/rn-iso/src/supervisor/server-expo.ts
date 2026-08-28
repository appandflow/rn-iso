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
// in-process would require deep imports of unversioned CLI internals and would
// still not provide a supported reporter hook, so the child is intentional.
//
// `expo start --port <n>` and NOTHING else, ever. Which flags a project needs
// is the project's judgment, the same reason rn-iso stopped wrapping builds.
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { metroStoreInjectionEnabled } from '../config.ts';
import { getExecutor } from '../exec.ts';
import { type NdjsonRecord, type NdjsonWriter, createNdjsonWriter } from '../ndjson.ts';
import { resolvePackageJson } from '../project.ts';
import {
  expoMetroConfigPath,
  expoMetroStoreEnv,
  metroStoreConfirmedRoot,
  metroStoreRoot,
  registerMetroStore,
} from './metro-store.ts';
import { supervisorError } from './errors.ts';

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

// THE PROJECT'S OWN expo binary, found by NODE RESOLUTION rather than by path
// joining. `<root>/node_modules/.bin/expo` does not exist on a hoisted
// monorepo -- neither a pnpm workspace nor a yarn-workspaces one puts it
// there -- and this used to refuse to start with "run npm install" on
// projects whose dependencies were installed perfectly well. Order:
//
//   1. require.resolve('expo/package.json', { paths: [root] }), then the
//      package's OWN `bin` field. That is the same lookup `import 'expo'`
//      from the project performs, so it finds the hoisted copy the project
//      actually loads, and the bin field is where the package says which file
//      to run (expo's is { expo: "bin/cli", ... }).
//   2. node_modules/.bin/expo walking UP from the project. Covers a package
//      whose package.json cannot be resolved (an exports map without
//      ./package.json) but whose shim the installer still linked.
//
// Never `npx expo`: npx on a project without expo installed downloads
// whatever version is newest and runs THAT against the app -- a dev server,
// or a prebuild, from an SDK the project never chose.
export function expoBinPath(root: string): string | null {
  const fromPackage = expoBinFromPackage(resolvePackageJson(root, 'expo'));
  if (fromPackage) return fromPackage;
  return findBinUpward(root, 'expo');
}

// Expo added EXPO_OVERRIDE_METRO_CONFIG in SDK 54. Older CLIs have no
// supported way to supply a config without editing the project, so rn-iso
// deliberately leaves their Metro cache alone.
export function expoSdkMajor(root: string): number | null {
  const packageJsonPath = resolvePackageJson(root, 'expo');
  if (!packageJsonPath) return null;
  try {
    const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const version = (pkg as { version?: unknown } | null)?.version;
    if (typeof version !== 'string') return null;
    const match = /^(\d+)/.exec(version);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

// PURE-ish (reads the package.json it is given the path to). The executable a
// package's `bin` field names, or null. Both shapes are handled: a string
// ("bin/cli") and a map ({ expo: "bin/cli" }).
export function expoBinFromPackage(packageJsonPath: string | null, binName = 'expo'): string | null {
  if (!packageJsonPath) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a project's package.json, parsed defensively
  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  } catch {
    return null;
  }
  const bin = pkg?.bin;
  const rel = typeof bin === 'string' ? bin : bin && typeof bin === 'object' ? bin[binName] : null;
  if (typeof rel !== 'string' || rel.trim() === '') return null;
  const file = join(dirname(packageJsonPath), rel);
  return isExecutableFile(file) ? file : null;
}

// The .bin shim, from the project up to the filesystem root. A hoisted
// install puts it at the workspace root; stopping at the project would miss
// every monorepo, which is the bug this exists for. Bounded by the root
// directory, and it stops at the first hit, so the nearest copy wins.
export function findBinUpward(
  startDir: string,
  name: string,
  { exists = existsSync }: { exists?: (p: string) => boolean } = {},
): string | null {
  let dir = startDir;
  const stop = parse(startDir).root;
  while (true) {
    const candidate = join(dir, 'node_modules', '.bin', name);
    if (exists(candidate)) return candidate;
    if (dir === stop) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// A bin file that is not executable would fail at spawn time with EACCES,
// which reads as "expo is broken" rather than "this copy is not the one to
// run". Falling through to the .bin shim is the better answer.
function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The refusal when no expo binary can be found. Its remedy has to be true on
// a monorepo: "run npm install" was printed at two repos whose dependencies
// were installed, and it sent the reader looking in the wrong place.
export function expoBinRefusal(
  root: string,
  what = 'start an Expo dev server for',
): { message: string; remedy: string } {
  return {
    message:
      `Cannot ${what} ${root}: the \`expo\` package is not resolvable from it` +
      ' (require.resolve("expo/package.json") failed, and no node_modules/.bin/expo exists in it or in any parent).',
    remedy:
      "Install the project's dependencies (in a monorepo, from the workspace root), or check that this package really depends on `expo`.",
  };
}

// CSI sequences (colour, cursor moves) and OSC sequences (window titles,
// hyperlinks). Expo colours nearly every line, and an escape sequence inside a
// JSON string is unreadable in a log and unmatchable by `logs --grep`.
// oxlint-disable-next-line no-control-regex -- intentional ANSI escape match
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;

export function stripAnsi(text: unknown): string {
  return String(text).replace(ANSI, '');
}

// Expo marks errors and warnings with symbols as often as with words, so both
// are recognized. Anything else is info: over-reporting a line as an error is
// worse than under-reporting it, because `logs --errors` is the query an agent
// loop branches on.
const CROSS = '\u2716'; // heavy multiplication x, Expo's error bullet
const CROSS_MARK = '\u274C'; // cross mark emoji
const WARNING_SIGN = '\u26A0'; // warning sign

// --- the one demotion this stream carries ---------------------------------
//
// FIELD PROVENANCE (release gate, 2026-08-24): every cold Android launch --
// a healthy one -- ended with `logs --errors` returning one record and
// `status` reporting "1 error since the last marker". rn-iso itself produces
// it. Contract 6 launches the app with the expo-dev-client deep link
// `<scheme>://expo-development-client/?url=http://10.0.2.2:<port>`
// (devClientUrl, engine/app-install.js); expo-dev-launcher hands the app the
// URL it was opened with, and React Navigation logs at console.error that
// nothing handled a NAVIGATE to a route named `expo-development-client`.
// There is no such screen and there is not supposed to be: the launcher's
// host is not a route. The app is loaded, bundled and working.
//
// The rule is deliberately two-sided -- the unhandled-NAVIGATE shape AND the
// `expo-development-client` route name, in the SAME record -- because the only
// thing this demotion could break is a real unhandled navigation, and those
// name a route the app actually has. Either half on its own stays an error.
//
// Demotion, not suppression: the record is still written, still shows in a
// plain `logs`, and only stops counting as an error. Same treatment, and the
// same reason, as the device-noise lists in collector/ios.js and
// collector/android.js.
const UNHANDLED_NAVIGATE =
  /The action '(?:NAVIGATE|NAVIGATE_DEPRECATED)' with payload .*was not handled by any navigator/;
const DEV_CLIENT_ROUTE = 'expo-development-client';

// PURE. Whether this line is rn-iso's own dev-client deep link arriving in a
// navigator that has no route for it.
export function isDevClientNavigationNotice(line: unknown): boolean {
  const text = String(line);
  return text.includes(DEV_CLIENT_ROUTE) && UNHANDLED_NAVIGATE.test(text);
}

export function inferLevel(line: unknown): string {
  const text = String(line).trimStart();
  if (!text) return 'info';
  if (isDevClientNavigationNotice(text)) return 'info';
  const first = text[0];
  if (first === CROSS || first === CROSS_MARK) return 'error';
  if (first === WARNING_SIGN) return 'warn';
  const word = /^([A-Za-z]+)/.exec(text);
  const lead = word?.[1]?.toLowerCase() ?? '';
  if (lead === 'error' || lead === 'fatal') return 'error';
  if (lead === 'warn' || lead === 'warning') return 'warn';
  // Expo's real failure vocabulary carries no bullet and no leading "error":
  // "iOS Bundling failed 6566ms ..." and "Unable to resolve \"./x\" from ..."
  // were both stored at info in the tlon field test, which made
  // `logs --errors` return empty against a build that failed. Match the
  // phrases, not a prefix.
  if (/\bBundling failed\b/.test(text)) return 'error';
  if (/^Unable to resolve\b/.test(text)) return 'error';
  if (/^Failed to (load|resolve|compile|build)\b/.test(text)) return 'error';
  // Node-exception shape: "PluginError: Failed to resolve plugin ...",
  // "CommandError: ...". This is how an expo child dies on a config error,
  // and it was stored at info in the tlon fresh-pass -- which hid the death
  // cry from `logs --errors` AND from start's failure evidence (#30).
  if (/^[A-Z][A-Za-z]*Error:/.test(text)) return 'error';
  return 'info';
}

// The marker resets the window `logs --errors` reports over, and BOTH ends of
// a bundle attempt carry one. The bare path gets them from the reporter's
// bundle_build_done / bundle_build_failed events; the equivalents here are the
// lines Expo prints when a bundle finishes: "iOS Bundled 812ms index.js (1150
// modules)" on success, "iOS Bundling failed 893ms" on failure. Without the
// success marker an Expo workspace's error window would never reset and an
// error fixed three builds ago would keep being reported as current; without
// the FAILURE marker, back-to-back failed bundles would pile up and the
// oldest -- least relevant -- failure would be listed first
// (appandflow/rn-iso#13). Marking the failed line cannot hide the failure it
// summarizes: Expo prints it BEFORE the detail lines that explain it, and
// logs-query's bundle cutoff is strict (<), so the line itself (error-level,
// stamped at the marker's own ts) and everything after it stay reported while
// the previous attempt's errors go.
export function isBundleMarker(line: unknown): boolean {
  const text = String(line);
  return /\bBundled\b/.test(text) || /\bBundling failed\b/.test(text);
}

// PURE. Proof that SOMETHING asked this dev server for a bundle: Expo prints
// "iOS Bundling complete 812ms", "Android Bundling failed 91ms" and
// "iOS Bundled 812ms index.js (1150 modules)" only in response to a bundle
// request. It is the expo-child equivalent of the bare path's
// bundle_build_started event, and it is what `ios` / `android` poll for after
// a launch: an app sitting on expo-dev-launcher's server picker has fetched
// nothing, and the picker looks identical to a loaded app from the outside.
export function isBundleActivityLine(line: unknown): boolean {
  return /\bBundl(?:ing|ed)\b/.test(String(line));
}

// A terminal shows only what follows the last carriage return, which is how
// progress lines redraw in place. Doing the same here keeps a spinner from
// arriving as one record containing thirty copies of itself.
export function cleanLine(line: unknown): string {
  const parts = stripAnsi(line).split('\r');
  return (parts[parts.length - 1] ?? '').trimEnd();
}

export function recordFromLine(line: unknown, { stream = 'stdout' }: { stream?: string } = {}): NdjsonRecord | null {
  const msg = cleanLine(line);
  if (!msg.trim()) return null;
  // THE ONE STRUCTURED LINE IN THIS STREAM. The config adapter runs inside this
  // child, so its success line is the only evidence rn-iso can have that the
  // shared transform store reached the config Metro loaded -- see
  // resolveMetroStoreInjection below for why the record cannot be written on
  // the way in. It is promoted out of the raw stream rather than stored as one
  // more info line: `raw: true` would say the structure was inferred, and this
  // one was reported.
  const confirmed = metroStoreConfirmedRoot(msg);
  if (confirmed) {
    return {
      src: 'metro',
      level: 'debug',
      event: 'cache_store_added',
      msg: `sharing Metro transforms through ${confirmed} (the dev server process confirmed the store is in the config Metro loaded)`,
    };
  }
  const record: NdjsonRecord = {
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

export function createLineReader(onLine: (line: string) => void): { push(chunk: unknown): void; flush(): void } {
  let buffered = '';
  return {
    push(chunk: unknown) {
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

interface ExpoExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

// The ServerHandle runSupervisor drives, plus the pieces a test reaches for.
export interface ExpoServerHandle {
  mode: string;
  serverPid: number | null;
  child: ChildProcess;
  onExit(cb: (info: ExpoExitInfo | null) => void): void;
  close(): Promise<void>;
}

// THE ZERO-CONFIG HALF OF `rn-iso start` ON AN EXPO PROJECT.
//
// The bare path can append a cache store to the config it loaded, because it
// loads the config. Here the dev server is the project's own `expo start`.
// Expo SDK 54+ exposes EXPO_OVERRIDE_METRO_CONFIG, so rn-iso points it at a
// packaged adapter that composes the project's own config and appends the
// store. SDK 53 and older run normally without rn-iso's shared Metro store.
//
// This path has a kill switch and a fail-soft adapter:
// `caches.injectMetroStore: false` in
// ~/.rn-iso/config.json turns it off MACHINE-wide, which is the point --
// evaluating rn-iso must need no change to the repo, so opting out of a piece
// of it must not need one either.
//
// Every branch that does not inject is a log record and none is fatal.
function resolveMetroStoreInjection(
  root: string,
  { log, env }: { log: NdjsonWriter; env: NodeJS.ProcessEnv },
): Record<string, string> | null {
  if (!metroStoreInjectionEnabled()) {
    log.write({
      src: 'metro',
      level: 'debug',
      event: 'cache_store_skipped',
      msg: 'the shared Metro transform store is off (caches.injectMetroStore is false in ~/.rn-iso/config.json)',
    });
    return null;
  }
  const sdkMajor = expoSdkMajor(root);
  if (sdkMajor === null || sdkMajor < 54) {
    log.write({
      src: 'metro',
      level: 'debug',
      event: 'cache_store_skipped',
      msg:
        sdkMajor === null
          ? "could not determine this project's Expo SDK, so rn-iso left its Metro cache unchanged"
          : `Expo SDK ${sdkMajor} predates the config override added in SDK 54, so it runs with its normal Metro cache`,
    });
    return null;
  }
  const adapterPath = expoMetroConfigPath();
  if (!adapterPath) {
    log.write({
      src: 'metro',
      level: 'warn',
      event: 'cache_store_skipped',
      msg: "rn-iso's Expo Metro config adapter is missing from this install, so the dev server runs on whatever transform cache the project configured",
    });
    return null;
  }
  const storeRoot = metroStoreRoot(root);
  const additions = expoMetroStoreEnv({
    root,
    storeRoot,
    adapterPath,
    existingOverride: env.EXPO_OVERRIDE_METRO_CONFIG,
  });
  registerMetroStore(storeRoot);
  // WHAT RN-ISO DID, NOT WHAT HAPPENED. This record used to claim the store
  // was shared, and it was written HERE -- before the child existed, let alone
  // before the adapter inside it had tried anything. On tlon that made the
  // timeline report a shared store through three bundles while the adapter was
  // failing on every one of them (issue #73). The only thing this side can
  // honestly report is the request it is about to make; the outcome belongs to
  // the process that has it, and arrives as the adapter's own line, which
  // recordFromLine turns into `cache_store_added`.
  log.write({
    src: 'metro',
    level: 'debug',
    event: 'cache_store_requested',
    msg:
      `asked this project's Expo dev server to share Metro transforms through ${storeRoot} ` +
      '(EXPO_OVERRIDE_METRO_CONFIG, no metro.config.js change); the config adapter in that process reports the outcome',
  });
  return additions;
}

export async function startExpoServer({
  root,
  port,
  logsDir,
  writer = null,
  spawnFn = null,
  killTimeoutMs = 5000,
}: {
  root: string;
  port: number;
  logsDir: string;
  writer?: NdjsonWriter | null;
  spawnFn?: ((cmd: string, args: string[], opts: SpawnOptions) => ChildProcess) | null;
  killTimeoutMs?: number;
}): Promise<ExpoServerHandle> {
  const bin = expoBinPath(root);
  if (!bin) {
    const refusal = expoBinRefusal(root);
    throw supervisorError('RN_ISO_EXPO_BIN', refusal.message, refusal.remedy);
  }

  const log = writer || createNdjsonWriter(join(logsDir, 'metro.ndjson'));
  const spawn = spawnFn || ((cmd: string, args: string[], opts: SpawnOptions) => getExecutor().spawn(cmd, args, opts));

  // APPENDED to the caller's environment, never substituted for it. If the
  // caller already supplied an Expo override, the adapter composes that config
  // before adding the shared store.
  const storeEnv = resolveMetroStoreInjection(root, { log, env: process.env });

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
    env: { ...process.env, FORCE_COLOR: '0', ...storeEnv },
  });

  // Expo prints some fatal lines to BOTH streams (the config PluginError in
  // the tlon fresh-pass arrived once on stdout and once on stderr, ms apart),
  // which doubled the death cry in `logs --errors` and in start's failure
  // evidence. Same msg as the previous record within a second is stream
  // duplication, not information.
  let lastMsg: string | null = null;
  let lastAt = 0;
  const emit = (stream: string) => (chunk: unknown) => {
    const record = recordFromLine(chunk, { stream });
    if (!record) return;
    const now = Date.now();
    if (record.msg === lastMsg && now - lastAt < 1000) return;
    lastMsg = typeof record.msg === 'string' ? record.msg : null;
    lastAt = now;
    log.write(record);
  };
  const outReader = createLineReader(emit('stdout'));
  const errReader = createLineReader(emit('stderr'));
  child.stdout?.setEncoding?.('utf-8');
  child.stderr?.setEncoding?.('utf-8');
  child.stdout?.on('data', (chunk) => outReader.push(chunk));
  child.stderr?.on('data', (chunk) => errReader.push(chunk));

  let exited = false;
  let exitInfo: ExpoExitInfo | null = null;
  const listeners: ((info: ExpoExitInfo | null) => void)[] = [];
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
    onExit(cb: (info: ExpoExitInfo | null) => void) {
      if (exited) {
        cb(exitInfo);
        return;
      }
      listeners.push(cb);
    },
    async close() {
      if (exited || !child.pid) return;
      const dead = new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
      });
      // The child pid, not its group: detached:false means it shares the
      // supervisor's group, so a group signal would kill the supervisor before
      // it could write its final record and clear its registration.
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {
        return;
      }
      await Promise.race([dead, delay(killTimeoutMs)]);
      if (!exited) {
        // An Expo that ignored SIGTERM would otherwise keep the port and
        // outlive the supervisor that is supposed to own it.
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
        await Promise.race([dead, delay(killTimeoutMs)]);
      }
    },
  };
}
