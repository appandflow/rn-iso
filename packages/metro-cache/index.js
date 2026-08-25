// A Metro transform cache shared by every worktree on the machine.
//
// Metro's default cache lives under the project, so a second worktree starts
// cold and re-transforms the whole module graph -- thousands of modules, every
// time. Pointing every checkout at one store means only the first one pays.
//
//   const { sharedCacheStores } = require('@rn-iso/metro-cache');
//   config.cacheStores = sharedCacheStores('myapp');
//
// The thin part is the FileStore. The part worth packaging is telling rn-iso the
// cache exists, so `gc --caches` can report and trim it -- Metro's FileStore has
// no eviction logic whatsoever, so without that it grows until the disk does.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// THIS RESOLUTION EXISTS THREE TIMES: here, in
// packages/expo-build-cache/index.js, and in rn-iso's own src/paths.js
// (sharedMetroCache / sharedBuildCache). This package cannot import that module
// -- it has to work on a machine with no rn-iso installed at all -- so the
// duplication is deliberate, the same way buildCacheKey is duplicated between
// the build-cache implementations. Change one and you must change all three:
// when they drift, one entry point writes a cache the other will never read,
// and neither of them says so. rn-iso's test/cache-packages.test.js asserts all
// three agree.
//
// RN_ISO_METRO_CACHE comes first because it did before the layout existed, and
// quietly ignoring an override someone already set reads as an empty cache
// rather than as an error. It names one directory, so it wins for a named cache
// too -- otherwise half the stores on a machine would move and half would not.
function configDir() {
  return process.env.RN_ISO_HOME || path.join(os.homedir(), '.rn-iso');
}

// Anything that is not a plain path segment is replaced, and leading dots go, so
// a scoped package name cannot climb out of the cache root.
function cacheNameSegment(name) {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '') || 'app';
}

function cacheRoot(name) {
  if (process.env.RN_ISO_METRO_CACHE) return process.env.RN_ISO_METRO_CACHE;
  const root = path.join(configDir(), 'metro-cache');
  return name === undefined || name === null || name === '' ? root : path.join(root, cacheNameSegment(name));
}

// Registering makes this cache visible to `rn-iso gc --caches`, which is the
// only thing that will ever trim it -- Metro's FileStore has no eviction of its
// own.
//
// The manifest is written directly rather than through rn-iso's own module, for
// two reasons that both made the import silently do nothing:
//   - the documented way to use the CLI is `npx rn-iso`, so it is usually not a
//     dependency of the project and the specifier does not resolve at all
//   - rn-iso is an ES module, so `require` of it throws ERR_REQUIRE_ESM on Node
//     before 20.19
// A dynamic import fixes the second and not the first.
function registerCache({ dir, name, prune, note, entriesDepth }) {
  try {
    const home = configDir();
    const file = path.join(home, 'caches.json');
    let manifest = { version: 1, caches: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (Array.isArray(parsed?.caches)) manifest = { version: 1, caches: parsed.caches };
    } catch {
      // No manifest yet, or an unreadable one: start clean rather than fail.
    }
    // Keyed on the directory so repeated calls update rather than accumulate --
    // these run on every build.
    const others = manifest.caches.filter(c => c.dir !== dir);
    const record = { dir, name, prune, note, registeredBy: process.cwd() };
    // Only written when the caller sets it: an absent depth means the entries
    // are the directory's immediate children, which is the common case.
    if (entriesDepth) record.entriesDepth = entriesDepth;
    others.push(record);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, caches: others }, null, 2));
  } catch {
    // A cache that cannot announce itself still works; it is just invisible.
  }
}

function registerOnce(dir) {
  registerCache({
    dir,
    name: 'Metro transform cache',
    // One file per cache key, so entries nothing has touched can go
    // individually rather than emptying the whole store. FileStore shards one
    // level above them, so the entries are two deep.
    prune: 'entries',
    entriesDepth: 2,
    note: 'shared Metro transforms; no eviction of its own',
  });
}

// `name` only distinguishes one app's cache from another's on the same machine:
// it is a subdirectory of the shared root, not a directory of its own. Metro
// keys entries by content, so sharing one store between unrelated projects would
// be correct but pointlessly large.
function sharedCacheStores(name = 'app', { FileStore } = {}) {
  const Store = FileStore || require('metro-cache').FileStore;
  const root = cacheRoot(name);
  registerOnce(root);
  return [new Store({ root })];
}

module.exports = { sharedCacheStores, cacheRoot };
