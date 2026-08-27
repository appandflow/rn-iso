// The shared Metro transform cache, installed by rn-iso on the dev servers it
// hosts -- with no metro.config.js in the project.
//
// WHY THIS EXISTS: Metro's default transform cache is a temp directory keyed
// per project, so every worktree re-transforms the whole module graph from
// cold -- thousands of modules, every time. @rn-iso/metro has always packaged
// the fix (`config.cacheStores = sharedCacheStores('app')`), but wiring it up
// is an edit to a file the project owns, which on somebody else's repo is a
// PR. rn-iso already loads (bare) or launches (Expo) the dev server, so it can
// supply the store from its own side of that seam instead.
//
// Two shapes, because the two dev servers are two different things:
//   bare  -- rn-iso loads the project's Metro config in-process, so the store
//            is APPENDED to config.cacheStores right there (appendCacheStore).
//   expo  -- the dev server is the project's own `expo start` child, so the
//            store rides in on NODE_OPTIONS=--require <shim> (metroShimPath /
//            composeNodeOptions). The shim is the fail-soft half; see it.
//
// BOTH ADDRESS ONE STORE. The root comes from @rn-iso/core's metroCacheRoot,
// which is the same function @rn-iso/metro's own cacheRoot() calls, so a
// project that ALSO wires up @rn-iso/metro by hand shares entries with the
// store rn-iso installs rather than filling a second one beside it. That is
// also why the root is re-derived nowhere: CLAUDE.md records what these three
// copies cost when they drift.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { metroCacheRoot } from '@rn-iso/core';
import { register } from '../cache-manifest.ts';

// A Metro FileStore, kept structural so rn-iso need not depend on
// metro-cache's types: the constructor is all of it that is used here.
type FileStoreCtor = new (options: { root: string }) => { _root?: string };

// The env vars the shim reads. Named here because this module is what sets
// them and the shim is what reads them, and nothing else may -- which is also
// why they are module-local rather than exported.
const STORE_ENV = 'RN_ISO_METRO_STORE';
const PROJECT_ENV = 'RN_ISO_PROJECT_ROOT';

// PURE-ish (reads one file). The name that partitions this project's entries
// inside the shared root, mirroring @rn-iso/metro's `sharedCacheStores(name)`
// argument. The project's package name is the obvious answer and the one a
// hand-written call would almost always pass; an unreadable or nameless
// package.json falls back to @rn-iso/metro's own default so the store still
// exists.
export function metroStoreName(root: string): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    const name = (pkg as { name?: unknown } | null)?.name;
    if (typeof name === 'string' && name.trim() !== '') return name;
  } catch {
    // Nameless is not an error here; it is just the default segment.
  }
  return 'app';
}

// The FileStore root for this project. metroCacheRoot applies the same
// sanitising segment rule for a scoped package name that @rn-iso/metro's
// cacheRoot does, because it IS that function.
export function metroStoreRoot(root: string): string {
  return metroCacheRoot(metroStoreName(root));
}

// Make the store visible to `rn-iso gc`, which is the only thing that will
// ever trim it -- a Metro FileStore has no eviction logic whatsoever, so an
// unregistered one grows until the disk does. Same registration @rn-iso/metro
// performs, at the same entriesDepth, and keyed on the directory, so a project
// that uses both ends up with one entry rather than two. Best-effort: a cache
// that cannot announce itself still works.
export function registerMetroStore(storeRoot: string): void {
  try {
    register({
      dir: storeRoot,
      name: 'Metro transform cache',
      prune: 'entries',
      entriesDepth: 2,
      note: 'shared Metro transforms, installed by rn-iso start; no eviction of its own',
    });
  } catch {
    // Invisible to gc is survivable; a dev server that did not start is not.
  }
}

// PURE. Whether a store list already points at this root, so a second call --
// or a project that wired @rn-iso/metro up by hand at the same path -- cannot
// end up with the store twice. Metro's FileStore keeps its root on `_root`.
export function hasStoreAt(stores: unknown, storeRoot: string): boolean {
  if (!Array.isArray(stores)) return false;
  return stores.some((s) => s !== null && typeof s === 'object' && (s as { _root?: unknown })._root === storeRoot);
}

// The result of appendCacheStore, as data rather than as a thrown error: the
// caller's answer to every outcome is the same (serve the dev server) and only
// the log line differs.
export interface StoreAppendResult {
  added: boolean;
  storeRoot: string;
  reason?: string;
}

// APPEND, NEVER REPLACE. Whatever cacheStores the project configured stays
// exactly where it is and keeps its order; rn-iso's store is one more place to
// look. `cacheStores` may also be a FUNCTION of Metro's cache module (Metro
// supports that form), which is wrapped rather than evaluated here -- calling
// it would run it at the wrong time and with an argument this module does not
// have.
export function appendCacheStore(
  config: { cacheStores?: unknown } | null | undefined,
  { storeRoot, FileStore }: { storeRoot: string; FileStore: FileStoreCtor },
): StoreAppendResult {
  if (!config || typeof config !== 'object') return { added: false, storeRoot, reason: 'no config to add it to' };
  const stores = config.cacheStores;
  if (typeof stores === 'function') {
    const original = stores as (cache: unknown) => unknown;
    config.cacheStores = (cache: unknown) => {
      const resolved = original(cache);
      return (Array.isArray(resolved) ? resolved : []).concat([new FileStore({ root: storeRoot })]);
    };
    return { added: true, storeRoot };
  }
  if (hasStoreAt(stores, storeRoot)) {
    return { added: false, storeRoot, reason: 'a store already points at it' };
  }
  const existing = Array.isArray(stores) ? stores : [];
  config.cacheStores = [...existing, new FileStore({ root: storeRoot })];
  return { added: true, storeRoot };
}

// --- the Expo half: the shim and the NODE_OPTIONS it rides in on ------------

const SHIM_FILE = 'metro-cache-store.cjs';

// The shim is a real file shipped in the package (see package.json "files"),
// not a string this module writes to a temp directory: it has to be
// require()-able by SOMEBODY ELSE'S node process, and a generated temp file is
// one more thing to clean up and one more thing to be missing.
//
// Two candidate depths because there are two ways this module runs: from
// `dist/` in a published install, and from `src/supervisor/` in this repo.
// Checking both beats hardcoding either.
export function metroShimPath(fromUrl: string = import.meta.url): string | null {
  const here = dirname(fileURLToPath(fromUrl));
  for (const rel of ['../shim', '../../shim']) {
    const candidate = resolve(here, rel, SHIM_FILE);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// PURE. NODE_OPTIONS with our --require APPENDED, never clobbered: the caller
// may have set it for reasons of their own (a profiler, a source-map hook, an
// --max-old-space-size a big graph needs) and dropping that would be rn-iso
// silently changing how somebody else's dev server runs.
//
// Returns null when the shim must not be injected at all, which is a state the
// caller reports rather than works around:
//   - already there (an outer rn-iso, a re-exec): adding it twice is not
//     harmful, but it is noise, and the shim is idempotent anyway
//   - a path containing a double quote, which NODE_OPTIONS' own tokenizer
//     cannot express. Node parses NODE_OPTIONS shell-like and understands
//     quotes, so a path with SPACES is quoted here and works; a path with a
//     quote in it is refused rather than mis-parsed into arguments that would
//     make the child fail to start.
export function composeNodeOptions(existing: string | undefined | null, shimPath: string): string | null {
  if (shimPath.includes('"')) return null;
  const current = typeof existing === 'string' ? existing : '';
  if (current.includes(shimPath)) return null;
  const flag = `--require ${/\s/.test(shimPath) ? `"${shimPath}"` : shimPath}`;
  return current.trim() === '' ? flag : `${current} ${flag}`;
}

// PURE. The environment additions that put the shim into an Expo child, or
// null when it must not go in. Kept separate from the spawn so the composition
// -- which is the part with a rule in it -- is testable without a child
// process.
export function metroStoreEnv({
  root,
  storeRoot,
  shimPath,
  nodeOptions,
}: {
  root: string;
  storeRoot: string;
  shimPath: string;
  nodeOptions?: string | null;
}): Record<string, string> | null {
  const composed = composeNodeOptions(nodeOptions, shimPath);
  if (composed === null) return null;
  return { NODE_OPTIONS: composed, [STORE_ENV]: storeRoot, [PROJECT_ENV]: root };
}
