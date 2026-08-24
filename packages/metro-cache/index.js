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

const os = require('node:os');
const path = require('node:path');

function cacheRoot(name) {
  return process.env.RN_ISO_METRO_CACHE || path.join(os.homedir(), `.${name}-metro-cache`);
}

// Best effort: this package is useful without rn-iso installed, and a missing
// peer must never break a bundler config. Registration is idempotent.
function registerOnce(dir) {
  try {
    // eslint-disable-next-line global-require
    const { register } = require('rn-iso/cache-manifest');
    register({
      dir,
      name: 'Metro transform cache',
      // One file per cache key, so entries nothing has touched can go
      // individually rather than emptying the whole store.
      prune: 'entries',
      note: 'shared Metro transforms; no eviction of its own',
    });
  } catch {
    // rn-iso not installed, or too old to export the manifest.
  }
}

// `name` only distinguishes one app's cache from another's on the same machine.
// Metro keys entries by content, so sharing a store between unrelated projects
// would be correct but pointlessly large.
function sharedCacheStores(name = 'app', { FileStore } = {}) {
  const Store = FileStore || require('metro-cache').FileStore;
  const root = cacheRoot(name);
  registerOnce(root);
  return [new Store({ root })];
}

module.exports = { sharedCacheStores, cacheRoot };
