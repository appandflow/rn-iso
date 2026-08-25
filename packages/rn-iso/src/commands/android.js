// src/commands/android.js -- ensure the owned emulator is booted, verify this
// workspace's Metro, fingerprint, install from the cache or build, launch
// wired to the reserved port, attach the device-log collector.
//
// The output IS the product here. A successful run is about eight lines on
// stderr and one outcome line on stdout; a failed one is the extracted
// diagnostic plus the path to the log that holds the rest. `expo run:android`
// emits several thousand lines and an agent pays for all of them on success
// as well as on failure, which is the cost this command exists to remove. The
// full transcript is still on disk in .rn-iso/logs/build-android.ndjson -- it
// is simply never tokens.
//
// Two orderings in the flow below are deliberate:
//
// 1. METRO IS VERIFIED BEFORE ANY BUILD WORK. rn-iso never starts the bundler
//    (the metro-handoff rule), so a workspace with no healthy Metro on its
//    reserved port cannot produce a running app -- and failing at second two
//    is worth more to an agent loop than four minutes of gradle followed by an
//    app that cannot load a bundle. `--no-metro-check` overrides.
// 2. THE FINGERPRINT IS TAKEN BEFORE PREBUILD. @expo/fingerprint hashes config
//    and dependencies on a CNG project rather than the generated native
//    directory, so a cache hit skips generation entirely.
//
// Contract 6 lives in engine/app-install.js: the cached APK is shared across
// every workspace on the machine, so the Metro port is never baked into it --
// `adb reverse tcp:8081 tcp:<reserved>` applies it at launch instead.
import chalk from 'chalk';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProject, upsertProject } from '../config.js';
import { getExecutor } from '../exec.js';
import { buildCacheKey, fingerprintProject, resolveBuild, storeBuild } from '../build-cache.js';
import { createNdjsonWriter } from '../ndjson.js';
import { resolveProjectMetro } from '../metro.js';
import { workspaceLogsDir } from '../paths.js';
import { detectAndroidPackage, detectBundleId, detectIsExpo, findProjectRoot, projectShortcut } from '../project.js';
import { resolveSettings } from '../settings.js';
import { gitCommonDir, repoRoot } from '../worktree.js';
import { readCollectors } from '../collector/run.js';
import { writeWorkspaceState } from '../supervisor/run.js';
import { DEFAULT_METRO_PORT, installAndroidApp, launchAndroidApp } from '../engine/app-install.js';
import { ensureBooted, ensureOwnedDevice } from '../engine/device.js';
import { needsPrebuild, runPrebuild } from '../engine/prebuild.js';
import { buildAndroid } from '../engine/gradle.js';
import { formatDiagnostic } from '../engine/errors-gradle.js';

export const PLATFORM = 'android';

// The plan's error codes. RN_ISO_NO_DEVICE is the one addition: the spec's
// contract is that EVERY refusal carries a code an agent can branch on, and a
// device that cannot be created or booted is a refusal like any other.
export const NO_METRO = 'RN_ISO_NO_METRO';
export const NO_FINGERPRINT = 'RN_ISO_NO_FINGERPRINT';
export const NO_DEVICE = 'RN_ISO_NO_DEVICE';
export const INSTALL_FAILED = 'RN_ISO_INSTALL_FAILED';
export const LAUNCH_FAILED = 'RN_ISO_LAUNCH_FAILED';

// The label column of the phase lines. One width for every line, including
// the failure ones, so the values line up whatever the run did.
const LABEL_WIDTH = 11;

// How many raw transcript lines stand in for a diagnostic when nothing could
// be extracted from the build output.
const FALLBACK_LINES = 5;

export function collectorEntry() {
  return fileURLToPath(new URL('../collector/run.js', import.meta.url));
}

// PURE. `  fingerprint a3f9b1.. hit`
export function phaseLine(label, text) {
  return `  ${String(label).padEnd(LABEL_WIDTH)} ${text}`;
}

// PURE. Paths under the workspace print relative to it, the way the spec's
// worked example does: `.rn-iso/logs/build-android.ndjson` is shorter than
// the absolute path, and every command here runs from inside the workspace.
// The --json payload keeps the absolute form, which is what a consumer needs.
export function displayPath(root, path) {
  const rel = relative(root, path);
  return rel && !rel.startsWith('..') ? rel : path;
}

// PURE. A fingerprint is 64 hex characters and no agent reads more than the
// first few; the whole hash is in the --json payload and in state.json.
export function shortHash(hash) {
  const text = String(hash || '');
  return text.length > 8 ? `${text.slice(0, 6)}..` : text;
}

// PURE. Durations an agent reads at a glance: milliseconds under a second,
// then seconds, then minutes -- the spec's "3.1s" and "2m41s".
export function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return 'unknown';
  if (value < 1000) return `${Math.round(value)}ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(Math.round(seconds - minutes * 60)).padStart(2, '0')}s`;
}

// PURE. The --json payload.
export function androidFacts({ serial, fingerprint, cacheHit, appPath, bundleId, launched, logs }) {
  return {
    platform: PLATFORM,
    serial: serial ?? null,
    fingerprint: fingerprint ?? null,
    cacheHit: Boolean(cacheHit),
    appPath: appPath ?? null,
    bundleId: bundleId ?? null,
    launched: Boolean(launched),
    logs: logs ?? null,
  };
}

// PURE. Contract 4, the state.json.lastBuild record.
export function lastBuildRecord({ fingerprint, cacheKey, cacheHit, durationMs, appPath, bundleId, startedAt, status, errorCode = null }) {
  const record = {
    platform: PLATFORM,
    fingerprint: fingerprint ?? null,
    cacheKey: cacheKey ?? null,
    cacheHit: Boolean(cacheHit),
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    appPath: appPath ?? null,
    bundleId: bundleId ?? null,
    startedAt,
    status,
  };
  if (errorCode) record.errorCode = errorCode;
  return record;
}

// Contract 5. The previous collector for THIS platform is killed before a new
// one starts: two logcat streams on one device write the same lines twice into
// device.ndjson, and the older one is attached to the pid of an app that has
// just been replaced. A dead pid is the normal case (the app was killed, the
// collector noticed and exited), so ESRCH is not a failure.
export function killPreviousCollector(root, { platform = PLATFORM, kill = (pid, signal) => process.kill(pid, signal), collectors = null } = {}) {
  const record = (collectors ?? readCollectors(root))?.[platform];
  const pid = Number(record?.pid);
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return null;
  try {
    kill(pid, 'SIGTERM');
    return pid;
  } catch {
    // Already gone. The collector clears its own registration on the way out,
    // and a stale entry is overwritten by the one we are about to start.
    return null;
  }
}

export default function androidCommand(program) {
  registerAndroid(program);
}

export function registerAndroid(program) {
  program
    .command('android')
    .description(
      'Build (or install from the shared cache), install and launch this workspace\'s Android app on its owned '
      + 'emulator, wired to the reserved Metro port. Never starts the bundler -- run `rn-iso start` first.'
    )
    .option('--json', 'Emit the facts as a single JSON line on stdout; every other line goes to stderr')
    .option('--no-metro-check', 'Skip the reserved-port Metro health check (the app will load no bundle unless something else serves it)')
    .action(async (opts) => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project (no package.json found).'));
        process.exit(1);
        return;
      }
      const result = await runAndroid({ root, json: Boolean(opts.json), metroCheck: opts.metroCheck !== false });
      if (!result.ok) process.exit(1);
    });
}

// Every side effect is a seam with the real thing as its default, so the flow
// is testable without an emulator, a gradle daemon, or a network. The command
// action above passes none of them.
export async function runAndroid({
  root,
  json = false,
  metroCheck = true,
  ensureDevice = ensureOwnedDevice,
  ensureDeviceBooted = ensureBooted,
  resolveMetro = resolveProjectMetro,
  fingerprint = fingerprintProject,
  resolveCached = resolveBuild,
  storeCached = storeBuild,
  needsPrebuildFor = needsPrebuild,
  prebuild = runPrebuild,
  build = buildAndroid,
  install = installAndroidApp,
  launch = launchAndroidApp,
  spawn = (cmd, args, opts) => getExecutor().spawn(cmd, args, opts),
  kill = (pid, signal) => process.kill(pid, signal),
  createWriter = createNdjsonWriter,
  writeState = writeWorkspaceState,
  now = Date.now,
  out = (line) => console.error(line),
  emit = (line) => console.log(line),
} = {}) {
  const started = now();
  const startedAt = new Date(started).toISOString();
  const logsDir = workspaceLogsDir(root);
  const buildLog = join(logsDir, 'build-android.ndjson');
  const writer = createWriter(buildLog);

  // Failure state that lands in Contract 4 is accumulated as the run goes, so
  // a failure at any step after the fingerprint records what it knew.
  const record = { fingerprint: null, cacheKey: null, cacheHit: false, appPath: null, bundleId: null };

  const phase = (label, text) => out(phaseLine(label, text));
  // One formatter for every refusal, so a failed run reads the same whatever
  // step failed: the code and the message, then whatever was extracted, then
  // the remedy, then the log that holds the rest. Never the transcript.
  const fail = (code, message, remedy, { lastBuildStatus = false, diagnostics = [], lines = [], logPath = null } = {}) => {
    if (lastBuildStatus) {
      persistLastBuild({ writeState, root, record, startedAt, durationMs: now() - started, status: 'failed', errorCode: code, out });
    }
    out(phaseLine('error', chalk.red(`${code}: ${message}`)));
    for (const diagnostic of diagnostics) out(phaseLine('error', chalk.red(diagnostic)));
    for (const line of lines) out(phaseLine('', chalk.dim(line)));
    if (remedy) out(phaseLine('remedy', remedy));
    if (logPath) out(phaseLine('log', logPath));
    if (json) emit(JSON.stringify({ code, message, remedy: remedy ?? null }));
    writer.close();
    return { ok: false, error: { code, message, remedy: remedy ?? null } };
  };

  // ---- project facts -------------------------------------------------
  const settings = resolveSettings({
    projectPath: root,
    gitCommonDir: gitCommonDir(root),
    repoRoot: repoRoot(root),
  });
  const isExpo = detectIsExpo(root);
  let androidPackage = detectAndroidPackage(root);
  // Recorded as soon as it is known, so a failure before the launch step
  // still says which app it was about.
  record.bundleId = androidPackage;
  upsertProject(root, { bundleId: detectBundleId(root), androidPackage, isExpo });
  const project = getProject(root);
  const label = projectShortcut(root, project);

  // ---- device --------------------------------------------------------
  let device;
  try {
    device = await ensureDevice({
      platform: PLATFORM,
      project,
      projectPath: root,
      label,
      settings,
      flags: {},
      note: out,
      out,
    });
  } catch (err) {
    return fail(
      NO_DEVICE,
      `Could not ensure an owned Android emulator: ${err?.message || err}`,
      'Check that JAVA_HOME and ANDROID_HOME are set correctly, and that an arm64 system image is installed (`sdkmanager "system-images;android-36;google_apis;arm64-v8a"`).'
    );
  }

  const booted = await ensureDeviceBooted({ platform: PLATFORM, device, out });
  if (booted.failed) {
    return fail(NO_DEVICE, booted.reason, 'Run `rn-iso status` to see what rn-iso thinks it owns; `rn-iso up android` creates a fresh owned AVD.');
  }
  const serial = booted.serial;
  phase('device', `${device.avdName || serial} (${serial}) booted`);

  // ---- metro (fail fast, before any build work) -----------------------
  const reservedPort = project?.metroPort ?? null;
  if (metroCheck) {
    if (!reservedPort) {
      return fail(NO_METRO, 'No Metro port is reserved for this workspace.', 'Run `rn-iso start` first, or pass --no-metro-check.');
    }
    const held = await resolveMetro(reservedPort, root);
    if (!held.metro) {
      const detail = held.notOurs
        ? `Port ${reservedPort} is held by something that is not this project's Metro: ${held.notOurs}.`
        : `No Metro server holds reserved port ${reservedPort}.`;
      return fail(NO_METRO, detail, 'Run `rn-iso start` first, or pass --no-metro-check.');
    }
    phase('metro', `port ${reservedPort} (pid ${held.metro.pid})`);
  } else {
    phase('metro', reservedPort ? `port ${reservedPort} (not checked)` : `no reservation; using ${DEFAULT_METRO_PORT} (not checked)`);
  }
  const metroPort = reservedPort ?? DEFAULT_METRO_PORT;

  // ---- fingerprint ----------------------------------------------------
  let hash;
  try {
    hash = await fingerprint(root);
  } catch (err) {
    return fail(NO_FINGERPRINT, `@expo/fingerprint could not fingerprint ${root}: ${err?.message || err}`, 'Fix the error above, or install a working copy with `npm i -D @expo/fingerprint`.');
  }
  if (!hash) {
    return fail(
      NO_FINGERPRINT,
      `@expo/fingerprint is not resolvable from ${root} or from rn-iso, so the build cache cannot be addressed.`,
      'Install it in the project: `npm i -D @expo/fingerprint`.'
    );
  }
  record.fingerprint = hash;
  const cacheKey = buildCacheKey(PLATFORM, hash, {});
  record.cacheKey = cacheKey;

  const cached = resolveCached(PLATFORM, cacheKey);
  record.cacheHit = Boolean(cached);
  phase('fingerprint', `${shortHash(hash)} ${cached ? 'hit' : 'miss'}`);

  // ---- build (only on a miss) ------------------------------------------
  let apkPath = cached || null;
  if (!cached) {
    if (needsPrebuildFor(root, PLATFORM, isExpo)) {
      const pre = await prebuild(root, PLATFORM, writer, { isExpo });
      if (pre.failed) {
        return fail(pre.code, pre.reason, pre.remedy, { lastBuildStatus: true, lines: tail(pre.lastLines), logPath: displayPath(root, buildLog) });
      }
      phase('prebuild', `android/ generated (${formatDuration(pre.durationMs)})`);
      // The package name may only exist once the manifest has been written.
      androidPackage = androidPackage || detectAndroidPackage(root);
      record.bundleId = androidPackage;
    }

    const built = await build({ root, logWriter: writer });
    if (built.failed) {
      const diagnostics = built.diagnostics || [];
      // Contract 1: the raw transcript went to the log as debug; the
      // extracted diagnostics go there as errors, which is what makes
      // `logs --errors` show a build failure at all.
      for (const diag of diagnostics) {
        writer.write({ src: 'build', level: 'error', event: 'gradle_diagnostic', msg: formatDiagnostic(diag) });
      }
      phase('build', chalk.red(`FAILED after ${formatDuration(built.durationMs)}`));
      const extracted = diagnostics.map(formatDiagnostic);
      if (built.truncated > 0) extracted.push(`... and ${built.truncated} more diagnostic(s) in the log`);
      return fail(built.code, built.reason,
        // The remedy of a diagnostic beats the generic one: "set ANDROID_HOME"
        // is the whole answer where it applies, and "read the log" is not.
        diagnostics.find((d) => d.remedy)?.remedy || built.remedy || null,
        {
          lastBuildStatus: true,
          diagnostics: extracted,
          // Only when nothing could be extracted: the tail of a transcript is
          // the worst of both worlds otherwise -- tokens, and no diagnosis.
          lines: extracted.length ? [] : tail(built.lastLines),
          logPath: displayPath(root, buildLog),
        });
    }
    apkPath = built.apkPath;
    phase('build', `${basename(apkPath)} (${formatDuration(built.durationMs)})`);

    try {
      storeCached(PLATFORM, cacheKey, apkPath);
    } catch (err) {
      // A cache that cannot be written still builds; it just costs the next
      // workspace a rebuild. Never a reason to fail a run that succeeded.
      phase('cache', chalk.yellow(`could not store the build: ${err?.message || err}`));
    }
  }
  record.appPath = apkPath;

  // ---- install --------------------------------------------------------
  const installStarted = now();
  const installed = install({ serial, apkPath });
  if (installed.failed) {
    return fail(installed.code || INSTALL_FAILED, installed.reason, `Check that ${serial} is still connected (\`adb devices\`) and has room for the APK.`, { lastBuildStatus: true });
  }
  phase('install', `${cached ? 'from cache' : basename(apkPath)} (${formatDuration(now() - installStarted)})`);

  // ---- launch (Contract 6) ---------------------------------------------
  androidPackage = androidPackage || detectAndroidPackage(root);
  record.bundleId = androidPackage;
  if (!androidPackage) {
    return fail(
      LAUNCH_FAILED,
      'Could not determine this app\'s Android package name, so there is nothing to launch.',
      'Set `expo.android.package` in app.json / app.config.js, or `namespace` in android/app/build.gradle.',
      { lastBuildStatus: true }
    );
  }
  const launched = launch({ serial, packageName: androidPackage, metroPort });
  if (launched.failed) {
    return fail(launched.code || LAUNCH_FAILED, launched.reason, `Check the app installed correctly (\`adb -s ${serial} shell pm list packages ${androidPackage}\`).`, { lastBuildStatus: true });
  }
  writer.write({
    src: 'build',
    level: 'info',
    event: 'app_launched',
    // Contract 1's marker: `logs --errors` reports what happened since the
    // most recent launch, so this record is what closes the previous window.
    marker: true,
    msg: `launched ${androidPackage} on ${serial} against Metro port ${metroPort}`,
  });
  phase('launch', `${androidPackage} (tcp:${DEFAULT_METRO_PORT} -> tcp:${metroPort})`);

  // ---- Contract 4, then Contract 5 -------------------------------------
  //
  // lastBuild is written BEFORE the collector is spawned. Both writers
  // read-modify-write the same state.json, and the collector registers itself
  // within milliseconds of starting; writing ours first means its merge
  // carries lastBuild forward rather than racing it.
  persistLastBuild({ writeState, root, record, startedAt, durationMs: now() - started, status: 'ok', out });

  const collectorPid = startCollector({ root, serial, packageName: androidPackage, spawn, kill, out });
  phase('logs', `${displayPath(root, logsDir)}${collectorPid ? ` (collector pid ${collectorPid})` : ''}`);

  const facts = androidFacts({
    serial,
    fingerprint: hash,
    cacheHit: Boolean(cached),
    appPath: apkPath,
    bundleId: androidPackage,
    launched: true,
    logs: logsDir,
  });
  writer.close();

  if (json) {
    emit(JSON.stringify(facts));
  } else {
    emit(chalk.green(`OK: ${androidPackage} launched on ${serial}, Metro port ${metroPort} (${cached ? 'cache hit' : 'built'})`));
  }
  return { ok: true, facts };
}

// --- helpers ---------------------------------------------------------------

function persistLastBuild({ writeState, root, record, startedAt, durationMs, status, errorCode = null, out }) {
  const lastBuild = lastBuildRecord({ ...record, startedAt, durationMs, status, errorCode });
  try {
    // The MERGING writer the supervisor and the collector both use: it reads
    // state.json, spreads our key over it, and lands the result temp+rename.
    // Replacing the file instead would drop `supervisor` and `collectors`,
    // and `stop` reads both to know what to halt.
    writeState(root, { lastBuild });
  } catch (err) {
    out(phaseLine('state', chalk.yellow(`could not record lastBuild: ${err?.message || err}`)));
  }
  return lastBuild;
}

function startCollector({ root, serial, packageName, spawn, kill, out }) {
  killPreviousCollector(root, { kill });
  try {
    const child = spawn(
      process.execPath,
      [collectorEntry(), '--platform', PLATFORM, '--root', root, '--serial', serial, '--package', packageName],
      {
        cwd: root,
        // detached + unref, exactly as `start` spawns the supervisor: the
        // collector outlives this command, and its own stdio is discarded
        // because everything it has to say goes into device.ndjson.
        detached: true,
        stdio: 'ignore',
        env: process.env,
      }
    );
    child?.unref?.();
    return child?.pid ?? null;
  } catch (err) {
    // A missing collector costs `logs --source device` and nothing else. The
    // app is installed and running; refusing the run over it would be a
    // strictly worse answer.
    out(phaseLine('logs', chalk.yellow(`could not start the device log collector: ${err?.message || err}`)));
    return null;
  }
}

function tail(lines, n = FALLBACK_LINES) {
  return (Array.isArray(lines) ? lines : []).slice(-n);
}
