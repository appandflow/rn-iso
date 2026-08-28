import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { format } from 'node:util';
import { getExecutor } from '../exec.ts';
import { createNdjsonWriter, type NdjsonWriter } from '../ndjson.ts';
import { workspaceLogsDir } from '../paths.ts';
import { stripAnsi } from '../process-output.ts';
import { resolvePackageJson } from '../project.ts';
import { expoBinFromPackage, expoBinPath, findBinUpward } from '../supervisor/server-expo.ts';

export const EAS_PROVIDER_PACKAGE = 'eas-build-cache-provider';

export const LOCAL_PROVIDER_PACKAGE = '@rn-iso/expo-build-cache';

export const RESOLVE_TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 60_000;
export const CONFIG_TIMEOUT_MS = 30_000;

const DYNAMIC_CONFIG_FILES = ['app.config.ts', 'app.config.js', 'app.config.mjs', 'app.config.cjs'];

const TIMED_OUT = Symbol('timed-out');

type ProjectConfig = Record<string, unknown>;

type ExecFileFn = (file: string, args: string[], opts?: { timeoutMs?: number }) => string;

interface ReadProjectConfigResult {
  config?: ProjectConfig | null;
  source?: string | null;
  unavailable?: string;
}

interface NormalizedProvider {
  name?: string;
  reference?: string;
  options?: Record<string, unknown>;
  invalid?: string;
}

export interface ProviderPlugin {
  resolveBuildCache?: (props: unknown, options: unknown) => unknown;
  resolveRemoteBuildCache?: (props: unknown, options: unknown) => unknown;
  uploadBuildCache?: (props: unknown, options: unknown) => unknown;
  uploadRemoteBuildCache?: (props: unknown, options: unknown) => unknown;
  calculateFingerprintHash?: (props: unknown, options: unknown) => unknown;
}

interface LoadedProvider {
  plugin: ProviderPlugin;
  options: Record<string, unknown>;
}

export interface LoadProjectProviderResult {
  provider?: LoadedProvider;
  name?: string;
  owner?: string | null;
  none?: true;
  unavailable?: string;
}

interface WhoamiResult {
  loggedOut?: true;
  unknown?: string;
  loggedIn?: true;
  account?: string;
  accounts?: string[] | null;
  viaToken?: boolean;
}

interface EasAuthNoteStatus {
  code?: string;
  account?: string | null;
  owner?: string;
  reason?: string;
  phase?: 'resolve' | 'upload';
}

export interface EasAuthResult {
  ok?: true;
  account?: string | null;
  accounts?: string[] | null;
  viaToken?: boolean;
  source?: string;
  failed?: true;
  code?: 'no-cli' | 'logged-out' | 'wrong-account';
  reason?: string;
  remedy?: string;
  owner?: string;
  unknown?: string;
}

export interface RemoteCacheResolveResult {
  appPath?: string;
  failed?: string;
  timedOut?: true;
}

export interface RemoteCacheUploadResult {
  uploaded?: true;
  destination?: string;
  failed?: string;
  timedOut?: true;
  skipped?: true;
}

interface CaptureFrame {
  lines: string[];
  pending: string;
  onLine?: ((line: string) => void) | null;
  writer: () => NdjsonWriter | null;
  close: () => void;
}

interface BudgetOutcome {
  value?: unknown;
  error?: unknown;
  timedOut?: true;
  lines: string[];
}

export function dynamicConfigFile(root: string): string | null {
  for (const name of DYNAMIC_CONFIG_FILES) {
    if (existsSync(join(root, name))) return name;
  }
  return null;
}

export function providerFromConfig(config?: ProjectConfig | null): unknown {
  if (!config || typeof config !== 'object') return null;
  const expoField = (config as { expo?: unknown }).expo;
  const exp = (expoField && typeof expoField === 'object' ? expoField : config) as {
    buildCacheProvider?: unknown;
    experiments?: { buildCacheProvider?: unknown };
  };
  return exp.buildCacheProvider ?? exp.experiments?.buildCacheProvider ?? null;
}

export function ownerFromConfig(config?: ProjectConfig | null): string | null {
  if (!config || typeof config !== 'object') return null;
  const expoField = (config as { expo?: unknown }).expo;
  const exp = (expoField && typeof expoField === 'object' ? expoField : config) as { owner?: unknown };
  const owner = exp.owner;
  return typeof owner === 'string' && owner.trim() !== '' ? owner.trim() : null;
}

export function normalizeProvider(raw: unknown): NormalizedProvider | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw === 'eas') return { name: 'eas', reference: EAS_PROVIDER_PACKAGE, options: {} };
  if (typeof raw === 'object') {
    const obj = raw as { plugin?: unknown; options?: unknown };
    if (typeof obj.plugin === 'string' && obj.plugin.trim() !== '') {
      const reference = obj.plugin.trim();
      return {
        name: reference,
        reference,
        options: obj.options && typeof obj.options === 'object' ? (obj.options as Record<string, unknown>) : {},
      };
    }
  }
  return { invalid: typeof raw === 'string' ? `"${raw}"` : JSON.stringify(raw) };
}

export function runOptionsFor(platform?: string | null): { variant: string } | { configuration: string } {
  return platform === 'android' ? { variant: 'debug' } : { configuration: 'Debug' };
}

export function isProviderPlugin(plugin: unknown): plugin is ProviderPlugin {
  if (!plugin || typeof plugin !== 'object') return false;
  const p = plugin as ProviderPlugin;
  const resolves = typeof p.resolveBuildCache === 'function' || typeof p.resolveRemoteBuildCache === 'function';
  const uploads = typeof p.uploadBuildCache === 'function' || typeof p.uploadRemoteBuildCache === 'function';
  return resolves && uploads;
}

export function cacheLevel(value: unknown): 'local' | 'remote' | false {
  return value === 'local' || value === 'remote' ? value : false;
}

export function exitAfterFlush(
  code = 0,
  {
    exit = (c: number) => process.exit(c),
    stream = process.stdout,
  }: { exit?: (code: number) => void; stream?: NodeJS.WriteStream } = {},
): void {
  try {
    stream.write('', () => exit(code));
  } catch {
    exit(code);
  }
}

export function readProjectConfig(
  root: string,
  { run = null, timeoutMs = CONFIG_TIMEOUT_MS }: { run?: ExecFileFn | null; timeoutMs?: number } = {},
): ReadProjectConfigResult {
  const dynamic = dynamicConfigFile(root);
  if (!dynamic) {
    const file = join(root, 'app.json');
    if (!existsSync(file)) return { config: null, source: null };
    try {
      return { config: JSON.parse(readFileSync(file, 'utf-8')), source: 'app.json' };
    } catch (err) {
      return { unavailable: `app.json could not be parsed: ${firstLine(err)}` };
    }
  }

  const bin = expoBinPath(root);
  if (!bin) {
    return {
      unavailable:
        `${dynamic} is code, so it has to be evaluated to read its buildCacheProvider, ` +
        'and the `expo` package is not resolvable from this project ' +
        '(no expo/package.json to read a bin from, and no node_modules/.bin/expo here or in any parent)',
    };
  }
  const exec: ExecFileFn = run || ((file, args, opts) => getExecutor().runFile(file, args, opts));
  let stdout;
  try {
    stdout = exec(bin, ['config', '--json', root], { timeoutMs });
  } catch (err) {
    return { unavailable: `\`expo config --json\` failed: ${firstLine(err)}` };
  }
  try {
    return { config: JSON.parse(String(stdout)), source: dynamic };
  } catch (err) {
    return { unavailable: `\`expo config --json\` did not print JSON: ${firstLine(err)}` };
  }
}

export async function loadPlugin(
  projectRoot: string,
  reference: string,
  { requireFrom = null }: { requireFrom?: ((root: string) => NodeRequire) | null } = {},
): Promise<ProviderPlugin> {
  const localRequire = requireFrom ? requireFrom(projectRoot) : createRequire(join(projectRoot, 'package.json'));
  const file = localRequire.resolve(reference);
  let mod;
  try {
    mod = localRequire(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ERR_REQUIRE_ESM') throw err;
    mod = await import(pathToFileURL(file).href);
  }
  const plugin = mod?.default ?? mod;
  if (!isProviderPlugin(plugin)) {
    throw new Error(`"${reference}" does not export resolveBuildCache and uploadBuildCache functions`);
  }
  return plugin;
}

export async function loadProjectProvider(
  projectRoot: string,
  {
    isExpo = true,
    run = null,
    requireFrom = null,
    timeoutMs = CONFIG_TIMEOUT_MS,
  }: {
    isExpo?: boolean;
    run?: ExecFileFn | null;
    requireFrom?: ((root: string) => NodeRequire) | null;
    timeoutMs?: number;
  } = {},
): Promise<LoadProjectProviderResult> {
  if (!isExpo) return { none: true };

  const read = readProjectConfig(projectRoot, { run, timeoutMs });
  if (read.unavailable) return { unavailable: read.unavailable };

  const normalized = normalizeProvider(providerFromConfig(read.config));
  if (!normalized) return { none: true };
  if (normalized.invalid) {
    return { unavailable: `buildCacheProvider is ${normalized.invalid}, which is not "eas" or { plugin: <module> }` };
  }
  if (normalized.reference === LOCAL_PROVIDER_PACKAGE) return { none: true };

  let plugin: ProviderPlugin;
  try {
    plugin = await loadPlugin(projectRoot, normalized.reference!, { requireFrom });
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException)?.code === 'MODULE_NOT_FOUND';
    return {
      unavailable:
        normalized.name === 'eas' && missing
          ? `the EAS build cache needs the \`${EAS_PROVIDER_PACKAGE}\` package, which is not installed in this project`
          : `${normalized.name} could not be loaded: ${firstLine(err)}`,
    };
  }
  return {
    provider: { plugin, options: normalized.options ?? {} },
    name: normalized.name,
    owner: ownerFromConfig(read.config),
  };
}

export const WHOAMI_TIMEOUT_MS = 15_000;

const EAS_CLI_PACKAGE = 'eas-cli';
const EAS_CLI_BIN = 'eas';

export function parseWhoami({
  stdout = '',
  stderr = '',
  exitCode = 0,
}: { stdout?: string; stderr?: string; exitCode?: number } = {}): WhoamiResult {
  const out = stripAnsi(stdout);
  const combined = `${out}\n${stripAnsi(stderr)}`;
  if (/^\s*Not logged in\s*$/m.test(combined)) return { loggedOut: true };
  if (exitCode !== 0) {
    return { unknown: firstLine(combined.trim() || `eas whoami exited ${exitCode}`) };
  }
  const lines = out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return { unknown: 'eas whoami printed nothing' };

  const raw = lines[0];
  if (raw === undefined) return { unknown: 'eas whoami printed nothing' };
  const viaToken = /\(authenticated using EXPO_TOKEN\)\s*$/.test(raw);
  const display = raw.replace(/\s*\(authenticated using EXPO_TOKEN\)\s*$/, '').trim();

  const accounts: string[] = [];
  for (const line of lines) {
    const m = /^\u2022\s*(\S+)\s*\(Role:/.exec(line);
    const name = m?.[1];
    if (name !== undefined) accounts.push(name);
  }
  if (accounts.length === 0 && !display.endsWith('(robot)') && display !== 'robot') {
    accounts.push(display);
  }
  return {
    loggedIn: true,
    account: display,
    accounts: accounts.length ? accounts : null,
    viaToken,
  };
}

export function isEasAuthFailureText(text?: string | null): boolean {
  const t = stripAnsi(text || '');
  if (t.trim() === '') return false;
  return (
    /not logged in/i.test(t) ||
    /\beas login\b/i.test(t) ||
    /EXPO_TOKEN/.test(t) ||
    /unauthorized/i.test(t) ||
    /not authorized/i.test(t) ||
    /authentication (failed|required)/i.test(t)
  );
}

export function easAuthNote(status?: EasAuthNoteStatus | null): string | null {
  const { code, account, owner, reason, phase = 'resolve' } = status || {};
  const because = reason ? ` (${reason})` : '';
  if (code === 'logged-out') {
    return (
      `eas is not authenticated${because} -- run \`eas login\` (or set EXPO_TOKEN); ` +
      (phase === 'upload' ? 'this build stayed in the local cache' : 'building with the local cache only')
    );
  }
  if (code === 'wrong-account') {
    return (
      `eas is authenticated as ${account}, and this project's owner is ${owner} -- ` +
      `run \`eas login\` as a member of ${owner} (or set EXPO_TOKEN); consulting the EAS cache anyway`
    );
  }
  return null;
}

export function resolveEasCliBin(
  projectRoot: string,
  { lookupPath = null, timeoutMs = 5000 }: { lookupPath?: (() => string | null) | null; timeoutMs?: number } = {},
): { file: string; source: 'project' | 'path' } | null {
  const fromPackage = expoBinFromPackage(resolvePackageJson(projectRoot, EAS_CLI_PACKAGE), EAS_CLI_BIN);
  if (fromPackage) return { file: fromPackage, source: 'project' };
  const shim = findBinUpward(projectRoot, EAS_CLI_BIN);
  if (shim) return { file: shim, source: 'project' };
  const onPath = lookupPath ? lookupPath() : getExecutor().runQuiet(`command -v ${EAS_CLI_BIN}`, { timeoutMs });
  const file = (String(onPath || '').split('\n')[0] ?? '').trim();
  return file ? { file, source: 'path' } : null;
}

const easAuthCache = new Map<string, EasAuthResult>();

export function resetEasAuthCache(): void {
  easAuthCache.clear();
}

interface CheckEasAuthOptions {
  projectRoot: string;
  owner?: string | null;
  run?: ExecFileFn | null;
  resolveBin?: ((root: string) => { file: string; source: 'project' | 'path' } | null) | null;
  timeoutMs?: number;
  cache?: Map<string, EasAuthResult> | null;
}

type ExecFileSyncError = NodeJS.ErrnoException & {
  signal?: string | null;
  killed?: boolean;
  stdout?: unknown;
  stderr?: unknown;
  status?: number | null;
};

export function checkEasAuth({
  projectRoot,
  owner = null,
  run = null,
  resolveBin = null,
  timeoutMs = WHOAMI_TIMEOUT_MS,
  cache = easAuthCache,
}: CheckEasAuthOptions): EasAuthResult {
  const key = `${projectRoot}::${owner || ''}`;
  if (cache?.has(key)) return cache.get(key)!;
  const answer = probeEasAuth({ projectRoot, owner, run, resolveBin, timeoutMs });
  cache?.set(key, answer);
  return answer;
}

function probeEasAuth({
  projectRoot,
  owner,
  run,
  resolveBin,
  timeoutMs,
}: {
  projectRoot: string;
  owner?: string | null;
  run?: ExecFileFn | null;
  resolveBin?: ((root: string) => { file: string; source: 'project' | 'path' } | null) | null;
  timeoutMs?: number;
}): EasAuthResult {
  const bin = (resolveBin || resolveEasCliBin)(projectRoot);
  if (!bin) {
    return {
      failed: true,
      code: 'no-cli',
      reason: 'no `eas` executable is resolvable from this project or on PATH',
      remedy: 'Install eas-cli (`npm i -g eas-cli`, or as a project devDependency), then run `eas login`.',
    };
  }

  const exec: ExecFileFn = run || ((file, args, opts) => getExecutor().runFile(file, args, opts));
  let result: { stdout: string; stderr?: string; exitCode: number };
  try {
    result = { stdout: String(exec(bin.file, ['whoami'], { timeoutMs }) ?? ''), exitCode: 0 };
  } catch (e) {
    const err = e as ExecFileSyncError;
    if (err?.code === 'ETIMEDOUT' || err?.signal === 'SIGTERM' || err?.killed) {
      return { unknown: `eas whoami timed out after ${timeoutMs}ms` };
    }
    result = {
      stdout: String(err?.stdout ?? ''),
      stderr: String(err?.stderr ?? err?.message ?? ''),
      exitCode: typeof err?.status === 'number' ? err.status : 1,
    };
  }

  const parsed = parseWhoami(result);
  if (parsed.loggedOut) {
    return {
      failed: true,
      code: 'logged-out',
      reason: 'eas whoami says "Not logged in"',
      remedy: 'Run `eas login` (or set EXPO_TOKEN).',
    };
  }
  if (parsed.unknown) return { unknown: parsed.unknown };

  if (owner && Array.isArray(parsed.accounts) && !parsed.accounts.includes(owner)) {
    return {
      failed: true,
      code: 'wrong-account',
      account: parsed.account,
      accounts: parsed.accounts,
      owner,
      reason:
        `eas is authenticated as ${parsed.account} (accounts: ${parsed.accounts.join(', ')}), ` +
        `which does not include this project's owner ${owner}`,
      remedy: `Run \`eas login\` as a member of ${owner}, or set EXPO_TOKEN to a token for it.`,
    };
  }
  return {
    ok: true,
    account: parsed.account,
    accounts: parsed.accounts,
    viaToken: parsed.viaToken,
    source: bin.source,
  };
}

const capturing: CaptureFrame[] = [];
const abandoned = new Set<CaptureFrame>();
let patched: {
  stdout: NodeJS.WriteStream;
  write: NodeJS.WriteStream['write'];
  log: typeof console.log;
  patchedWrite: NodeJS.WriteStream['write'];
  patchedLog: typeof console.log;
} | null = null;

const PROVIDER_CONTEXT = new AsyncLocalStorage<CaptureFrame>();

export function uploadDestination(lines?: string[] | null): string | null {
  const text = (lines || []).map(stripAnsi);
  for (const line of text) {
    const url = /(https?:\/\/[^\s'"]+)/.exec(line)?.[1];
    if (url !== undefined) return url.replace(/[.,)\]]+$/, '');
  }
  for (const line of text) {
    const slug = /\bto\s+(@?[\w.-]+\/[\w.-]+)/i.exec(line)?.[1];
    if (slug !== undefined) return slug.replace(/[.,)\]]+$/, '');
  }
  return null;
}

function providerNote(text: string): string {
  return `${'cache'.padEnd(11)} ${text}`;
}

function currentFrame(): CaptureFrame | null {
  const store = PROVIDER_CONTEXT.getStore();
  return store && (capturing.includes(store) || abandoned.has(store)) ? store : null;
}

function install(): void {
  if (patched && process.stdout.write === patched.patchedWrite) return;
  const stdout = process.stdout;
  const write = stdout.write.bind(stdout);
  const log = console.log;
  const passthrough = write as unknown as (chunk: unknown, encoding?: unknown, callback?: unknown) => boolean;
  const patchedWrite = ((chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    const frame = currentFrame();
    if (!frame) return passthrough(chunk, encoding, callback);
    const cb = typeof encoding === 'function' ? encoding : callback;
    absorb(frame, typeof chunk === 'string' ? chunk : String(chunk));
    if (typeof cb === 'function') (cb as () => void)();
    return true;
  }) as NodeJS.WriteStream['write'];
  const patchedLog = (...args: unknown[]): void => {
    const frame = currentFrame();
    if (!frame) return log(...args);
    absorb(frame, `${format(...args)}\n`);
    return undefined;
  };
  stdout.write = patchedWrite;
  console.log = patchedLog;
  patched = { stdout, write, log, patchedWrite, patchedLog };
}

function uninstall(): void {
  if (!patched || capturing.length || abandoned.size) return;
  if (patched.stdout.write === patched.patchedWrite) patched.stdout.write = patched.write;
  if (console.log === patched.patchedLog) console.log = patched.log;
  patched = null;
}

function absorb(frame: CaptureFrame, chunk: string): void {
  try {
    process.stderr.write(chunk);
  } catch {}
  frame.pending += chunk;
  let index = frame.pending.indexOf('\n');
  while (index !== -1) {
    emitLine(frame, frame.pending.slice(0, index));
    frame.pending = frame.pending.slice(index + 1);
    index = frame.pending.indexOf('\n');
  }
}

function emitLine(frame: CaptureFrame, raw: string): void {
  const line = stripAnsi(raw).trim();
  if (line === '') return;
  frame.lines.push(line);
  const writer = frame.writer();
  try {
    writer?.write({ src: 'build', level: 'debug', event: 'provider', msg: line });
  } catch {}
  frame.onLine?.(line);
}

interface BeginCaptureOptions {
  logWriter?: NdjsonWriter | null;
  projectRoot?: string | null;
  platform?: string | null;
  onLine?: ((line: string) => void) | null;
}

function beginCapture({
  logWriter = null,
  projectRoot = null,
  platform = null,
  onLine = null,
}: BeginCaptureOptions = {}): CaptureFrame {
  let own: NdjsonWriter | null = null;
  const frame: CaptureFrame = {
    lines: [],
    pending: '',
    onLine,
    writer: () => {
      if (logWriter) return logWriter;
      if (own) return own;
      if (!projectRoot || !platform) return null;
      own = createNdjsonWriter(join(workspaceLogsDir(projectRoot), `build-${platform}.ndjson`));
      return own;
    },
    close: () => {
      own?.close?.();
      own = null;
    },
  };
  capturing.push(frame);
  install();
  return frame;
}

function endCapture(frame?: CaptureFrame | null): void {
  if (!frame) return;
  const at = capturing.lastIndexOf(frame);
  if (at !== -1) capturing.splice(at, 1);
  abandoned.delete(frame);
  if (frame.pending !== '') {
    const rest = frame.pending;
    frame.pending = '';
    emitLine(frame, rest);
  }
  frame.close();
  uninstall();
}

function abandonCapture(frame: CaptureFrame | null, work: Promise<unknown>): void {
  if (!frame) return;
  const at = capturing.lastIndexOf(frame);
  if (at !== -1) capturing.splice(at, 1);
  abandoned.add(frame);
  Promise.resolve(work).then(
    () => endCapture(frame),
    () => endCapture(frame),
  );
}

interface ResolveRemoteOptions {
  provider?: LoadedProvider | null;
  platform?: string | null;
  projectRoot?: string | null;
  fingerprintHash?: string | null;
  runOptions?: Record<string, unknown> | null;
  timeoutMs?: number;
  logWriter?: NdjsonWriter | null;
}

export async function resolveRemote({
  provider,
  platform,
  projectRoot,
  fingerprintHash,
  runOptions = null,
  timeoutMs = RESOLVE_TIMEOUT_MS,
  logWriter = null,
}: ResolveRemoteOptions = {}): Promise<RemoteCacheResolveResult | null> {
  if (!provider?.plugin || !fingerprintHash) return null;
  const opts = runOptions || runOptionsFor(platform);

  const outcome = await withBudget(
    async () => {
      const hash =
        (await providerFingerprint({ provider, platform, projectRoot, runOptions: opts })) ?? fingerprintHash;
      const props = { fingerprintHash: hash, platform, runOptions: opts, projectRoot };
      return typeof provider.plugin.resolveBuildCache === 'function'
        ? provider.plugin.resolveBuildCache(props, provider.options)
        : provider.plugin.resolveRemoteBuildCache!(props, provider.options);
    },
    timeoutMs,
    { logWriter, projectRoot, platform },
  );

  if (outcome.timedOut) return { timedOut: true };
  if (outcome.error) return { failed: firstLine(outcome.error) };
  const appPath = typeof outcome.value === 'string' ? outcome.value.trim() : '';
  if (!appPath) return null;
  if (!existsSync(appPath)) {
    return { failed: `returned ${appPath}, which does not exist` };
  }
  return { appPath };
}

interface UploadRemoteOptions {
  provider?: LoadedProvider | null;
  platform?: string | null;
  projectRoot?: string | null;
  fingerprintHash?: string | null;
  buildPath?: string | null;
  runOptions?: Record<string, unknown> | null;
  timeoutMs?: number;
  logWriter?: NdjsonWriter | null;
  note?: (line: string) => void;
}

export async function uploadRemote({
  provider,
  platform,
  projectRoot,
  fingerprintHash,
  buildPath,
  runOptions = null,
  timeoutMs = UPLOAD_TIMEOUT_MS,
  logWriter = null,
  note = (line: string) => console.error(line),
}: UploadRemoteOptions = {}): Promise<RemoteCacheUploadResult> {
  if (!provider?.plugin || !fingerprintHash || !buildPath) return { skipped: true };
  const opts = runOptions || runOptionsFor(platform);

  let announced = false;
  const onLine = (line: string) => {
    if (announced) return;
    const dest = uploadDestination([line]);
    if (!dest) return;
    announced = true;
    note(providerNote(`uploading to ${dest}`));
  };

  const outcome = await withBudget(
    async () => {
      const hash =
        (await providerFingerprint({ provider, platform, projectRoot, runOptions: opts })) ?? fingerprintHash;
      const props = { projectRoot, platform, fingerprintHash: hash, buildPath, runOptions: opts };
      return typeof provider.plugin.uploadBuildCache === 'function'
        ? provider.plugin.uploadBuildCache(props, provider.options)
        : provider.plugin.uploadRemoteBuildCache!(props, provider.options);
    },
    timeoutMs,
    { logWriter, projectRoot, platform, onLine },
  );

  if (outcome.timedOut) return { timedOut: true };
  if (outcome.error) return { failed: firstLine(outcome.error) };
  const destination = uploadDestination(outcome.lines);
  return destination ? { uploaded: true, destination } : { uploaded: true };
}

async function providerFingerprint({
  provider,
  platform,
  projectRoot,
  runOptions,
}: {
  provider: LoadedProvider;
  platform?: string | null;
  projectRoot?: string | null;
  runOptions: Record<string, unknown>;
}): Promise<string | null> {
  if (typeof provider.plugin.calculateFingerprintHash !== 'function') return null;
  try {
    const hash = await provider.plugin.calculateFingerprintHash(
      { projectRoot, platform, runOptions },
      provider.options,
    );
    return typeof hash === 'string' && hash.trim() !== '' ? hash.trim() : null;
  } catch {
    return null;
  }
}

async function withBudget(
  factory: () => Promise<unknown>,
  ms: number,
  capture?: BeginCaptureOptions | null,
): Promise<BudgetOutcome> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer?.unref?.();
  });
  const frame = beginCapture(capture || {});
  const work = Promise.resolve()
    .then(() => PROVIDER_CONTEXT.run(frame, factory))
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  try {
    const settled = await Promise.race([work, timeout]);
    if (settled === TIMED_OUT) {
      abandonCapture(frame, work);
      return { timedOut: true, lines: frame.lines };
    }
    endCapture(frame);
    return { ...settled, lines: frame.lines };
  } catch (err) {
    endCapture(frame);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function firstLine(err: unknown): string {
  const text = String((err as Error)?.message || err || 'unknown error').trim();
  const line = (text.split('\n')[0] ?? '').trim();
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}
