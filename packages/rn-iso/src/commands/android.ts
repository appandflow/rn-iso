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
import type { ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { spawnEntry } from '../spawn-entry.ts';
import type { Command } from 'commander';
import type { AndroidFacts, WaitedForBuild } from '../types.ts';
import { getConcurrencyLimits, getProject, upsertProject } from '../config.ts';
import { getExecutor } from '../exec.ts';
import { buildCacheKey, fingerprintProject, resolveBuild, storeBuild } from '../build-cache.ts';
import {
  acquireBuildLock,
  releaseBuildLock,
  waitForBuild as waitForOtherBuild,
  type BuildLockHandle,
  type WaitForBuildResult,
} from '../engine/build-lock.ts';
import { acquireBuildSlot, releaseBuildSlot, type BuildSlotHandle } from '../engine/build-slots.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { isPidAlive, resolveProjectMetro } from '../metro.ts';
import { workspaceLogsDir } from '../paths.ts';
import { detectAndroidPackage, detectBundleId, detectIsExpo, findProjectRoot, projectShortcut } from '../project.ts';
import {
  // devClientScheme is the app.json half of the iOS reader and is not
  // iOS-specific at all -- it reads the project's config, which is the
  // fallback here too. Imported rather than copied: two readers of one
  // config key drift, and this one is already tested.
  devClientScheme as configuredDevClientScheme,
  ensureWorkspaceIgnoredSafely,
  noMetroMessage,
  noMetroRemedy,
  pickDevClientScheme,
  resolveMetroWithRetry,
} from './ios.ts';
import { resolveSettings } from '../settings.ts';
import { gitCommonDir, repoRoot } from '../worktree.ts';
import { readCollectors } from '../collector/state.ts';
import { MODE_BARE, MODE_EXPO, readWorkspaceState, writeWorkspaceState } from '../supervisor/state.ts';
import {
  DEFAULT_METRO_PORT,
  LAUNCH_UNVERIFIED,
  androidDevClientUrl,
  installAndroidApp,
  launchAndroidApp,
  unverifiedLaunchLines,
  verifyLaunch,
} from '../engine/app-install.ts';
import { androidHome } from '../sim/android.ts';
import { checkDeviceCapacity, ensureBooted, ensureOwnedDevice } from '../engine/device.ts';
import type { OwnedDeviceRecord } from '../engine/device.ts';
import { needsPrebuild, runPrebuild } from '../engine/prebuild.ts';
import { buildAndroid } from '../engine/gradle.ts';
import {
  RESOLVE_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
  cacheLevel,
  exitAfterFlush,
  checkEasAuth,
  easAuthNote,
  isEasAuthFailureText,
  loadProjectProvider,
  resolveRemote,
  uploadRemote,
  type LoadProjectProviderResult,
} from '../engine/remote-cache.ts';
import { formatDiagnostic, type Diagnostic } from '../engine/errors-gradle.ts';

export const PLATFORM = 'android';

// --- local, flat shapes for engine results ---------------------------------
//
// These interfaces describe only the shape THIS file reads off the engine and
// sim results -- a deliberately local, all-optional view, looser than the
// producers' own exported types, matching the defensive reads underneath.

interface SupervisorLike {
  pid?: number;
  port?: number;
  mode?: string;
}

interface RemoteUploadLike {
  uploaded?: boolean;
  timedOut?: boolean;
  failed?: string | null;
}

interface PrebuildResultLike {
  failed?: boolean;
  code?: string;
  reason?: string;
  remedy?: string;
  lastLines?: string[];
  durationMs?: number;
}

interface BuildAndroidResultLike {
  failed?: boolean;
  code?: string;
  reason?: string;
  remedy?: string;
  diagnostics?: Diagnostic[];
  truncated?: number;
  lastLines?: string[];
  durationMs?: number;
  apkPath?: string;
}

interface InstallResultLike {
  failed?: boolean;
  code?: string;
  reason?: string;
}

interface LaunchResultLike {
  failed?: boolean;
  code?: string;
  reason?: string;
  mode?: string;
  component?: string;
  devClientNote?: string | null;
  devClientUrl?: string;
  reversed?: string[];
  debugHttpHost?: string | null;
  debugHttpHostNote?: string | null;
}

interface VerifyLaunchResultLike {
  verified?: boolean;
  skipped?: boolean;
  waitedMs?: number;
}

interface AndroidCommandOptions {
  json?: boolean;
  metroCheck?: boolean;
  buildCache?: boolean;
}

interface FailExtra {
  lastBuildStatus?: boolean;
  diagnostics?: string[];
  lines?: string[];
  logPath?: string | null;
}

interface AndroidRecord {
  fingerprint?: string | null;
  cacheKey?: string | null;
  cacheHit?: boolean | string;
  cacheSkipped?: boolean;
  appPath?: string | null;
  bundleId?: string | null;
  avdName?: string | null;
  deviceName?: string | null;
}

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

// --- the dev-client deep link, Android half (mirrors devClientScheme in
// --- commands/ios.js) ------------------------------------------------------
//
// Without this an expo-dev-client app cold-launches into expo-dev-launcher's
// DEVELOPMENT SERVERS screen -- EMPTY on a fresh emulator, since the launcher
// has no history to list -- and every `rn-iso android` run reported
// `launched: unverified` because nothing ever asked this workspace's Metro
// for a bundle. iOS has had the deep link since the picker bug; Android had
// only `am start -n <component>`, which IS the launcher screen.
//
// The BUILT APK is the primary source, for the reason the iOS comment gives:
// a project with a dynamic config has no scheme in app.json at all, while
// whatever the config pipeline computed is in the manifest of the thing we
// just installed.
//
// `aapt dump badging` is NOT the dump to read -- verified on a real
// dev-client APK, badging prints the package, the launchable activity and the
// permissions, and NOT ONE intent-filter data element. `aapt dump xmltree
// <apk> AndroidManifest.xml` prints the whole manifest tree including
// `android:scheme`, in 10ms on a 415MB apk, and aapt2's `dump xmltree --file`
// prints the same tree with namespace-qualified attribute names. Both are
// parsed below.

// A parsed aapt xmltree node -- see parseXmltree below.
interface XmlNode {
  tag: string;
  attrs: Record<string, string | null>;
  children: XmlNode[];
  indent: number;
}

interface AaptTool {
  path: string;
  tool: string;
  version: string;
}

// Build-tools directory names are versions: "36.0.0", "35.0.0", "34.0.0".
// PURE, so the ordering is testable without an SDK.
export function newestBuildTools(names: unknown): string | null {
  return (
    [...(Array.isArray(names) ? names : [])]
      .filter((n) => /^\d+(\.\d+)*(-\w+)?$/.test(String(n)))
      .sort((a, b) => {
        const pa = String(a).split(/[.-]/).map(Number);
        const pb = String(b).split(/[.-]/).map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const d = (pb[i] || 0) - (pa[i] || 0);
          if (d) return d;
        }
        return 0;
      })[0] ?? null
  );
}

// aapt / aapt2, newest build-tools first. Neither is on PATH on a normal
// machine (verified: `which aapt` finds nothing with a fully installed SDK),
// so they are addressed through ANDROID_HOME the way sim/android.js addresses
// avdmanager.
export function findAapt(
  home: string = androidHome(),
  {
    readDir = readdirSync,
    exists = existsSync,
  }: { readDir?: (path: string) => string[]; exists?: (path: string) => boolean } = {},
): AaptTool | null {
  const root = join(home, 'build-tools');
  let versions: string[] = [];
  try {
    versions = readDir(root);
  } catch {
    return null;
  }
  while (versions.length) {
    const version = newestBuildTools(versions);
    if (!version) return null;
    for (const tool of ['aapt', 'aapt2']) {
      const path = join(root, version, tool);
      if (exists(path)) return { path, tool, version };
    }
    versions = versions.filter((v) => v !== version);
  }
  return null;
}

// The manifest tree, as text. Null on anything at all going wrong: a missing
// SDK, an apk aapt cannot read, a build-tools install without aapt. The
// app.json fallback is behind this and a missing scheme is survivable.
export function dumpApkManifest(
  apkPath: unknown,
  { exec = null, aapt = null }: { exec?: import('../exec.ts').Executor | null; aapt?: AaptTool | null } = {},
): string | null {
  if (typeof apkPath !== 'string' || apkPath.trim() === '') return null;
  const tool = aapt || findAapt();
  if (!tool) return null;
  const e = exec || getExecutor();
  // The two spellings of the same dump; aapt2 wants the entry behind --file.
  const args =
    tool.tool === 'aapt2'
      ? ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apkPath]
      : ['dump', 'xmltree', apkPath, 'AndroidManifest.xml'];
  try {
    const out = e.runFile(tool.path, args);
    return typeof out === 'string' && out.includes('E: manifest') ? out : null;
  } catch {
    return null;
  }
}

// PURE. aapt's xmltree is an indented element/attribute listing:
//
//   E: activity (line=262)
//     A: android:name(0x01010003)="com.x.MainActivity" (Raw: "com.x.MainActivity")
//     E: intent-filter (line=272)
//       E: data (line=291)
//         A: android:scheme(0x01010027)="th3rdwave" (Raw: "th3rdwave")
//
// Attributes belong to the nearest element above them at a smaller indent,
// which is all the structure this needs. Values that are not string literals
// -- `@0x7f1300c6` (an unresolved resource reference, which a scheme set from
// a string resource really is) and `(type 0x12)0xffffffff` -- come back as
// null rather than as their raw text: a scheme nobody can resolve must not
// become a deep link.
export function parseXmltree(text: unknown): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [], indent: -1 };
  const stack: XmlNode[] = [root];
  for (const raw of String(text ?? '').split('\n')) {
    const indent = raw.search(/\S/);
    if (indent < 0) continue;
    const line = raw.trim();
    const element = /^E: ([\w.:-]+)/.exec(line);
    if (element) {
      // stack always holds the root sentinel, so stack[length-1] is present
      // (the `length > 1` guard here is about not popping the root).
      while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
      // element matched /^E: ([\w.:-]+)/, so capture group 1 is present.
      const node: XmlNode = { tag: element[1]!, attrs: {}, children: [], indent };
      stack[stack.length - 1]!.children.push(node);
      stack.push(node);
      continue;
    }
    const attr = /^A: ([^(=]+?)(?:\(0x[0-9a-f]+\))?=(.*)$/.exec(line);
    if (attr && stack.length > 1) {
      // attr matched, so groups 1 and 2 are present.
      // aapt prints `android:name`, aapt2 the full namespace URI.
      const name = attr[1]!.replace(/^http:\/\/schemas\.android\.com\/apk\/res\/android:/, 'android:');
      const value = /^"((?:[^"\\]|\\.)*)"/.exec(attr[2]!);
      // stack holds the root sentinel, so stack[length-1] is present.
      stack[stack.length - 1]!.attrs[name] = value ? value[1]! : null;
    }
  }
  return root;
}

function eachNode(node: XmlNode, fn: (node: XmlNode) => void): void {
  fn(node);
  for (const child of node.children) eachNode(child, fn);
}

interface ApkDevClientFacts {
  devClient: boolean;
  schemes: string[];
}

// PURE. What the installed APK says about deep-linking into it:
//   devClient   does the manifest declare expo-dev-launcher at all
//   schemes     the schemes on the LAUNCHABLE activity, in manifest order
//
// Scoping the schemes to the launchable activity is the whole point, and it
// is not caution -- on the real APK this was built against, the manifest also
// declares `expo-dev-launcher` (on the launcher's own OAuth AuthActivity),
// `stripe-connect`, `stripe-auth`, `link-popup` and four more from SDKs.
// `expo-dev-launcher` is the LONGEST of them, so the length tie-break Expo's
// CLI uses (and that pickDevClientScheme inherits for iOS, where the plist
// gives no activity structure) picks exactly the wrong one. The activity that
// answers android.intent.action.MAIN is the app.
// PURE. The `package` attribute of the manifest root -- the ground truth the
// APK itself carries. Exists for the same reason the iOS command reads the
// bundle id out of the cached .app's Info.plist: on a cache HIT no prebuild
// ran, so a managed app may have no android/ dir and no android.package in
// app.json, yet the artifact in hand knows exactly what it is.
export function apkPackage(text: unknown): string | null {
  const root = parseXmltree(text);
  const manifest = root.children.find((c) => c.tag === 'manifest');
  const pkg = manifest?.attrs['package'];
  return typeof pkg === 'string' && pkg.trim() ? pkg.trim() : null;
}

export function apkDevClientFacts(text: unknown): ApkDevClientFacts {
  const root = parseXmltree(text);
  const facts: ApkDevClientFacts = { devClient: false, schemes: [] };
  let launchable: XmlNode | null = null;
  eachNode(root, (node) => {
    const name = node.attrs['android:name'];
    if (typeof name === 'string' && name.startsWith('expo.modules.devlauncher')) facts.devClient = true;
    if (node.tag !== 'activity' && node.tag !== 'activity-alias') return;
    const filters = node.children.filter((c) => c.tag === 'intent-filter');
    const isLauncher = filters.some((f) =>
      f.children.some((c) => c.tag === 'action' && c.attrs['android:name'] === 'android.intent.action.MAIN'),
    );
    if (!isLauncher || launchable) return;
    launchable = node;
    for (const filter of filters) {
      for (const data of filter.children) {
        if (data.tag !== 'data') continue;
        const scheme = data.attrs['android:scheme'];
        if (typeof scheme === 'string' && scheme.trim()) facts.schemes.push(scheme.trim());
      }
    }
  });
  return facts;
}

// The scheme to deep-link this launch with, or undefined for "plain launch".
//
// The APK is authoritative in BOTH directions: an app whose manifest has no
// expo-dev-launcher in it is not a dev client, and sending it a deep link
// would just fail to resolve. Only when the apk cannot be read at all does
// this fall back to the project config, exactly as iOS does.
export function androidDevClientScheme(
  root: string,
  apkPath: unknown,
  {
    exec = null,
    dump = dumpApkManifest,
    aapt = null,
  }: { exec?: import('../exec.ts').Executor | null; dump?: typeof dumpApkManifest; aapt?: AaptTool | null } = {},
): string | null | undefined {
  const text = dump(apkPath, { exec, aapt });
  if (text) {
    const facts = apkDevClientFacts(text);
    if (!facts.devClient) return undefined;
    const scheme = pickDevClientScheme(facts.schemes);
    if (scheme) return scheme;
  }
  return configuredDevClientScheme(root, null);
}

export function collectorEntry(): string {
  return spawnEntry('collector-run');
}

// PURE. `  fingerprint a3f9b1.. hit`
export function phaseLine(label: unknown, text: string): string {
  return `  ${String(label).padEnd(LABEL_WIDTH)} ${text}`;
}

// PURE. Paths under the workspace print relative to it, the way the spec's
// worked example does: `.rn-iso/logs/build-android.ndjson` is shorter than
// the absolute path, and every command here runs from inside the workspace.
// The --json payload keeps the absolute form, which is what a consumer needs.
export function displayPath(root: string, path: string): string {
  const rel = relative(root, path);
  return rel && !rel.startsWith('..') ? rel : path;
}

// PURE. A fingerprint is 64 hex characters and no agent reads more than the
// first few; the whole hash is in the --json payload and in state.json.
export function shortHash(hash: unknown): string {
  const text = String(hash || '');
  return text.length > 8 ? `${text.slice(0, 6)}..` : text;
}

// PURE. Durations an agent reads at a glance: milliseconds under a second,
// then seconds, then minutes -- the spec's "3.1s" and "2m41s".
export function formatDuration(ms: unknown): string {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return 'unknown';
  if (value < 1000) return `${Math.round(value)}ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(Math.round(seconds - minutes * 60)).padStart(2, '0')}s`;
}

// PURE. The --json payload.
export function androidFacts({
  serial,
  avdName = null,
  deviceName = null,
  fingerprint,
  cacheHit,
  cacheSkipped = false,
  waitedForBuild = null,
  appPath,
  bundleId,
  launched,
  logs,
  debugHttpHost = null,
  debugHttpHostNote = null,
  devClientUrl = null,
}: {
  serial?: string | null;
  avdName?: string | null;
  deviceName?: string | null;
  fingerprint?: string | null;
  cacheHit?: boolean | string;
  cacheSkipped?: boolean;
  waitedForBuild?: WaitedForBuild | null;
  appPath?: string | null;
  bundleId?: string | null;
  launched?: boolean | string;
  logs?: string | null;
  debugHttpHost?: string | null;
  debugHttpHostNote?: string | null;
  devClientUrl?: string | null;
}): AndroidFacts {
  return {
    platform: PLATFORM,
    serial: serial ?? null,
    // The serial is a SLOT (emulator-5554 is whatever booted into that
    // console port first); the AVD name is the identity, and it is what every
    // device tool -- `emulator -avd`, avdmanager, an agent's device skill --
    // is addressed by. A payload that carried only the serial made the caller
    // go and ask `adb emu avd name` for it.
    avdName: avdName ?? null,
    deviceName: deviceName ?? avdName ?? null,
    fingerprint: fingerprint ?? null,
    // 'local' | 'remote' | false. Which LEVEL answered, not merely whether one
    // did: an agent reading `true` cannot tell a free install from one that
    // cost a download (see cacheLevel in engine/remote-cache.js).
    cacheHit: cacheLevel(cacheHit),
    // true only when --no-build-cache was passed: "nothing was looked up" is a
    // different fact from "nothing was found".
    cacheSkipped: Boolean(cacheSkipped),
    // { pid, ms } when this run did not compile because ANOTHER workspace was
    // already compiling the same fingerprint and it waited for that artifact;
    // null when nothing was waited for. cacheHit is 'local' either way -- the
    // APK really did come out of the local cache -- so this is the only thing
    // that separates "the cache already had it" from "the cache had it twelve
    // minutes later, which still beat compiling it twice".
    waitedForBuild: waitedForBuild ? { pid: waitedForBuild.pid ?? null, ms: waitedForBuild.ms ?? 0 } : null,
    appPath: appPath ?? null,
    bundleId: bundleId ?? null,
    // Three-valued, like the iOS payload: 'unverified' is what a launch that
    // produced no bundle request from this workspace's Metro reports. An
    // unconditional `true` is what let an app sitting on the dev-launcher's
    // server picker read as a successful run.
    launched: launched === LAUNCH_UNVERIFIED ? LAUNCH_UNVERIFIED : Boolean(launched),
    // Contract 6's two Android mechanisms, reported rather than merely
    // attempted. debugHttpHost is `10.0.2.2:<port>` when the SharedPreferences
    // write landed and null when it did not, and the note says why -- the
    // launch survives either way on the adb reverse alone, so the difference
    // is invisible without this. devClientUrl is the deep link that was sent
    // (null for a plain launcher start), which is the exact command an
    // `unverified` launch has to be re-driven with.
    debugHttpHost: debugHttpHost ?? null,
    debugHttpHostNote: debugHttpHostNote ?? null,
    devClientUrl: devClientUrl ?? null,
    logs: logs ?? null,
  };
}

// PURE. Contract 4, the state.json.lastBuild record.
export function lastBuildRecord({
  fingerprint,
  cacheKey,
  cacheHit,
  cacheSkipped = false,
  durationMs,
  appPath,
  bundleId,
  startedAt,
  status,
  errorCode = null,
  avdName = null,
  deviceName = null,
}: {
  fingerprint?: string | null;
  cacheKey?: string | null;
  cacheHit?: boolean | string;
  cacheSkipped?: boolean;
  durationMs?: number;
  appPath?: string | null;
  bundleId?: string | null;
  startedAt: string;
  status: string;
  errorCode?: string | null;
  avdName?: string | null;
  deviceName?: string | null;
}): Record<string, unknown> {
  const record: Record<string, unknown> = {
    platform: PLATFORM,
    // Which emulator this build went to, by name and not only by console-port
    // slot -- see androidFacts. `status` reads state.json, and an agent
    // driving the device after a build has nothing else to address it with.
    avdName: avdName ?? null,
    deviceName: deviceName ?? avdName ?? null,
    fingerprint: fingerprint ?? null,
    cacheKey: cacheKey ?? null,
    cacheHit: cacheLevel(cacheHit),
    cacheSkipped: Boolean(cacheSkipped),
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
export function killPreviousCollector(
  root: string,
  {
    platform = PLATFORM,
    kill = (pid: number, signal: NodeJS.Signals) => process.kill(pid, signal),
    collectors = null,
  }: {
    platform?: string;
    kill?: (pid: number, signal: NodeJS.Signals) => boolean;
    collectors?: Record<string, { pid?: number }> | null;
  } = {},
): number | null {
  const record = (collectors ?? readCollectors(root))?.[platform] as { pid?: number } | undefined;
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

export default function androidCommand(program: Command): void {
  registerAndroid(program);
}

export function registerAndroid(program: Command): void {
  program
    .command('android')
    .description(
      "Build (or install from the shared cache), install and launch this workspace's Android app on its owned " +
        'emulator, wired to the reserved Metro port. Never starts the bundler -- run `rn-iso start` first.',
    )
    .option('--json', 'Emit the facts as a single JSON line on stdout; every other line goes to stderr')
    .option(
      '--no-metro-check',
      'Skip the reserved-port Metro health check (the app will load no bundle unless something else serves it)',
    )
    .option(
      '--no-build-cache',
      "Build fresh, ignoring cached artifacts (local and the project's build-cache provider); the fresh build still replaces the cache entry",
    )
    .action(async (opts: AndroidCommandOptions) => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project (no package.json found).'));
        process.exit(1);
        return;
      }
      const result = await runAndroid({
        root,
        json: Boolean(opts.json),
        metroCheck: opts.metroCheck !== false,
        useBuildCache: opts.buildCache !== false,
      });
      if (!result.ok) process.exit(1);
    });
}

// The DI seam, typed against each real default's own type via `typeof`. `root`
// has no default of its own (every real call site, including the tests,
// always supplies one) -- the `= {}` on the whole parameter is a pre-existing
// fallback for "called with nothing", which is why the default below is cast
// rather than left to fail the structural check.
interface RunAndroidOptions {
  root: string;
  json?: boolean;
  metroCheck?: boolean;
  useBuildCache?: boolean;
  getLimits?: typeof getConcurrencyLimits;
  checkCapacity?: typeof checkDeviceCapacity;
  acquireSlot?: typeof acquireBuildSlot;
  releaseSlot?: typeof releaseBuildSlot;
  ensureDevice?: typeof ensureOwnedDevice;
  ensureDeviceBooted?: typeof ensureBooted;
  resolveMetro?: typeof resolveProjectMetro;
  resolveMetroRetrying?: typeof resolveMetroWithRetry;
  readState?: typeof readWorkspaceState;
  pidAlive?: typeof isPidAlive;
  verifyLaunched?: typeof verifyLaunch;
  ensureIgnored?: typeof ensureWorkspaceIgnoredSafely;
  fingerprint?: typeof fingerprintProject;
  resolveCached?: typeof resolveBuild;
  storeCached?: typeof storeBuild;
  acquireLock?: typeof acquireBuildLock;
  releaseLock?: typeof releaseBuildLock;
  waitForBuild?: typeof waitForOtherBuild;
  loadProvider?: typeof loadProjectProvider;
  easAuth?: typeof checkEasAuth;
  resolveRemoteBuild?: typeof resolveRemote;
  uploadRemoteBuild?: typeof uploadRemote;
  needsPrebuildFor?: typeof needsPrebuild;
  prebuild?: typeof runPrebuild;
  build?: typeof buildAndroid;
  install?: typeof installAndroidApp;
  launch?: typeof launchAndroidApp;
  resolveDevClientScheme?: typeof androidDevClientScheme;
  spawn?: (cmd: string, args: readonly string[], opts: Record<string, unknown>) => ChildProcess;
  kill?: (pid: number, signal: NodeJS.Signals) => boolean;
  createWriter?: typeof createNdjsonWriter;
  writeState?: typeof writeWorkspaceState;
  now?: () => number;
  out?: (line: string) => void;
  emit?: (line: string) => void;
}

interface RunAndroidResult {
  ok: boolean;
  // code is `string | undefined` because a couple of call sites (the prebuild
  // and gradle failure paths) pass an engine result's `code` straight through
  // with no fallback, same as the original untyped JS did.
  error?: { code?: string; message?: string | null; remedy?: string | null };
  facts?: AndroidFacts;
}

// Every side effect is a seam with the real thing as its default, so the flow
// is testable without an emulator, a gradle daemon, or a network. The command
// action above passes none of them.
export async function runAndroid(
  {
    root,
    json = false,
    metroCheck = true,
    // --no-build-cache turns off every LOOKUP -- the local cache and the
    // project's provider both -- and nothing else: the fresh build is still
    // stored (over the entry it was told not to trust) and still uploaded.
    useBuildCache = true,
    getLimits = getConcurrencyLimits,
    checkCapacity = checkDeviceCapacity,
    acquireSlot = acquireBuildSlot,
    releaseSlot = releaseBuildSlot,
    ensureDevice = ensureOwnedDevice,
    ensureDeviceBooted = ensureBooted,
    resolveMetro = resolveProjectMetro,
    resolveMetroRetrying = resolveMetroWithRetry,
    readState = readWorkspaceState,
    pidAlive = isPidAlive,
    verifyLaunched = verifyLaunch,
    ensureIgnored = ensureWorkspaceIgnoredSafely,
    fingerprint = fingerprintProject,
    resolveCached = resolveBuild,
    storeCached = storeBuild,
    acquireLock = acquireBuildLock,
    releaseLock = releaseBuildLock,
    waitForBuild = waitForOtherBuild,
    loadProvider = loadProjectProvider,
    easAuth = checkEasAuth,
    resolveRemoteBuild = resolveRemote,
    uploadRemoteBuild = uploadRemote,
    needsPrebuildFor = needsPrebuild,
    prebuild = runPrebuild,
    build = buildAndroid,
    install = installAndroidApp,
    launch = launchAndroidApp,
    resolveDevClientScheme = androidDevClientScheme,
    spawn = (cmd, args, opts) => getExecutor().spawn(cmd, args, opts),
    kill = (pid, signal) => process.kill(pid, signal),
    createWriter = createNdjsonWriter,
    writeState = writeWorkspaceState,
    now = Date.now,
    out = (line) => console.error(line),
    emit = (line) => console.log(line),
  }: RunAndroidOptions = {} as RunAndroidOptions,
): Promise<RunAndroidResult> {
  const started = now();
  const startedAt = new Date(started).toISOString();
  // Before ANY write into <root>/.rn-iso -- the build log opened on the next
  // line, the state file, the APK paths recorded in it.
  await ensureIgnored(root, { note: out });
  const logsDir = workspaceLogsDir(root);
  const buildLog = join(logsDir, 'build-android.ndjson');
  const writer = createWriter(buildLog, { truncate: true });

  // Failure state that lands in Contract 4 is accumulated as the run goes, so
  // a failure at any step after the fingerprint records what it knew.
  const record: AndroidRecord = {
    fingerprint: null,
    cacheKey: null,
    cacheHit: false,
    appPath: null,
    bundleId: null,
    avdName: null,
    deviceName: null,
  };

  // The build lock, when this run is the one compiling (engine/build-lock.js).
  // Released from the `finally` around the build below, on success, on a
  // formatted failure and on a throw alike: a failed build that kept its lock
  // would leave every other workspace on this fingerprint waiting for an
  // artifact nobody is making.
  let buildLock: BuildLockHandle | null = null;
  const releaseHeldLock = () => {
    if (!buildLock) return;
    const held = buildLock;
    buildLock = null;
    try {
      releaseLock(held);
    } catch (err) {
      out(
        phaseLine(
          'build',
          chalk.dim(`could not release the build lock at ${held.path}: ${(err as Error)?.message || err}`),
        ),
      );
    }
  };

  // The build SLOT (engine/build-slots.js), when concurrency.maxBuilds is set
  // and this run compiles. Acquired inside the build try below and released in
  // the same finally as the build lock, so a return through fail() frees it too.
  let buildSlot: BuildSlotHandle | null = null;
  const releaseHeldSlot = () => {
    if (!buildSlot) return;
    const held = buildSlot;
    buildSlot = null;
    try {
      releaseSlot(held);
    } catch (err) {
      out(phaseLine('build', chalk.dim(`could not release the build slot: ${(err as Error)?.message || err}`)));
    }
  };

  const phase = (label: unknown, text: string) => out(phaseLine(label, text));
  // One formatter for every refusal, so a failed run reads the same whatever
  // step failed: the code and the message, then whatever was extracted, then
  // the remedy, then the log that holds the rest. Never the transcript.
  const fail = (
    code: string | undefined,
    message?: string | null,
    remedy?: string | null,
    { lastBuildStatus = false, diagnostics = [], lines = [], logPath = null }: FailExtra = {},
  ): RunAndroidResult => {
    if (lastBuildStatus) {
      persistLastBuild({
        writeState,
        root,
        record,
        startedAt,
        durationMs: now() - started,
        status: 'failed',
        errorCode: code,
        out,
      });
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
  upsertProject(root, {
    bundleId: detectBundleId(root) ?? undefined,
    androidPackage: androidPackage ?? undefined,
    isExpo,
  });
  const project = getProject(root);
  const label = projectShortcut(root, project);

  // ---- concurrency: opt-in, unlimited by default ----
  const limits = getLimits();

  // The device cap is checked BEFORE ensureDevice, which creates and boots an
  // emulator: a refusal has to fire before that. It never refuses a workspace
  // whose own emulator is already running (re-running `android` is
  // idempotent), only a NEW device over concurrency.maxDevices.
  const capacity = checkCapacity({
    platform: PLATFORM,
    project,
    max: limits.maxDevices,
  });
  if (capacity) return fail(capacity.code, capacity.message, capacity.remedy);

  // ---- device --------------------------------------------------------
  let device: OwnedDeviceRecord;
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
      `Could not ensure an owned Android emulator: ${(err as Error)?.message || err}`,
      'Check that JAVA_HOME and ANDROID_HOME are set correctly, and that an arm64 system image is installed (`sdkmanager "system-images;android-36;google_apis;arm64-v8a"`).',
    );
  }

  // ---- metro (fail fast, before the boot and before any build work) ----
  //
  // Placed after ensureDevice (whose record the rest of this command reads)
  // but before ensureDeviceBooted, because waiting for an emulator to report
  // boot completion is the first expensive thing here and there is no reason
  // to pay it only to refuse afterwards.
  const reservedPort = project?.metroPort ?? null;
  if (metroCheck) {
    if (!reservedPort) {
      return fail(
        NO_METRO,
        'No Metro port is reserved for this workspace.',
        'Run `rn-iso start` first, or pass --no-metro-check.',
      );
    }
    // Retried: `start` returns when the server is LISTENING, and a bare
    // in-process Metro then blocks its event loop crawling a monorepo's file
    // map for ~20s, during which /status never answers. See
    // resolveMetroWithRetry in commands/ios.js -- one implementation, both
    // platforms.
    const held = await resolveMetroRetrying(resolveMetro, reservedPort, root, {
      onRetry: ({ delayMs }) =>
        phase(
          'metro',
          `port ${reservedPort} did not verify yet; retrying in ${Math.round(delayMs / 1000)}s (Metro may still be indexing)`,
        ),
    });
    if (!held.metro) {
      const supervisor = (readState(root)?.supervisor ?? null) as SupervisorLike | null;
      const supervisorAlive = Boolean(supervisor?.pid && pidAlive(supervisor.pid));
      return fail(
        NO_METRO,
        noMetroMessage({ port: reservedPort, resolution: held, supervisor, supervisorAlive }),
        noMetroRemedy({ port: reservedPort, supervisor, supervisorAlive }),
      );
    }
    phase('metro', `port ${reservedPort} (pid ${held.metro?.pid})`);
  } else {
    phase(
      'metro',
      reservedPort ? `port ${reservedPort} (not checked)` : `no reservation; using ${DEFAULT_METRO_PORT} (not checked)`,
    );
  }
  const metroPort = reservedPort ?? DEFAULT_METRO_PORT;

  const booted = await ensureDeviceBooted({ platform: PLATFORM, device, out });
  if (booted.failed) {
    return fail(
      NO_DEVICE,
      booted.reason,
      'Run `rn-iso status` to see what rn-iso thinks it owns; re-running `rn-iso android` creates a fresh owned AVD.',
    );
  }
  const serial = booted.serial;
  record.avdName = device.avdName ?? null;
  record.deviceName = device.deviceName ?? device.avdName ?? null;
  phase('device', `${device.avdName || serial} (${serial}) booted`);

  // ---- fingerprint ----------------------------------------------------
  let hash;
  try {
    // Scoped to Android. Unscoped, ios/ hashes into this key: a podspec that
    // bakes an absolute path into ios/Podfile.lock then makes every
    // cross-worktree build a miss. See src/build-cache.js.
    hash = await fingerprint(root, { platform: PLATFORM });
  } catch (err) {
    return fail(
      NO_FINGERPRINT,
      `@expo/fingerprint could not fingerprint ${root}: ${(err as Error)?.message || err}`,
      'Fix the error above, or install a working copy with `npm i -D @expo/fingerprint`.',
    );
  }
  if (!hash) {
    return fail(
      NO_FINGERPRINT,
      `@expo/fingerprint is not resolvable from ${root} or from rn-iso, so the build cache cannot be addressed.`,
      'Install it in the project: `npm i -D @expo/fingerprint`.',
    );
  }
  record.fingerprint = hash;
  const cacheKey = buildCacheKey(PLATFORM, hash, {});
  record.cacheKey = cacheKey;

  // ---- level one: this machine's shared cache --------------------------
  // Instant, offline, shared by every worktree on the machine, and the only
  // cache a bare React Native project has.
  const cached = useBuildCache ? resolveCached(PLATFORM, cacheKey) : null;
  record.cacheHit = cached ? 'local' : false;
  record.cacheSkipped = !useBuildCache;
  phase('fingerprint', `${shortHash(hash)} ${cached ? 'hit' : 'miss'}${useBuildCache ? '' : ' (--no-build-cache)'}`);

  // ---- level two: the project's OWN Expo build-cache provider ----------
  //
  // Only on a local miss, and only on an Expo project -- the community CLI has
  // no provider concept, so a bare project never reads a config and never
  // reaches the network. The provider is loaded even when --no-build-cache
  // turned the LOOKUP off, because the build that follows is still uploaded to
  // it. Every failure here is a NOTE: the build below is still able to run.
  let apkPath: string | null = cached || null;
  let remote: LoadProjectProviderResult | null = null;
  // A call we stopped waiting for may still hold the child process the
  // provider spawned; see the end of this function.
  let abandonedRemote = false;
  let uploadPending: Promise<RemoteUploadLike> | null = null;
  if (!apkPath) {
    const loaded: LoadProjectProviderResult = await loadProvider(root, { isExpo });
    if (loaded?.unavailable) {
      phase('cache', chalk.yellow(`provider not usable: ${loaded.unavailable}`));
    } else if (loaded?.provider) {
      remote = loaded;
    }
    // The EAS provider is the one that cannot report its own failure: both of
    // eas-build-cache-provider's entry points catch everything `npx eas-cli`
    // throws and return null, so an expired session reaches this command as a
    // clean MISS, on every build, forever. One bounded `eas whoami` (cached for
    // the run) is what turns that silence into a line.
    //
    // A definitively logged-out machine skips the tier outright and the run
    // continues on the local cache. Anything less than definitive (offline, no
    // eas-cli, an unrecognised output) changes NOTHING: an unreachable API is
    // not a logged-out user, and a build must not brick on a plane.
    if (remote?.name === 'eas') {
      const auth = easAuth({ projectRoot: root, owner: loaded?.owner || null });
      // easAuthNote's parameter interface is private to engine/remote-cache.ts and
      // narrower than EasAuthResult on a couple of fields; Parameters<> reaches
      // the real type without needing an export.
      const authNote = easAuthNote(auth as Parameters<typeof easAuthNote>[0]);
      if (authNote) phase('cache', chalk.yellow(authNote));
      // Wrong-account still consults the provider: whoami does not always
      // enumerate accounts, and access is the server's decision.
      if (auth?.code === 'logged-out') remote = null;
    }
  }

  if (remote && useBuildCache) {
    const hit = await resolveRemoteBuild({
      logWriter: writer,
      provider: remote.provider,
      platform: PLATFORM,
      projectRoot: root,
      fingerprintHash: hash,
    });
    if (hit?.appPath) {
      // INTO the local cache on the way past: the download is paid once per
      // machine rather than once per worktree.
      let stored = null;
      try {
        stored = storeCached(PLATFORM, cacheKey, hit.appPath);
      } catch (err) {
        phase('cache', chalk.yellow(`remote hit could not be stored locally: ${(err as Error)?.message || err}`));
      }
      apkPath = stored || hit.appPath;
      record.cacheHit = 'remote';
      phase('cache', `remote hit (${remote.name})${stored ? ' -> stored locally' : ''}`);
    } else if (hit?.timedOut) {
      abandonedRemote = true;
      phase(
        'cache',
        chalk.yellow(`${remote.name} did not answer within ${formatDuration(RESOLVE_TIMEOUT_MS)}; building instead`),
      );
    } else if (hit?.failed) {
      // An auth failure the provider DID surface gets the same specific note
      // the pre-flight would have printed, rather than the generic one.
      const authNote =
        remote.name === 'eas' && isEasAuthFailureText(hit.failed)
          ? easAuthNote({ code: 'logged-out', reason: hit.failed })
          : null;
      phase('cache', chalk.yellow(authNote || `${remote.name} could not be used: ${hit.failed}; building instead`));
    } else {
      phase('cache', `remote miss (${remote.name})`);
    }
  }

  // ---- level three: another workspace that is ALREADY building this ----
  //
  // Both caches missed, so this run is about to spend minutes in gradle -- and
  // the premise of this whole tool is that another agent is standing on the
  // same commit, about to spend the same minutes producing the same APK. The
  // lock decides which of them compiles; the rest wait for its artifact and
  // install that. This is commands/ios.js's block on the Android half, and the
  // reasoning is recorded there in full (engine/build-lock.js holds the rules).
  //
  // --no-build-cache stays outside it in both directions: it asked for a fresh
  // compile, so it neither installs someone else's artifact nor makes anyone
  // else wait on a build they did not ask for.
  let waitedForBuild: WaitedForBuild | null = null;
  if (!apkPath && useBuildCache) {
    let attempt: BuildLockHandle | null = null;
    try {
      attempt = acquireLock({ platform: PLATFORM, key: cacheKey, root, logFile: buildLog });
    } catch (err) {
      // Contained like the cache store: an optimisation that cannot run must
      // never stop a build.
      phase('build', chalk.yellow(`could not take the build lock: ${(err as Error)?.message || err}; building anyway`));
    }

    if (attempt?.acquired) {
      buildLock = attempt;
    } else if (attempt?.held) {
      const holder = attempt.held;
      const who = holder.projectRoot || 'another workspace';
      phase(
        'build',
        `${who} is already building ${shortHash(hash)} (pid ${holder.pid})` +
          `${holder.logFile ? ` -- tail ${holder.logFile}` : ''}`,
      );

      let waited: WaitForBuildResult | null = null;
      try {
        waited = await waitForBuild({ platform: PLATFORM, key: cacheKey, out });
      } catch (err) {
        const wtErr = err as Error & { code?: string; lockPath?: string };
        if (wtErr?.code !== 'RN_ISO_BUILD_WAIT_TIMEOUT') throw err;
        return fail(
          'RN_ISO_BUILD_WAIT_TIMEOUT',
          wtErr.message,
          `Check pid ${holder.pid}; if it is not really building, remove ${wtErr.lockPath} and run \`rn-iso android\` again.`,
          { lastBuildStatus: true },
        );
      }

      if (waited?.hit) {
        // The artifact the other workspace stored. It IS a local cache hit --
        // the same entry any later run resolves -- so cacheHit says 'local';
        // waitedForBuild is what says it was not free.
        apkPath = waited.hit ?? null;
        record.cacheHit = 'local';
        waitedForBuild = { pid: holder.pid, ms: waited.waitedMs };
        phase('build', `waited ${formatDuration(waited.waitedMs)} for ${who}'s build -> installed from cache`);
      } else {
        // The builder is gone and stored nothing. Take the lock OVER so a
        // third workspace waits on this run instead of starting a third
        // compile; if someone else took it first, build without it rather than
        // queueing again -- a redundant build is the cheaper failure.
        phase(
          'build',
          chalk.yellow(`${who}'s build ended without an artifact (${waited?.builderFailed}); building here`),
        );
        try {
          const takeover = acquireLock({ platform: PLATFORM, key: cacheKey, root, logFile: buildLog });
          if (takeover?.acquired) buildLock = takeover;
        } catch {
          /* contained the same way as the first attempt */
        }
      }
    }
  }

  // ---- build (only when neither level answered) ------------------------
  if (!apkPath) {
    // The `finally` is the point of the try: a build that fails, or one that
    // throws, must free its waiters at once. It releases BEFORE the install
    // below, so a waiting workspace starts installing the moment the artifact
    // is in the cache rather than when this run finishes launching.
    try {
      // ---- build slot (opt-in concurrency limit) ----
      //
      // AFTER single-flight dedup: a run that installed another workspace's
      // artifact never reached here, so it never consumed a slot. A full slate
      // WAITS, with the same pid-liveness a dead builder frees within a poll.
      if (limits.maxBuilds) {
        try {
          buildSlot = await acquireSlot({ max: limits.maxBuilds, root, logFile: buildLog, out });
        } catch (err) {
          phase(
            'build',
            chalk.yellow(`could not take a build slot: ${(err as Error)?.message || err}; building anyway`),
          );
        }
      }

      if (needsPrebuildFor(root, PLATFORM, isExpo)) {
        const pre: PrebuildResultLike = await prebuild(root, PLATFORM, writer, { isExpo });
        if (pre.failed) {
          return fail(pre.code!, pre.reason, pre.remedy, {
            lastBuildStatus: true,
            lines: tail(pre.lastLines),
            logPath: displayPath(root, buildLog),
          });
        }
        phase('prebuild', `android/ generated (${formatDuration(pre.durationMs)})`);
        // The package name may only exist once the manifest has been written.
        androidPackage = androidPackage || detectAndroidPackage(root);
        record.bundleId = androidPackage;
      }

      // buildAndroid returns either the success shape or the failure shape (see
      // engine/gradle.ts); read through the flat, all-optional local interface
      // rather than the discriminated union so `built.failed` narrows the way
      // the rest of this file's defensive checks expect.
      const built: BuildAndroidResultLike = await build({ root, logWriter: writer });
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
        if ((built.truncated ?? 0) > 0) extracted.push(`... and ${built.truncated} more diagnostic(s) in the log`);
        return fail(
          built.code!,
          built.reason,
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
          },
        );
      }
      // apkPath is provably set here: this branch only runs after a build that
      // did not report `failed`, and buildAndroid's success shape always carries one.
      apkPath = built.apkPath ?? null;
      phase('build', `${basename(apkPath!)} (${formatDuration(built.durationMs)})`);

      // `overwrite` only when --no-build-cache asked for a fresh build: the entry
      // that is there is the one this run was told not to trust, and leaving it
      // would mean the next run trusts it again.
      try {
        storeCached(PLATFORM, cacheKey, apkPath!, { overwrite: !useBuildCache });
      } catch (err) {
        // A cache that cannot be written still builds; it just costs the next
        // workspace a rebuild. Never a reason to fail a run that succeeded.
        phase('cache', chalk.yellow(`could not store the build: ${(err as Error)?.message || err}`));
      }

      // STARTED here, collected after the launch, so the upload overlaps the
      // install instead of being added to it. Nothing in this run depends on it.
      if (remote) {
        uploadPending = uploadRemoteBuild({
          logWriter: writer,
          provider: remote.provider,
          platform: PLATFORM,
          projectRoot: root,
          fingerprintHash: hash,
          buildPath: apkPath!,
        });
      }
    } finally {
      releaseHeldLock();
      releaseHeldSlot();
    }
  }
  record.appPath = apkPath;

  // ---- install --------------------------------------------------------
  // serial and apkPath are provably set by this point: booted.failed already
  // returned, and apkPath is set by either the cache branch or a build that
  // did not report `failed`.
  const installStarted = now();
  const installed: InstallResultLike = install({ serial: serial!, apkPath: apkPath! });
  if (installed.failed) {
    return fail(
      installed.code || INSTALL_FAILED,
      installed.reason,
      `Check that ${serial} is still connected (\`adb devices\`) and has room for the APK.`,
      { lastBuildStatus: true },
    );
  }
  phase(
    'install',
    `${record.cacheHit ? `from ${record.cacheHit} cache` : basename(apkPath!)} (${formatDuration(now() - installStarted)})`,
  );

  // ---- launch (Contract 6) ---------------------------------------------
  // Project files first, then the APK itself: on a cache hit no prebuild ran,
  // so a managed app can have no android/ dir and no android.package in its
  // config -- but the installed artifact always knows its own package.
  androidPackage = androidPackage || detectAndroidPackage(root) || apkPackage(dumpApkManifest(apkPath));
  // Persist the resolved package like ios persists bundleId: the config
  // detect at command start is empty on a managed app with no android/ dir,
  // which left `status` showing `app: ?` after a successful build.
  if (androidPackage) upsertProject(root, { androidPackage });
  record.bundleId = androidPackage;
  if (!androidPackage) {
    return fail(
      LAUNCH_FAILED,
      "Could not determine this app's Android package name, so there is nothing to launch.",
      'Set `expo.android.package` in app.json / app.config.js, or `namespace` in android/app/build.gradle.',
      { lastBuildStatus: true },
    );
  }
  // The scheme comes from the APK that was just installed, for the reason the
  // iOS command gives: an app.json is not the truth on a project with a
  // dynamic config, and the artifact is in hand.
  const scheme = resolveDevClientScheme(root, apkPath);
  const launchedAt = now();
  // launchAndroidApp returns one of four flat shapes (see engine/app-install.ts);
  // read through the local, all-optional interface rather than the union.
  const launched: LaunchResultLike = launch({
    serial: serial!,
    packageName: androidPackage,
    metroPort,
    devClientScheme: scheme,
  });
  if (launched.failed) {
    return fail(
      launched.code || LAUNCH_FAILED,
      launched.reason,
      `Check the app installed correctly (\`adb -s ${serial} shell pm list packages ${androidPackage}\`).`,
      { lastBuildStatus: true },
    );
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
  // HOW it was launched, because on Android that is the difference between
  // the app and the dev-launcher's server screen: `deep-link` lands on this
  // workspace's bundle, `am-start` / `monkey` open whatever the launcher
  // activity shows.
  const launchMode = launched.mode === 'deep-link' ? 'expo-dev-client deep link' : launched.mode;
  phase('launch', launchMode ? `${androidPackage} (${launchMode})` : androidPackage);

  // Contract 6, reported. Both mechanisms ran before the launch and until now
  // NOTHING consumed their result: launchAndroidApp has always returned
  // debugHttpHost / debugHttpHostNote and every caller dropped them, so the
  // months in which the prefs write could not have worked (it emitted an
  // invalid script) looked exactly like the months in which it did.
  if (launched.debugHttpHost) {
    phase(
      'wired',
      `debug_http_host ${launched.debugHttpHost} + adb reverse tcp:${DEFAULT_METRO_PORT} -> tcp:${metroPort}`,
    );
  } else {
    phase(
      'wired',
      chalk.yellow(
        `adb reverse tcp:${DEFAULT_METRO_PORT} -> tcp:${metroPort}; ${launched.debugHttpHostNote || 'debug_http_host not written'}`,
      ),
    );
    writer.write({
      src: 'build',
      level: 'warn',
      event: 'debug_http_host_failed',
      msg: `debug_http_host was not written for ${androidPackage} on ${serial}: ${launched.debugHttpHostNote || 'unknown reason'}`,
    });
  }
  if (launched.devClientNote) {
    phase('wired', chalk.yellow(launched.devClientNote));
    writer.write({ src: 'build', level: 'warn', event: 'dev_client_link_failed', msg: launched.devClientNote });
  }

  // ---- the upload, collected (it has been running since the build) -----
  // uploadPending is only ever set inside `if (remote)` above, so remote is
  // provably non-null whenever there is something to collect here; `?.` is
  // just belt-and-braces for TS, which cannot see that cross-variable link.
  if (uploadPending) {
    const upload = await uploadPending;
    if (upload?.uploaded) {
      phase('cache', `uploaded (${remote?.name})`);
    } else if (upload?.timedOut) {
      abandonedRemote = true;
      phase(
        'cache',
        chalk.yellow(`${remote?.name} upload still running after ${formatDuration(UPLOAD_TIMEOUT_MS)}; not waiting`),
      );
    } else if (upload?.failed) {
      const authNote =
        remote?.name === 'eas' && isEasAuthFailureText(upload.failed)
          ? easAuthNote({ code: 'logged-out', reason: upload.failed, phase: 'upload' })
          : null;
      phase('cache', chalk.yellow(authNote || `${remote?.name} upload failed: ${upload.failed}`));
    }
  }

  // ---- Contract 4, then Contract 5 -------------------------------------
  //
  // lastBuild is written BEFORE the collector is spawned. Both writers
  // read-modify-write the same state.json, and the collector registers itself
  // within milliseconds of starting; writing ours first means its merge
  // carries lastBuild forward rather than racing it.
  persistLastBuild({ writeState, root, record, startedAt, durationMs: now() - started, status: 'ok', out });

  // The collector is attached BEFORE the launch verification below: that poll
  // can take 20 seconds, and those are the seconds whose logcat says why the
  // app did not load a bundle.
  const collectorPid = startCollector({ root, serial, packageName: androidPackage, spawn, kill, out });
  phase('logs', `${displayPath(root, logsDir)}${collectorPid ? ` (collector pid ${collectorPid})` : ''}`);

  // ---- proof, not assertion (see verifyLaunch in engine/app-install.js) ----
  //
  // `am start` returning 0 proves an activity was started. It does not prove
  // the app loaded a bundle from THIS workspace's Metro -- an expo-dev-client
  // app opens its DEVELOPMENT SERVERS picker instead, listing every other
  // workspace on the machine. A timeout leaves the exit code at 0 and reports
  // launched: 'unverified'.
  //
  // Skipped under --no-metro-check, for the reason given in commands/ios.js:
  // the gate was waived, so there is nothing to poll for. The fact still is
  // not `true`.
  // Read through a flat, all-optional local interface rather than
  // verifyLaunch's return union -- this file branches only on
  // `verified` / `skipped` / `waitedMs`.
  const verification: VerifyLaunchResultLike = metroCheck
    ? await verifyLaunched({ logsDir, since: launchedAt, mode: isExpo ? MODE_EXPO : MODE_BARE })
    : { verified: false, skipped: true };
  let launchState: boolean | string = true;
  if (verification?.verified) {
    phase('verify', `bundle requested from Metro port ${metroPort} (${formatDuration(verification.waitedMs ?? 0)})`);
  } else if (verification?.skipped) {
    launchState = LAUNCH_UNVERIFIED;
    phase('verify', 'skipped (--no-metro-check): the launch is reported as unverified');
  } else {
    launchState = LAUNCH_UNVERIFIED;
    phase('verify', chalk.yellow("UNVERIFIED: no bundle request reached this workspace's Metro"));
    for (const line of unverifiedLaunchLines({
      platform: PLATFORM,
      metroPort,
      waitedMs: verification?.waitedMs,
      bundleId: androidPackage,
      serial,
      devClientUrl: scheme ? androidDevClientUrl(scheme, metroPort) : null,
      mode: isExpo ? MODE_EXPO : MODE_BARE,
    }))
      phase('', chalk.yellow(line));
  }

  // The outcome in the timeline too, where `rn-iso logs` will find it.
  writer.write({
    src: 'build',
    level: launchState === LAUNCH_UNVERIFIED ? 'warn' : 'info',
    event: launchState === LAUNCH_UNVERIFIED ? 'launch_unverified' : 'launch_verified',
    msg:
      launchState === LAUNCH_UNVERIFIED
        ? `no bundle request from ${androidPackage} reached this workspace's Metro on port ${metroPort}`
        : `${androidPackage} fetched a bundle from this workspace's Metro on port ${metroPort}`,
  });

  const facts = androidFacts({
    serial,
    avdName: record.avdName,
    deviceName: record.deviceName,
    debugHttpHost: launched.debugHttpHost ?? null,
    debugHttpHostNote: launched.debugHttpHostNote ?? null,
    devClientUrl: launched.devClientUrl ?? null,
    fingerprint: hash,
    cacheHit: record.cacheHit,
    cacheSkipped: !useBuildCache,
    waitedForBuild,
    appPath: apkPath,
    bundleId: androidPackage,
    launched: launchState,
    logs: logsDir,
  });
  writer.close();

  if (json) {
    emit(JSON.stringify(facts));
  } else {
    const summary = `OK: ${androidPackage} launched on ${serial}, Metro port ${metroPort} (${cacheOutcome(record.cacheHit, remote?.name)})`;
    emit(launchState === LAUNCH_UNVERIFIED ? chalk.yellow(`${summary} -- launch UNVERIFIED`) : chalk.green(summary));
  }

  // Everything this command does is done. If a provider call was abandoned at
  // its bound, the child process it spawned may still be open and node will not
  // exit while it is -- an agent's `rn-iso android` would sit there long after
  // the app launched, waiting on a call whose result nothing reads.
  if (abandonedRemote) exitAfterFlush(0);
  return { ok: true, facts };
}

// --- helpers ---------------------------------------------------------------

// PURE. How the outcome line describes where the APK came from.
export function cacheOutcome(cacheHit: unknown, providerName: string | null = null): string {
  if (cacheHit === 'remote') return `cache hit from ${providerName || 'the remote cache'}`;
  if (cacheHit === 'local') return 'cache hit';
  return 'built';
}

function persistLastBuild({
  writeState,
  root,
  record,
  startedAt,
  durationMs,
  status,
  errorCode = null,
  out,
}: {
  writeState: typeof writeWorkspaceState;
  root: string;
  record: AndroidRecord;
  startedAt: string;
  durationMs: number;
  status: string;
  errorCode?: string | null;
  out: (line: string) => void;
}): Record<string, unknown> {
  const lastBuild = lastBuildRecord({ ...record, startedAt, durationMs, status, errorCode });
  try {
    // The MERGING writer the supervisor and the collector both use: it reads
    // state.json, spreads our key over it, and lands the result temp+rename.
    // Replacing the file instead would drop `supervisor` and `collectors`,
    // and `stop` reads both to know what to halt.
    writeState(root, { lastBuild });
  } catch (err) {
    out(phaseLine('state', chalk.yellow(`could not record lastBuild: ${(err as Error)?.message || err}`)));
  }
  return lastBuild;
}

function startCollector({
  root,
  serial,
  packageName,
  spawn,
  kill,
  out,
}: {
  root: string;
  serial?: string;
  packageName: string;
  spawn: (cmd: string, args: readonly string[], opts: Record<string, unknown>) => ChildProcess;
  kill: (pid: number, signal: NodeJS.Signals) => boolean;
  out: (line: string) => void;
}): number | null {
  killPreviousCollector(root, { kill });
  try {
    const child = spawn(
      process.execPath,
      [collectorEntry(), '--platform', PLATFORM, '--root', root, '--serial', serial!, '--package', packageName],
      {
        cwd: root,
        // detached + unref, exactly as `start` spawns the supervisor: the
        // collector outlives this command, and its own stdio is discarded
        // because everything it has to say goes into device.ndjson.
        detached: true,
        stdio: 'ignore',
        env: process.env,
      },
    );
    child?.unref?.();
    return child?.pid ?? null;
  } catch (err) {
    // A missing collector costs `logs --source device` and nothing else. The
    // app is installed and running; refusing the run over it would be a
    // strictly worse answer.
    out(phaseLine('logs', chalk.yellow(`could not start the device log collector: ${(err as Error)?.message || err}`)));
    return null;
  }
}

function tail(lines: unknown, n = FALLBACK_LINES): string[] {
  return (Array.isArray(lines) ? lines : []).slice(-n);
}
