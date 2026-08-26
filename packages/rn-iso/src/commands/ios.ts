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
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnEntry } from '../spawn-entry.ts';
import type { Command } from 'commander';
import { buildCacheKey, fingerprintProject, resolveBuild, storeBuild } from '../build-cache.ts';
import { getConcurrencyLimits, getProject, upsertProject, type ProjectRecord } from '../config.ts';
import {
  DEFAULT_METRO_PORT,
  LAUNCH_UNVERIFIED,
  devClientUrl,
  installIosApp,
  launchIosApp,
  unverifiedLaunchLines,
  verifyLaunch,
} from '../engine/app-install.ts';
import {
  acquireBuildLock,
  releaseBuildLock,
  waitForBuild,
  type BuildLockHandle,
  type WaitForBuildResult,
} from '../engine/build-lock.ts';
import { acquireBuildSlot, releaseBuildSlot, type BuildSlotHandle } from '../engine/build-slots.ts';
import { readPodState, podsAreStale, runPodInstall } from '../engine/deps.ts';
import { checkDeviceCapacity, ensureBooted, ensureOwnedDevice } from '../engine/device.ts';
import { type Diagnostic, describeDiagnostic } from '../engine/errors-xcode.ts';
import { needsPrebuild, runPrebuild } from '../engine/prebuild.ts';
import {
  RESOLVE_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
  cacheLevel,
  checkEasAuth,
  easAuthNote,
  exitAfterFlush,
  isEasAuthFailureText,
  loadProjectProvider,
  resolveRemote,
  uploadRemote,
  type LoadProjectProviderResult,
} from '../engine/remote-cache.ts';
import { buildIos, readBundleId } from '../engine/xcode.ts';
import { getExecutor } from '../exec.ts';
import type { CacheHitLevel, IosFacts } from '../types.ts';
import { NOT_OURS_FOREIGN_CWD, isPidAlive, resolveProjectMetro } from '../metro.ts';
import { createNdjsonWriter, type NdjsonWriter } from '../ndjson.ts';
import { workspaceLogsDir } from '../paths.ts';
import { detectBundleId, detectIsExpo, findProjectRoot, isPackageResolvable, projectShortcut } from '../project.ts';
import { resolveSettings, unknownSettingKeys } from '../settings.ts';
import { MODE_BARE, MODE_EXPO, readWorkspaceState, writeWorkspaceState } from '../supervisor/state.ts';
import { gitCommonDir, repoRoot } from '../worktree.ts';

export const PLATFORM = 'ios';

// --- local, flat shapes for engine results ---------------------------------
//
// The engine modules (engine/*, sim/*) are being typed by other agents
// concurrently and their exports may still be implicitly-typed. These
// interfaces describe only the shape THIS file reads off their results, all
// fields optional to match the defensive JS underneath.

interface DeviceLike {
  deviceName?: string | null;
  name?: string | null;
  avdName?: string | null;
}

interface PodStateLike {
  hasPodfile?: boolean;
  lockText?: unknown;
  manifestText?: unknown;
}

interface PodVerdictLike {
  stale?: boolean;
  reason?: string;
  noPods?: boolean;
}

interface MetroResolutionLike {
  metro?: { pid?: number } | null;
  kind?: string;
  notOurs?: string | null;
}

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

interface PodInstallResultLike {
  failed?: boolean;
  code?: string;
  reason?: string;
  remedy?: string;
  lastLines?: string[];
  durationMs?: number;
}

interface BuildIosResultLike {
  failed?: boolean;
  code?: string;
  durationMs?: number;
  diagnostics?: unknown[];
  truncated?: number;
  tail?: string[];
  exitCode?: number | null;
  appPath?: string;
  bundleId?: string;
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
}

interface VerifyLaunchResultLike {
  verified?: boolean;
  skipped?: boolean;
  waitedMs?: number;
}

interface IosCommandOptions {
  json?: boolean;
  metroCheck?: boolean;
  buildCache?: boolean;
}

interface WaitedForBuild {
  pid?: number | null;
  ms?: number;
}

interface FailArgs {
  code: string;
  message?: string | null;
  remedy?: string | null;
  lines?: string[];
  logPath?: string | null;
  build?: BuildFailureFields | null;
}

interface BuildFailureFields {
  fingerprint?: string | null;
  cacheKey?: string | null;
  cacheHit?: boolean | string;
  cacheSkipped?: boolean;
  appPath?: string | null;
  bundleId?: string | null;
}

// The build log for this platform, merged into the timeline by `logs`.
export function buildLogFile(root: string): string {
  return join(workspaceLogsDir(root), `build-${PLATFORM}.ndjson`);
}

// The collector's own stdio. It writes its records to device.ndjson itself;
// this file only ever catches the few lines it prints when it cannot do that
// (a registration it could not write, a stream that would not start). NOT
// .ndjson, so the k-way merge in logs-query never tries to parse it.
export function collectorLogFile(root: string): string {
  return join(workspaceLogsDir(root), `collector-${PLATFORM}.log`);
}

export function collectorEntry() {
  return spawnEntry('collector-run');
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- pure formatting ------------------------------------------------------

// "18s", "2m41s". Sub-minute durations stay in seconds because that is how
// long a pod install or a cached install actually takes to read.
export function formatDuration(ms: unknown): string {
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
export function shortHash(hash: unknown): string {
  const text = String(hash ?? '');
  return text.length > 6 ? `${text.slice(0, 6)}..` : text;
}

export function shortUdid(udid: unknown): string {
  const text = String(udid ?? '');
  return text.length > 4 ? `${text.slice(0, 4)}..` : text;
}

export function deviceLabel(device: DeviceLike | null | undefined, udid: unknown): string {
  const name = device?.deviceName || device?.name || null;
  return name ? `${name} (${shortUdid(udid)})` : shortUdid(udid);
}

// The phase-line column. One shape for every line, so the interesting half
// starts at the same column whatever happened.
export function phaseLine(name: unknown, text: string): string {
  return `${String(name).padEnd(11)} ${text}`;
}

// PURE. The name the iOS collector's log predicate matches: it filters on
// processImagePath, which ends in <ProductName>.app/<ProductName>. The
// collector falls back to the bundle id's last segment, and that fallback is
// WRONG whenever the product name differs from it (`com.acme.MyApp` for a
// product called `MyAppDev`), which is why the real name is derived from the
// .app path and passed explicitly.
export function appNameFromPath(appPath: unknown): string | null {
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
export function podAction(
  podState: PodStateLike | null | undefined,
  verdict: PodVerdictLike | null | undefined,
): { install: boolean; reason?: string } {
  if (verdict?.stale) return { install: true, reason: verdict.reason };
  if (verdict?.noPods && podState?.hasPodfile) {
    return { install: true, reason: 'ios/Podfile exists but no pods are installed' };
  }
  return { install: false };
}

// The dev-client scheme, read from THE BUILT APP first.
//
// This used to read app.json and nothing else, and app.json is the wrong
// source: a project with a dynamic config (app.config.ts) has no scheme there
// at all, so the openurl was skipped and the app opened straight into
// expo-dev-launcher's DEVELOPMENT SERVERS picker, listing every other
// workspace's Metro. The BUILT .app is the truth for both kinds of project --
// whatever the config pipeline computed, or whatever a committed native
// project declares, ends up as CFBundleURLSchemes in the bundle's Info.plist
// (verified on a repo with a dynamic config: ios/<Target>/Info.plist carries
// io.tlon.groups even though no app.json exists). The path is in hand at
// install time, so there is nothing to guess.
//
// app.json stays as the fallback for the case where the plist cannot be read.
// Note what is NOT claimed any more: the old comment said a plain launch
// "works for every RN app". It does not -- for a dev-client app a plain
// launch is precisely the picker.
//
// expo-dev-client is still required: the deep link is handled by
// expo-dev-launcher, so an app without it would get an openurl no process
// answers. `resolvable` as well as `in dependencies`, because a monorepo
// hoists it out of the app's own node_modules.
export function devClientScheme(
  root: string,
  appPath: string | null = null,
  { exec = null }: { exec?: import('../exec.ts').Executor | null } = {},
): string | undefined {
  if (!hasDevClient(root)) return undefined;
  const fromBundle = pickDevClientScheme(readBundleSchemes(appPath, { exec }));
  if (fromBundle) return fromBundle;
  const app = readJson(join(root, 'app.json'));
  const raw = app?.expo?.scheme ?? app?.scheme ?? null;
  const scheme = Array.isArray(raw) ? raw.find((s) => typeof s === 'string' && s.trim() !== '') : raw;
  if (typeof scheme !== 'string' || scheme.trim() === '') return undefined;
  return scheme.trim();
}

// PURE. CFBundleURLTypes[].CFBundleURLSchemes, flattened -- the same read
// @expo/config-plugins does (ios/Scheme.ts, getSchemesFromPlist).
export function schemesFromInfoPlist(plist: unknown): string[] {
  const types = (plist as { CFBundleURLTypes?: unknown })?.CFBundleURLTypes;
  if (!Array.isArray(types)) return [];
  const out: string[] = [];
  for (const type of types) {
    const schemes = (type as { CFBundleURLSchemes?: unknown })?.CFBundleURLSchemes;
    if (Array.isArray(schemes)) out.push(...schemes.filter((s) => typeof s === 'string' && s.trim() !== ''));
  }
  return out;
}

// The built app's Info.plist, through plutil (a built bundle's plist is
// BINARY, so it cannot simply be read as text). Empty on any failure: the
// app.json fallback is behind this, and a missing scheme is survivable where a
// wrong one is not.
export function readBundleSchemes(
  appPath: unknown,
  { exec = null }: { exec?: import('../exec.ts').Executor | null } = {},
): string[] {
  if (typeof appPath !== 'string' || appPath.trim() === '') return [];
  const e = exec || getExecutor();
  let out;
  try {
    out = e.runFile('plutil', ['-convert', 'json', '-o', '-', join(appPath, 'Info.plist')]);
  } catch {
    return [];
  }
  try {
    return schemesFromInfoPlist(JSON.parse(String(out)));
  } catch {
    return [];
  }
}

// Schemes that belong to a third-party SDK rather than to the app. An app
// declares them so an OAuth callback comes home, and they are NOT safe to
// open a dev client with: `fb<digits>` is also declared by the Facebook app,
// so which app iOS routes it to depends on what else is installed.
//
// This is the one place rn-iso goes further than Expo's own CLI, which sorts
// by length and takes the longest (src/utils/scheme.ts,
// resolveExpoOrLongestScheme). On a real repo the longest is
// `com.googleusercontent.apps.869857856617-...` and the app's own scheme is
// `th3rdwave` -- the shortest of the three.
const THIRD_PARTY_SCHEME =
  /^(?:fb\d+|com\.googleusercontent\.apps\.|msauth\.|msauthv2|twitterkit-|db-[a-z0-9]+$|spotify|snapchat|com\.facebook)/i;

// PURE. Which of an app's schemes to deep-link with.
//
// `exp+<slug>` first, exactly as Expo's CLI does: expo-dev-client adds it for
// this purpose, so when it is present it is unambiguously the right one.
// Otherwise the app's own schemes, third-party callbacks dropped, longest
// first (Expo's tie-break: longer is likelier to be unique to this app).
export function pickDevClientScheme(schemes: unknown): string | null {
  const all = (Array.isArray(schemes) ? schemes : [])
    .filter((s) => typeof s === 'string' && s.trim() !== '')
    .map((s) => s.trim())
    .filter((s) => !/^(?:https?|mailto|tel|sms|itms(?:-apps)?)$/i.test(s));
  const expo = all.filter((s) => s.startsWith('exp+'));
  const pool = expo.length ? expo : all.filter((s) => !THIRD_PARTY_SCHEME.test(s));
  const sorted = [...pool].sort((a, b) => b.length - a.length);
  return sorted[0] ?? null;
}

function hasDevClient(root: string): boolean {
  const pkg = readJson(join(root, 'package.json'));
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if ('expo-dev-client' in deps) return true;
  // Hoisted: a monorepo installs it at the workspace root, where the app's
  // own package.json is still the one that declares it -- but not always, and
  // Node resolution is the question that actually matters.
  return isPackageResolvable(root, 'expo-dev-client');
}

// any: JSON.parse of an arbitrary project file (package.json / app.json), shape unknown until read.
function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

// --- the Metro gate's retry (the start -> ios race) ------------------------
//
// `rn-iso start` returns when the server is LISTENING. A bare in-process Metro
// then crawls the project's file map, and on a monorepo that blocks its event
// loop for ~20 seconds -- during which the socket accepts and /status never
// answers. The single 2s probe `ios` used to make timed out inside that
// window and the gate refused with "run rn-iso start first", about a
// supervisor `start` itself had just spawned two seconds earlier.
//
// So the resolve is retried. The backoff spans the crawl without adding a
// pause to the ordinary case, where the first attempt answers immediately.
export const GATE_RETRY_DELAYS_MS = [3000, 7000];

// PURE. Whether waiting could change this answer. A port held by a bundler
// running OUTSIDE this project will not become ours; anything else (nothing
// listening yet, or listening and not answering /status) is exactly what an
// indexing Metro looks like.
export function gateShouldRetry(resolution: MetroResolutionLike | null | undefined): boolean {
  if (resolution?.metro) return false;
  return resolution?.kind !== NOT_OURS_FOREIGN_CWD;
}

// Resolve, retrying while the answer could still change. Returns the LAST
// resolution, so the refusal describes what was actually seen.
export async function resolveMetroWithRetry(
  resolve: (port: number, root: string) => Promise<MetroResolutionLike>,
  port: number,
  root: string,
  {
    delays = GATE_RETRY_DELAYS_MS,
    sleep: wait = sleep,
    onRetry = (_info: { attempt: number; delayMs: number; resolution: MetroResolutionLike }) => {},
  }: {
    delays?: number[];
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (info: { attempt: number; delayMs: number; resolution: MetroResolutionLike }) => void;
  } = {},
): Promise<MetroResolutionLike> {
  let resolution = await resolve(port, root);
  for (let i = 0; i < delays.length && gateShouldRetry(resolution); i++) {
    onRetry({ attempt: i + 1, delayMs: delays[i], resolution });
    await wait(delays[i]);
    resolution = await resolve(port, root);
  }
  return resolution;
}

// PURE. The refusal text, which has to separate two cases an agent acts on
// differently: a supervisor record for THIS port (retry, or raise --wait --
// the dev server exists and is probably still indexing) from a genuinely
// foreign or absent listener (start one).
export function noMetroMessage({
  port,
  resolution,
  supervisor,
  supervisorAlive,
}: {
  port: number;
  resolution?: MetroResolutionLike | null;
  supervisor?: SupervisorLike | null;
  supervisorAlive?: boolean;
}): string {
  const foreign = resolution?.notOurs;
  if (supervisor && supervisor.port === port && supervisorAlive) {
    const mode = supervisor.mode ? `${supervisor.mode} ` : '';
    return (
      `A supervisor record exists for port ${port} (pid ${supervisor.pid}, ${mode}dev server) but it did not verify as this workspace's Metro` +
      `${foreign ? `: ${foreign}` : ' -- nothing answered /status'}.` +
      ' Metro may still be indexing this project (a monorepo file-map crawl blocks its event loop for ~20s after the port opens).'
    );
  }
  if (foreign) return `Port ${port} is in use but is NOT this workspace's dev server: ${foreign}.`;
  return `Nothing is serving this workspace's dev server on port ${port}.`;
}

// PURE. The remedy that goes with it.
export function noMetroRemedy({
  port,
  supervisor,
  supervisorAlive,
}: {
  port: number;
  supervisor?: SupervisorLike | null;
  supervisorAlive?: boolean;
}): string {
  if (supervisor && supervisor.port === port && supervisorAlive) {
    return 'Re-run `rn-iso ios` in a few seconds, or give the dev server longer to verify with `rn-iso start --wait <seconds>`.';
  }
  return 'Run `rn-iso start` first, or pass --no-metro-check.';
}

// `<root>/.rn-iso` must be git-ignored before this command writes a build log,
// a state file or a derived-data tree into it. Imported dynamically and
// tolerantly: it is one repo-hygiene write, and a build must not fail because
// of it.
export async function ensureWorkspaceIgnoredSafely(
  root: string,
  { note = (_line: string) => {} }: { note?: (line: string) => void } = {},
): Promise<unknown> {
  try {
    const mod = await import('../engine/workspace.ts');
    return mod.ensureWorkspaceIgnored?.(root) ?? null;
  } catch (err) {
    note(
      chalk.dim(
        `Could not ensure ${root}/.gitignore lists the rn-iso workspace directory: ${(err as Error)?.message || err}`,
      ),
    );
    return null;
  }
}

// PURE. Contract 4: state.json.lastBuild.
export function lastBuildRecord({
  fingerprint = null,
  cacheKey = null,
  cacheHit = false,
  cacheSkipped = false,
  durationMs = 0,
  appPath = null,
  bundleId = null,
  startedAt,
  status,
  errorCode = null,
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
}): Record<string, unknown> {
  const record: Record<string, unknown> = {
    platform: PLATFORM,
    fingerprint,
    cacheKey,
    cacheHit: cacheLevel(cacheHit),
    cacheSkipped: Boolean(cacheSkipped),
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
//
// `launched` is THREE-valued on purpose: true when a bundle request from this
// workspace's Metro was observed after the launch, and the string
// 'unverified' when it was not. It was an unconditional `true` while the app
// was demonstrably sitting on the dev-launcher's server picker having loaded
// nothing -- a fact an agent branches on must not be a constant.
export function iosFacts({
  udid,
  deviceName,
  fingerprint,
  cacheKey,
  cacheHit,
  cacheSkipped = false,
  waitedForBuild = null,
  appPath,
  bundleId,
  metroPort,
  logsDir,
  durationMs,
  launched = true,
}: {
  udid: string;
  deviceName?: string | null;
  fingerprint?: string | null;
  cacheKey?: string | null;
  cacheHit?: boolean | string;
  cacheSkipped?: boolean;
  waitedForBuild?: WaitedForBuild | null;
  appPath?: string | null;
  bundleId?: string | null;
  metroPort?: number | null;
  logsDir?: string;
  durationMs?: number;
  launched?: boolean | string;
}): IosFacts {
  return {
    platform: PLATFORM,
    udid,
    deviceName: deviceName ?? null,
    fingerprint,
    cacheKey,
    // 'local' | 'remote' | false -- see cacheLevel.
    cacheHit: cacheLevel(cacheHit),
    // true only when --no-build-cache was passed: "nothing was looked up",
    // which is a different fact from "nothing was found".
    cacheSkipped: Boolean(cacheSkipped),
    // { pid, ms } when this run did not compile because ANOTHER workspace was
    // already compiling the same fingerprint and it waited for that artifact;
    // null when nothing was waited for. cacheHit is 'local' either way -- the
    // artifact did come out of the local cache -- so this is the only thing
    // that distinguishes "the cache already had it" (free) from "the cache
    // had it 12 minutes later" (a wait that was still cheaper than a second
    // compile). See engine/build-lock.js.
    waitedForBuild: waitedForBuild ? { pid: waitedForBuild.pid ?? null, ms: waitedForBuild.ms ?? 0 } : null,
    appPath,
    bundleId,
    launched: launched === LAUNCH_UNVERIFIED ? LAUNCH_UNVERIFIED : Boolean(launched),
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
export function writeLastBuild(
  root: string,
  record: Record<string, unknown>,
  { write = writeWorkspaceState }: { write?: typeof writeWorkspaceState } = {},
): Record<string, unknown> {
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
interface ReplaceCollectorArgs {
  root: string;
  udid: string;
  bundleId: string;
  appName?: string | null;
  spawn?: (cmd: string, args: readonly string[], opts: Record<string, unknown>) => ChildProcess;
  kill?: (pid: number, signal: NodeJS.Signals) => boolean;
  alive?: (pid: number) => boolean;
  readState?: typeof readWorkspaceState;
  waitMs?: number;
  note?: (line: string) => void;
}

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
  note = (_line: string) => {},
}: ReplaceCollectorArgs): Promise<{ killed: number | null; pid: number | null }> {
  const previous = (readState(root)?.collectors as Record<string, { pid?: number }> | undefined)?.[PLATFORM] || null;
  const previousPid = Number(previous?.pid) || null;
  let killed: number | null = null;

  if (previousPid) {
    try {
      kill(previousPid, 'SIGTERM');
      killed = previousPid;
    } catch (err) {
      // ESRCH is the ordinary case: the collector died with the app, or with
      // the sim, and only its record outlived it. Anything else is worth a
      // line, because it means a process we could not stop is still holding
      // the device's log stream.
      if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') {
        note(
          chalk.yellow(
            `Could not stop the previous ${PLATFORM} log collector (pid ${previousPid}): ${(err as Error)?.message || err}`,
          ),
        );
      }
    }
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && alive(previousPid)) {
      await sleep(COLLECTOR_POLL_MS);
    }
  }

  const args = [collectorEntry(), '--platform', PLATFORM, '--root', root, '--udid', udid, '--bundle', bundleId];
  // The real product name, from the .app path. The collector's own fallback
  // (the bundle id's last segment) matches nothing whenever the two differ,
  // and the symptom is an empty device.ndjson rather than an error.
  if (appName) args.push('--app-name', appName);

  let stdio: 'ignore' | (number | 'ignore')[] = 'ignore';
  try {
    mkdirSync(workspaceLogsDir(root), { recursive: true });
    const fd = openSync(collectorLogFile(root), 'a');
    stdio = ['ignore', fd, fd];
  } catch {
    // Without the file the collector is silent, which is survivable; without
    // the collector the timeline has no device lines at all, which is what we
    // are here to avoid.
  }

  let child: ChildProcess | undefined;
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
    note(chalk.yellow(`Could not start the ${PLATFORM} log collector: ${(err as Error)?.message || err}`));
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
  checkDeviceCapacity,
  ensureOwnedDevice,
  ensureBooted,
  resolveProjectMetro,
  resolveMetroWithRetry,
  readWorkspaceState,
  isPidAlive,
  getConcurrencyLimits,
  fingerprintProject,
  resolveBuild,
  storeBuild,
  acquireBuildLock,
  releaseBuildLock,
  waitForBuild,
  acquireBuildSlot,
  releaseBuildSlot,
  loadProjectProvider,
  checkEasAuth,
  resolveRemote,
  uploadRemote,
  needsPrebuild,
  runPrebuild,
  readPodState,
  podsAreStale,
  runPodInstall,
  buildIos,
  readBundleId,
  installIosApp,
  launchIosApp,
  verifyLaunch,
  ensureWorkspaceIgnored: ensureWorkspaceIgnoredSafely,
  replaceCollector,
  writeWorkspaceState,
  createWriter: createNdjsonWriter,
  now: () => Date.now(),
};

export default function iosCommand(program: Command): void {
  registerIos(program);
}

// `deps` is the test seam. Every engine call goes through it, so the tests
// below assert the ORDER of a build (metro gate, then fingerprint, then
// prebuild, pods, build, store) without a simulator or an xcodebuild.
export function registerIos(program: Command, deps: Partial<typeof DEFAULT_DEPS> = {}): void {
  program
    .command('ios')
    .description(
      "Build (or restore from the fingerprint cache), install and launch this workspace's app on its owned " +
        'simulator, wired to the reserved Metro port. Requires a running dev server (`rn-iso start`).',
    )
    .option('--json', 'Emit the facts as a single JSON line on stdout; every other line goes to stderr')
    .option('--no-metro-check', 'Skip the "is this workspace\'s dev server running?" gate and build anyway')
    .option(
      '--no-build-cache',
      "Build fresh, ignoring cached artifacts (local and the project's build-cache provider); the fresh build still replaces the cache entry",
    )
    .action(async (opts: IosCommandOptions) => {
      await runIos(opts, deps);
    });
}

export async function runIos(
  opts: IosCommandOptions = {},
  overrides: Partial<typeof DEFAULT_DEPS> = {},
): Promise<IosFacts | null> {
  // Annotated explicitly: spreading a Partial<> over the full DEFAULT_DEPS
  // would otherwise let TS infer some properties as possibly-undefined, even
  // though every key is always present (DEFAULT_DEPS supplies every one).
  const d: typeof DEFAULT_DEPS = { ...DEFAULT_DEPS, ...overrides };
  const json = Boolean(opts.json);
  // commander's --no-metro-check leaves metroCheck true by default.
  const metroCheck = opts.metroCheck !== false;
  // Same for --no-build-cache. It turns off every LOOKUP -- the local cache and
  // the project's provider both -- and nothing else: the fresh build is still
  // stored (over the entry that was there, see storeBuild's `overwrite`) and
  // still uploaded. "Do not trust what is cached" is the request; "do not share
  // what I built" is a different one nobody made.
  const useBuildCache = opts.buildCache !== false;

  // Phase lines are progress, and progress is stderr in BOTH modes: stdout
  // carries one line, and which line it is is the only difference --json
  // makes.
  const phase = (name: unknown, text: string) => console.error(phaseLine(name, text));
  const note = (line: string) => console.error(line);

  const started = d.now();
  const startedAt = new Date(started).toISOString();
  const elapsed = () => d.now() - started;

  const root = d.findProjectRoot(process.cwd());
  if (!root) {
    note(chalk.red('Not in a React Native project (no package.json found).'));
    process.exit(1);
    return null;
  }

  // Before ANY write into <root>/.rn-iso -- the build log below, the state
  // file, the derived-data tree -- make sure git ignores the directory.
  await d.ensureWorkspaceIgnored(root, { note });

  const logsDir = workspaceLogsDir(root);
  const logFile = buildLogFile(root);
  // `= null as NdjsonWriter | null` rather than `: NdjsonWriter | null = null`:
  // the latter lets TS narrow the DECLARED type itself down to the literal
  // `null`, which then makes every later `writer?.close()` resolve to `never`
  // instead of `NdjsonWriter` (a known quirk of narrowing a `let` initialized
  // with a bare `null` literal even under an explicit union annotation).
  let writer = null as NdjsonWriter | null;
  // Opened lazily by createNdjsonWriter's first write, so a run that fails at
  // the Metro gate leaves no empty log behind.
  const logWriter = () => (writer ||= d.createWriter(logFile));

  // Every failure exits the same way: the diagnostic, the remedy if there is
  // one, the machine-readable code, and -- once there is a build attempt to
  // describe -- a Contract-4 record saying the last build failed.
  // The build lock, when this run is the one compiling (engine/build-lock.js).
  //
  // Declared up here, above `fail`, because releasing it is not something a
  // `finally` around the build can be trusted with on its own: `fail` ends in
  // process.exit, and process.exit does not unwind the stack, so a finally
  // block below it never runs. Every exit from the build therefore goes
  // through this function -- the finally for a success or a throw, `fail`
  // itself for a refusal. A failed build that kept its lock would leave every
  // other workspace on the fingerprint waiting for an artifact nobody is
  // making.
  let buildLock: BuildLockHandle | null = null;
  const releaseLock = () => {
    if (!buildLock) return;
    const held = buildLock;
    buildLock = null;
    try {
      d.releaseBuildLock(held);
    } catch (e) {
      note(chalk.dim(`Could not release the build lock at ${held.path}: ${(e as Error)?.message || e}`));
    }
  };

  // The build SLOT (engine/build-slots.js), when concurrency.maxBuilds is set
  // and this run is one that actually compiles. Released the same
  // process.exit-safe way the build lock is: every exit from the build goes
  // through `fail` (which releases both) or the finally below.
  let buildSlot: BuildSlotHandle | null = null;
  const releaseSlot = () => {
    if (!buildSlot) return;
    const held = buildSlot;
    buildSlot = null;
    try {
      d.releaseBuildSlot(held);
    } catch (e) {
      note(chalk.dim(`Could not release the build slot: ${(e as Error)?.message || e}`));
    }
  };

  const fail = ({ code, message, remedy = null, lines = [], logPath = null, build = null }: FailArgs): null => {
    releaseLock();
    releaseSlot();
    if (message) note(chalk.red(phaseLine('error', message)));
    for (const line of lines) note(chalk.dim(phaseLine('', line)));
    if (remedy) note(chalk.dim(phaseLine('remedy', remedy)));
    // `logPath` rather than a note() at each call site, so the log line lands
    // in the same place relative to the remedy that `android` puts it.
    if (logPath) note(chalk.dim(phaseLine('log', logPath)));
    if (build)
      writeLastBuild(
        root,
        lastBuildRecord({ ...build, startedAt, status: 'failed', errorCode: code, durationMs: elapsed() }),
        { write: d.writeWorkspaceState },
      );
    note(chalk.red(phaseLine('failed', code)));
    // --json is a promise about stdout in BOTH directions: exactly one
    // parseable line whatever happened. Without this, a failed `ios --json`
    // put NOTHING on stdout, so a caller that captured it with `$(...)` had an
    // empty string to parse and no machine-readable way to tell a refusal from
    // a crash. The shape is `android`'s, deliberately: one contract, two
    // commands -- and so is the rule that BOTH fields are populated. The
    // build-failure path used to hardcode `message: null`, which made this the
    // one failure an unattended caller could report only as a bare code; see
    // xcodeFailureReport for what fills it now.
    if (json) console.log(JSON.stringify({ code, message: message ?? null, remedy: remedy ?? null }));
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
  d.upsertProject(root, { bundleId: d.detectBundleId(root) ?? undefined, isExpo });
  const proj = d.getProject(root);
  const label = d.projectShortcut(root, proj);

  // ---- concurrency: opt-in, unlimited by default ----
  const limits = d.getConcurrencyLimits();

  // The device cap is checked BEFORE ensureOwnedDevice, which creates and boots
  // a sim: a refusal has to fire before that, not after. It never refuses a
  // workspace whose own sim is already booted (re-running `ios` is idempotent),
  // only a NEW device that would push the machine over concurrency.maxDevices.
  const capacity = d.checkDeviceCapacity({
    platform: PLATFORM,
    project: proj,
    max: limits.maxDevices,
  });
  if (capacity) return fail(capacity);

  // device.ts's note/out params default to a 0-arg no-op, so TS infers their
  // parameter type as `() => void` even though the real implementation calls
  // them with a line of text. This adapter satisfies that (too-narrow)
  // inferred type while still forwarding the text through.
  const noteAny = (...args: unknown[]) => note(String(args[0] ?? ''));

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
      note: noteAny,
      out: noteAny,
    });
  } catch (e) {
    return fail({
      code: 'RN_ISO_NO_DEVICE',
      message: `Could not ensure an owned iOS simulator: ${(e as Error)?.message || e}`,
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
  let metroPort = proj?.metroPort ?? null;
  if (metroCheck) {
    if (!metroPort) {
      return fail({
        code: 'RN_ISO_NO_METRO',
        message: 'No Metro port is reserved for this workspace, so there is no dev server to build against.',
        remedy: 'Run `rn-iso start` first, or pass --no-metro-check.',
      });
    }
    // Retried, because `start` returns at listening and a monorepo's file-map
    // crawl then blocks Metro's event loop for ~20s (see
    // resolveMetroWithRetry). ~10s of backoff, only when waiting could change
    // the answer.
    const resolution = await d.resolveMetroWithRetry(d.resolveProjectMetro, metroPort, root, {
      onRetry: ({ delayMs }) =>
        note(
          chalk.dim(
            phaseLine(
              'metro',
              `port ${metroPort} did not verify yet; retrying in ${Math.round(delayMs / 1000)}s (Metro may still be indexing)`,
            ),
          ),
        ),
    });
    if (!resolution?.metro) {
      const supervisor = (d.readWorkspaceState(root)?.supervisor ?? null) as SupervisorLike | null;
      const supervisorAlive = Boolean(supervisor?.pid && d.isPidAlive(supervisor.pid));
      return fail({
        code: 'RN_ISO_NO_METRO',
        message: noMetroMessage({ port: metroPort, resolution, supervisor, supervisorAlive }),
        remedy: noMetroRemedy({ port: metroPort, supervisor, supervisorAlive }),
      });
    }
  } else if (!metroPort) {
    // --no-metro-check with no reservation: the app has to be told SOME
    // port, and 8081 is what an unconfigured debug build asks for anyway.
    metroPort = DEFAULT_METRO_PORT;
    note(chalk.yellow(`No Metro port is reserved for this workspace; wiring the app to ${metroPort}.`));
  }

  const booted = await d.ensureBooted({ platform: PLATFORM, device, out: noteAny });
  if (!booted?.ok) {
    return fail({
      code: 'RN_ISO_NO_DEVICE',
      message: booted?.reason || 'The owned simulator could not be booted.',
      remedy: 'Run `rn-iso ios` again to re-establish an owned simulator for this workspace.',
    });
  }
  // booted.ok just verified true, so ensureBooted's success shape always carries a udid.
  const udid = booted.udid!;
  phase('device', `${deviceLabel(device, udid)} booted`);

  // ---- fingerprint and cache ----
  let fingerprint;
  try {
    // Scoped to iOS: an unscoped hash folds android/ into the iOS key (and
    // vice versa), which is what kept `android` from ever hitting the shared
    // cache across worktrees. See src/build-cache.js.
    fingerprint = await d.fingerprintProject(root, { platform: PLATFORM });
  } catch (e) {
    fingerprint = null;
    note(chalk.dim(`Fingerprinting failed: ${(e as Error)?.message || e}`));
  }
  if (!fingerprint) {
    return fail({
      code: 'RN_ISO_NO_FINGERPRINT',
      message: `Could not fingerprint ${root}: @expo/fingerprint is not resolvable from the project or from rn-iso.`,
      remedy:
        'Install it in the project (`npm i -D @expo/fingerprint`) so builds can be cached and shared between worktrees.',
    });
  }
  // Debug / simulator defaults: the same key `build-cache` and the Expo
  // provider derive, so an entry stored here answers either of them.
  const cacheKey = buildCacheKey(PLATFORM, fingerprint, {});

  // ---- level one: this machine's shared cache ----
  // Instant, offline, and shared by every worktree on the machine. Always
  // asked first, and the only thing asked at all on a bare RN project.
  const cached = useBuildCache ? d.resolveBuild(PLATFORM, cacheKey) : null;
  let cacheHit: CacheHitLevel = cached ? 'local' : false;
  phase(
    'fingerprint',
    `${shortHash(fingerprint)} ${cached ? 'hit' : 'miss'}${useBuildCache ? '' : ' (--no-build-cache)'}`,
  );

  let appPath: string | null = cached;
  let bundleId: string | null = null;

  // ---- level two: the project's OWN Expo build-cache provider ----
  //
  // Only on a local miss, and only on an Expo project: the community CLI has
  // no provider concept, so a bare project has nothing configured and never
  // reaches the network (engine/remote-cache.js). The provider is loaded even
  // when --no-build-cache turned the LOOKUP off, because the build that
  // follows is still uploaded to it.
  let remote: LoadProjectProviderResult | null = null;
  // A resolve or an upload we stopped waiting for may still hold the child
  // process the provider spawned (eas-build-cache-provider shells out to
  // eas-cli), and node will not exit while it is open. See the end of this
  // function.
  let abandonedRemote = false;
  let uploadPending: Promise<RemoteUploadLike> | null = null;
  if (!appPath) {
    const loaded: LoadProjectProviderResult = await d.loadProjectProvider(root, { isExpo });
    if (loaded?.unavailable) {
      // ONE line. A provider that is configured and unusable is worth saying
      // once -- the alternative is a project that believes it has a remote
      // cache and rebuilds forever without ever being told why.
      note(chalk.yellow(phaseLine('cache', `provider not usable: ${loaded.unavailable}`)));
    } else if (loaded?.provider) {
      remote = loaded;
    }
    // The EAS provider is the one that cannot report its own failure: both of
    // eas-build-cache-provider's entry points catch everything `npx eas-cli`
    // throws and return null, so an expired session is served to this command
    // as a clean MISS, on every build, forever. One bounded `eas whoami`
    // (cached for the run) is what turns that silence into a line.
    //
    // A definitively logged-out machine skips the tier outright -- asking it
    // costs 30 seconds of npx and answers nothing -- and the run continues on
    // the local cache. Anything less than definitive (offline, no eas-cli, an
    // output this does not recognise) changes NOTHING: an unreachable API is
    // not a logged-out user, and a build must not brick on a plane.
    if (remote?.name === 'eas') {
      const auth = d.checkEasAuth({ projectRoot: root, owner: loaded?.owner || null });
      // easAuthNote's parameter interface is private to engine/remote-cache.ts and
      // narrower than EasAuthResult on a couple of fields (e.g. `account` allows
      // null here); Parameters<> reaches the real type without needing an export.
      const authNote = easAuthNote(auth as Parameters<typeof easAuthNote>[0]);
      if (authNote) note(chalk.yellow(phaseLine('cache', authNote)));
      // Wrong-account still consults the provider: whoami does not always
      // enumerate accounts, and access is the server's decision.
      if (auth?.code === 'logged-out') remote = null;
    }
  }

  if (remote && useBuildCache) {
    const hit = await d.resolveRemote({
      provider: remote.provider,
      platform: PLATFORM,
      projectRoot: root,
      fingerprintHash: fingerprint,
    });
    if (hit?.appPath) {
      // INTO the local cache on the way past: the download is paid once per
      // machine rather than once per worktree, and the next workspace to
      // fingerprint this commit hits level one.
      let stored = null;
      try {
        stored = d.storeBuild(PLATFORM, cacheKey, hit.appPath);
      } catch (e) {
        note(chalk.yellow(phaseLine('cache', `remote hit could not be stored locally: ${(e as Error)?.message || e}`)));
      }
      appPath = stored || hit.appPath;
      cacheHit = 'remote';
      phase('cache', `remote hit (${remote.name})${stored ? ' -> stored locally' : ''}`);
    } else if (hit?.timedOut) {
      abandonedRemote = true;
      note(
        chalk.yellow(
          phaseLine(
            'cache',
            `${remote.name} did not answer within ${formatDuration(RESOLVE_TIMEOUT_MS)}; building instead`,
          ),
        ),
      );
    } else if (hit?.failed) {
      // An auth failure the provider DID surface gets the same specific note
      // the pre-flight would have printed, rather than the generic one.
      const authNote =
        remote.name === 'eas' && isEasAuthFailureText(hit.failed)
          ? easAuthNote({ code: 'logged-out', reason: hit.failed })
          : null;
      note(
        chalk.yellow(
          phaseLine('cache', authNote || `${remote.name} could not be used: ${hit.failed}; building instead`),
        ),
      );
    } else {
      phase('cache', `remote miss (${remote.name})`);
    }
  }

  // ---- level three: another workspace that is ALREADY building this ----
  //
  // Both caches missed, so this run is about to spend ~19 minutes in
  // xcodebuild. The premise of this whole tool is that two more agents are
  // standing on the same commit -- and without this they each spend the same
  // 19 minutes producing the same .app, with three toolchains fighting for the
  // same cores. Exactly one of them compiles; the others wait for its artifact
  // and install it, which is the same install a second worktree gets for free
  // ten minutes later, only sooner.
  //
  // It is a THIRD cache level and not a mutex: the lock's only job is to
  // decide who compiles. Nothing waits on it, nothing is queued behind it, and
  // a builder that dies frees it by dying (engine/build-lock.js: staleness is
  // pid-liveness, because a 20-minute hold is normal here).
  //
  // --no-build-cache is outside all of it, in both directions: it asked for a
  // fresh compile, so it must not install someone else's artifact, and it must
  // not make anyone else wait on a build they did not ask for. Its
  // overwrite-store at the end is already safe beside a concurrent builder --
  // storeBuild renames a staging directory into place.
  let waitedForBuild: WaitedForBuild | null = null;
  if (!appPath && useBuildCache) {
    let attempt: BuildLockHandle | null = null;
    try {
      attempt = d.acquireBuildLock({ platform: PLATFORM, key: cacheKey, root, logFile });
    } catch (e) {
      // Same containment as the cache store and the provider: this is an
      // optimisation, and one that cannot run must never stop a build.
      note(
        chalk.yellow(
          phaseLine('build', `could not take the build lock: ${(e as Error)?.message || e}; building anyway`),
        ),
      );
    }

    if (attempt?.acquired) {
      buildLock = attempt;
    } else if (attempt?.held) {
      const held = attempt.held;
      const who = held.projectRoot || 'another workspace';
      phase(
        'build',
        `${who} is already building ${shortHash(fingerprint)} (pid ${held.pid})` +
          `${held.logFile ? ` -- tail ${held.logFile}` : ''}`,
      );

      let waited: WaitForBuildResult | null = null;
      try {
        waited = await d.waitForBuild({ platform: PLATFORM, key: cacheKey, out: note });
      } catch (e) {
        const err = e as Error & { code?: string; lockPath?: string };
        if (err?.code !== 'RN_ISO_BUILD_WAIT_TIMEOUT') throw e;
        return fail({
          code: 'RN_ISO_BUILD_WAIT_TIMEOUT',
          message: err.message,
          remedy: `Check pid ${held.pid}; if it is not really building, remove ${err.lockPath} and run \`rn-iso ios\` again.`,
          build: { fingerprint, cacheKey, cacheHit, cacheSkipped: !useBuildCache },
        });
      }

      if (waited?.hit) {
        // The artifact the other workspace stored. It IS a local cache hit --
        // the same entry any later run would resolve -- so cacheHit says
        // 'local'; waitedForBuild is what tells the caller it was not free.
        appPath = waited.hit ?? null;
        cacheHit = 'local';
        waitedForBuild = { pid: held.pid, ms: waited.waitedMs };
        phase('build', `waited ${formatDuration(waited.waitedMs)} for ${who}'s build -> installed from cache`);
      } else {
        // The builder is gone and stored nothing: it failed, or it was killed.
        // Take the lock OVER, so a third workspace waits on this run rather
        // than starting a third compile. If someone else took it first, build
        // without it -- one wait is a good bet, but queueing again after a
        // failure could repeat, and a redundant build is the cheaper failure.
        note(
          chalk.yellow(
            phaseLine('build', `${who}'s build ended without an artifact (${waited?.builderFailed}); building here`),
          ),
        );
        try {
          const takeover = d.acquireBuildLock({ platform: PLATFORM, key: cacheKey, root, logFile });
          if (takeover?.acquired) buildLock = takeover;
        } catch {
          /* contained the same way as the first attempt */
        }
      }
    }
  }

  const buildFailure = { fingerprint, cacheKey, cacheHit, cacheSkipped: !useBuildCache };

  if (appPath) {
    // A hit -- at either level -- skips prebuild, pods and xcodebuild
    // ENTIRELY: that is the whole point of the cache, and it is what makes a
    // second worktree install in seconds. The bundle id comes from the cached
    // .app's own Info.plist rather than from the project config: the binary is
    // the truth about what is being installed.
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
    // Everything from here to the store is what the lock covers, and the
    // `finally` is the whole reason it is a try: a build that fails, or one
    // that throws, must free its waiters immediately. It releases BEFORE the
    // install below, so a waiting workspace starts installing the moment the
    // artifact is in the cache rather than when this run finishes launching.
    try {
      // ---- build slot (opt-in concurrency limit) ----
      //
      // AFTER single-flight dedup: a run that installed another workspace's
      // artifact never reached here, so it never consumed a slot. This is the
      // one place a compile actually happens, so it is where the maxBuilds cap
      // applies. A full slate WAITS (the builder already holds the single-flight
      // lock, so waiters on this exact fingerprint keep waiting on it), with the
      // same pid-liveness a dead builder frees within a poll.
      if (limits.maxBuilds) {
        try {
          buildSlot = await d.acquireBuildSlot({ max: limits.maxBuilds, root, logFile, out: note });
        } catch (e) {
          // Same containment as the build lock: a slot system that cannot run
          // must never stop a build, only stop limiting it.
          note(
            chalk.yellow(
              phaseLine('build', `could not take a build slot: ${(e as Error)?.message || e}; building anyway`),
            ),
          );
        }
      }

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
      // buildIos returns either the success shape or the failure shape (see
      // engine/xcode.ts); read through the flat, all-optional local interface
      // rather than the discriminated union so `result?.failed` narrows the way
      // the rest of this file's defensive checks expect.
      const result: BuildIosResultLike = await d.buildIos({ root, udid, logWriter: logWriter() });
      if (result?.failed) {
        phase('build', `FAILED after ${formatDuration(result.durationMs)}`);
        printDiagnostics(note, result);
        const report = xcodeFailureReport(result, logFile);
        return fail({
          code: result.code || 'RN_ISO_BUILD_FAILED',
          message: report.message,
          remedy: report.remedy,
          logPath: logFile,
          build: buildFailure,
        });
      }
      phase('build', `ok (${formatDuration(result.durationMs)})`);
      appPath = result.appPath ?? null;
      bundleId = result.bundleId ?? null;

      // Storing is best-effort on purpose: the app is built and installable
      // either way, and a full disk must not turn a successful build into a
      // failed command.
      //
      // `overwrite` only when --no-build-cache asked for a fresh build: the
      // entry that is there is the one the run was told not to trust, and
      // leaving it would mean the next run trusts it again.
      try {
        // appPath is provably set here: this branch only runs after a build that
        // did not report `failed`, and buildIos's success shape always carries one.
        d.storeBuild(PLATFORM, cacheKey, appPath!, { overwrite: !useBuildCache });
      } catch (e) {
        note(chalk.yellow(`Could not store the build in the shared cache: ${(e as Error)?.message || e}`));
      }

      // The upload is STARTED here and collected after the launch, so it runs
      // beside the install rather than being added to it. Nothing about this run
      // depends on it.
      if (remote) {
        uploadPending = d.uploadRemote({
          provider: remote.provider,
          platform: PLATFORM,
          projectRoot: root,
          fingerprintHash: fingerprint,
          buildPath: appPath!,
        });
      }
    } finally {
      releaseLock();
      releaseSlot();
    }
  }

  // ---- install ----
  // appPath and bundleId are provably set by this point: the cache branch above
  // fails early when bundleId cannot be read, and the build branch's buildIos
  // success shape always carries both.
  const installed = d.installIosApp({ udid, appPath: appPath! });
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
  //
  // The scheme comes from the BUILT app, which is why appPath is passed: a
  // dev-client app launched without its deep link opens the dev-launcher's
  // server picker, and the picker lists every workspace on the machine.
  const scheme = d.devClientScheme(root, appPath);
  const launchedAt = d.now();
  const launched = d.launchIosApp({
    udid,
    bundleId: bundleId!,
    metroPort,
    devClientScheme: scheme,
  });
  if (launched?.failed) {
    return fail({
      code: launched.code || 'RN_ISO_LAUNCH_FAILED',
      message: launched.reason,
      remedy: `Run \`xcrun simctl launch --console ${udid} ${bundleId}\` to see what the app reports, and check ${logFile}.`,
      build: { ...buildFailure, appPath, bundleId },
    });
  }
  phase('launch', bundleId!);

  // The launch marker (Contract 1). `logs --errors` uses it to bound the
  // window: errors from the run BEFORE this launch are not this run's.
  logWriter().write({
    src: 'build',
    level: 'info',
    marker: true,
    event: 'launch',
    msg:
      `launched ${bundleId} on ${udid} against Metro port ${metroPort}` +
      (launched?.mode === 'openurl' ? ' (expo-dev-client)' : ''),
  });

  // ---- collector (Contract 5) ----
  //
  // BEFORE the launch verification below, not after: the poll can take 20
  // seconds, and those are exactly the seconds whose device log says why the
  // app did not load a bundle.
  await d.replaceCollector({
    root,
    udid,
    bundleId: bundleId!,
    appName: appNameFromPath(appPath),
    note,
  });

  // ---- proof, not assertion: did the app actually fetch a bundle from US? --
  //
  // See verifyLaunch in engine/app-install.js. A timeout is not a failure --
  // the exit code stays 0 -- but the FACT changes, and the warning names the
  // two things that produce it (a picker awaiting a tap, an iOS 26
  // confirmation alert in front of `simctl openurl`).
  //
  // Skipped under --no-metro-check: the gate that proves there is a dev server
  // to fetch from was waived, so there is nothing to poll for and no reason to
  // spend 20 seconds proving it. The fact still is not `true` -- nothing was
  // verified -- it is simply reported in one line instead of a warning block.
  // verifyLaunch is still untyped in engine/app-install.ts; read through the
  // flat, all-optional local interface rather than its inferred return union.
  const verification: VerifyLaunchResultLike = metroCheck
    ? await d.verifyLaunch({ logsDir, since: launchedAt, mode: isExpo ? MODE_EXPO : MODE_BARE })
    : { verified: false, skipped: true };
  let launchState: boolean | string = true;
  if (verification?.verified) {
    phase('verify', `bundle requested from Metro port ${metroPort} (${formatDuration(verification.waitedMs ?? 0)})`);
  } else if (verification?.skipped) {
    launchState = LAUNCH_UNVERIFIED;
    phase('verify', 'skipped (--no-metro-check): the launch is reported as unverified');
  } else {
    launchState = LAUNCH_UNVERIFIED;
    const lines = unverifiedLaunchLines({
      platform: PLATFORM,
      metroPort,
      waitedMs: verification?.waitedMs,
      bundleId,
      udid,
      devClientUrl: scheme ? devClientUrl(scheme, metroPort) : null,
      mode: isExpo ? MODE_EXPO : MODE_BARE,
    });
    phase('verify', chalk.yellow("UNVERIFIED: no bundle request reached this workspace's Metro"));
    for (const line of lines) note(chalk.yellow(phaseLine('', line)));
  }

  // The outcome, in the timeline as well as on stderr: `rn-iso logs` is where
  // an agent looks when the app is not behaving, and "the launch was never
  // verified" is the first thing it should find there.
  logWriter().write({
    src: 'build',
    level: launchState === LAUNCH_UNVERIFIED ? 'warn' : 'info',
    event: launchState === LAUNCH_UNVERIFIED ? 'launch_unverified' : 'launch_verified',
    msg:
      launchState === LAUNCH_UNVERIFIED
        ? `no bundle request from ${bundleId} reached this workspace's Metro on port ${metroPort}`
        : `${bundleId} fetched a bundle from this workspace's Metro on port ${metroPort}`,
  });

  // ---- the upload, collected (it has been running since the build) ----
  // uploadPending is only ever set inside `if (remote)` above, so remote is
  // provably non-null whenever there is something to collect here; `?.` is
  // just belt-and-braces for TS, which cannot see that cross-variable link.
  if (uploadPending) {
    const upload = await uploadPending;
    if (upload?.uploaded) {
      phase('cache', `uploaded (${remote?.name})`);
    } else if (upload?.timedOut) {
      abandonedRemote = true;
      note(
        chalk.yellow(
          phaseLine(
            'cache',
            `${remote?.name} upload still running after ${formatDuration(UPLOAD_TIMEOUT_MS)}; not waiting`,
          ),
        ),
      );
    } else if (upload?.failed) {
      const authNote =
        remote?.name === 'eas' && isEasAuthFailureText(upload.failed)
          ? easAuthNote({ code: 'logged-out', reason: upload.failed, phase: 'upload' })
          : null;
      note(chalk.yellow(phaseLine('cache', authNote || `${remote?.name} upload failed: ${upload.failed}`)));
    }
  }

  // ---- the record (Contract 4) ----
  const durationMs = elapsed();
  writeLastBuild(
    root,
    lastBuildRecord({
      fingerprint,
      cacheKey,
      cacheHit,
      cacheSkipped: !useBuildCache,
      durationMs,
      appPath,
      bundleId,
      startedAt,
      status: 'ok',
    }),
    { write: d.writeWorkspaceState },
  );

  // `writer` is assigned only inside the `logWriter` closure (via `||=`), which
  // TS's control-flow analysis cannot see, so it narrows the outer binding to
  // `never` here. The cast restates the real runtime type (a writer was created
  // iff anything was logged); it is not `any`.
  (writer as NdjsonWriter | null)?.close?.();

  const facts = iosFacts({
    udid,
    deviceName: device?.deviceName ?? null,
    fingerprint,
    cacheKey,
    cacheHit,
    cacheSkipped: !useBuildCache,
    waitedForBuild,
    appPath,
    bundleId,
    metroPort,
    logsDir,
    durationMs,
    launched: launchState,
  });

  if (json) {
    console.log(JSON.stringify(facts));
  } else {
    const summary =
      `OK: ${bundleId} on ${deviceLabel(device, udid)}, Metro port ${metroPort}` +
      ` (${cacheDescription(cacheHit, remote?.name)}, ${formatDuration(durationMs)})`;
    // The outcome line says which kind of OK this is. "OK" alone, over an app
    // that loaded nothing, is the claim this whole check exists to stop.
    console.log(
      launchState === LAUNCH_UNVERIFIED ? chalk.yellow(`${summary} -- launch UNVERIFIED`) : chalk.green(summary),
    );
  }

  // Everything this command does is done. If a provider call was abandoned,
  // its own child process may still be open, and node will not exit while it
  // is -- an agent's `rn-iso ios` would sit there long after the app launched,
  // waiting on a network call whose result nothing reads any more.
  if (abandonedRemote) exitAfterFlush(0);
  return facts;
}

// PURE. How the outcome line describes where the app came from.
export function cacheDescription(cacheHit: CacheHitLevel, providerName: string | null = null) {
  if (cacheHit === 'remote') return `from ${providerName || 'the remote cache'}`;
  if (cacheHit === 'local') return 'from cache';
  return 'built';
}

// PURE. The {message, remedy} an `ios` build failure reports.
//
// This is `android`'s shape, ported. `buildIos` returns no `reason` the way
// `buildAndroid` does -- its diagnosis is the extracted diagnostic list -- so
// the summary sentence is composed here, and the remedy follows android's rule
// exactly: the remedy of a diagnostic beats the generic one, because "run `pod
// install`" is the whole answer where it applies and "read the log" is not.
//
// The message is a SUMMARY, not a copy of the first diagnostic: the
// diagnostics are already on stderr in full, and repeating one of them there
// would be noise. What a --json consumer gets is a sentence it can report
// verbatim plus a next step, which is what it had for every other failure code
// and did not have for this one.
export function xcodeFailureReport(result: BuildIosResultLike, logPath: string) {
  const diagnostics = (Array.isArray(result?.diagnostics) ? result.diagnostics : []) as Diagnostic[];
  const code = result?.exitCode;
  const how = code === null || code === undefined ? '' : ` (exit code ${code})`;
  const message = diagnostics.length
    ? `\`xcodebuild\` failed${how} with ${diagnostics.length} diagnostic${diagnostics.length === 1 ? '' : 's'}.`
    : `\`xcodebuild\` failed${how} with no recognizable diagnostic.`;
  const remedy = diagnostics.find((d) => d?.remedy)?.remedy || `See ${logPath} for the transcript.`;
  return { message, remedy };
}

// The extract, never the transcript. `truncated` and the log path are what
// make the omission honest rather than silent.
function printDiagnostics(note: (line: string) => void, result: BuildIosResultLike) {
  const diagnostics = (Array.isArray(result?.diagnostics) ? result.diagnostics : []) as Diagnostic[];
  const shown = diagnostics.slice(0, MAX_PRINTED_DIAGNOSTICS);
  for (const diagnostic of shown) {
    note(chalk.red(phaseLine('error', describeDiagnostic(diagnostic))));
  }
  const hidden = diagnostics.length - shown.length + (result?.truncated || 0);
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
