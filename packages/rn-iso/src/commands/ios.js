// src/commands/ios.js -- `rn-iso ios`: an owned booted simulator, a verified
// Metro port, the app (from cache when the fingerprint already has one), and
// a launch wired to THIS workspace's port.
//
// This file is orchestration only. Every step it takes lives in an engine
// module that is tested on its own (engine/device, engine/deps,
// engine/prebuild, engine/xcode, engine/app-install, build-cache), and every
// one of them is injectable, so this command's own tests are about ORDER and
// OUTPUT rather than about xcodebuild.
//
// THE ORDER IS THE PRODUCT. The Metro gate runs BEFORE fingerprinting and
// before any build work, because the failure it catches -- no dev server on
// the reserved port -- is one an agent must learn about at second zero, not
// at minute four with a compiled app it cannot talk to. Everything expensive
// happens after every cheap check has passed.
//
// Output discipline (design principle 2): the phase lines go to STDERR as
// they happen, so a caller can watch a four-minute build; stdout carries
// exactly ONE line, the OK summary or the --json payload. A failure prints
// the EXTRACTED diagnostics and the log path, never the transcript, and
// leaves stdout empty.
import chalk from 'chalk';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCacheKey, fingerprintProject, resolveBuild, storeBuild } from '../build-cache.js';
import { getProject, upsertProject } from '../config.js';
import { DEFAULT_METRO_PORT, installIosApp, launchIosApp } from '../engine/app-install.js';
import { readPodState, podsAreStale, runPodInstall } from '../engine/deps.js';
import { ensureBooted, ensureOwnedDevice } from '../engine/device.js';
import { describeDiagnostic } from '../engine/errors-xcode.js';
import { needsPrebuild, runPrebuild } from '../engine/prebuild.js';
import { buildIos, readBundleId } from '../engine/xcode.js';
import { getExecutor } from '../exec.js';
import { isPidAlive, resolveProjectMetro } from '../metro.js';
import { createNdjsonWriter } from '../ndjson.js';
import { workspaceLogsDir } from '../paths.js';
import { detectBundleId, detectIsExpo, findProjectRoot, projectShortcut } from '../project.js';
import { resolveSettings, unknownSettingKeys } from '../settings.js';
import { readWorkspaceState, writeWorkspaceState } from '../supervisor/run.js';
import { gitCommonDir, repoRoot } from '../worktree.js';

export const PLATFORM = 'ios';

// The build log for this platform, merged into the timeline by `logs`.
export function buildLogFile(root) {
  return join(workspaceLogsDir(root), `build-${PLATFORM}.ndjson`);
}

// The collector's own stdio. It writes its records to device.ndjson itself;
// this file only ever catches the few lines it prints when it cannot do that
// (a registration it could not write, a stream that would not start). NOT
// .ndjson, so the k-way merge in logs-query never tries to parse it.
export function collectorLogFile(root) {
  return join(workspaceLogsDir(root), `collector-${PLATFORM}.log`);
}

export function collectorEntry() {
  return fileURLToPath(new URL('../collector/run.js', import.meta.url));
}

// How many extracted diagnostics reach stderr. The engine caps at 10; the
// point of the extract is that it FITS, and a failure that prints ten
// diagnostics plus phase lines is a transcript again. The rest stay in the
// log, whose path is the next line.
const MAX_PRINTED_DIAGNOSTICS = 6;

// How long a previous collector gets to die before the fresh one is spawned.
// Not a nicety: the dying collector unregisters ITSELF from
// state.json.collectors on SIGTERM, so a new one registered first would have
// its record deleted by its predecessor's exit handler and become invisible
// to `stop`.
const COLLECTOR_EXIT_WAIT_MS = 2000;
const COLLECTOR_POLL_MS = 25;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- pure formatting ------------------------------------------------------

// "18s", "2m41s". Sub-minute durations stay in seconds because that is how
// long a pod install or a cached install actually takes to read.
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  if (total < 60) return `${Math.round(total)}s`;
  const minutes = Math.floor(total / 60);
  const seconds = Math.round(total - minutes * 60);
  // 119.6s must not print as "1m60s".
  if (seconds === 60) return `${minutes + 1}m0s`;
  return `${minutes}m${seconds}s`;
}

// Enough of a fingerprint to compare two runs by eye, never enough to mistake
// for the whole hash -- the ".." is the part that says so.
export function shortHash(hash) {
  const text = String(hash ?? '');
  return text.length > 6 ? `${text.slice(0, 6)}..` : text;
}

export function shortUdid(udid) {
  const text = String(udid ?? '');
  return text.length > 4 ? `${text.slice(0, 4)}..` : text;
}

export function deviceLabel(device, udid) {
  const name = device?.deviceName || device?.name || null;
  return name ? `${name} (${shortUdid(udid)})` : shortUdid(udid);
}

// The phase-line column. One shape for every line, so the interesting half
// starts at the same column whatever happened.
export function phaseLine(name, text) {
  return `${String(name).padEnd(11)} ${text}`;
}

// PURE. The name the iOS collector's log predicate matches: it filters on
// processImagePath, which ends in <ProductName>.app/<ProductName>. The
// collector falls back to the bundle id's last segment, and that fallback is
// WRONG whenever the product name differs from it (`com.acme.MyApp` for a
// product called `MyAppDev`), which is why the real name is derived from the
// .app path and passed explicitly.
export function appNameFromPath(appPath) {
  if (typeof appPath !== 'string' || appPath.trim() === '') return null;
  const name = basename(appPath).replace(/\.app$/i, '');
  return name === '' ? null : name;
}

// PURE. Whether pods have to be installed before this build, given what
// readPodState found and what podsAreStale decided.
//
// The composition matters. `podsAreStale` reports `noPods` when NEITHER
// Podfile.lock nor Pods/Manifest.lock exists, which is honestly ambiguous on
// its own: it is a project with no CocoaPods at all (skip -- there is nothing
// to install and `pod install` would fail for want of a Podfile), or it is a
// fresh checkout whose pods have simply never been installed (install -- the
// build cannot link without them). `hasPodfile` is what separates the two,
// and it is exactly why readPodState returns it.
export function podAction(podState, verdict) {
  if (verdict?.stale) return { install: true, reason: verdict.reason };
  if (verdict?.noPods && podState?.hasPodfile) {
    return { install: true, reason: 'ios/Podfile exists but no pods are installed' };
  }
  return { install: false };
}

// PURE-ish (one file read). The dev-client scheme, ONLY when it is trivially
// available: `expo.scheme` in app.json, or a top-level `scheme`. An
// app.config.js is a program whose value comes from evaluating the config
// plugin pipeline, and rn-iso does not run that -- a wrong guess here sends
// `simctl openurl` at a scheme nothing handles, which fails silently with the
// app never launching. No scheme means undefined, and launchIosApp falls back
// to a plain launch plus RCT_jsLocation, which works for every RN app.
//
// expo-dev-client is required as well as a scheme: the deep link is handled
// by expo-dev-launcher, so a project without it would get an openurl no
// process answers. An Expo app without the dev client reads RCT_jsLocation
// through the ordinary RN provider, which the plain launch already sets.
export function devClientScheme(root) {
  const app = readJson(join(root, 'app.json'));
  const raw = app?.expo?.scheme ?? app?.scheme ?? null;
  const scheme = Array.isArray(raw) ? raw.find((s) => typeof s === 'string' && s.trim() !== '') : raw;
  if (typeof scheme !== 'string' || scheme.trim() === '') return undefined;
  if (!hasDevClient(root)) return undefined;
  return scheme.trim();
}

function hasDevClient(root) {
  const pkg = readJson(join(root, 'package.json'));
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  return 'expo-dev-client' in deps;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

// PURE. Contract 4: state.json.lastBuild.
export function lastBuildRecord({
  fingerprint = null,
  cacheKey = null,
  cacheHit = false,
  durationMs = 0,
  appPath = null,
  bundleId = null,
  startedAt,
  status,
  errorCode = null,
}) {
  const record = {
    platform: PLATFORM,
    fingerprint,
    cacheKey,
    cacheHit: Boolean(cacheHit),
    durationMs,
    appPath,
    bundleId,
    startedAt,
    status,
  };
  if (errorCode) record.errorCode = errorCode;
  return record;
}

// PURE. The --json payload.
export function iosFacts({ udid, deviceName, fingerprint, cacheKey, cacheHit, appPath, bundleId, metroPort, logsDir, durationMs }) {
  return {
    platform: PLATFORM,
    udid,
    deviceName: deviceName ?? null,
    fingerprint,
    cacheKey,
    cacheHit: Boolean(cacheHit),
    appPath,
    bundleId,
    launched: true,
    metroPort,
    logs: { dir: logsDir },
    durationMs,
  };
}

// --- state (Contract 4 / Contract 5) --------------------------------------

// MERGED, never replaced. The same state.json holds `supervisor` (the dev
// server's) and `collectors` (the log streams'), and a build that overwrote
// the file would leave `stop` unable to find either -- a supervisor nothing
// can halt and a `log stream` nothing will ever reap. writeWorkspaceState
// read-modify-writes for exactly this reason; this function exists so there
// is one call site to point the test at.
export function writeLastBuild(root, record, { write = writeWorkspaceState } = {}) {
  try {
    write(root, { lastBuild: record });
  } catch {
    // A workspace whose .rn-iso directory cannot be written still built and
    // launched an app; losing the record is not worth failing the run over.
  }
  return record;
}

/**
 * Contract 5: one collector per platform, replaced rather than duplicated.
 *
 * The previous collector is SIGTERMed and given a moment to exit before the
 * fresh one is spawned (see COLLECTOR_EXIT_WAIT_MS). Nothing waits on the new
 * one: it registers itself before it streams, and a `rn-iso ios` that blocked
 * on a log stream would never return.
 */
export async function replaceCollector({
  root,
  udid,
  bundleId,
  appName,
  spawn = (cmd, args, opts) => getExecutor().spawn(cmd, args, opts),
  kill = (pid, signal) => process.kill(pid, signal),
  alive = isPidAlive,
  readState = readWorkspaceState,
  waitMs = COLLECTOR_EXIT_WAIT_MS,
  note = () => {},
} = {}) {
  const previous = readState(root)?.collectors?.[PLATFORM] || null;
  const previousPid = Number(previous?.pid) || null;
  let killed = null;

  if (previousPid) {
    try {
      kill(previousPid, 'SIGTERM');
      killed = previousPid;
    } catch (err) {
      // ESRCH is the ordinary case: the collector died with the app, or with
      // the sim, and only its record outlived it. Anything else is worth a
      // line, because it means a process we could not stop is still holding
      // the device's log stream.
      if (err?.code !== 'ESRCH') {
        note(chalk.yellow(`Could not stop the previous ${PLATFORM} log collector (pid ${previousPid}): ${err?.message || err}`));
      }
    }
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && alive(previousPid)) {
      await sleep(COLLECTOR_POLL_MS);
    }
  }

  const args = [
    collectorEntry(),
    '--platform', PLATFORM,
    '--root', root,
    '--udid', udid,
    '--bundle', bundleId,
  ];
  // The real product name, from the .app path. The collector's own fallback
  // (the bundle id's last segment) matches nothing whenever the two differ,
  // and the symptom is an empty device.ndjson rather than an error.
  if (appName) args.push('--app-name', appName);

  let stdio = 'ignore';
  try {
    mkdirSync(workspaceLogsDir(root), { recursive: true });
    const fd = openSync(collectorLogFile(root), 'a');
    stdio = ['ignore', fd, fd];
  } catch {
    // Without the file the collector is silent, which is survivable; without
    // the collector the timeline has no device lines at all, which is what we
    // are here to avoid.
  }

  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: root,
      // detached + unref: the collector outlives this command, exactly like
      // the supervisor, and leads its own process group so `stop` can signal
      // it without reaching the caller's shell.
      detached: true,
      stdio,
      env: process.env,
    });
    child?.unref?.();
  } catch (err) {
    note(chalk.yellow(`Could not start the ${PLATFORM} log collector: ${err?.message || err}`));
    return { killed, pid: null };
  }
  return { killed, pid: child?.pid ?? null };
}

// --- the command ----------------------------------------------------------

const DEFAULT_DEPS = {
  findProjectRoot,
  resolveSettings,
  gitCommonDir,
  repoRoot,
  detectBundleId,
  detectIsExpo,
  devClientScheme,
  getProject,
  upsertProject,
  projectShortcut,
  ensureOwnedDevice,
  ensureBooted,
  resolveProjectMetro,
  fingerprintProject,
  resolveBuild,
  storeBuild,
  needsPrebuild,
  runPrebuild,
  readPodState,
  podsAreStale,
  runPodInstall,
  buildIos,
  readBundleId,
  installIosApp,
  launchIosApp,
  replaceCollector,
  writeWorkspaceState,
  createWriter: createNdjsonWriter,
  now: () => Date.now(),
};

export default function iosCommand(program) {
  registerIos(program);
}

// `deps` is the test seam. Every engine call goes through it, so the tests
// below assert the ORDER of a build (metro gate, then fingerprint, then
// prebuild, pods, build, store) without a simulator or an xcodebuild.
export function registerIos(program, deps = {}) {
  program
    .command('ios')
    .description(
      'Build (or restore from the fingerprint cache), install and launch this workspace\'s app on its owned '
      + 'simulator, wired to the reserved Metro port. Requires a running dev server (`rn-iso start`).'
    )
    .option('--json', 'Emit the facts as a single JSON line on stdout; every other line goes to stderr')
    .option('--no-metro-check', 'Skip the "is this workspace\'s dev server running?" gate and build anyway')
    .action(async (opts) => {
      await runIos(opts, deps);
    });
}

export async function runIos(opts = {}, overrides = {}) {
  const d = { ...DEFAULT_DEPS, ...overrides };
  const json = Boolean(opts.json);
  // commander's --no-metro-check leaves metroCheck true by default.
  const metroCheck = opts.metroCheck !== false;

  // Phase lines are progress, and progress is stderr in BOTH modes: stdout
  // carries one line, and which line it is is the only difference --json
  // makes.
  const phase = (name, text) => console.error(phaseLine(name, text));
  const note = (line) => console.error(line);

  const started = d.now();
  const startedAt = new Date(started).toISOString();
  const elapsed = () => d.now() - started;

  const root = d.findProjectRoot(process.cwd());
  if (!root) {
    note(chalk.red('Not in a React Native project (no package.json found).'));
    process.exit(1);
    return null;
  }

  const logsDir = workspaceLogsDir(root);
  const logFile = buildLogFile(root);
  let writer = null;
  // Opened lazily by createNdjsonWriter's first write, so a run that fails at
  // the Metro gate leaves no empty log behind.
  const logWriter = () => (writer ||= d.createWriter(logFile));

  // Every failure exits the same way: the diagnostic, the remedy if there is
  // one, the machine-readable code, and -- once there is a build attempt to
  // describe -- a Contract-4 record saying the last build failed.
  const fail = ({ code, message, remedy = null, lines = [], build = null }) => {
    if (message) note(chalk.red(phaseLine('error', message)));
    for (const line of lines) note(chalk.dim(phaseLine('', line)));
    if (remedy) note(chalk.dim(phaseLine('remedy', remedy)));
    if (build) writeLastBuild(root, lastBuildRecord({ ...build, startedAt, status: 'failed', errorCode: code, durationMs: elapsed() }), { write: d.writeWorkspaceState });
    note(chalk.red(phaseLine('failed', code)));
    writer?.close?.();
    process.exit(1);
    return null;
  };

  const settings = d.resolveSettings({
    projectPath: root,
    gitCommonDir: d.gitCommonDir(root),
    repoRoot: d.repoRoot(root),
  });
  for (const key of unknownSettingKeys(settings)) {
    note(chalk.yellow(`Warning: setting "${key}" is not read by rn-iso and will be ignored.`));
  }

  const isExpo = d.detectIsExpo(root);
  d.upsertProject(root, { bundleId: d.detectBundleId(root), isExpo });
  const proj = d.getProject(root);
  const label = d.projectShortcut(root, proj);

  // ---- device: owned, and actually booted ----
  let device;
  try {
    device = await d.ensureOwnedDevice({
      platform: PLATFORM,
      project: proj,
      projectPath: root,
      label,
      settings,
      flags: {},
      note,
      out: note,
    });
  } catch (e) {
    return fail({
      code: 'RN_ISO_NO_DEVICE',
      message: `Could not ensure an owned iOS simulator: ${e?.message || e}`,
      remedy: 'Run `rn-iso doctor` to check the simulator toolchain, then try again.',
    });
  }

  // ---- the Metro gate, BEFORE anything expensive ----
  //
  // A build that finishes without a dev server produces an app that opens to
  // a red screen four minutes from now. The reserved port is checked for
  // IDENTITY, not just occupancy (resolveProjectMetro), because a foreign
  // bundler answering there would send this app's bundle requests at another
  // workspace's code.
  //
  // It sits AFTER ensureOwnedDevice (which needs to run for the device record
  // the rest of this command reads) and BEFORE ensureBooted, which is the
  // expensive half: booting a simulator is ~10s of polling, and there is no
  // reason to pay it to then refuse at second twelve. The whole point of the
  // gate is that the refusal is instant.
  const noMetro = (message) => fail({
    code: 'RN_ISO_NO_METRO',
    message,
    remedy: 'Run `rn-iso start` first, or pass --no-metro-check.',
  });

  let metroPort = proj?.metroPort ?? null;
  if (metroCheck) {
    if (!metroPort) {
      return noMetro('No Metro port is reserved for this workspace, so there is no dev server to build against.');
    }
    const resolution = await d.resolveProjectMetro(metroPort, root);
    if (!resolution?.metro) {
      return noMetro(resolution?.notOurs
        ? `Port ${metroPort} is in use but is NOT this workspace's dev server: ${resolution.notOurs}.`
        : `Nothing is serving this workspace's dev server on port ${metroPort}.`);
    }
  } else if (!metroPort) {
    // --no-metro-check with no reservation: the app has to be told SOME
    // port, and 8081 is what an unconfigured debug build asks for anyway.
    metroPort = DEFAULT_METRO_PORT;
    note(chalk.yellow(`No Metro port is reserved for this workspace; wiring the app to ${metroPort}.`));
  }

  const booted = await d.ensureBooted({ platform: PLATFORM, device, out: note });
  if (!booted?.ok) {
    return fail({
      code: 'RN_ISO_NO_DEVICE',
      message: booted?.reason || 'The owned simulator could not be booted.',
      remedy: 'Run `rn-iso ios` again to re-establish an owned simulator for this workspace.',
    });
  }
  const udid = booted.udid;
  phase('device', `${deviceLabel(device, udid)} booted`);

  // ---- fingerprint and cache ----
  let fingerprint;
  try {
    fingerprint = await d.fingerprintProject(root);
  } catch (e) {
    fingerprint = null;
    note(chalk.dim(`Fingerprinting failed: ${e?.message || e}`));
  }
  if (!fingerprint) {
    return fail({
      code: 'RN_ISO_NO_FINGERPRINT',
      message: `Could not fingerprint ${root}: @expo/fingerprint is not resolvable from the project or from rn-iso.`,
      remedy: 'Install it in the project (`npm i -D @expo/fingerprint`) so builds can be cached and shared between worktrees.',
    });
  }
  // Debug / simulator defaults: the same key `build-cache` and the Expo
  // provider derive, so an entry stored here answers either of them.
  const cacheKey = buildCacheKey(PLATFORM, fingerprint, {});
  const cached = d.resolveBuild(PLATFORM, cacheKey);
  const cacheHit = Boolean(cached);
  phase('fingerprint', `${shortHash(fingerprint)} ${cacheHit ? 'hit' : 'miss'}`);

  const buildFailure = { fingerprint, cacheKey, cacheHit };
  let appPath = cached;
  let bundleId = null;

  if (cacheHit) {
    // A hit skips prebuild, pods and xcodebuild ENTIRELY -- that is the whole
    // point of the cache, and it is what makes a second worktree install in
    // seconds. The bundle id comes from the cached .app's own Info.plist
    // rather than from the project config: the binary is the truth about what
    // is being installed.
    bundleId = d.readBundleId(appPath) || d.detectBundleId(root);
    if (!bundleId) {
      return fail({
        code: 'RN_ISO_INSTALL_FAILED',
        message: `Could not read a bundle identifier from the cached app at ${appPath}.`,
        remedy: 'Remove the cache entry (`rn-iso gc`) and run again to rebuild it.',
        build: { ...buildFailure, appPath },
      });
    }
  } else {
    // ---- prebuild (Expo, and only when ios/ is absent) ----
    if (d.needsPrebuild(root, PLATFORM, isExpo)) {
      const result = await d.runPrebuild(root, PLATFORM, logWriter());
      if (result?.failed) {
        phase('prebuild', 'FAILED');
        return fail({
          code: result.code || 'RN_ISO_PREBUILD_FAILED',
          message: result.reason || 'expo prebuild failed.',
          remedy: result.remedy || `See ${logFile} for the transcript.`,
          lines: (result.lastLines || []).slice(-5),
          build: buildFailure,
        });
      }
      phase('prebuild', `ios/ absent -> generated (${formatDuration(result?.durationMs ?? 0)})`);
    }

    // ---- pods ----
    const podState = d.readPodState(root);
    const verdict = d.podsAreStale(podState.lockText, podState.manifestText);
    const action = podAction(podState, verdict);
    if (action.install) {
      const result = await d.runPodInstall(root, logWriter());
      if (result?.failed) {
        phase('pods', 'FAILED');
        return fail({
          code: result.code || 'RN_ISO_DEPS_FAILED',
          message: result.reason || '`pod install` failed.',
          remedy: result.remedy || `See ${logFile} for the transcript.`,
          lines: (result.lastLines || []).slice(-5),
          build: buildFailure,
        });
      }
      phase('pods', `${action.reason} -> installed (${formatDuration(result?.durationMs ?? 0)})`);
    }
    // A project with no CocoaPods at all prints nothing: there is no decision
    // to report, and a "pods  none" line every run is noise.

    // ---- build ----
    const result = await d.buildIos({ root, udid, logWriter: logWriter() });
    if (result?.failed) {
      phase('build', `FAILED after ${formatDuration(result.durationMs)}`);
      printDiagnostics(note, result);
      note(chalk.dim(phaseLine('log', logFile)));
      return fail({ code: result.code || 'RN_ISO_BUILD_FAILED', message: null, build: buildFailure });
    }
    phase('build', `ok (${formatDuration(result.durationMs)})`);
    appPath = result.appPath;
    bundleId = result.bundleId;

    // Storing is best-effort on purpose: the app is built and installable
    // either way, and a full disk must not turn a successful build into a
    // failed command.
    try {
      d.storeBuild(PLATFORM, cacheKey, appPath);
    } catch (e) {
      note(chalk.yellow(`Could not store the build in the shared cache: ${e?.message || e}`));
    }
  }

  // ---- install ----
  const installed = d.installIosApp({ udid, appPath });
  if (installed?.failed) {
    return fail({
      code: installed.code || 'RN_ISO_INSTALL_FAILED',
      message: installed.reason,
      remedy: 'Check that the simulator is booted and that the app was built for the simulator SDK.',
      build: { ...buildFailure, appPath, bundleId },
    });
  }
  phase('install', `-> ${deviceLabel(device, udid)}`);

  // ---- launch, wired to THIS workspace's port (Contract 6) ----
  const launched = d.launchIosApp({
    udid,
    bundleId,
    metroPort,
    devClientScheme: d.devClientScheme(root),
  });
  if (launched?.failed) {
    return fail({
      code: launched.code || 'RN_ISO_LAUNCH_FAILED',
      message: launched.reason,
      remedy: `Run \`xcrun simctl launch --console ${udid} ${bundleId}\` to see what the app reports, and check ${logFile}.`,
      build: { ...buildFailure, appPath, bundleId },
    });
  }
  phase('launch', bundleId);

  // The launch marker (Contract 1). `logs --errors` uses it to bound the
  // window: errors from the run BEFORE this launch are not this run's.
  logWriter().write({
    src: 'build',
    level: 'info',
    marker: true,
    event: 'launch',
    msg: `launched ${bundleId} on ${udid} against Metro port ${metroPort}`
      + (launched?.mode === 'openurl' ? ' (expo-dev-client)' : ''),
  });

  // ---- collector (Contract 5) ----
  await d.replaceCollector({
    root,
    udid,
    bundleId,
    appName: appNameFromPath(appPath),
    note,
  });

  // ---- the record (Contract 4) ----
  const durationMs = elapsed();
  writeLastBuild(root, lastBuildRecord({
    fingerprint,
    cacheKey,
    cacheHit,
    durationMs,
    appPath,
    bundleId,
    startedAt,
    status: 'ok',
  }), { write: d.writeWorkspaceState });

  writer?.close?.();

  const facts = iosFacts({
    udid,
    deviceName: device?.deviceName ?? null,
    fingerprint,
    cacheKey,
    cacheHit,
    appPath,
    bundleId,
    metroPort,
    logsDir,
    durationMs,
  });

  if (json) {
    console.log(JSON.stringify(facts));
  } else {
    console.log(chalk.green(
      `OK: ${bundleId} on ${deviceLabel(device, udid)}, Metro port ${metroPort}`
      + ` (${cacheHit ? 'from cache' : 'built'}, ${formatDuration(durationMs)})`
    ));
  }
  return facts;
}

// The extract, never the transcript. `truncated` and the log path are what
// make the omission honest rather than silent.
function printDiagnostics(note, result) {
  const diagnostics = Array.isArray(result?.diagnostics) ? result.diagnostics : [];
  const shown = diagnostics.slice(0, MAX_PRINTED_DIAGNOSTICS);
  for (const diagnostic of shown) {
    note(chalk.red(phaseLine('error', describeDiagnostic(diagnostic))));
  }
  const hidden = (diagnostics.length - shown.length) + (result?.truncated || 0);
  if (hidden > 0) {
    note(chalk.dim(phaseLine('error', `... and ${hidden} more diagnostic${hidden === 1 ? '' : 's'} in the log`)));
  }
  if (diagnostics.length === 0) {
    // Nothing recognizable: the last few transcript lines are all there is,
    // and printing them beats printing nothing at all.
    note(chalk.red(phaseLine('error', 'xcodebuild failed with no recognizable diagnostic; last lines:')));
    for (const line of (result?.tail || []).slice(-5)) note(chalk.dim(phaseLine('', line)));
  }
}
