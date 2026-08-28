import { closeSync, mkdirSync, openSync, writeSync } from 'fs';
import { dirname } from 'path';

export interface NdjsonRecord {
  ts?: number;
  src?: string;
  level?: string;
  msg?: string;
  [key: string]: unknown;
}

export interface NdjsonWriter {
  readonly file: string;
  write(record: unknown): boolean;
  close(): { file: string; written: number; dropped: number; lastError: Error | null };
  readonly written: number;
  readonly dropped: number;
  readonly lastError: Error | null;
}

export const LEVELS: string[] = ['debug', 'info', 'warn', 'error', 'fatal'];

export const SOURCES: string[] = ['metro', 'client', 'device', 'build'];

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

export function formatNdjsonLine(record: unknown): string | null {
  try {
    return `${JSON.stringify(record)}\n`;
  } catch {
    return null;
  }
}

export function createNdjsonWriter(file: string, { truncate = false }: { truncate?: boolean } = {}): NdjsonWriter {
  let fd: number | null = null;
  let freshFile = truncate;
  let written = 0;
  let dropped = 0;
  let lastError: Error | null = null;
  let closed = false;

  function open(): void {
    mkdirSync(dirname(file), { recursive: true });
    fd = openSync(file, freshFile ? 'w' : 'a');
    freshFile = false;
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
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {}
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
      } catch {}
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

function stamp(record: unknown): NdjsonRecord {
  const base: NdjsonRecord =
    record && typeof record === 'object' && !Array.isArray(record) ? (record as NdjsonRecord) : { msg: String(record) };
  if (typeof base.ts === 'number' && Number.isFinite(base.ts)) return base;
  return { ...base, ts: Date.now() };
}
