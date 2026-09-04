import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'fs';
import { join } from 'path';
import { StringDecoder } from 'string_decoder';
import { type NdjsonRecord, levelRank, parseNdjsonLine, parseNdjsonText } from './ndjson.ts';

const SINCE_UNITS: { s: number; m: number; h: number } = { s: 1000, m: 60000, h: 3600000 };
const SINCE_FORMS = '30s, 5m, 2h';

interface SinceResult {
  ms?: number;
  error?: string;
}

interface GrepResult {
  re?: RegExp;
  error?: string;
}

interface MarkerWindow {
  launchTs: number | null;
  bundleTs: number | null;
}

export interface QueryCriteria {
  sources?: string[];
  minLevel?: string;
  grep?: RegExp;
  sinceTs?: number;
  errorsOnly?: boolean;
  markerTs?: number;
  bundleMarkerTs?: number;
}

interface TailState {
  offset: number;
  partial: string;
}

export function parseSince(text: unknown): SinceResult {
  if (typeof text !== 'string') {
    return { error: `Invalid --since value ${JSON.stringify(text)}. Use a count and a unit, e.g. ${SINCE_FORMS}.` };
  }
  const m = /^(\d+)\s*([smh])$/i.exec(text.trim());
  if (!m) {
    return { error: `Invalid --since value "${text}". Use a count and a unit, e.g. ${SINCE_FORMS}.` };
  }
  const unit = (m[2] ?? '').toLowerCase() as keyof typeof SINCE_UNITS;
  return { ms: parseInt(m[1] ?? '', 10) * SINCE_UNITS[unit] };
}

export function compileGrep(pattern: unknown): GrepResult {
  if (pattern instanceof RegExp) return { re: pattern };
  try {
    return { re: new RegExp(String(pattern)) };
  } catch (err) {
    return { error: `Invalid --grep pattern "${pattern}": ${(err as Error).message}` };
  }
}

export const ERROR_SOURCES: string[] = ['metro', 'client', 'build'];

export function markerWindow(records: NdjsonRecord[]): MarkerWindow {
  let launchTs: number | null = null;
  let bundleTs: number | null = null;
  for (const r of records) {
    if (r?.marker !== true) continue;
    const ts = tsOf(r);
    if (ts === null) continue;
    if (r.src === 'metro') {
      if (bundleTs === null || ts > bundleTs) bundleTs = ts;
    } else if (launchTs === null || ts > launchTs) {
      launchTs = ts;
    }
  }
  return { launchTs, bundleTs };
}

export function recordMatches(record: NdjsonRecord | null | undefined, criteria: QueryCriteria = {}): boolean {
  if (!record) return false;
  const { sources, minLevel, grep, sinceTs, errorsOnly, markerTs, bundleMarkerTs } = criteria;

  if (sources && sources.length > 0 && !sources.includes(record.src as string)) return false;
  if (minLevel && levelRank(record.level) < levelRank(minLevel)) return false;

  if (errorsOnly) {
    if (record.level !== 'error' && record.level !== 'fatal') return false;
    if (typeof markerTs === 'number') {
      const ts = tsOf(record);
      if (ts === null || ts <= markerTs) return false;
    }
    if (typeof bundleMarkerTs === 'number' && record.src === 'metro') {
      const ts = tsOf(record);
      if (ts === null || ts < bundleMarkerTs) return false;
    }
  }

  if (typeof sinceTs === 'number') {
    const ts = tsOf(record);
    if (ts === null || ts < sinceTs) return false;
  }

  if (grep) {
    const re = grep instanceof RegExp ? grep : compileGrep(grep).re;
    if (!re || String(record.msg ?? '').search(re) === -1) return false;
  }

  return true;
}

export function buildCriteria({
  sources,
  minLevel,
  since,
  grep,
  errorsOnly,
  markerTs,
  bundleMarkerTs,
  now,
}: {
  sources?: string[];
  minLevel?: string;
  since?: string | null;
  grep?: string | RegExp | null;
  errorsOnly?: boolean;
  markerTs?: number;
  bundleMarkerTs?: number;
  now?: number;
} = {}): QueryCriteria {
  const criteria: QueryCriteria = { errorsOnly: Boolean(errorsOnly) };
  if (sources && sources.length > 0) criteria.sources = sources;
  else if (criteria.errorsOnly) criteria.sources = ERROR_SOURCES;
  if (minLevel) criteria.minLevel = minLevel;
  if (typeof markerTs === 'number') criteria.markerTs = markerTs;
  if (typeof bundleMarkerTs === 'number') criteria.bundleMarkerTs = bundleMarkerTs;
  if (since !== undefined && since !== null && since !== '') {
    const parsed = parseSince(since);
    if (parsed.error) throw new Error(parsed.error);
    criteria.sinceTs = (typeof now === 'number' ? now : Date.now()) - (parsed.ms as number);
  }
  if (grep !== undefined && grep !== null && grep !== '') {
    const compiled = compileGrep(grep);
    if (compiled.error) throw new Error(compiled.error);
    criteria.grep = compiled.re;
  }
  return criteria;
}

export function logFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.ndjson'))
    .map((e) => e.name)
    .toSorted();
}

export function fileSizes(dir: string): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const name of logFiles(dir)) {
    try {
      sizes[name] = statSync(join(dir, name)).size;
    } catch {}
  }
  return sizes;
}

export function readLogRecords(dir: string): NdjsonRecord[] {
  const all: NdjsonRecord[] = [];
  for (const name of logFiles(dir)) {
    let text;
    try {
      text = readFileSync(join(dir, name), 'utf-8');
    } catch {
      continue;
    }
    for (const record of parseNdjsonText(text)) all.push(record);
  }
  return sortByTs(all);
}

function isExpoErrorContext(record: NdjsonRecord, event: unknown): boolean {
  if (record.src !== 'metro' || record.raw !== true || record.event !== event || typeof record.msg !== 'string') {
    return false;
  }
  return (
    /^Code: \S/.test(record.msg) ||
    /^\s*>?\s*\d+\s*\|/.test(record.msg) ||
    /^\s*\|\s*\^/.test(record.msg) ||
    /^Call Stack$/.test(record.msg) ||
    /^\s+.+\([^()]+:\d+:\d+\)\s*$/.test(record.msg) ||
    /^\s+at\s+\S+:\d+:\d+\s*$/.test(record.msg)
  );
}

function attachExpoErrorContext(all: NdjsonRecord[], matched: NdjsonRecord[]): NdjsonRecord[] {
  return matched.map((record) => {
    if (
      record.src !== 'metro' ||
      record.raw !== true ||
      (record.level !== 'error' && record.level !== 'fatal') ||
      typeof record.msg !== 'string'
    ) {
      return record;
    }
    const index = all.indexOf(record);
    if (index === -1) return record;
    const context: string[] = [];
    for (let i = index + 1; i < all.length; i += 1) {
      const next = all[i] as NdjsonRecord;
      if (next.src !== 'metro') continue;
      if (!isExpoErrorContext(next, record.event)) break;
      context.push(next.msg as string);
    }
    return context.length > 0 ? { ...record, msg: [record.msg, ...context].join('\n') } : record;
  });
}

export function queryLogs({
  dir,
  sources,
  minLevel,
  since,
  grep,
  tail,
  errorsOnly,
  errorContext,
  now,
}: {
  dir?: string;
  sources?: string[];
  minLevel?: string;
  since?: string;
  grep?: string | RegExp;
  tail?: number;
  errorsOnly?: boolean;
  errorContext?: boolean;
  now?: number;
} = {}): NdjsonRecord[] {
  const all = readLogRecords(dir as string);
  if (all.length === 0) return [];

  const { launchTs, bundleTs } = errorsOnly ? markerWindow(all) : { launchTs: null, bundleTs: null };
  const criteria = buildCriteria({
    sources,
    minLevel,
    since,
    grep,
    errorsOnly,
    now,
    markerTs: launchTs === null ? undefined : launchTs,
    bundleMarkerTs: bundleTs === null ? undefined : bundleTs,
  });

  let matched = all.filter((r) => recordMatches(r, criteria));
  if (typeof tail === 'number' && tail >= 0 && matched.length > tail) {
    matched = matched.slice(matched.length - tail);
  }
  return errorContext ? attachExpoErrorContext(all, matched) : matched;
}

export function tailRead(prev: TailState | null | undefined, size: number): { start: number; prev: TailState } {
  const state = prev && typeof prev.offset === 'number' ? prev : { offset: 0, partial: '' };
  if (size < state.offset) return { start: 0, prev: { offset: 0, partial: '' } };
  return { start: state.offset, prev: state };
}

export function advanceTail(
  prev: TailState | null | undefined,
  chunk: string | null | undefined,
  size: number,
): { state: TailState; records: NdjsonRecord[] } {
  const partialIn = prev && typeof prev.partial === 'string' ? prev.partial : '';
  const text = partialIn + (chunk || '');
  const lines = text.split('\n');
  const partial = lines.pop() as string;
  const records: NdjsonRecord[] = [];
  for (const line of lines) {
    const record = parseNdjsonLine(line);
    if (record) records.push(record);
  }
  return { state: { offset: size, partial }, records };
}

export function followLogs({
  dir,
  onRecord,
  criteria = {},
  intervalMs = 500,
  offsets = null,
}: {
  dir: string;
  onRecord: (record: NdjsonRecord) => void;
  criteria?: QueryCriteria;
  intervalMs?: number;
  offsets?: Record<string, number> | null;
}): () => void {
  const state = new Map<string, TailState>();
  const decoders = new Map<string, StringDecoder>();
  for (const [name, size] of Object.entries(offsets || fileSizes(dir))) {
    state.set(name, { offset: size, partial: '' });
    decoders.set(name, new StringDecoder('utf8'));
  }

  function pollFile(name: string): void {
    const path = join(dir, name);
    const size = statSync(path).size;
    const entry = state.get(name);
    const { start, prev } = tailRead(entry, size);
    if (prev !== entry) decoders.set(name, new StringDecoder('utf8'));
    if (!decoders.has(name)) decoders.set(name, new StringDecoder('utf8'));

    let chunk = '';
    if (size > start) {
      const fd = openSync(path, 'r');
      try {
        const buf = Buffer.allocUnsafe(size - start);
        const read = readSync(fd, buf, 0, size - start, start);
        chunk = decoders.get(name)!.write(buf.subarray(0, read));
      } finally {
        closeSync(fd);
      }
    }

    const next = advanceTail(prev, chunk, size);
    state.set(name, next.state);
    for (const record of next.records) {
      if (recordMatches(record, criteria)) onRecord(record);
    }
  }

  function poll() {
    for (const name of logFiles(dir)) {
      try {
        pollFile(name);
      } catch {}
    }
  }

  const timer = setInterval(poll, intervalMs);
  return function stop() {
    clearInterval(timer);
  };
}

function tsOf(record: NdjsonRecord | null | undefined): number | null {
  return typeof record?.ts === 'number' && Number.isFinite(record.ts) ? record.ts : null;
}

function sortByTs(records: NdjsonRecord[]): NdjsonRecord[] {
  return records.toSorted((a, b) => {
    const ta = tsOf(a);
    const tb = tsOf(b);
    if (ta === null && tb === null) return 0;
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta - tb;
  });
}
