import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { readCacheManifest, updateCacheManifest } from '@stim-cli/core';
import { getConfigDir } from './config.ts';

export interface CacheEntry {
  dir: string;
  name?: string;
  prune?: 'atomic' | 'entries';
  entriesDepth?: number;
  note?: string;
  registeredBy?: string;
  layout?: string;
}

export function manifestPath(): string {
  return join(getConfigDir(), 'caches.json');
}

function expand(dir: string): string {
  return resolve(dir.startsWith('~') ? join(homedir(), dir.slice(1)) : dir);
}

export function readManifest(path: string = manifestPath()): { version: number; caches: CacheEntry[] } {
  return { version: 1, caches: cacheEntries(readCacheManifest(path).caches) };
}

function cacheEntries(caches: Array<Record<string, unknown>>): Array<Record<string, unknown> & CacheEntry> {
  return caches.filter((cache): cache is Record<string, unknown> & CacheEntry => typeof cache.dir === 'string');
}

export function register(entry: CacheEntry, path: string = manifestPath()): CacheEntry {
  if (!entry?.dir) throw new Error('a cache registration needs a `dir`');
  const dir = expand(entry.dir);
  const record: Record<string, unknown> & CacheEntry = {
    dir,
    name: entry.name || dir,
    prune: entry.prune === 'atomic' ? 'atomic' : 'entries',
    entriesDepth: normalizeDepth(entry.entriesDepth),
    note: entry.note || 'registered by the project',
    registeredBy: entry.registeredBy || process.cwd(),
  };
  if (entry.layout) record.layout = entry.layout;
  updateCacheManifest(path, (caches) => {
    const others = cacheEntries(caches).filter((cache) => expand(cache.dir) !== dir);
    return [...others, record];
  });
  return record;
}

function normalizeDepth(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return 1;
  return n;
}

export function unregister(dir: string, path: string = manifestPath()): boolean {
  const target = expand(dir);
  let removed = false;
  updateCacheManifest(path, (caches) => {
    const entries = cacheEntries(caches);
    const remaining = entries.filter((cache) => expand(cache.dir) !== target);
    removed = remaining.length !== entries.length;
    return remaining;
  });
  return removed;
}

export function registeredCaches(path: string = manifestPath()): {
  name: string | undefined;
  dir: string;
  prune: 'atomic' | 'entries';
  entriesDepth: number;
  note: string | undefined;
  layout: string | undefined;
}[] {
  return readManifest(path)
    .caches.filter((c) => c.dir && existsSync(c.dir))
    .map((c) => ({
      name: c.name,
      dir: c.dir,
      prune: c.prune === 'atomic' ? 'atomic' : 'entries',
      entriesDepth: normalizeDepth(c.entriesDepth),
      note: c.note,
      layout: c.layout,
    }));
}
