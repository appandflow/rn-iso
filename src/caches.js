// Shared build caches: the ones that make a second workspace fast, and the ones
// that therefore grow without bound.
//
// These are NOT the same thing as the artifacts `gc` already reclaims. A
// DerivedData directory belongs to one workspace and is provably dead once that
// workspace is gone. A shared cache is alive by design, shared across every
// project on the machine, and never dead -- only bigger. Nothing prunes them:
// Metro's FileStore has no eviction at all, and Xcode's compilation cache has no
// size cap. That is why they are reported separately and never included in a
// plain `gc --delete`: deleting one is a performance decision, not a cleanup.
import { existsSync, readdirSync, statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { getExecutor } from './exec.js';
import { derivedDataRoot, directorySize } from './artifacts.js';

// `bounded` records whether the cache evicts anything on its own. An unbounded
// cache is the one worth telling the user about, because it will only ever grow.
const UNBOUNDED = false;
const BOUNDED = true;

// ccache is the one cache here that can cap itself, so read its own config
// rather than guessing a path -- CCACHE_DIR, a config file, or the default all
// resolve inside ccache, and it reports the answer.
function ccacheCache() {
  const dir = getExecutor().runQuiet('ccache --get-config cache_dir');
  if (!dir) return null;
  const path = dir.trim();
  if (!path || !existsSync(path)) return null;
  const max = getExecutor().runQuiet('ccache --get-config max_size');
  return {
    name: 'ccache',
    dir: path,
    bounded: BOUNDED,
    note: max ? `capped at ${max.trim()} by ccache itself` : 'capped by ccache itself',
  };
}

// Xcode 26's content-addressed compilation cache. The default sits at the
// DerivedData root, which makes it per-machine rather than per-workspace -- but
// a project that points COMPILATION_CACHE_CAS_PATH elsewhere (the only way to
// share it when DerivedData is per-workspace) lands somewhere we cannot guess,
// which is what the `caches` setting is for.
function compilationCache() {
  const dir = join(derivedDataRoot(), 'CompilationCache.noindex');
  if (!existsSync(dir)) return null;
  return { name: 'Xcode compilation cache', dir, bounded: UNBOUNDED, note: 'no size cap' };
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
    bounded: UNBOUNDED,
    note: `${names.length} file(s), one per project root Metro has served`,
  };
}

// Anything the user points us at: a Metro FileStore, an Expo build-cache
// provider's artifact directory, a relocated CAS. rn-iso cannot detect these --
// they are chosen by a project's own config -- so they are declared.
function declaredCaches(paths) {
  return (paths || [])
    .map(p => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p))
    .filter(p => existsSync(p))
    .map(dir => ({ name: 'declared', dir, bounded: UNBOUNDED, note: 'from the `caches` setting' }));
}

// Sizes are measured here rather than at discovery so a caller that only wants
// to know WHICH caches exist does not pay for a full directory walk of several
// gigabytes.
export function discoverCaches({ declared = [] } = {}) {
  const found = [ccacheCache(), compilationCache(), metroFileMaps(), ...declaredCaches(declared)];
  return found.filter(Boolean);
}

export function sizeCaches(caches) {
  return caches.map(c => ({
    ...c,
    bytes: c.bytes ?? directorySize(c.dir),
  }));
}
