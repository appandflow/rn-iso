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
//   expo  -- SDK 54+ lets the child load a config path supplied through
//            EXPO_OVERRIDE_METRO_CONFIG. rn-iso points that at its adapter,
//            which composes the project's config and appends the store.
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
import { metroCacheRoot, sharedStoreRoot, tagSharedStore } from '@rn-iso/core';
import { register } from '../cache-manifest.ts';

// A Metro FileStore, kept structural so rn-iso need not depend on
// metro-cache's types: the constructor is all of it that is used here.
type FileStoreCtor = new (options: { root: string }) => object;

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
// end up with the store twice. The root comes from @rn-iso/core's
// sharedStoreRoot, which reads the tag every store WE create carries: Metro
// made FileStore's `_root` private in metro-cache 0.83.0, so reading the
// store's own field stopped working on every current Metro.
export function hasStoreAt(stores: unknown, storeRoot: string): boolean {
  if (!Array.isArray(stores)) return false;
  return stores.some((s) => sharedStoreRoot(s) === storeRoot);
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
      return (Array.isArray(resolved) ? resolved : []).concat([
        tagSharedStore(new FileStore({ root: storeRoot }), storeRoot),
      ]);
    };
    return { added: true, storeRoot };
  }
  if (hasStoreAt(stores, storeRoot)) {
    return { added: false, storeRoot, reason: 'a store already points at it' };
  }
  const existing = Array.isArray(stores) ? stores : [];
  config.cacheStores = [...existing, tagSharedStore(new FileStore({ root: storeRoot }), storeRoot)];
  return { added: true, storeRoot };
}

// --- the Expo half: SDK 54+'s supported config override seam ----------------

const EXPO_ADAPTER_FILE = 'expo-metro-config.cjs';

// The adapter is a real file shipped in the package (see package.json "files"),
// not a string this module writes to a temp directory: it has to be
// require()-able by SOMEBODY ELSE'S node process, and a generated temp file is
// one more thing to clean up and one more thing to be missing.
//
// Two candidate depths because there are two ways this module runs: from
// `dist/` in a published install, and from `src/supervisor/` in this repo.
// Checking both beats hardcoding either.
export function expoMetroConfigPath(fromUrl: string = import.meta.url): string | null {
  const here = dirname(fileURLToPath(fromUrl));
  for (const rel of ['../shim', '../../shim']) {
    const candidate = resolve(here, rel, EXPO_ADAPTER_FILE);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// THE ADAPTER'S SUCCESS LINE, and the other half of the contract the env vars
// above start. rn-iso can only ever know that it ASKED for the injection --
// it configured a process it does not run -- so the record that says the store
// IS in the config Metro loaded has to come from the adapter, after it put it
// there. The adapter writes this one line to stderr; server-expo turns it
// into the `cache_store_added` record, the same event the bare path writes for
// the same fact.
//
// The prefix is duplicated in shim/expo-metro-config.cjs (which cannot import
// rn-iso's ESM internals), so the two move together or the confirmation
// silently stops arriving -- which is exactly the failure mode this replaced.
const STORE_OK_PREFIX = 'rn-iso-metro-store: sharing Metro transforms through ';

// PURE. The store root an adapter line confirms, or null when this is not one.
export function metroStoreConfirmedRoot(line: string): string | null {
  if (!line.startsWith(STORE_OK_PREFIX)) return null;
  const root = line.slice(STORE_OK_PREFIX.length).trim();
  return root === '' ? null : root;
}

// PURE. The environment additions that point an Expo child at the adapter.
// Kept separate from the spawn so composing a caller's existing override is
// testable without a child process.
export function expoMetroStoreEnv({
  root,
  storeRoot,
  adapterPath,
  existingOverride,
}: {
  root: string;
  storeRoot: string;
  adapterPath: string;
  existingOverride?: string | null;
}): Record<string, string> {
  return {
    EXPO_OVERRIDE_METRO_CONFIG: adapterPath,
    RN_ISO_METRO_STORE: storeRoot,
    RN_ISO_PROJECT_ROOT: root,
    ...(existingOverride ? { RN_ISO_EXPO_METRO_CONFIG: existingOverride } : {}),
  };
}
