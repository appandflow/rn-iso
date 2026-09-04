import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  cacheProviderConfigFromEnv,
  cacheProviderEnvIsSet,
  createTieredMetroStore,
  loadCacheProvider,
  type CacheProviderConfig,
  type LoadCacheProviderResult,
  type MetroCacheStore,
  type WarnOnce,
} from '@stim-cli/cache';
import {
  metroCacheRoot,
  METRO_NAMED_CACHE_LAYOUT,
  registerCache,
  tagSharedStore,
  workspaceLogDir,
} from '@stim-cli/core';

type FileStoreCtor = new (options: { root: string }) => object;

export interface SharedCacheStoresOptions {
  FileStore?: FileStoreCtor;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  loadProvider?: (input: { projectRoot: string; config: CacheProviderConfig }) => Promise<LoadCacheProviderResult>;
  warn?: WarnOnce;
}

const requireFromHere = createRequire(import.meta.url);

// A Metro reporter event. Metro's event union is large and version-dependent, so
// only the fields this reporter reads are named; the rest ride along untyped.
interface MetroEvent {
  type?: string;
  level?: unknown;
  data?: unknown;
  error?: unknown;
  stack?: unknown;
  codeFrame?: unknown;
  buildID?: string;
  bundleDetails?: { platform?: string | null };
}

interface LogRecord {
  ts: number;
  src: 'metro' | 'client';
  level: string;
  msg: string;
  event?: string;
  stack?: unknown;
  marker?: boolean;
  buildID?: string;
  platform?: string;
}

export interface NdjsonReporter {
  dir: string;
  update(event: MetroEvent): void;
  readonly drops: number;
}

export function cacheRoot(name?: string | null): string {
  return metroCacheRoot(name);
}

function registerOnce(
  dir: string,
  replaces: Array<{
    dir: string;
    name: string;
    prune: string;
    entriesDepth: number;
    layout: null;
  }> = [],
): void {
  registerCache({
    dir,
    name: 'Metro transform cache',
    prune: 'entries',
    entriesDepth: 2,
    layout: METRO_NAMED_CACHE_LAYOUT,
    note: 'shared Metro transforms; no eviction of its own',
    replaces,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function repositoryRoot(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function committedProviderConfig(startDir: string): CacheProviderConfig | null {
  const start = path.resolve(startDir);
  const stop = repositoryRoot(start) ?? start;
  let dir = start;
  for (;;) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, '.stim.json'), 'utf-8'));
    } catch {
      parsed = null;
    }
    const cache = isPlainObject(parsed) && isPlainObject(parsed.cache) ? parsed.cache : null;
    const reference = cache?.provider;
    if (typeof reference === 'string' && reference.trim() !== '') {
      return {
        provider: reference.trim(),
        options: isPlainObject(cache?.options) ? cache.options : {},
        baseDir: dir,
      };
    }
    const parent = path.dirname(dir);
    if (dir === stop || parent === dir) return null;
    dir = parent;
  }
}

function warnToStderr(_code: string, message: string): void {
  process.stderr.write(`warning: ${message}\n`);
}

export function sharedCacheStores(
  name = 'app',
  {
    FileStore,
    env = process.env,
    cwd = process.cwd(),
    loadProvider = loadCacheProvider,
    warn = warnToStderr,
  }: SharedCacheStoresOptions = {},
): object[] {
  // metro-cache is a peer dependency that resolves at call time.
  const Store: FileStoreCtor = FileStore || (requireFromHere('metro-cache') as { FileStore: FileStoreCtor }).FileStore;
  const parent = cacheRoot();
  const root = cacheRoot(name);
  registerOnce(
    root,
    root === parent
      ? []
      : [
          {
            dir: parent,
            name: 'Metro transform cache',
            prune: 'entries',
            entriesDepth: 2,
            layout: null,
          },
        ],
  );
  const local = tagSharedStore(new Store({ root }), root);
  const config = cacheProviderConfigFromEnv(env) ?? (cacheProviderEnvIsSet(env) ? null : committedProviderConfig(cwd));
  if (!config) return [local];

  const tiered = createTieredMetroStore({
    local: local as MetroCacheStore,
    projectRoot: path.resolve(cwd),
    cacheName: name,
    loadProvider: () => loadProvider({ projectRoot: path.resolve(cwd), config }),
    warn,
  });
  return [tagSharedStore(tiered, root)];
}

const NDJSON_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'fatal']);

function ndjsonLevel(level: unknown, fallback: string): string {
  const value = String(level === undefined || level === null ? '' : level).toLowerCase();
  if (NDJSON_LEVELS.has(value)) return value;
  switch (value) {
    case 'log':
    case 'dir':
    case 'table':
    case 'group':
    case 'groupcollapsed':
    case 'groupend':
      return 'info';
    case 'trace':
      return 'debug';
    case 'warning':
      return 'warn';
    default:
      return fallback;
  }
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message || String(value);
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {}
  try {
    return String(value);
  } catch {
    return '[unprintable]';
  }
}

function formatData(data: unknown): string {
  if (data === undefined || data === null) return '';
  if (Array.isArray(data)) return data.map(formatValue).join(' ');
  return formatValue(data);
}

function errorMessage(error: unknown): string {
  if (error === undefined || error === null) return 'unknown error';
  if (typeof error === 'string') return error;
  if (typeof (error as { message?: unknown }).message === 'string' && (error as { message: string }).message) {
    return (error as { message: string }).message;
  }
  return formatValue(error);
}

function symbolicationMessage(codeFrame: unknown): string {
  if (!isPlainObject(codeFrame) || typeof codeFrame.content !== 'string') return 'Call Stack';
  const fileName = typeof codeFrame.fileName === 'string' ? codeFrame.fileName : 'unknown source';
  const location = isPlainObject(codeFrame.location) ? codeFrame.location : null;
  const row = typeof location?.row === 'number' ? `:${location.row}` : '';
  const column = typeof location?.column === 'number' ? `:${location.column}` : '';
  return `Code: ${fileName}${row}${column}\n${codeFrame.content}\nCall Stack`;
}

function symbolicationStack(stack: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(stack)) return [];
  return stack
    .filter((frame) => isPlainObject(frame) && frame.collapse !== true)
    .map((frame) => {
      const normalized: Record<string, unknown> = {};
      if (typeof frame.file === 'string') normalized.file = frame.file;
      if (typeof frame.lineNumber === 'number') normalized.line = frame.lineNumber;
      if (typeof frame.column === 'number') normalized.column = frame.column;
      if (typeof frame.methodName === 'string') normalized.fn = frame.methodName;
      return normalized;
    })
    .filter((frame) => Object.keys(frame).length > 0);
}

export function ndjsonReporter({ dir }: { dir?: string } = {}): NdjsonReporter {
  const logDir = dir || workspaceLogDir(process.cwd());
  let ensured = false;
  let drops = 0;
  const builds = new Map<string, string | null>();
  let failedBuild: { buildID: string; platform: string | null } | null = null;

  function write(file: string, record: LogRecord): void {
    try {
      if (!ensured) {
        fs.mkdirSync(logDir, { recursive: true });
        ensured = true;
      }
      fs.appendFileSync(path.join(logDir, file), JSON.stringify(record) + '\n');
    } catch {
      drops += 1;
      ensured = false;
    }
  }

  function update(event: MetroEvent): void {
    try {
      const type = event && typeof event.type === 'string' ? event.type : '';
      const record: LogRecord = { ts: Date.now(), src: 'metro', level: 'debug', msg: '' };
      if (type) record.event = type;

      if (type !== 'bundling_error') failedBuild = null;

      if (type === 'bundle_build_started' && event.buildID) {
        const platform = event.bundleDetails?.platform || null;
        builds.set(event.buildID, platform);
        record.buildID = event.buildID;
        if (platform) record.platform = platform;
      } else if ((type === 'bundle_build_done' || type === 'bundle_build_failed') && event.buildID) {
        const platform = builds.get(event.buildID) || null;
        record.buildID = event.buildID;
        if (platform) record.platform = platform;
        builds.delete(event.buildID);
        if (type === 'bundle_build_failed') failedBuild = { buildID: event.buildID, platform };
      } else if (type === 'bundling_error' && failedBuild) {
        record.buildID = failedBuild.buildID;
        if (failedBuild.platform) record.platform = failedBuild.platform;
        failedBuild = null;
      }

      if (type === 'client_log') {
        record.src = 'client';
        record.level = ndjsonLevel(event.level, 'info');
        record.msg = formatData(event.data);
        if (event.stack) record.stack = event.stack;
        write('client.ndjson', record);
        return;
      }

      if (type === 'client_symbolication') {
        const stack = symbolicationStack(event.stack);
        const hasCodeFrame = isPlainObject(event.codeFrame) && typeof event.codeFrame.content === 'string';
        if (!hasCodeFrame && stack.length === 0) return;
        record.src = 'client';
        record.level = 'info';
        record.msg = symbolicationMessage(event.codeFrame);
        if (stack.length > 0) record.stack = stack;
        write('client.ndjson', record);
        return;
      }

      if (type === 'bundling_error' || type === 'transformer_error') {
        record.level = 'error';
        record.msg = errorMessage(event.error);
      } else if (type === 'bundle_build_done' || type === 'bundle_build_failed') {
        const what = type === 'bundle_build_done' ? 'bundle build done' : 'bundle build failed';
        record.level = 'info';
        record.msg = event.buildID ? `${what} (${event.buildID})` : what;
        record.marker = true;
      } else if (type === 'unstable_server_log') {
        record.level = ndjsonLevel(event.level, 'info');
        record.msg = formatData(event.data);
      } else {
        record.msg = formatData(event && event.data) || type || 'metro event';
      }

      write('metro.ndjson', record);
    } catch {
      drops += 1;
    }
  }

  return {
    dir: logDir,
    update,
    get drops() {
      return drops;
    },
  };
}
