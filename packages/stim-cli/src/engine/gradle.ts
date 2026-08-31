import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import chalk from 'chalk';
import { getExecutor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { createLineReader, stripAnsi, waitForChild } from '../process-output.ts';
import { androidHome } from '../sim/android.ts';
import { capDiagnostics, type Diagnostic, extractGradleDiagnostics } from './errors-gradle.ts';
import { HEARTBEAT_INTERVAL_MS, startBuildHeartbeat } from './xcode.ts';

export const BUILD_ERROR = 'STIM_BUILD_FAILED';

type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess;

interface AndroidProjectResult {
  failed?: boolean;
  code?: string;
  reason?: string;
  remedy?: string;
  androidDir?: string;
  gradlew?: string;
}

export const ASSEMBLE_TASK = 'assembleDebug';

export function assembleTaskFor(variant?: string | null): string {
  const name = typeof variant === 'string' ? variant.trim() : '';
  if (!name) return ASSEMBLE_TASK;
  return `assemble${name[0]!.toUpperCase()}${name.slice(1)}`;
}

const LAST_LINES = 20;

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

export function discoverAndroidProject(root: string): AndroidProjectResult {
  const dir = androidDir(root);
  if (!existsSync(dir)) {
    return {
      failed: true,
      code: BUILD_ERROR,
      reason: `No android/ directory in ${root}.`,
      remedy:
        'Generate it (`npx expo prebuild -p android`, which `stim android` runs itself on an Expo project) or check out the native sources.',
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

export function pickDebugApk(files: unknown): string | null | undefined {
  const list = (Array.isArray(files) ? files : [])
    .filter((f) => typeof f === 'string' && f.endsWith('.apk'))
    .filter((f) => !/-(?:unsigned|unaligned)\.apk$/.test(f));
  if (list.length === 0) return null;
  const named = list.find((f) => baseName(f) === 'app-debug.apk');
  if (named) return named;
  const debug = list.filter((f) => baseName(f).endsWith('-debug.apk'));
  const pool = debug.length ? debug : list;
  return pool.toSorted((a, b) => baseName(a).length - baseName(b).length || baseName(a).localeCompare(baseName(b)))[0];
}

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

export function variantNameOf(segments: unknown): string {
  return (Array.isArray(segments) ? segments : [])
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s: string, i: number) => (i === 0 ? s : `${s[0]!.toUpperCase()}${s.slice(1)}`))
    .join('');
}

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

function findVariantApkDir(root: string, variant: string): string | null {
  const base = apkOutputsDir(root);
  const wanted = variant.trim().toLowerCase();
  for (const segments of listApkSubdirs(base)) {
    if (variantNameOf(segments).toLowerCase() === wanted) return join(base, ...segments);
  }
  return null;
}

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
  return found.toSorted();
}

export interface LocateApkResult {
  apkPath?: string | null;
  note?: string | null;
  candidates?: string[];
}

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

export function gradleArgs(task: string, { buildCache = true }: { buildCache?: boolean } = {}): string[] {
  return buildCache ? [task, '--build-cache'] : [task];
}

export async function buildAndroid(
  { root, logWriter, variant = null }: { root: string; logWriter?: NdjsonWriter | null; variant?: string | null },
  {
    spawnFn = null,
    now = Date.now,
    env = process.env,
    buildCache = true,
    heartbeatMs = HEARTBEAT_INTERVAL_MS,
    onHeartbeat = (line: string) => console.error(line),
    onNote = (line: string) => console.error(line),
  }: {
    spawnFn?: SpawnFn | null;
    now?: () => number;
    env?: NodeJS.ProcessEnv;
    buildCache?: boolean;
    heartbeatMs?: number;
    onHeartbeat?: (line: string) => void;
    onNote?: (line: string) => void;
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
  const args = gradleArgs(task, { buildCache });
  if (buildCache) {
    onNote(
      chalk.dim(
        'gradle build cache on for this build: --build-cache (shared under the Gradle user home; gradle.properties is not touched)',
      ),
    );
  }

  logWriter?.write?.({
    src: 'build',
    level: 'info',
    msg: `${project.gradlew as string} ${args.join(' ')}`,
    event: 'build_start',
  });

  const startedAt = now();
  const tail: string[] = [];
  const window: string[] = [];
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
    child = spawn(project.gradlew as string, args, {
      cwd: project.androidDir,
      stdio: ['ignore', 'pipe', 'pipe'],
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
    return {
      failed: true,
      code: BUILD_ERROR,
      reason: `\`./gradlew ${task}\` left ${located.candidates.length} debug APKs under ${apkOutputsDir(root)}, and nothing says which flavor to install.`,
      remedy: `Set the android.variant setting to the variant to install -- e.g. {"android": {"variant": "${variantNameOf(relative(apkOutputsDir(root), located.candidates[0]!).split('/').slice(0, -1))}"}} in .stim.json.`,
      diagnostics: [],
      truncated: 0,
      lastLines: located.candidates.map((c) => relative(androidDir(root), c)),
      durationMs,
    };
  }
  if (!located.apkPath) {
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

  let mtimeMs = Number.NaN;
  try {
    mtimeMs = statSync(apkPath).mtimeMs;
  } catch {}
  const stale = staleApkRefusal({ task, apkPath, mtimeMs, buildStartMs: startedAt });
  if (stale) {
    return { failed: true, ...stale, diagnostics: [], truncated: 0, lastLines: tail.slice(), durationMs };
  }

  return { ok: true, apkPath, apkNote: located.note ?? null, durationMs, lastLines: tail.slice() };
}

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
