// Shared build caches: the ones that make a second workspace fast, and the ones
// that therefore grow without bound.
//
// These are NOT the same thing as the artifacts `gc` already reclaims. A
// DerivedData directory belongs to one workspace and is provably dead once that
// workspace is gone. A shared cache is alive by design, shared across every
// project on the machine, and never dead -- only bigger. Nothing prunes them:
// Metro's FileStore has no eviction logic at all, and Xcode's compilation cache
// has no size cap. That is why they are reported separately and never included in a
// plain `gc --delete`: deleting one is a performance decision, not a cleanup.
import { existsSync, readdirSync, rmSync, statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, resolve } from 'path';
import { derivedDataRoot, directorySize } from './artifacts.js';
import { registeredCaches } from './cache-manifest.js';
import { findProjectRoot } from './project.js';
import { resolveSettings } from './settings.js';
import { gitCommonDir, repoRoot } from './worktree.js';

// Xcode 26's content-addressed compilation cache. The default sits at the
// DerivedData root, which makes it per-machine rather than per-workspace -- but
// a project that points COMPILATION_CACHE_CAS_PATH elsewhere (the only way to
// share it when DerivedData is per-workspace) lands somewhere we cannot guess,
// which is what the `caches` setting is for.
function compilationCache() {
  const dir = join(derivedDataRoot(), 'CompilationCache.noindex');
  if (!existsSync(dir)) return null;
  // An LLVM CAS: `v4.actions` indexes the `v9.*.leaf` data files. Removing
  // leaves individually would leave the index pointing at data that is gone,
  // so this one can only be emptied wholesale.
  return { name: 'Xcode compilation cache', dir, prune: 'atomic', note: 'index-backed, so it can only be emptied whole' };
}

// Metro's file map: one per project root, in the system temp dir. Individually
// small, but there is one for every root Metro has ever served on this machine,
// and nothing ever removes them.
function metroFileMaps() {
  const root = tmpdir();
  if (!existsSync(root)) return null;
  let names;
  try {
    names = readdirSync(root).filter(n => n.startsWith('metro-file-map-'));
  } catch {
    return null;
  }
  if (!names.length) return null;
  let bytes = 0;
  for (const n of names) {
    try {
      bytes += statSync(join(root, n)).size;
    } catch {
      // A temp file that vanished between listing and stat is not an error.
    }
  }
  return {
    name: 'Metro file maps',
    dir: root,
    files: names.map(n => join(root, n)),
    bytes,
    prune: 'entries',
    note: `${names.length} file(s), one per project root Metro has served`,
  };
}

// Anything the user points us at: a Metro FileStore, an Expo build-cache
// provider's artifact directory, a relocated CAS. rn-iso cannot detect these --
// they are chosen by a project's own config -- so they are declared.
function declaredCaches(paths) {
  return (paths || [])
    // resolve() as well as expanding ~: the manifest stores resolved paths, and
    // a declared path written as `~/x/../x` or as a relative path would
    // otherwise fail to match the registration of the same directory and be
    // reported twice.
    .map(p => resolve(p.startsWith('~') ? join(homedir(), p.slice(1)) : p))
    .filter(p => existsSync(p))
    // Declared caches -- a Metro FileStore, an Expo build-cache directory -- are
    // flat collections of independent entries, so old ones can go individually.
    .map(dir => ({ name: 'declared', dir, prune: 'entries', note: 'from the `caches` setting' }));
}

// The `caches` setting is per project, so it only has an answer when the
// command runs inside one. Outside a project there is nothing declared to add,
// which is a normal state for `gc` on a machine-wide sweep, not an error.
export function declaredCachePaths(cwd = process.cwd()) {
  const root = findProjectRoot(cwd);
  if (!root) return [];
  const settings = resolveSettings({
    projectPath: root,
    gitCommonDir: gitCommonDir(root),
    repoRoot: repoRoot(root),
  });
  return Array.isArray(settings?.caches) ? settings.caches : [];
}

// Sizes are measured here rather than at discovery so a caller that only wants
// to know WHICH caches exist does not pay for a full directory walk of several
// gigabytes.
export function discoverCaches({ declared = [] } = {}) {
  // Registered first: a cache that described itself is better information than
  // anything inferred here, so when both name the same directory the
  // registration wins. Detection stays as the fallback for caches that nothing
  // has registered -- Xcode's, and anything named in the `caches` setting.
  // `source` lets a report say which rows a project described itself and which
  // ones rn-iso guessed at, so "nothing registered" is never printed over a
  // machine that plainly has caches.
  const registered = registeredCaches().map(c => ({ ...c, source: 'registered' }));
  const seen = new Set(registered.map(c => c.dir));
  const detected = [compilationCache(), metroFileMaps(), ...declaredCaches(declared)]
    .filter(Boolean)
    .filter(c => !seen.has(c.dir))
    .map(c => ({ ...c, source: 'detected' }));
  return [...registered, ...detected];
}

export function sizeCaches(caches) {
  return caches.map(c => ({
    ...c,
    bytes: c.bytes ?? directorySize(c.dir),
  }));
}

// Remove entries not used in the last `olderThanDays`, and report what went.
//
// "Used" is the later of atime and mtime: a cache hit reads an entry without
// rewriting it, so mtime alone would age out exactly the entries that are
// earning their keep. Metro's FileStore is a flat sharded tree of one file per
// key and the Expo build cache is one directory per fingerprint, so in both
// cases an entry is independent and can go on its own.
//
// Returns { removed, bytes, skipped } -- `skipped` explains a cache that cannot
// be trimmed this way rather than silently doing nothing to it.
export function pruneCache(cache, { olderThanDays, now = Date.now() } = {}) {
  const cutoff = now - olderThanDays * 24 * 60 * 60 * 1000;

  if (cache.prune === 'atomic') {
    return { removed: 0, bytes: 0, skipped: 'index-backed; empty it whole or not at all' };
  }

  const entries = cache.files ?? entriesAtDepth(cache.dir, cache.entriesDepth ?? 1);
  let removed = 0;
  let bytes = 0;
  for (const entry of entries) {
    let used;
    let size;
    try {
      const st = statSync(entry);
      used = Math.max(st.atimeMs, st.mtimeMs);
      size = st.isDirectory() ? directorySize(entry) : st.size;
    } catch {
      continue;
    }
    if (used >= cutoff) continue;
    try {
      rmSync(entry, { recursive: true, force: true });
      removed++;
      bytes += size;
    } catch {
      // An entry that vanished or is unreadable is not worth failing the sweep.
    }
  }
  return { removed, bytes, skipped: null };
}

// A cache's entries are the children `depth` levels below its root. Depth 1 is
// a flat store. Depth 2 is a root with one layer of grouping above the entries:
// a build cache is <root>/<platform>/<fingerprint>, and a Metro FileStore is
// <root>/<shard>/<key> with 256 shards -- so at depth 1 a single removal would
// take an entire platform's builds or a 256th of every transform on the machine.
//
// Anything at an intermediate level that is not a directory is left out
// entirely: readdirSync throws on it, and a child of the root that gc cannot
// explain is one it must not remove.
//
// A cache that does not own its directory does not come through here at all --
// Metro's file maps live loose in the system temp dir and carry an explicit
// file list for exactly that reason.
function entriesAtDepth(dir, depth) {
  let level = [dir];
  for (let i = 0; i < depth; i++) {
    const next = [];
    for (const parent of level) {
      let names;
      try {
        names = readdirSync(parent);
      } catch {
        continue;
      }
      for (const name of names) next.push(join(parent, name));
    }
    level = next;
  }
  return level;
}
