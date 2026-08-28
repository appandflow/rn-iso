// src/engine/xcode.js -- the iOS half of the build engine: find the project,
// find its scheme, run xcodebuild, and hand back an installable .app.
//
// The split this file obeys (CLAUDE.md, "pure parsing/decision logic separate
// from invocation"): every decision -- which container to build, which scheme,
// what argv, which product, which bundle id -- is a pure function of data, and
// the fs/exec wrappers around them are three lines each. That is what makes
// the interesting parts testable without a 4-minute build, and it is also what
// let the argv below be checked against a real xcodebuild once (CLAUDE.md item
// 9) rather than trusted from a mock.
//
// STREAMING IS THE POINT OF buildIos. A native RN build runs two to six
// minutes, and the agent that started it has nothing to do but watch. Every
// transcript line is written to the NDJSON log AS IT ARRIVES, so `rn-iso logs
// --follow` shows a build in progress rather than a file that appears at the
// end. Two things make that real and both are easy to lose: the child's stdout
// is consumed line-by-line instead of collected into one buffer, and
// NSUnbufferedIO is set in its environment -- xcodebuild block-buffers its
// output when stdout is a pipe rather than a terminal, which delivers the
// whole transcript in one lump at exit and silently un-does the streaming.
import type { ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import chalk from 'chalk';
import { getExecutor, type Executor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { sharedCompilationCache, workspaceDerivedData } from '../paths.ts';
import { capDiagnostics, describeDiagnostic, type Diagnostic, extractXcodeDiagnostics } from './errors-xcode.ts';
// Borrowed rather than copied: these two are generic child-stdout plumbing
// that happens to live next to the Expo server because that is what needed
// them first. A second copy would be one more thing to keep in step, and
// CLAUDE.md's whole cache-package section is about what duplicated helpers
// cost when they drift.
import { cleanLine, createLineReader } from '../supervisor/server-expo.ts';

const IOS_DIR = 'ios';

// The remedy every "there is no iOS project here" failure carries. rn-iso's
// own flow prebuilds before it gets here, so reaching this means either the
// project is not a CNG project (nothing will generate ios/ for it) or the
// prebuild did not run.
const PREBUILD_REMEDY =
  'Generate it with `npx expo prebuild -p ios` (rn-iso ios does this automatically for an Expo project with no ios/ directory), or commit the native project.';

// A "here is what to build" descriptor OR a failure -- flat and all-optional
// (CLAUDE.md pattern 3), matching the defensive JS shape that either carries
// `error` or the project fields, never both.
interface XcodeProject {
  kind?: string;
  flag?: string;
  file?: string;
  name?: string | null;
  dir?: string;
  path?: string;
  error?: { code: string; message: string; remedy: string | null };
}

// resolveScheme's / listSchemes' result: either the error or the resolved
// scheme, flat and all-optional for the same reason.
interface SchemeResult {
  error?: { code: string; message: string; remedy: string };
  scheme?: string;
  schemes?: string[];
}

function buildFailure(message: string, remedy: string | null): XcodeProject {
  return { error: { code: 'RN_ISO_BUILD_FAILED', message, remedy } };
}

// A CocoaPods project MUST be built through its workspace: the .xcodeproj
// alone does not link the Pods targets, so building it produces either a link
// failure or -- worse -- an app missing native modules that fails at runtime.
// Every RN project with pods therefore prefers the workspace, and a project
// without pods has no workspace to prefer.
//
// Pure: takes a directory listing, returns a choice. Nothing here touches fs.
export function pickXcodeProject(entries: unknown): { kind: string; flag: string; file: string; name: string } | null {
  const names = (Array.isArray(entries) ? entries : []).filter((e) => typeof e === 'string');
  const workspaces = names.filter((e) => e.endsWith('.xcworkspace')).sort();
  const projects = names.filter((e) => e.endsWith('.xcodeproj')).sort();

  if (workspaces.length > 0) {
    // With more than one workspace, the one named after a project beside it is
    // the pods workspace; anything else is a deterministic alphabetical pick,
    // so two runs on the same tree never choose differently.
    const projectNames = new Set(projects.map((p) => basename(p, '.xcodeproj')));
    const match = workspaces.find((w) => projectNames.has(basename(w, '.xcworkspace')));
    const file = match || workspaces[0];
    if (file === undefined) return null; // workspaces.length > 0 checked above; guards index type
    return { kind: 'workspace', flag: '-workspace', file, name: basename(file, '.xcworkspace') };
  }
  if (projects.length > 0) {
    const file = projects[0];
    if (file === undefined) return null; // projects.length > 0 checked above; guards index type
    return { kind: 'project', flag: '-project', file, name: basename(file, '.xcodeproj') };
  }
  return null;
}

// The thin fs wrapper over pickXcodeProject. Returns either a target
// descriptor or `{error}` in the CLI's error shape -- never throws, because
// "this project has no ios/ directory" is a fact about the project, not a
// programmer error.
export function discoverXcodeProject(root: string): XcodeProject {
  const dir = join(root, IOS_DIR);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return buildFailure(`No ${IOS_DIR}/ directory in ${root}.`, PREBUILD_REMEDY);
  }
  const picked = pickXcodeProject(entries);
  if (!picked) {
    return buildFailure(`${dir} contains no .xcworkspace and no .xcodeproj.`, PREBUILD_REMEDY);
  }
  return { ...picked, dir, path: join(dir, picked.file) };
}

// `xcodebuild -list -json` prints JSON, but not always ONLY JSON: resolving a
// Swift package graph, a stale-simulator note or an NSLog from xcodebuild
// itself all land on the same stream first. Slicing from the first brace to
// the last is what makes this survive that, and returning the empty answer
// rather than throwing is what keeps a caller's error a scheme error instead
// of a JSON parse error.
export function parseSchemeList(text: unknown): { name: string | null; schemes: string[] } {
  const empty = { name: null, schemes: [] };
  if (typeof text !== 'string') return empty;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return empty;
  // JSON.parse's result is deliberately loosely typed here: xcodebuild's own
  // JSON shape is what this parses, and it is genuinely dynamic output.
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return empty;
  }
  if (!data || typeof data !== 'object') return empty;
  // A workspace listing carries `workspace`, a project listing `project`; the
  // project form additionally has targets and configurations, which nothing
  // here needs.
  const record = data as { workspace?: unknown; project?: unknown };
  const container = record.workspace || record.project;
  if (!container || typeof container !== 'object') return empty;
  const info = container as { schemes?: unknown; name?: unknown };
  const schemes: string[] = Array.isArray(info.schemes)
    ? info.schemes.filter((s: unknown) => typeof s === 'string' && s.trim() !== '')
    : [];
  return { name: typeof info.name === 'string' ? info.name : null, schemes };
}

// Test schemes are never buildable-and-runnable app schemes, and an RN project
// that has one has it beside the app scheme. They are excluded only from the
// "is there exactly one?" count -- an exact name match still wins, because a
// project genuinely named `SomethingTests` would otherwise become unbuildable.
const TEST_SCHEME = /(?:UI)?Tests$/;

// Order matters and encodes decreasing confidence:
//   1. the scheme named after the container. `npx @react-native-community/cli
//      init MyApp` and `expo prebuild` both produce exactly this, so it is the
//      answer in essentially every real project.
//   2. the only non-test scheme, when there is exactly one.
//   3. null. NOT a guess: picking the alphabetically-first of several schemes
//      would silently build the tvOS target or a staging variant, and four
//      minutes later install something the agent did not ask for. A structured
//      RN_ISO_NO_SCHEME the agent can answer is worth more than a coin flip.
export function pickScheme(schemes: unknown, containerName: unknown): string | null | undefined {
  const list: string[] = (Array.isArray(schemes) ? schemes : []).filter(
    (s: unknown) => typeof s === 'string' && s.trim() !== '',
  );
  if (list.length === 0) return null;
  const name = typeof containerName === 'string' ? containerName.trim() : '';
  if (name) {
    const exact = list.find((s) => s === name);
    if (exact) return exact;
    const insensitive = list.find((s) => s.toLowerCase() === name.toLowerCase());
    if (insensitive) return insensitive;
  }
  const app = list.filter((s) => !TEST_SCHEME.test(s));
  return app.length === 1 ? app[0] : null;
}

// A workspace whose packages are not yet resolved makes `-list` fetch and
// resolve them, which is a network operation on a cold checkout. Generous, but
// bounded: an agent loop that hangs here has no way to tell it is hung.
const LIST_TIMEOUT_MS = 180000;

// null means the tool itself failed (no Xcode, unparseable pbxproj, a package
// graph that would not resolve) -- distinct from a listing that succeeded and
// contained no schemes, which is `{name, schemes: []}`. Both end in
// RN_ISO_NO_SCHEME, but only one of them is worth telling the user to run
// `xcodebuild -list` by hand about.
export function listSchemes(
  project: XcodeProject,
  { exec = null }: { exec?: Executor | null } = {},
): { name: string | null; schemes: string[] } | null {
  const executor = exec || getExecutor();
  try {
    const out = executor.runFile('xcodebuild', [project.flag as string, project.path as string, '-list', '-json'], {
      timeoutMs: LIST_TIMEOUT_MS,
    });
    return parseSchemeList(out);
  } catch {
    return null;
  }
}

// The mapping the plan's command flow needs, kept here so `ios` and any future
// caller phrase RN_ISO_NO_SCHEME the same way.
export function resolveScheme(project: XcodeProject, { exec = null }: { exec?: Executor | null } = {}): SchemeResult {
  const listing = listSchemes(project, { exec });
  if (listing === null) {
    return {
      error: {
        code: 'RN_ISO_NO_SCHEME',
        message: `Could not list schemes for ${project.path}.`,
        remedy: `Run \`xcodebuild ${project.flag} ${project.path} -list\` to see what it reports.`,
      },
    };
  }
  const scheme = pickScheme(listing.schemes, listing.name || project.name);
  if (!scheme) {
    const found = listing.schemes.length ? listing.schemes.join(', ') : 'none';
    return {
      error: {
        code: 'RN_ISO_NO_SCHEME',
        message: `No buildable scheme found in ${project.path} (schemes: ${found}).`,
        remedy:
          'Share the app scheme in Xcode (Product > Scheme > Manage Schemes, tick Shared) so xcodebuild can see it.',
      },
    };
  }
  return { scheme, schemes: listing.schemes };
}

// --- Xcode's compilation cache, supplied on OUR OWN argv ------------------
//
// THE POINT: rn-iso needs no project changes to run. xcodebuild takes
// `SETTING=value` overrides that apply to every target in the build, Pods
// included, so the content-addressed compilation cache that used to require a
// Podfile `post_install` block is expressible on the command line rn-iso
// already composes. The project's Podfile is never read for this and never
// written to; a repo that ALSO wants the setting for builds run outside rn-iso
// still commits it, and gets the identical settings either way.
//
// The five settings are what an equivalent Podfile `post_install` block would
// have to set, for a repo that also wants them outside rn-iso:
//
//   COMPILATION_CACHE_ENABLE_CACHING  turn the CAS on
//   COMPILATION_CACHE_CAS_PATH        point it OUTSIDE DerivedData -- the
//                                     default CAS lives at the DerivedData
//                                     root, and rn-iso's DerivedData is
//                                     workspace-local, so the default shares
//                                     nothing between worktrees, which is the
//                                     only reason to enable it
//   SWIFT_ENABLE_COMPILE_CACHE=NO     Swift caching cannot hit across
//                                     workspaces without SWIFT_OTHER_PREFIX_
//                                     MAPPINGS, and that setting crashes
//                                     swift-frontend whenever a compile batch
//                                     mixes mapped and unmapped sources
//                                     (swiftlang/swift#90698, fixed upstream,
//                                     not yet in a released Xcode). Off
//                                     explicitly, which also silences the
//                                     per-target warning
//   CLANG_ENABLE_PREFIX_MAPPING       let clang canonicalise absolute paths
//   CLANG_OTHER_PREFIX_MAPPINGS       and map THIS workspace's root to a fixed
//                                     virtual prefix, so a second worktree of
//                                     the same commit computes the same cache
//                                     keys instead of missing everything
export const COMPILATION_CACHE_MIN_XCODE = 26;

// The virtual prefix the workspace root is rewritten to. A repo that commits
// the equivalent Podfile `post_install` block for its own builds must use this
// exact string: committing one AND running rn-iso has to land on one set of
// cache keys, not two.
const PREFIX_MAP_TARGET = '/^src';

// ONE mapping, not two. A Podfile block has to map $(DERIVED_DATA_DIR) as well,
// because a project's DerivedData sits outside its source tree; rn-iso builds
// with `-derivedDataPath` set to the global workspace derived-data directory,
// root, so the root mapping already covers it at the identical relative path
// in every worktree. Adding the second mapping here would also risk expanding
// an undefined setting reference into an empty prefix.
export function prefixMapping(workspaceRoot: string): string {
  return `${String(workspaceRoot).replace(/\/+$/, '')}=${PREFIX_MAP_TARGET}`;
}

// DerivedData used to be nested under the source root, so the source mapping
// covered both. It now lives under RN_ISO_HOME and needs its own stable virtual
// prefix or the human-readable per-workspace directory leaks into CAS keys.
function compilationPrefixMappings(workspaceRoot: string, derivedDataPath: string): string {
  const source = resolve(workspaceRoot);
  const derived = resolve(derivedDataPath);
  const mappings = [prefixMapping(source)];
  const rel = relative(source, derived);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    mappings.push(`${derived}=/^derived-data`);
  }
  return mappings.join(' ');
}

// PURE. Whether the project has ccache wired into its pod build. ccache and
// compilation caching are mutually exclusive in practice -- the ccache
// launcher script is what disables explicitly built modules, which compilation
// caching requires -- so a project that chose ccache keeps ccache, and rn-iso
// adds nothing. doctor's checkCcacheConflict reads the same predicate; this is
// the one implementation of it.
export function ccacheEnabled(podfileProperties: unknown): boolean {
  if (!podfileProperties || typeof podfileProperties !== 'object') return false;
  return (podfileProperties as Record<string, unknown>)['apple.ccacheEnabled'] === 'true';
}

// The thin fs half. Absent or unreadable is "no ccache", not an error: this
// decides whether to ADD a setting, and the safe direction on doubt is to add
// nothing.
export function readPodfileProperties(root: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, IOS_DIR, 'Podfile.properties.json'), 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// PURE. The build settings this invocation should carry, or [] when it must
// carry none.
//
// THE FLOOR IS XCODE 26, AND AN UNREADABLE VERSION COUNTS AS BELOW IT. 26 is
// the release that shipped the content-addressed compilation cache; on 25 and
// older these settings do nothing at all. doctor hedges on a null major and
// prints its advice anyway, because advice is free -- this is the opposite
// trade: adding five build settings to a real four-minute build buys nothing
// on a version that ignores them and is one more variable when that build
// fails. So a version rn-iso could not read (no Xcode, command line tools
// only, a localized or future `xcodebuild -version` format) leaves the argv
// exactly as it was.
export function compilationCacheSettings({
  workspaceRoot,
  derivedDataPath,
  casPath,
  xcodeMajor,
  ccache = false,
}: {
  workspaceRoot: string;
  derivedDataPath: string;
  casPath: string;
  xcodeMajor: number | null;
  ccache?: boolean;
}): string[] {
  if (xcodeMajor === null || xcodeMajor === undefined) return [];
  if (xcodeMajor < COMPILATION_CACHE_MIN_XCODE) return [];
  if (ccache) return [];
  return [
    'COMPILATION_CACHE_ENABLE_CACHING=YES',
    `COMPILATION_CACHE_CAS_PATH=${casPath}`,
    'SWIFT_ENABLE_COMPILE_CACHE=NO',
    'CLANG_ENABLE_PREFIX_MAPPING=YES',
    `CLANG_OTHER_PREFIX_MAPPINGS=${compilationPrefixMappings(workspaceRoot, derivedDataPath)}`,
  ];
}

// `xcodebuild -version` prints "Xcode 26.1" on its first line. Anything else --
// no Xcode, command line tools only, a localized or future format -- is null,
// which every caller treats as "version unknown" rather than as a number.
//
// This lives here rather than in doctor.ts because it parses xcodebuild's own
// output and the BUILD is now its main consumer; doctor imports it from here.
export function parseXcodeMajor(output: unknown): number | null {
  const m = /^Xcode\s+(\d+)/m.exec(String(output || ''));
  if (!m) return null;
  const digits = m[1];
  if (digits === undefined) return null;
  const major = parseInt(digits, 10);
  return Number.isFinite(major) ? major : null;
}

// The thin I/O half. Returns null on any failure: this is a hint that shapes
// advice and argv, and a machine without Xcode must still be able to run
// doctor. Bounded, so a wedged Xcode install cannot hang either caller.
export function detectXcodeMajor(exec: Executor | null = null): number | null {
  return parseXcodeMajor((exec || getExecutor()).runQuiet('xcodebuild -version', { timeoutMs: 10000 }));
}

// The I/O half of the decision, plus the ONE note that keeps it from being
// invisible: a build that is silently caching differently from the last one is
// exactly the kind of thing an agent cannot debug from a transcript.
function resolveCompilationCacheSettings({
  root,
  derivedDataPath,
  exec = null,
  casPath = sharedCompilationCache(),
  onNote = (line: string) => console.error(line),
}: {
  root: string;
  derivedDataPath: string;
  exec?: Executor | null;
  casPath?: string;
  onNote?: (line: string) => void;
}): string[] {
  const settings = compilationCacheSettings({
    workspaceRoot: root,
    derivedDataPath,
    casPath,
    xcodeMajor: detectXcodeMajor(exec),
    ccache: ccacheEnabled(readPodfileProperties(root)),
  });
  if (settings.length > 0) {
    onNote(
      chalk.dim(
        `compilation cache on for this build: CAS at ${casPath} (rn-iso sets it on its own xcodebuild; the Podfile is not touched)`,
      ),
    );
  }
  return settings;
}

// Exactly the invocation the plan specifies, as data, so a test can assert the
// shape without running anything. `id=<udid>` is the production destination:
// building for the specific simulator that will run the app is what makes the
// product architecture and the runtime match. A caller may pass `destination`
// instead for a build-only run against no device.
export function xcodebuildArgs({
  project,
  scheme,
  udid = null,
  destination = null,
  configuration = 'Debug',
  sdk = 'iphonesimulator',
  derivedDataPath,
  extraArgs = [],
  buildSettings = [],
}: {
  project: XcodeProject;
  scheme: string;
  udid?: string | null;
  destination?: string | null;
  configuration?: string;
  sdk?: string;
  derivedDataPath: string;
  extraArgs?: string[];
  // `SETTING=value` overrides, injected rather than computed here so this
  // stays pure and so a caller can pass none. See compilationCacheSettings.
  buildSettings?: string[];
}): string[] {
  return [
    project.flag as string,
    project.path as string,
    '-scheme',
    scheme,
    '-configuration',
    configuration,
    '-sdk',
    sdk,
    '-destination',
    destination || `id=${udid}`,
    '-derivedDataPath',
    derivedDataPath,
    ...extraArgs,
    'build',
    // AFTER the action, which is where xcodebuild's own usage line puts build
    // settings (`[action ...] [buildsetting=value ...]`). extraArgs are
    // OPTIONS and stay before it; these are not options.
    ...buildSettings,
  ];
}

export function productsDir(
  derivedDataPath: string,
  { configuration = 'Debug', sdk = 'iphonesimulator' }: { configuration?: string; sdk?: string } = {},
): string {
  return join(derivedDataPath, 'Build', 'Products', `${configuration}-${sdk}`);
}

// Pure. A scheme that builds app extensions or a watch app puts more than one
// .app in the products directory, and the top-level one is the one named after
// the scheme -- the others are nested inside it as well, but a flat listing
// cannot tell which. Preferring the scheme name, then falling back to a sorted
// pick, keeps the choice deterministic either way.
export function pickAppBundle(entries: unknown, preferredName: string | null = null): string | null | undefined {
  const apps = (Array.isArray(entries) ? entries : [])
    .filter((e) => typeof e === 'string' && e.endsWith('.app'))
    .sort();
  if (apps.length === 0) return null;
  if (preferredName) {
    const wanted = `${preferredName}.app`;
    const exact = apps.find((a) => a === wanted);
    if (exact) return exact;
  }
  return apps[0];
}

export function findAppBundle(dir: string, preferredName: string | null = null): string | null {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const app = pickAppBundle(entries, preferredName);
  return app ? join(dir, app) : null;
}

// Pure: the JSON `plutil -convert json` produces, in. A missing or non-string
// identifier is null rather than an exception -- the caller turns it into a
// build failure with a remedy, which is more use than a stack trace.
export function parseBundleId(plistJson: unknown): string | null {
  if (typeof plistJson !== 'string') return null;
  // Genuinely dynamic: this is Info.plist converted to JSON by `plutil`, an
  // Apple-defined shape this module has no reason to model beyond one field.
  let data: unknown;
  try {
    data = JSON.parse(plistJson);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const id = (data as { CFBundleIdentifier?: unknown }).CFBundleIdentifier;
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : null;
}

// A built app's Info.plist is a BINARY plist, so it cannot simply be read: it
// goes through plutil. `defaults read` is the fallback because it is the one
// other tool present on every Mac that understands the format -- note it takes
// the path WITHOUT the .plist extension, which is why the two calls do not
// look alike.
//
// runFile, not run: the .app path comes from a derived-data directory under a
// project path the user chose, and a space in it must reach the tool as one
// argument (CLAUDE.md, "Single exec wrapper").
export function readBundleId(appPath: string, { exec = null }: { exec?: Executor | null } = {}): string | null {
  const executor = exec || getExecutor();
  try {
    const json = executor.runFile('plutil', ['-convert', 'json', '-o', '-', join(appPath, 'Info.plist')]);
    const id = parseBundleId(json);
    if (id) return id;
  } catch {
    // Fall through to defaults.
  }
  try {
    const value = executor.runFile('defaults', ['read', join(appPath, 'Info'), 'CFBundleIdentifier']);
    const trimmed = String(value).trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

// The last few non-empty lines, which is what a caller prints when extraction
// found nothing recognizable. Kept here because buildIos already holds the
// transcript in memory and re-reading the log file to get it back would be
// absurd.
export function tailLines(lines: unknown, count = 5): string[] {
  const nonEmpty = (Array.isArray(lines) ? lines : []).filter((l) => typeof l === 'string' && l.trim() !== '');
  return nonEmpty.slice(-count);
}

// --- the build heartbeat ---------------------------------------------------
//
// A native build runs two to six minutes, and between the command layer's
// fingerprint line and its completion line stderr prints NOTHING: the
// transcript streams to the build log, and an agent watching the command
// cannot tell "compiling" from "wedged" without going around the CLI to the
// log file or the process table. The heartbeat is one stderr line roughly
// every 30 seconds while the build child runs -- the elapsed time plus the
// last meaningful transcript line, truncated -- so the silence is never
// longer than one interval. stdout stays untouched: progress is stderr in
// both output modes (CLAUDE.md item 7, one payload on stdout).
//
// gradle.ts imports these rather than copying them -- the same
// borrowed-not-copied reasoning as the line reader above.

export const HEARTBEAT_INTERVAL_MS = 30_000;

// How much of the sampled transcript line survives into the heartbeat. Long
// enough to name a compile target, short enough that the line stays a line.
const HEARTBEAT_HINT_LENGTH = 80;

// 5m19s / 42s: the shape the completion line already uses for durations, so
// the heartbeat and the summary read as the same clock.
export function formatHeartbeatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

// PURE. The line itself, in the commands' phase-line shape (label padded to
// 11 columns) so it lines up with the `fingerprint` and `build` lines around
// it on stderr.
export function heartbeatLine(elapsedMs: number, lastLine: string, label = 'build'): string {
  const hint =
    lastLine.length > HEARTBEAT_HINT_LENGTH ? `${lastLine.slice(0, HEARTBEAT_HINT_LENGTH - 3)}...` : lastLine;
  const activity = hint.trim() === '' ? '' : `: ${hint}`;
  return `${label.padEnd(11)} still running (${formatHeartbeatElapsed(elapsedMs)})${activity}`;
}

// Starts the timer, returns the stop function. The timer samples state
// through the two thunks rather than owning any: the caller already tracks
// elapsed time and the latest transcript line for other reasons, and a timer
// that kept its own copies would drift from them. `unref` keeps a heartbeat
// from holding the process open should the child's close never fire.
export function startBuildHeartbeat({
  intervalMs,
  elapsed,
  lastLine,
  emit,
  label = 'build',
}: {
  intervalMs: number;
  elapsed: () => number;
  lastLine: () => string;
  emit: (line: string) => void;
  label?: string;
}): () => void {
  if (!(intervalMs > 0)) return () => {};
  const timer = setInterval(() => emit(heartbeatLine(elapsed(), lastLine(), label)), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function failedResult({
  code,
  diagnostics,
  durationMs,
  exitCode = null,
  transcriptLines = 0,
  tail = [],
}: {
  code: string;
  diagnostics: Diagnostic[];
  durationMs: number;
  exitCode?: number | null;
  transcriptLines?: number;
  tail?: string[];
}) {
  const capped = capDiagnostics(diagnostics);
  return {
    failed: true,
    code,
    diagnostics: capped.diagnostics,
    truncated: capped.truncated,
    durationMs,
    exitCode,
    transcriptLines,
    tail,
  };
}

// The all-optional view of buildIos's two outcomes: the success shape and the
// failedResult shape, per the doc comment below.
export type BuildIosResult = {
  failed?: boolean;
  code?: string;
  diagnostics?: Diagnostic[];
  truncated?: number;
  exitCode?: number | null;
  tail?: string[];
  appPath?: string;
  bundleId?: string;
  scheme?: string;
  project?: XcodeProject;
  derivedDataPath?: string;
  productsDir?: string;
  durationMs: number;
  transcriptLines: number;
};

/**
 * Run xcodebuild for the simulator, streaming the transcript into logWriter.
 *
 * Resolves to either
 *   { appPath, bundleId, durationMs, ... }                   -- success
 *   { failed: true, code, diagnostics, truncated, durationMs, ... }
 *
 * A FAILED BUILD IS A RETURN VALUE, NEVER A THROW. It is the single most
 * expected outcome of this function, and an exception would force every
 * caller into a try/catch whose catch block has to re-derive what happened
 * from an Error. Only programmer errors -- a missing root, a missing writer,
 * no device to build for -- throw, and those are bugs in the caller.
 */
export async function buildIos({
  root,
  udid = null,
  logWriter,
  project = null,
  scheme = null,
  configuration = 'Debug',
  sdk = 'iphonesimulator',
  destination = null,
  derivedDataPath = null,
  extraArgs = [],
  compilationCache = undefined,
  now = () => Date.now(),
  exec = null,
  heartbeatMs = HEARTBEAT_INTERVAL_MS,
  onHeartbeat = (line: string) => console.error(line),
  onNote = (line: string) => console.error(line),
}: {
  root: string;
  udid?: string | null;
  logWriter: NdjsonWriter;
  project?: XcodeProject | null;
  scheme?: string | null;
  configuration?: string;
  sdk?: string;
  destination?: string | null;
  derivedDataPath?: string | null;
  extraArgs?: string[];
  // The compilation-cache build settings, INJECTABLE so tests drive them and
  // so a caller can turn them off: `null` means carry none, an array dictates
  // them exactly, and leaving it out resolves them from this machine's Xcode
  // and this project (the default, and the whole point of the feature).
  compilationCache?: string[] | null;
  now?: () => number;
  exec?: Executor | null;
  heartbeatMs?: number;
  onHeartbeat?: (line: string) => void;
  onNote?: (line: string) => void;
}): Promise<BuildIosResult> {
  if (!root || typeof root !== 'string') throw new TypeError('buildIos requires {root}');
  if (!logWriter || typeof logWriter.write !== 'function')
    throw new TypeError('buildIos requires {logWriter} with a write() method');
  if (!udid && !destination) throw new TypeError('buildIos requires {udid} (or an explicit {destination})');

  const executor = exec || getExecutor();
  const dd = derivedDataPath || workspaceDerivedData(root);
  const startedAt = now();
  const elapsed = () => now() - startedAt;

  const reportError = (message: string, remedy?: string | null) => {
    logWriter.write({
      src: 'build',
      level: 'error',
      msg: message,
      event: 'build_diagnostic',
      ...(remedy ? { remedy } : {}),
    });
  };

  let target: XcodeProject | null = project;
  if (!target) {
    const discovered = discoverXcodeProject(root);
    if (discovered.error) {
      reportError(discovered.error.message, discovered.error.remedy);
      return failedResult({
        code: discovered.error.code,
        diagnostics: [{ message: discovered.error.message, remedy: discovered.error.remedy ?? undefined }],
        durationMs: elapsed(),
      });
    }
    target = discovered;
  }
  // Always assigned above: either the caller's own project, or the freshly
  // discovered one (the error branch already returned).
  const resolvedTarget = target as XcodeProject;

  let chosenScheme: string | null = scheme;
  if (!chosenScheme) {
    const resolved = resolveScheme(resolvedTarget, { exec: executor });
    if (resolved.error) {
      reportError(resolved.error.message, resolved.error.remedy);
      return failedResult({
        code: resolved.error.code,
        diagnostics: [{ message: resolved.error.message, remedy: resolved.error.remedy }],
        durationMs: elapsed(),
      });
    }
    chosenScheme = resolved.scheme ?? null;
  }
  // Always assigned above: either the caller's own scheme, or the resolved
  // one (the error branch already returned).
  const buildScheme = chosenScheme as string;

  const buildSettings =
    compilationCache === undefined
      ? resolveCompilationCacheSettings({ root, derivedDataPath: dd, exec: executor, onNote })
      : compilationCache || [];

  const args = xcodebuildArgs({
    project: resolvedTarget,
    scheme: buildScheme,
    udid,
    destination,
    configuration,
    sdk,
    derivedDataPath: dd,
    extraArgs,
    buildSettings,
  });

  // The exact command, first line of the log. An agent debugging a build it
  // did not compose needs to see what was actually run, and reconstructing it
  // from this file's source is not the same thing as reading it.
  logWriter.write({
    src: 'build',
    level: 'info',
    msg: `xcodebuild ${args.join(' ')}`,
    event: 'build_start',
  });

  const transcript: string[] = [];
  // The heartbeat's activity hint: the last non-blank line the child printed.
  let lastTranscriptLine = '';
  const onLine = (line: unknown) => {
    const msg = cleanLine(line);
    transcript.push(msg);
    // Blank lines are transcript structure, not records: they are kept for
    // extraction (the linker's undefined-symbol block ends on one) and dropped
    // from the log, where they would be thousands of empty entries.
    if (msg.trim() === '') return;
    lastTranscriptLine = msg;
    logWriter.write({ src: 'build', level: 'debug', msg });
  };

  let child: ChildProcess;
  try {
    child = executor.spawn('xcodebuild', args, {
      cwd: resolvedTarget.dir || root,
      // stdin is ignored: xcodebuild never prompts in this mode, and a build
      // run from a detached agent has no terminal to prompt to.
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env,
        // See the header: without this the transcript arrives in one lump at
        // exit and `logs --follow` shows nothing for four minutes.
        NSUnbufferedIO: 'YES',
        FORCE_COLOR: '0',
      },
    });
  } catch (err) {
    const message = `Could not run xcodebuild: ${(err as Error).message}`;
    const remedy = 'Install Xcode and select it with `sudo xcode-select -s /Applications/Xcode.app`.';
    reportError(message, remedy);
    return failedResult({ code: 'RN_ISO_BUILD_FAILED', diagnostics: [{ message, remedy }], durationMs: elapsed() });
  }

  const outReader = createLineReader(onLine);
  const errReader = createLineReader(onLine);
  child.stdout?.setEncoding?.('utf-8');
  child.stderr?.setEncoding?.('utf-8');
  child.stdout?.on('data', (chunk) => outReader.push(chunk));
  child.stderr?.on('data', (chunk) => errReader.push(chunk));

  const stopHeartbeat = startBuildHeartbeat({
    intervalMs: heartbeatMs,
    elapsed,
    lastLine: () => lastTranscriptLine,
    emit: onHeartbeat,
  });

  // `close`, not `exit`: exit fires when the process ends, which can be before
  // its stdio pipes have been drained. Waiting for close is what guarantees
  // the last diagnostic -- usually the most important line in the file -- is
  // in the transcript rather than lost in a pipe.
  const outcome = await new Promise<{ code?: number | null; signal?: NodeJS.Signals | null; error?: Error }>(
    (resolve) => {
      let settled = false;
      const finish = (value: { code?: number | null; signal?: NodeJS.Signals | null; error?: Error }) => {
        if (settled) return;
        settled = true;
        outReader.flush();
        errReader.flush();
        resolve(value);
      };
      child.on('close', (code, signal) => finish({ code, signal }));
      // A spawn that fails after the call returned (ENOENT resolved
      // asynchronously) emits `error` and may never emit `close`.
      child.on('error', (error) => finish({ code: null, signal: null, error }));
    },
  );

  stopHeartbeat();
  const durationMs = elapsed();
  const text = transcript.join('\n');

  if (outcome.error) {
    const message = `Could not run xcodebuild: ${outcome.error.message}`;
    const remedy = 'Install Xcode and select it with `sudo xcode-select -s /Applications/Xcode.app`.';
    reportError(message, remedy);
    return failedResult({
      code: 'RN_ISO_BUILD_FAILED',
      diagnostics: [{ message, remedy }],
      durationMs,
      transcriptLines: transcript.length,
      tail: tailLines(transcript),
    });
  }

  if (outcome.code !== 0) {
    const diagnostics = extractXcodeDiagnostics(text);
    const capped = capDiagnostics(diagnostics);
    for (const d of capped.diagnostics) reportError(describeDiagnostic(d), d.remedy);
    if (capped.diagnostics.length === 0) {
      // Nothing recognizable. Say so in the log rather than leaving a reader
      // to wonder whether extraction ran at all.
      reportError(
        `xcodebuild exited ${outcome.code ?? `on ${outcome.signal}`} with no recognizable diagnostic; see the transcript above.`,
        null,
      );
    }
    return failedResult({
      code: 'RN_ISO_BUILD_FAILED',
      diagnostics,
      durationMs,
      exitCode: outcome.code,
      transcriptLines: transcript.length,
      tail: tailLines(transcript),
    });
  }

  const products = productsDir(dd, { configuration, sdk });
  const appPath = findAppBundle(products, buildScheme);
  if (!appPath) {
    const message = `xcodebuild reported success but no .app is in ${products}.`;
    const remedy = 'Check that the scheme builds an application target, not a library or a test bundle.';
    reportError(message, remedy);
    return failedResult({
      code: 'RN_ISO_BUILD_FAILED',
      diagnostics: [{ message, remedy }],
      durationMs,
      exitCode: 0,
      transcriptLines: transcript.length,
      tail: tailLines(transcript),
    });
  }

  // The bundle id is not a nicety: install and launch both need it, and so
  // does the device-log collector's predicate. Reading it HERE, while the
  // transcript is still in hand, turns "the app is unusable" into a build
  // failure with a remedy instead of an install failure three steps later
  // with no context.
  const bundleId = readBundleId(appPath, { exec: executor });
  if (!bundleId) {
    const message = `No readable CFBundleIdentifier in ${join(appPath, 'Info.plist')}.`;
    const remedy = "Check PRODUCT_BUNDLE_IDENTIFIER in the target's Debug configuration.";
    reportError(message, remedy);
    return failedResult({
      code: 'RN_ISO_BUILD_FAILED',
      diagnostics: [{ message, remedy }],
      durationMs,
      exitCode: 0,
      transcriptLines: transcript.length,
      tail: tailLines(transcript),
    });
  }

  logWriter.write({
    src: 'build',
    level: 'info',
    msg: `BUILD SUCCEEDED ${appPath} (${bundleId}) in ${durationMs}ms`,
    event: 'build_done',
  });

  return {
    appPath,
    bundleId,
    durationMs,
    scheme: buildScheme,
    project: resolvedTarget,
    derivedDataPath: dd,
    productsDir: products,
    transcriptLines: transcript.length,
  };
}
