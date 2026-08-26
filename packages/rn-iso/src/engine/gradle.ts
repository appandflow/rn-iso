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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getExecutor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { androidHome } from '../sim/android.ts';
import { createLineReader, stripAnsi } from '../supervisor/server-expo.ts';
import { waitForChild } from './deps.ts';
import { capDiagnostics, extractGradleDiagnostics } from './errors-gradle.ts';

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
export const ASSEMBLE_TASK = 'assembleDebug';

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

export function debugApkDir(root: string) {
  return join(androidDir(root), 'app', 'build', 'outputs', 'apk', 'debug');
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
}) {
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
export function pickDebugApk(files: unknown) {
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
export function parseOutputMetadata(text: unknown) {
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

export function parseApkFromTranscript(text: unknown) {
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

// Thin: the three sources above against the disk, in order of authority for
// THIS build. A transcript path is what the build itself said it produced; the
// metadata file is what AGP recorded; the directory listing is the fallback
// for a build that reported neither.
export function locateDebugApk(root: string, transcript = '') {
  const dir = debugApkDir(root);

  const fromTranscript = parseApkFromTranscript(transcript);
  if (fromTranscript) {
    const abs = fromTranscript.startsWith('/') ? fromTranscript : join(androidDir(root), fromTranscript);
    if (existsSync(abs)) return abs;
  }

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

// `./gradlew assembleDebug` with cwd android/.
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
  { root, logWriter }: { root: string; logWriter?: NdjsonWriter | null },
  {
    spawnFn = null,
    now = Date.now,
    env = process.env,
  }: { spawnFn?: SpawnFn | null; now?: () => number; env?: NodeJS.ProcessEnv } = {},
) {
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
  const startedAt = now();
  const tail: string[] = [];
  const window: string[] = [];
  const push = (line: unknown) => {
    const msg = stripAnsi(String(line)).trimEnd();
    if (!msg.trim()) return;
    tail.push(msg);
    if (tail.length > LAST_LINES) tail.shift();
    window.push(msg);
    if (window.length > TRANSCRIPT_LINES) window.shift();
    logWriter?.write?.({ src: 'build', level: 'debug', msg, raw: true, event: 'gradle' });
  };

  let child: ChildProcess;
  try {
    child = spawn(project.gradlew as string, [ASSEMBLE_TASK], {
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

  const result = await waitForChild(child);
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
      reason: `\`./gradlew ${ASSEMBLE_TASK}\` failed (${how}).`,
      diagnostics: shown,
      truncated,
      lastLines: tail.slice(),
      durationMs,
    };
  }

  const apkPath = locateDebugApk(root, transcript);
  if (!apkPath) {
    // Exit 0 with no artifact is a build that did nothing -- an `assembleDebug`
    // wired to a flavour that produces its output elsewhere, or a task that was
    // skipped entirely. Reporting success here would install a stale APK from
    // a previous run, or nothing at all.
    return {
      failed: true,
      code: BUILD_ERROR,
      reason: `\`./gradlew ${ASSEMBLE_TASK}\` succeeded but produced no APK in ${debugApkDir(root)}.`,
      remedy:
        'Check that assembleDebug builds the app module (`./gradlew :app:assembleDebug` in android/) and that no flavour redirects the output.',
      diagnostics: [],
      truncated: 0,
      lastLines: tail.slice(),
      durationMs,
    };
  }

  return { ok: true, apkPath, durationMs, lastLines: tail.slice() };
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
