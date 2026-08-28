import type { ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import chalk from 'chalk';
import { getExecutor, type Executor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { sharedCompilationCache, workspaceDerivedData } from '../paths.ts';
import { createLineReader } from '../process-output.ts';
import { capDiagnostics, describeDiagnostic, type Diagnostic, extractXcodeDiagnostics } from './errors-xcode.ts';
import { cleanLine } from '../supervisor/server-expo.ts';

const IOS_DIR = 'ios';

const PREBUILD_REMEDY =
  'Generate it with `npx expo prebuild -p ios` (stim-cli ios does this automatically for an Expo project with no ios/ directory), or commit the native project.';

interface XcodeProject {
  kind?: string;
  flag?: string;
  file?: string;
  name?: string | null;
  dir?: string;
  path?: string;
  error?: { code: string; message: string; remedy: string | null };
}

interface SchemeResult {
  error?: { code: string; message: string; remedy: string };
  scheme?: string;
  schemes?: string[];
}

function buildFailure(message: string, remedy: string | null): XcodeProject {
  return { error: { code: 'STIM_CLI_BUILD_FAILED', message, remedy } };
}

export function pickXcodeProject(entries: unknown): { kind: string; flag: string; file: string; name: string } | null {
  const names = (Array.isArray(entries) ? entries : []).filter((e) => typeof e === 'string');
  const workspaces = names.filter((e) => e.endsWith('.xcworkspace')).toSorted();
  const projects = names.filter((e) => e.endsWith('.xcodeproj')).toSorted();

  if (workspaces.length > 0) {
    const projectNames = new Set(projects.map((p) => basename(p, '.xcodeproj')));
    const match = workspaces.find((w) => projectNames.has(basename(w, '.xcworkspace')));
    const file = match || workspaces[0];
    if (file === undefined) return null;
    return { kind: 'workspace', flag: '-workspace', file, name: basename(file, '.xcworkspace') };
  }
  if (projects.length > 0) {
    const file = projects[0];
    if (file === undefined) return null;
    return { kind: 'project', flag: '-project', file, name: basename(file, '.xcodeproj') };
  }
  return null;
}

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

export function parseSchemeList(text: unknown): { name: string | null; schemes: string[] } {
  const empty = { name: null, schemes: [] };
  if (typeof text !== 'string') return empty;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return empty;
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return empty;
  }
  if (!data || typeof data !== 'object') return empty;
  const record = data as { workspace?: unknown; project?: unknown };
  const container = record.workspace || record.project;
  if (!container || typeof container !== 'object') return empty;
  const info = container as { schemes?: unknown; name?: unknown };
  const schemes: string[] = Array.isArray(info.schemes)
    ? info.schemes.filter((s: unknown) => typeof s === 'string' && s.trim() !== '')
    : [];
  return { name: typeof info.name === 'string' ? info.name : null, schemes };
}

const TEST_SCHEME = /(?:UI)?Tests$/;

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

const LIST_TIMEOUT_MS = 180000;

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

export function resolveScheme(project: XcodeProject, { exec = null }: { exec?: Executor | null } = {}): SchemeResult {
  const listing = listSchemes(project, { exec });
  if (listing === null) {
    return {
      error: {
        code: 'STIM_CLI_NO_SCHEME',
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
        code: 'STIM_CLI_NO_SCHEME',
        message: `No buildable scheme found in ${project.path} (schemes: ${found}).`,
        remedy:
          'Share the app scheme in Xcode (Product > Scheme > Manage Schemes, tick Shared) so xcodebuild can see it.',
      },
    };
  }
  return { scheme, schemes: listing.schemes };
}

export const COMPILATION_CACHE_MIN_XCODE = 26;

const PREFIX_MAP_TARGET = '/^src';

export function prefixMapping(workspaceRoot: string): string {
  return `${String(workspaceRoot).replace(/\/+$/, '')}=${PREFIX_MAP_TARGET}`;
}

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

export function ccacheEnabled(podfileProperties: unknown): boolean {
  if (!podfileProperties || typeof podfileProperties !== 'object') return false;
  return (podfileProperties as Record<string, unknown>)['apple.ccacheEnabled'] === 'true';
}

export function readPodfileProperties(root: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, IOS_DIR, 'Podfile.properties.json'), 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

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

export function parseXcodeMajor(output: unknown): number | null {
  const m = /^Xcode\s+(\d+)/m.exec(String(output || ''));
  if (!m) return null;
  const digits = m[1];
  if (digits === undefined) return null;
  const major = parseInt(digits, 10);
  return Number.isFinite(major) ? major : null;
}

export function detectXcodeMajor(exec: Executor | null = null): number | null {
  return parseXcodeMajor((exec || getExecutor()).runQuiet('xcodebuild -version', { timeoutMs: 10000 }));
}

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
        `compilation cache on for this build: CAS at ${casPath} (stim-cli sets it on its own xcodebuild; the Podfile is not touched)`,
      ),
    );
  }
  return settings;
}

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
    ...buildSettings,
  ];
}

export function productsDir(
  derivedDataPath: string,
  { configuration = 'Debug', sdk = 'iphonesimulator' }: { configuration?: string; sdk?: string } = {},
): string {
  return join(derivedDataPath, 'Build', 'Products', `${configuration}-${sdk}`);
}

export function pickAppBundle(entries: unknown, preferredName: string | null = null): string | null | undefined {
  const apps = (Array.isArray(entries) ? entries : [])
    .filter((e) => typeof e === 'string' && e.endsWith('.app'))
    .toSorted();
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

export function parseBundleId(plistJson: unknown): string | null {
  if (typeof plistJson !== 'string') return null;
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

export function readBundleId(appPath: string, { exec = null }: { exec?: Executor | null } = {}): string | null {
  const executor = exec || getExecutor();
  try {
    const json = executor.runFile('plutil', ['-convert', 'json', '-o', '-', join(appPath, 'Info.plist')]);
    const id = parseBundleId(json);
    if (id) return id;
  } catch {}
  try {
    const value = executor.runFile('defaults', ['read', join(appPath, 'Info'), 'CFBundleIdentifier']);
    const trimmed = String(value).trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

export function tailLines(lines: unknown, count = 5): string[] {
  const nonEmpty = (Array.isArray(lines) ? lines : []).filter((l) => typeof l === 'string' && l.trim() !== '');
  return nonEmpty.slice(-count);
}

export const HEARTBEAT_INTERVAL_MS = 30_000;

const HEARTBEAT_HINT_LENGTH = 80;

export function formatHeartbeatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

export function heartbeatLine(elapsedMs: number, lastLine: string, label = 'build'): string {
  const hint =
    lastLine.length > HEARTBEAT_HINT_LENGTH ? `${lastLine.slice(0, HEARTBEAT_HINT_LENGTH - 3)}...` : lastLine;
  const activity = hint.trim() === '' ? '' : `: ${hint}`;
  return `${label.padEnd(11)} still running (${formatHeartbeatElapsed(elapsedMs)})${activity}`;
}

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

  logWriter.write({
    src: 'build',
    level: 'info',
    msg: `xcodebuild ${args.join(' ')}`,
    event: 'build_start',
  });

  const transcript: string[] = [];
  let lastTranscriptLine = '';
  const onLine = (line: unknown) => {
    const msg = cleanLine(line);
    transcript.push(msg);
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
        NSUnbufferedIO: 'YES',
        FORCE_COLOR: '0',
      },
    });
  } catch (err) {
    const message = `Could not run xcodebuild: ${(err as Error).message}`;
    const remedy = 'Install Xcode and select it with `sudo xcode-select -s /Applications/Xcode.app`.';
    reportError(message, remedy);
    return failedResult({ code: 'STIM_CLI_BUILD_FAILED', diagnostics: [{ message, remedy }], durationMs: elapsed() });
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

  const outcome = await new Promise<{ code?: number | null; signal?: NodeJS.Signals | null; error?: Error }>(
    (settlePromise) => {
      let settled = false;
      const finish = (value: { code?: number | null; signal?: NodeJS.Signals | null; error?: Error }) => {
        if (settled) return;
        settled = true;
        outReader.flush();
        errReader.flush();
        settlePromise(value);
      };
      child.on('close', (code, signal) => finish({ code, signal }));
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
      code: 'STIM_CLI_BUILD_FAILED',
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
      reportError(
        `xcodebuild exited ${outcome.code ?? `on ${outcome.signal}`} with no recognizable diagnostic; see the transcript above.`,
        null,
      );
    }
    return failedResult({
      code: 'STIM_CLI_BUILD_FAILED',
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
      code: 'STIM_CLI_BUILD_FAILED',
      diagnostics: [{ message, remedy }],
      durationMs,
      exitCode: 0,
      transcriptLines: transcript.length,
      tail: tailLines(transcript),
    });
  }

  const bundleId = readBundleId(appPath, { exec: executor });
  if (!bundleId) {
    const message = `No readable CFBundleIdentifier in ${join(appPath, 'Info.plist')}.`;
    const remedy = "Check PRODUCT_BUNDLE_IDENTIFIER in the target's Debug configuration.";
    reportError(message, remedy);
    return failedResult({
      code: 'STIM_CLI_BUILD_FAILED',
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
