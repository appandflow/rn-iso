// A registry that caches write to describe themselves.
//
// Discovery in caches.js is guesswork: it knows the shape of the caches it was
// taught about and nothing else. A Metro FileStore root, an Expo build cache
// directory, a relocated CAS -- all chosen by a project's own config, all
// invisible unless a human remembers to list them in the `caches` setting.
//
// So let the cache say so instead. Anything that creates a shared cache -- a
// metro.config.js, a build-cache provider, a setup script -- calls `register`
// once, and `gc`'s report and `doctor` both see it from then on. This is the
// ONLY registration path: the `cache register` / `forget` / `list` verbs are
// gone, and this module stays as the public `rn-iso/cache-manifest` export
// because it is how @rn-iso/metro and src/build-cache.js self-register.
// Registration is idempotent and keyed on the directory: re-registering an
// existing cache updates its metadata rather than duplicating it.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { getConfigDir } from './config.js';

// The shape a caller registers. `dir` is the only required field; gc reads
// `prune` / `entriesDepth` to decide how to trim, and the rest is provenance.
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

export function readManifest(path: string = manifestPath()): { version: number; caches: any[] } {
  if (!existsSync(path)) return { version: 1, caches: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return { version: 1, caches: Array.isArray(parsed?.caches) ? parsed.caches : [] };
  } catch {
    // A corrupt manifest must not take `gc` down with it: the caches it
    // described are still on disk, and the worst case is that they go back to
    // being invisible until something registers them again.
    return { version: 1, caches: [] };
  }
}

// Two writers are normal here: a metro.config.js and a build-cache provider
// both register on every build, and several worktrees build at once. A
// read-modify-write straight onto caches.json leaves a half-written file
// readable for as long as the write takes, which readManifest can only treat as
// corrupt. Writing a sibling and renaming makes the swap atomic, so a reader
// sees either the old manifest or the new one.
function writeManifest(path: string, caches: any[]): void {
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

// `prune` is the entry's contract with gc, and the only field a caller really
// has to think about:
//   'entries' -- a flat collection of independent entries, so old ones can go
//                individually. One file per key, or one directory per build.
//   'atomic'  -- an index references the data, so removing pieces corrupts it.
//                Empty it whole or not at all (an LLVM CAS is this).
//
// `entriesDepth` says how far below `dir` those entries sit, and defaults to 1
// (the children of the root are the entries). A cache whose root holds a layer
// of grouping directories -- <root>/<platform>/<fingerprint> for a build cache,
// <root>/<shard>/<key> for a Metro FileStore -- registers 2, so gc trims one
// build or one transform rather than an entire platform or shard.
export function register(entry: CacheEntry, path: string = manifestPath()) {
  if (!entry?.dir) throw new Error('a cache registration needs a `dir`');
  const dir = expand(entry.dir);
  const manifest = readManifest(path);
  const record = {
    dir,
    name: entry.name || dir,
    prune: entry.prune === 'atomic' ? 'atomic' : 'entries',
    entriesDepth: normalizeDepth(entry.entriesDepth),
    note: entry.note || 'registered by the project',
    // Which project registered it, so a stale entry can be explained later.
    // Not used for lookup: two projects may legitimately share one cache, which
    // is the entire point of a shared cache.
    registeredBy: entry.registeredBy || process.cwd(),
  };
  const caches = manifest.caches.filter((c) => expand(c.dir) !== dir);
  caches.push(record);
  writeManifest(path, caches);
  return record;
}

// A depth gc cannot walk is worse than no depth at all: too deep and it treats
// nothing as an entry, too shallow and one removal takes a whole group. Anything
// that is not a whole number of at least 1 falls back to the flat default.
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

// Registered caches whose directory still exists. A cache someone deleted by
// hand is dropped from the report rather than shown as 0 bytes -- but it is
// left in the manifest, because it will come back the next time that project
// builds, and re-registering it should not be the user's job.
export function registeredCaches(path: string = manifestPath()) {
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
