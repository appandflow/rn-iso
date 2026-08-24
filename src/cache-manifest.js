// A registry that caches write to describe themselves.
//
// Discovery in caches.js is guesswork: it knows the shape of the caches it was
// taught about and nothing else. A Metro FileStore root, an Expo build cache
// directory, a relocated CAS -- all chosen by a project's own config, all
// invisible unless a human remembers to list them in the `caches` setting.
//
// So let the cache say so instead. Anything that creates a shared cache -- a
// metro.config.js, a build-cache provider, a setup script -- calls `register`
// once, and `gc --caches` and `doctor` both see it from then on. Registration
// is idempotent and keyed on the directory: re-registering an existing cache
// updates its metadata rather than duplicating it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { getConfigDir } from './config.js';

export function manifestPath() {
  return join(getConfigDir(), 'caches.json');
}

function expand(dir) {
  return resolve(dir.startsWith('~') ? join(homedir(), dir.slice(1)) : dir);
}

export function readManifest(path = manifestPath()) {
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

// `prune` is the entry's contract with gc, and the only field a caller really
// has to think about:
//   'entries' -- a flat collection of independent entries, so old ones can go
//                individually. One file per key, or one directory per build.
//   'atomic'  -- an index references the data, so removing pieces corrupts it.
//                Empty it whole or not at all (an LLVM CAS is this).
export function register(entry, path = manifestPath()) {
  if (!entry?.dir) throw new Error('a cache registration needs a `dir`');
  const dir = expand(entry.dir);
  const manifest = readManifest(path);
  const record = {
    dir,
    name: entry.name || dir,
    prune: entry.prune === 'atomic' ? 'atomic' : 'entries',
    note: entry.note || 'registered by the project',
    // Which project registered it, so a stale entry can be explained later.
    // Not used for lookup: two projects may legitimately share one cache, which
    // is the entire point of a shared cache.
    registeredBy: entry.registeredBy || process.cwd(),
  };
  const caches = manifest.caches.filter(c => expand(c.dir) !== dir);
  caches.push(record);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, caches }, null, 2));
  return record;
}

export function unregister(dir, path = manifestPath()) {
  const manifest = readManifest(path);
  const target = expand(dir);
  const caches = manifest.caches.filter(c => expand(c.dir) !== target);
  if (caches.length === manifest.caches.length) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, caches }, null, 2));
  return true;
}

// Registered caches whose directory still exists. A cache someone deleted by
// hand is dropped from the report rather than shown as 0 bytes -- but it is
// left in the manifest, because it will come back the next time that project
// builds, and re-registering it should not be the user's job.
export function registeredCaches(path = manifestPath()) {
  return readManifest(path)
    .caches.filter(c => c.dir && existsSync(c.dir))
    .map(c => ({
      name: c.name,
      dir: c.dir,
      prune: c.prune === 'atomic' ? 'atomic' : 'entries',
      note: c.note,
    }));
}
