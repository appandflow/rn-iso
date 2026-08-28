import fs from 'node:fs';
import path from 'node:path';
import { metroCacheRoot, registerCache, tagSharedStore, workspaceLogDir } from '@stim-cli/core';

type FileStoreCtor = new (options: { root: string }) => object;

// A Metro reporter event. Metro's event union is large and version-dependent, so
// only the fields this reporter reads are named; the rest ride along untyped.
interface MetroEvent {
  type?: string;
  level?: unknown;
  data?: unknown;
  error?: unknown;
  stack?: string;
  buildID?: string;
}

interface LogRecord {
  ts: number;
  src: 'metro' | 'client';
  level: string;
  msg: string;
  event?: string;
  stack?: string;
  marker?: boolean;
}

export interface NdjsonReporter {
  dir: string;
  update(event: MetroEvent): void;
  readonly drops: number;
}

export function cacheRoot(name?: string | null): string {
  return metroCacheRoot(name);
}

function registerOnce(dir: string): void {
  registerCache({
    dir,
    name: 'Metro transform cache',
    prune: 'entries',
    entriesDepth: 2,
    note: 'shared Metro transforms; no eviction of its own',
  });
}

export function sharedCacheStores(name = 'app', { FileStore }: { FileStore?: FileStoreCtor } = {}): object[] {
  // metro-cache is a peer dependency, resolved at call time so this package
  // still loads on a machine that never installed it (the store can be
  // injected instead). require() is native at runtime in the built CJS.
  const Store: FileStoreCtor = FileStore || (require('metro-cache') as { FileStore: FileStoreCtor }).FileStore;
  const root = cacheRoot(name);
  registerOnce(root);
  return [tagSharedStore(new Store({ root }), root)];
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

export function ndjsonReporter({ dir }: { dir?: string } = {}): NdjsonReporter {
  const logDir = dir || workspaceLogDir(process.cwd());
  let ensured = false;
  let drops = 0;

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

      if (type === 'client_log') {
        record.src = 'client';
        record.level = ndjsonLevel(event.level, 'info');
        record.msg = formatData(event.data);
        if (event.stack) record.stack = event.stack;
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
