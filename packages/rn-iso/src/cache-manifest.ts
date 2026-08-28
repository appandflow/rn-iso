import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { getConfigDir } from './config.ts';

export interface CacheEntry {
  dir: string;
  name?: string;
  prune?: 'atomic' | 'entries';
  entriesDepth?: number;
  note?: string;
  registeredBy?: string;
}

export function manifestPath(): string {
  return join(getConfigDir(), 'caches.json');
}

function expand(dir: string): string {
  return resolve(dir.startsWith('~') ? join(homedir(), dir.slice(1)) : dir);
}

export function readManifest(path: string = manifestPath()): { version: number; caches: CacheEntry[] } {
  if (!existsSync(path)) return { version: 1, caches: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    const caches = Array.isArray(parsed?.caches)
      ? (parsed.caches as unknown[]).filter((c): c is CacheEntry => typeof (c as { dir?: unknown })?.dir === 'string')
      : [];
    return { version: 1, caches };
  } catch {
    return { version: 1, caches: [] };
  }
}

function writeManifest(path: string, caches: CacheEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify({ version: 1, caches }, null, 2));
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export function register(entry: CacheEntry, path: string = manifestPath()): CacheEntry {
  if (!entry?.dir) throw new Error('a cache registration needs a `dir`');
  const dir = expand(entry.dir);
  const manifest = readManifest(path);
  const record: CacheEntry = {
    dir,
    name: entry.name || dir,
    prune: entry.prune === 'atomic' ? 'atomic' : 'entries',
    entriesDepth: normalizeDepth(entry.entriesDepth),
    note: entry.note || 'registered by the project',
    registeredBy: entry.registeredBy || process.cwd(),
  };
  const caches = manifest.caches.filter((c) => expand(c.dir) !== dir);
  caches.push(record);
  writeManifest(path, caches);
  return record;
}

function normalizeDepth(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return 1;
  return n;
}

export function unregister(dir: string, path: string = manifestPath()): boolean {
  const manifest = readManifest(path);
  const target = expand(dir);
  const caches = manifest.caches.filter((c) => expand(c.dir) !== target);
  if (caches.length === manifest.caches.length) return false;
  writeManifest(path, caches);
  return true;
}

export function registeredCaches(path: string = manifestPath()): {
  name: string | undefined;
  dir: string;
  prune: 'atomic' | 'entries';
  entriesDepth: number;
  note: string | undefined;
}[] {
  return readManifest(path)
    .caches.filter((c) => c.dir && existsSync(c.dir))
    .map((c) => ({
      name: c.name,
      dir: c.dir,
      prune: c.prune === 'atomic' ? 'atomic' : 'entries',
      entriesDepth: normalizeDepth(c.entriesDepth),
      note: c.note,
    }));
}
