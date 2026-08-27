// src/engine/gradle.js -- `./gradlew assembleDebug`, and where the APK it
// produced ended up.
//
// The split CLAUDE.md asks for: every decision here (is there an android
// project, which of these files is the debug APK, what does the transcript
// say the output was) is a pure function of text or of a file list, and the
// spawn around them is thin.
//
// Nothing throws for a build failure. A gradle build failing is the single
// most ordinary thing this module does, and it comes back as
//   { failed: true, code, reason, diagnostics, truncated, lastLines, durationMs }
// so the command layer prints one extracted diagnostic and a log path rather
// than catching an exception three frames up and printing a stack.
//
// THE GRADLE BUILD DIRECTORY IS NOT REDIRECTED. paths.js offers
// workspaceGradleBuild(), and it is deliberately unused here: moving
// `buildDir` out of the project breaks assumptions AGP makes about where its
// intermediates, its merged manifests and its output listings live, and the
// failures it produces are silent and late (an APK that builds but resolves
// no resources). The workspace-local DerivedData that iOS gets has no safe
// Android equivalent yet, so each checkout keeps its own android/app/build
// and the SHARED artifact is the build cache entry, keyed on the fingerprint.
// Revisit if AGP grows a supported way to relocate it.
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { getExecutor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { androidHome } from '../sim/android.ts';
import { createLineReader, stripAnsi } from '../supervisor/server-expo.ts';
import { waitForChild } from './deps.ts';
import { capDiagnostics, type Diagnostic, extractGradleDiagnostics } from './errors-gradle.ts';
// Borrowed rather than copied (the same reasoning as the line reader above):
// the heartbeat is generic build-child plumbing that lives beside the iOS
// build because that is what needed it first, and a second copy would drift.
import { HEARTBEAT_INTERVAL_MS, startBuildHeartbeat } from './xcode.ts';

export const BUILD_ERROR = 'RN_ISO_BUILD_FAILED';

// The signature every spawnFn injection seam in this module accepts:
// getExecutor().spawn's shape, loosened to a plain options bag so callers do
// not have to import SpawnOptions.
type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess;

// discoverAndroidProject's result is either a refusal or the two paths a
// build needs -- flat and all-optional, matching the defensive JS shape
// (CLAUDE.md pattern 3), not a discriminated union.
interface AndroidProjectResult {
  failed?: boolean;
  code?: string;
  reason?: string;
  remedy?: string;
  androidDir?: string;
  gradlew?: string;
}

// Debug only, per the spec's out-of-scope list: no release path ships, which
// is what removes Android signing configuration from rn-iso entirely.
// A project with PRODUCT FLAVORS still needs a flavored debug build though
// (`assembleProductionDebug`), selected by the `--variant` flag (deliberate
// surface growth, issue #52) or its repo-level default, the `android.variant`
// setting.
export const ASSEMBLE_TASK = 'assembleDebug';

// PURE. The gradle task a variant selects. Gradle capitalizes the variant
// name after `assemble` (`productionDebug` -> `assembleProductionDebug`);
// unset means the default task, unchanged from before variants existed.
export function assembleTaskFor(variant?: string | null): string {
  const name = typeof variant === 'string' ? variant.trim() : '';
  if (!name) return ASSEMBLE_TASK;
  return `assemble${name[0]!.toUpperCase()}${name.slice(1)}`;
}

// How many transcript lines a failure carries back for the caller to print
// when nothing could be extracted from them.
const LAST_LINES = 20;

// The window the diagnostics are extracted from. Gradle prints the FAILURE
// block, the failing task and the compiler output at the END of a build, so a
// rolling window costs nothing in practice while keeping a multi-thousand-line
// React Native transcript out of memory. The COMPLETE transcript is in
// .rn-iso/logs/build-android.ndjson regardless -- every line goes to the
// writer as it arrives.
const TRANSCRIPT_LINES = 2000;

function androidDir(root: string) {
  return join(root, 'android');
}

function gradlewPath(root: string) {
  return join(androidDir(root), 'gradlew');
}

export function apkOutputsDir(root: string): string {
  return join(androidDir(root), 'app', 'build', 'outputs', 'apk');
}

export function debugApkDir(root: string): string {
  return join(apkOutputsDir(root), 'debug');
}

// Is there something to build here? Two failures, and the remedy for both
// names prebuild, because on a CNG project that is exactly what is missing:
// the native directory has not been generated yet.
export function discoverAndroidProject(root: string): AndroidProjectResult {
  const dir = androidDir(root);
  if (!existsSync(dir)) {
    return {
      failed: true,
      code: BUILD_ERROR,
      reason: `No android/ directory in ${root}.`,
      remedy:
        'Generate it (`npx expo prebuild -p android`, which `rn-iso android` runs itself on an Expo project) or check out the native sources.',
    };
  }
  const gradlew = gradlewPath(root);
  if (!existsSync(gradlew)) {
    return {
      failed: true,
      code: BUILD_ERROR,
      reason: `${gradlew} does not exist, so there is no gradle wrapper to build with.`,
      remedy:
        'Restore the wrapper (`gradle wrapper` in android/, or regenerate the project with `npx expo prebuild -p android --clean`).',
    };
  }
  return { androidDir: dir, gradlew };
}

// PURE. Whether the Android SDK is findable at all, given the resolved path
// and what exists. Gradle's own answer to a missing SDK is "SDK location not
// found" three minutes into configuration; answering at second zero with the
// variable to set is worth the check.
//
// android/local.properties (sdk.dir=...) satisfies gradle on its own, so a
// project carrying one is fine even with no environment variable set.
export function androidSdkRefusal({
  sdkPath,
  sdkExists,
  hasLocalProperties,
}: {
  sdkPath: string;
  sdkExists: boolean;
  hasLocalProperties: boolean;
}): { code: string; reason: string; remedy: string } | null {
  if (sdkExists || hasLocalProperties) return null;
  return {
    code: BUILD_ERROR,
    reason: `No Android SDK at ${sdkPath}.`,
    remedy:
      'Set ANDROID_HOME to the Android SDK (Android Studio installs it at ~/Library/Android/sdk), or write sdk.dir into android/local.properties. JAVA_HOME must point at a JDK 17 install as well.',
  };
}

// PURE. Which of these files is the debug APK.
//
// `app-debug.apk` is what AGP names it, but the name is a product of the
// module name and the flavour, so it is a preference and not an assumption:
// a project with flavours produces app-staging-debug.apk and nothing else.
// Intermediate outputs (-unsigned, -unaligned) are never the installable one.
export function pickDebugApk(files: unknown): string | null | undefined {
  const list = (Array.isArray(files) ? files : [])
    .filter((f) => typeof f === 'string' && f.endsWith('.apk'))
    .filter((f) => !/-(?:unsigned|unaligned)\.apk$/.test(f));
  if (list.length === 0) return null;
  const named = list.find((f) => baseName(f) === 'app-debug.apk');
  if (named) return named;
  const debug = list.filter((f) => baseName(f).endsWith('-debug.apk'));
  const pool = debug.length ? debug : list;
  // Shortest name first, then alphabetical: among app-debug.apk and
  // app-debug-androidTest.apk the app itself is the shorter one, and the
  // ordering is total so the answer does not depend on readdir order.
  return [...pool].sort((a, b) => baseName(a).length - baseName(b).length || baseName(a).localeCompare(baseName(b)))[0];
}

// PURE. The APK an output listing names. AGP writes
// <apk dir>/output-metadata.json after every assemble:
//   { "elements": [ { "outputFile": "app-debug.apk", ... } ] }
// This is the listing the plan asks the APK be verified against rather than
// hardcoded -- it is written by the build that just ran, so it is right about
// flavours, splits and renames in a way a hardcoded name is not.
export function parseOutputMetadata(text: unknown): string | null | undefined {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    return null;
  }
  const elements = Array.isArray(parsed?.elements) ? parsed.elements : [];
  const files = elements
    .map((e: { outputFile?: unknown }) => e?.outputFile)
    .filter((f: unknown) => typeof f === 'string');
  return pickDebugApk(files);
}

// PURE. The APK the transcript names, when it names one.
//
// `assembleDebug` does not normally print the path -- the metadata file above
// is the reliable source -- but several things in the React Native toolchain
// do (the community CLI's install step, custom copy tasks, `installDebug`),
// and a project whose build moves the APK somewhere else says so only here.
const TRANSCRIPT_APK = [
  /(?:Wrote APK to|APK (?:written|generated|copied) (?:to|at)|Built the following APKs?:)\s*(\S+\.apk)/i,
  /Installing APK '([^']+\.apk)'/i,
];

export function parseApkFromTranscript(text: unknown): string | null | undefined {
  if (typeof text !== 'string') return null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    for (const pattern of TRANSCRIPT_APK) {
      const m = pattern.exec(line);
      if (m) return m[1];
    }
  }
  return null;
}

// PURE. The gradle variant name a directory path under outputs/apk spells:
// AGP writes `apk/<flavor>/<buildType>` (the flavor-combination directory
// keeps its camelCase, the build type is lowercased), and the variant is the
// camelCase join -- ['production', 'debug'] is `productionDebug`, ['debug']
// alone is `debug`.
export function variantNameOf(segments: unknown): string {
  return (Array.isArray(segments) ? segments : [])
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s: string, i: number) => (i === 0 ? s : `${s[0]!.toUpperCase()}${s.slice(1)}`))
    .join('');
}

// The APK a single output directory holds: the metadata file AGP wrote there
// if it names one that exists, the listing otherwise.
function apkInDir(dir: string): string | null {
  const metadata = readOrNull(join(dir, 'output-metadata.json'));
  if (metadata) {
    const named = parseOutputMetadata(metadata);
    if (named) {
      const abs = named.startsWith('/') ? named : join(dir, named);
      if (existsSync(abs)) return abs;
    }
  }
  const listed = pickDebugApk(safeList(dir));
  return listed ? join(dir, listed) : null;
}

// Every directory under outputs/apk, depth-first, as segments relative to it.
// Depth-capped because outputs/apk is at most <flavor>/<buildType> deep and a
// symlink cycle must not hang a build that already succeeded.
function listApkSubdirs(base: string, prefix: string[] = [], depth = 0): string[][] {
  if (depth > 3) return [];
  const dirs: string[][] = [];
  for (const name of safeList(base)) {
    const path = join(base, name);
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const rel = [...prefix, name];
    dirs.push(rel);
    dirs.push(...listApkSubdirs(path, rel, depth + 1));
  }
  return dirs;
}

// The output directory of a configured variant: the subdirectory of
// outputs/apk whose camelCase join names it. Matching the DIRECTORIES rather
// than composing `<flavor>/<buildType>` from the variant string means a
// multi-dimension flavor combination (`demoMinApi24Debug` ->
// apk/demoMinApi24/debug) needs no guess about where the flavor part ends.
function findVariantApkDir(root: string, variant: string): string | null {
  const base = apkOutputsDir(root);
  const wanted = variant.trim().toLowerCase();
  for (const segments of listApkSubdirs(base)) {
    if (variantNameOf(segments).toLowerCase() === wanted) return join(base, ...segments);
  }
  return null;
}

// Every installable `*-debug.apk` under outputs/apk, recursively. Intermediate
// outputs and androidTest APKs fall out of the name filter the same way they
// do in pickDebugApk.
function findDebugApksUnder(base: string): string[] {
  const found: string[] = [];
  for (const segments of [[], ...listApkSubdirs(base)]) {
    const dir = join(base, ...segments);
    for (const name of safeList(dir)) {
      if (!name.endsWith('-debug.apk')) continue;
      if (/-(?:unsigned|unaligned)\.apk$/.test(name)) continue;
      found.push(join(dir, name));
    }
  }
  return found.sort();
}

// What locateApk answers: the APK when exactly one candidate was found (with
// a note when it took the recursive fallback to find it), the candidate list
// when a flavored project left several and no variant setting picks one.
export interface LocateApkResult {
  apkPath?: string | null;
  note?: string | null;
  candidates?: string[];
}

// Thin: the sources against the disk, in order of authority for THIS build. A
// transcript path is what the build itself said it produced; with a variant
// configured, the variant's own output directory (`apk/<flavor>/<buildType>`)
// is the place AGP puts it; without one, the default `apk/debug` -- and when
// THAT is empty, a recursive search, because a flavored project's
// `assembleDebug` succeeds into `apk/<flavor>/debug/` and reporting that
// successful build as failed is exactly the bug this fallback removes.
export function locateApk(root: string, transcript = '', variant: string | null = null): LocateApkResult {
  const fromTranscript = parseApkFromTranscript(transcript);
  if (fromTranscript) {
    const abs = fromTranscript.startsWith('/') ? fromTranscript : join(androidDir(root), fromTranscript);
    if (existsSync(abs)) return { apkPath: abs };
  }

  if (variant) {
    const dir = findVariantApkDir(root, variant);
    const apk = dir ? apkInDir(dir) : null;
    return { apkPath: apk };
  }

  const direct = apkInDir(debugApkDir(root));
  if (direct) return { apkPath: direct };

  const found = findDebugApksUnder(apkOutputsDir(root));
  if (found.length === 1) {
    const apk = found[0]!;
    const rel = relative(apkOutputsDir(root), apk).split('/').slice(0, -1);
    const suggested = variantNameOf(rel);
    return {
      apkPath: apk,
      note:
        `no APK in ${relative(androidDir(root), debugApkDir(root))}; using ${relative(androidDir(root), apk)}` +
        `${suggested ? ` -- set the android.variant setting to "${suggested}" to build this variant explicitly` : ''}`,
    };
  }
  if (found.length > 1) return { apkPath: null, candidates: found };
  return { apkPath: null };
}

// PURE. Whether an APK a just-finished build "produced" actually predates the
// build -- a stale artifact carried into the workspace (a copied build/
// directory, a worktree carry-over), which installs and then runs code that is
// not this checkout's. The slop absorbs filesystem timestamp granularity.
export function staleApkRefusal({
  task,
  apkPath,
  mtimeMs,
  buildStartMs,
  slopMs = 2000,
}: {
  task: string;
  apkPath: string;
  mtimeMs: number;
  buildStartMs: number;
  slopMs?: number;
}): { code: string; reason: string; remedy: string } | null {
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(buildStartMs)) return null;
  if (mtimeMs >= buildStartMs - slopMs) return null;
  return {
    code: BUILD_ERROR,
    reason: `\`./gradlew ${task}\` succeeded, but the APK at ${apkPath} predates the build that just ran, so it is a stale artifact this run did not produce.`,
    remedy:
      'Delete android/app/build/outputs/apk and run again so gradle repackages the APK. If the build was UP-TO-DATE because a flavor redirects its output elsewhere, set the android.variant setting.',
  };
}

// The all-optional view of buildAndroid's outcomes: { ok, apkPath } on
// success, the failure shape (with the diagnostics extract) otherwise.
export type BuildAndroidResult = {
  ok?: boolean;
  apkPath?: string;
  apkNote?: string | null;
  failed?: boolean;
  code?: string;
  reason?: string;
  remedy?: string;
  androidDir?: string;
  gradlew?: string;
  diagnostics?: Diagnostic[];
  truncated?: number;
  lastLines: string[];
  durationMs: number;
};

// `./gradlew assembleDebug` (or `assemble<Variant>` when the android.variant
// setting names a flavored variant) with cwd android/.
//
// Every line of the transcript reaches the writer as it arrives (Contract 1,
// src "build", level debug, raw) rather than at the end: a four-minute build
// that is followed with `rn-iso logs --follow` has to show progress while it
// is happening, and a build killed halfway must still leave what it printed.
//
// No --console flag and no extra arguments: gradle already drops its rich
// console when stdout is a pipe, which it is here, and every argument added
// to this line is one more thing that can differ from what the project's own
// `./gradlew assembleDebug` does.
export async function buildAndroid(
  { root, logWriter, variant = null }: { root: string; logWriter?: NdjsonWriter | null; variant?: string | null },
  {
    spawnFn = null,
    now = Date.now,
    env = process.env,
    heartbeatMs = HEARTBEAT_INTERVAL_MS,
    onHeartbeat = (line: string) => console.error(line),
  }: {
    spawnFn?: SpawnFn | null;
    now?: () => number;
    env?: NodeJS.ProcessEnv;
    heartbeatMs?: number;
    onHeartbeat?: (line: string) => void;
  } = {},
): Promise<BuildAndroidResult> {
  const project = discoverAndroidProject(root);
  if (project.failed) return { ...project, diagnostics: [], truncated: 0, lastLines: [] as string[], durationMs: 0 };

  const sdk = androidHome();
  const refusal = androidSdkRefusal({
    sdkPath: sdk,
    sdkExists: existsSync(sdk),
    hasLocalProperties: existsSync(join(project.androidDir as string, 'local.properties')),
  });
  if (refusal)
    return { failed: true, ...refusal, diagnostics: [], truncated: 0, lastLines: [] as string[], durationMs: 0 };

  const spawn: SpawnFn = spawnFn || ((cmd, args, opts) => getExecutor().spawn(cmd, args, opts));
  const task = assembleTaskFor(variant);
  const startedAt = now();
  const tail: string[] = [];
  const window: string[] = [];
  // The heartbeat's activity hint: the last non-blank line gradle printed.
  let lastTranscriptLine = '';
  const push = (line: unknown) => {
    const msg = stripAnsi(String(line)).trimEnd();
    if (!msg.trim()) return;
    lastTranscriptLine = msg;
    tail.push(msg);
    if (tail.length > LAST_LINES) tail.shift();
    window.push(msg);
    if (window.length > TRANSCRIPT_LINES) window.shift();
    logWriter?.write?.({ src: 'build', level: 'debug', msg, raw: true, event: 'gradle' });
  };

  let child: ChildProcess;
  try {
    child = spawn(project.gradlew as string, [task], {
      cwd: project.androidDir,
      // stdin ignored: nothing in an assembleDebug should prompt, and a
      // prompt in a detached agent loop is indistinguishable from a hang.
      stdio: ['ignore', 'pipe', 'pipe'],
      // TERM=dumb keeps gradle off the rich console even when something
      // downstream hands it a tty; the escape sequences would be unreadable
      // inside a JSON string and unmatchable by `logs --grep`.
      env: { ...env, TERM: 'dumb', FORCE_COLOR: '0' },
    });
  } catch (err) {
    return spawnFailure(err, project, now() - startedAt);
  }

  const outReader = createLineReader(push);
  const errReader = createLineReader(push);
  child.stdout?.setEncoding?.('utf-8');
  child.stderr?.setEncoding?.('utf-8');
  child.stdout?.on('data', (chunk) => outReader.push(chunk));
  child.stderr?.on('data', (chunk) => errReader.push(chunk));

  // One stderr line roughly every 30s while gradle runs -- see the heartbeat
  // block in xcode.ts for why the silence between the fingerprint line and
  // completion is worth breaking. stdout stays untouched.
  const stopHeartbeat = startBuildHeartbeat({
    intervalMs: heartbeatMs,
    elapsed: () => now() - startedAt,
    lastLine: () => lastTranscriptLine,
    emit: onHeartbeat,
  });

  const result = await waitForChild(child);
  stopHeartbeat();
  outReader.flush();
  errReader.flush();
  const durationMs = now() - startedAt;
  const transcript = window.join('\n');

  if (result.error) return { ...spawnFailure(result.error, project, durationMs), lastLines: tail.slice() };

  if (result.code !== 0) {
    const how = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`;
    const { shown, truncated } = capDiagnostics(extractGradleDiagnostics(transcript));
    return {
      failed: true,
      code: BUILD_ERROR,
      reason: `\`./gradlew ${task}\` failed (${how}).`,
      diagnostics: shown,
      truncated,
      lastLines: tail.slice(),
      durationMs,
    };
  }

  const located = locateApk(root, transcript, variant);
  if (!located.apkPath && located.candidates?.length) {
    // More than one debug APK and nothing configured to pick one: choosing by
    // recency or by name here installs SOME flavor, silently, and the wrong
    // one runs against the wrong applicationId. Refuse with the list instead.
    return {
      failed: true,
      code: BUILD_ERROR,
      reason: `\`./gradlew ${task}\` left ${located.candidates.length} debug APKs under ${apkOutputsDir(root)}, and nothing says which flavor to install.`,
      remedy: `Set the android.variant setting to the variant to install -- e.g. {"android": {"variant": "${variantNameOf(relative(apkOutputsDir(root), located.candidates[0]!).split('/').slice(0, -1))}"}} in .rn-iso.json.`,
      diagnostics: [],
      truncated: 0,
      lastLines: located.candidates.map((c) => relative(androidDir(root), c)),
      durationMs,
    };
  }
  if (!located.apkPath) {
    // Exit 0 with no artifact is a build that did nothing -- a task wired to
    // a flavour that produces its output elsewhere, or one that was skipped
    // entirely. Reporting success here would install a stale APK from a
    // previous run, or nothing at all.
    return {
      failed: true,
      code: BUILD_ERROR,
      reason: variant
        ? `\`./gradlew ${task}\` succeeded but produced no APK under ${apkOutputsDir(root)} for variant "${variant}".`
        : `\`./gradlew ${task}\` succeeded but produced no APK in ${debugApkDir(root)}.`,
      remedy: variant
        ? `Check that the android.variant setting ("${variant}") names a real variant (\`./gradlew :app:tasks\` lists the assemble tasks).`
        : `Check that ${task} builds the app module (\`./gradlew :app:${task}\` in android/) and that no flavour redirects the output.`,
      diagnostics: [],
      truncated: 0,
      lastLines: tail.slice(),
      durationMs,
    };
  }
  const apkPath = located.apkPath;

  // The freshness guard: a build that just ran must hand back an APK that
  // build wrote. An older one is a carried artifact -- the manual `cp` that
  // papered over the flavored-output bug produced exactly this, and installing
  // it reports success for code that never compiled.
  let mtimeMs = Number.NaN;
  try {
    mtimeMs = statSync(apkPath).mtimeMs;
  } catch {
    // Unstattable is unreadable; let the install step report it.
  }
  const stale = staleApkRefusal({ task, apkPath, mtimeMs, buildStartMs: startedAt });
  if (stale) {
    return { failed: true, ...stale, diagnostics: [], truncated: 0, lastLines: tail.slice(), durationMs };
  }

  return { ok: true, apkPath, apkNote: located.note ?? null, durationMs, lastLines: tail.slice() };
}

// A gradlew that will not execute is almost always the permission bit -- git
// on a machine with core.fileMode off, or an archive extracted without it --
// and "spawn EACCES" alone sends an agent looking at the wrong thing.
function spawnFailure(err: unknown, project: AndroidProjectResult, durationMs: number) {
  const nodeErr = err as NodeJS.ErrnoException;
  const message = String(nodeErr?.message || err || '');
  const permissionDenied = nodeErr?.code === 'EACCES' || /EACCES|permission denied/i.test(message);
  return {
    failed: true,
    code: BUILD_ERROR,
    reason: `Could not run ${project.gradlew}: ${message}`,
    remedy: permissionDenied
      ? `Make the wrapper executable: \`chmod +x ${project.gradlew}\`.`
      : 'Check that the gradle wrapper is intact (android/gradlew and android/gradle/wrapper/) and that JAVA_HOME points at a JDK 17 install.',
    diagnostics: [],
    truncated: 0,
    lastLines: [],
    durationMs,
  };
}

function baseName(file: string) {
  const parts = String(file).split('/');
  // split always yields >= 1 element, so the last index is present; the
  // fallback only satisfies the index type and is never taken.
  return parts[parts.length - 1] ?? String(file);
}

function safeList(dir: string) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readOrNull(file: string) {
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}
