// src/ndjson.ts -- Contract 1: the log record, and the two ends that touch it.
//
// One JSON object per line:
//   { ts, src: metro|client|device|build, level: debug|info|warn|error|fatal, msg }
// optional: event, stack[{file,line,column,fn}], proc, raw, marker.
//
// Two rules drive the shape of this file.
//
// 1. WRITING NEVER THROWS. The supervisor calls write() from inside a Metro
//    reporter, on every event. If a full disk, an EACCES, or a log directory
//    deleted by a concurrent `worktree remove` threw from there, the throw
//    would land in Metro's reporter call and take the dev server with it --
//    a logging failure would become a bundler outage. So every failure is a
//    counted drop and the count surfaces in close(), where a caller can
//    report it once instead of on every event.
// 2. READING NEVER THROWS. The last line of a file being appended to by a
//    live supervisor is routinely half written, so a corrupt line is skipped,
//    not fatal.
import { closeSync, mkdirSync, openSync, writeSync } from 'fs';
import { dirname } from 'path';

// A Contract-1 record. The required fields describe every log line; the index
// signature carries the optional ones (event, stack, proc, raw, marker) without
// pinning a shape a future producer has not invented yet.
export interface NdjsonRecord {
  ts?: number;
  src?: string;
  level?: string;
  msg?: string;
  [key: string]: unknown;
}

// A live NDJSON writer. Appends whole lines; every failure is a counted drop.
export interface NdjsonWriter {
  readonly file: string;
  write(record: unknown): boolean;
  close(): { file: string; written: number; dropped: number; lastError: Error | null };
  readonly written: number;
  readonly dropped: number;
  readonly lastError: Error | null;
}

// Ordered lowest to highest; index is the rank used by --level filtering.
export const LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'];

// The `src` values Contract 1 defines. Records are not validated against this
// on the way in -- a producer that invents a source still gets written -- but
// `logs --source` validates against it, so a typo fails loudly instead of
// returning an empty result that reads as a clean build.
export const SOURCES = ['metro', 'client', 'device', 'build'];

// An unrecognized level ranks at the bottom rather than being dropped: a
// record with a level we do not know is still a record, and hiding it behind
// `--level debug` is the least surprising place to put it.
export function levelRank(level?: string): number {
  const i = LEVELS.indexOf(level as string);
  return i < 0 ? 0 : i;
}

export function parseNdjsonLine(line: unknown): NdjsonRecord | null {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as NdjsonRecord;
}

// The trailing element of the split is whatever follows the last newline --
// an empty string for a complete file, a partial record for one being written
// right now. Either way it is not a finished line, so it is dropped.
export function parseNdjsonText(text: unknown): NdjsonRecord[] {
  if (typeof text !== 'string' || text === '') return [];
  const out: NdjsonRecord[] = [];
  const lines = text.split('\n');
  lines.pop();
  for (const line of lines) {
    const record = parseNdjsonLine(line);
    if (record) out.push(record);
  }
  return out;
}

// Returns null rather than throwing on a record that will not serialize (a
// circular object reached through some reporter event's payload). The caller
// counts it as a drop like any other failure.
export function formatNdjsonLine(record: unknown): string | null {
  try {
    return `${JSON.stringify(record)}\n`;
  } catch {
    return null;
  }
}

// Appends. The fd is opened lazily on the first write, in append mode, so a
// writer costs nothing until something is actually logged and two writers on
// one file interleave whole lines rather than overwriting each other.
//
// A failed open clears the fd, so the NEXT write retries it: a log directory
// that comes back (recreated by a later mkdir, a volume remounted) starts
// recording again instead of staying dead for the life of the supervisor.
export function createNdjsonWriter(file: string): NdjsonWriter {
  let fd: number | null = null;
  let written = 0;
  let dropped = 0;
  let lastError: Error | null = null;
  let closed = false;

  function open(): void {
    mkdirSync(dirname(file), { recursive: true });
    fd = openSync(file, 'a');
  }

  function write(record: unknown): boolean {
    if (closed) {
      dropped += 1;
      return false;
    }
    const line = formatNdjsonLine(stamp(record));
    if (line === null) {
      dropped += 1;
      lastError = new TypeError('record could not be serialized to JSON');
      return false;
    }
    try {
      if (fd === null) open();
      writeSync(fd as number, line);
      written += 1;
      return true;
    } catch (err) {
      // Drop the fd so a transient failure is retried on the next record.
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* already gone */
        }
        fd = null;
      }
      dropped += 1;
      lastError = err as Error;
      return false;
    }
  }

  function close(): { file: string; written: number; dropped: number; lastError: Error | null } {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
      fd = null;
    }
    closed = true;
    return { file, written, dropped, lastError };
  }

  return {
    file,
    write,
    close,
    get written() {
      return written;
    },
    get dropped() {
      return dropped;
    },
    get lastError() {
      return lastError;
    },
  };
}

// ts is stamped at write time when the producer did not supply one. Producers
// that replay buffered output (an expo child's stdout, a build transcript)
// carry their own and must keep it, or the merge in logs-query reorders them.
function stamp(record: unknown): NdjsonRecord {
  const base: NdjsonRecord =
    record && typeof record === 'object' && !Array.isArray(record) ? (record as NdjsonRecord) : { msg: String(record) };
  if (typeof base.ts === 'number' && Number.isFinite(base.ts)) return base;
  return { ...base, ts: Date.now() };
}
