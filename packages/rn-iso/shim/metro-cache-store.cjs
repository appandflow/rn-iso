'use strict';
// rn-iso: give an Expo dev server the SHARED Metro transform cache without
// editing the project's metro.config.js.
//
// rn-iso hosts a bare React Native project's Metro itself, so there it just
// appends its FileStore to the loaded config. An Expo dev server is the
// project's OWN `expo start` running as a child, so there is no in-process
// config to touch -- this file is how the store gets there instead. rn-iso's
// supervisor spawns the child with NODE_OPTIONS extended by
// `--require <this file>`, so it runs before the Expo CLI does.
//
// THE CONTRACT THIS FILE LIVES BY: it is loaded inside SOMEBODY ELSE'S
// process, whose only job is to serve a dev server. So
//   - CommonJS, and no dependencies at all. It cannot import rn-iso (an ESM
//     package that is usually not installed in the project -- `npx rn-iso` is
//     the documented way to run it), and it cannot assume anything about the
//     project's node_modules except that Metro is somewhere in it.
//   - it FAILS SOFT, always. Every failure path writes ONE line to stderr and
//     returns. The supervisor parses that stream into the log timeline, so the
//     line is visible in `rn-iso logs`, and the dev server keeps running --
//     uncached, which is exactly what it did before this file existed. A
//     transform cache is an optimisation; it may never be the reason a dev
//     server does not start.
//
// The two inputs arrive in the environment rather than in the argv, because
// `--require` has no argv:
//   RN_ISO_METRO_STORE   absolute path of the FileStore root. Unset means
//                        "do nothing" -- that is also the kill switch's effect
//                        (caches.injectMetroStore: false in ~/.rn-iso/config.json).
//   RN_ISO_PROJECT_ROOT  the project, for the module resolution below.

const STORE_ROOT = process.env.RN_ISO_METRO_STORE;

// ONE line, and it starts with "warning:" on purpose: server-expo.ts infers a
// record's level from the line's leading word, so this lands in the timeline
// as a warn rather than as info nobody queries. It is also why the reason is
// flattened -- a Node MODULE_NOT_FOUND message carries its own "Require
// stack:" newlines, and each of those would become a separate record whose
// level was inferred from a fragment.
function warn(reason) {
  try {
    process.stderr.write(
      "warning: rn-iso could not share this project's Metro transform cache (" +
        String(reason).replace(/\s*\n\s*/g, ' ') +
        '); the dev server is running with the cache it would have had anyway.\n',
    );
  } catch {
    // A process whose stderr is gone is not one to throw at.
  }
}

// Append, never replace. A project that configured its own cacheStores keeps
// every one of them -- rn-iso's store is one more place to look, not a
// substitute for the project's decision. `cacheStores` may also be a FUNCTION
// of Metro's cache module (Metro supports that form), which is wrapped rather
// than flattened, because calling it here would evaluate it at the wrong time.
function appendStore(config, store, root) {
  const stores = config.cacheStores;
  if (typeof stores === 'function') {
    config.cacheStores = function (metroCache) {
      const resolved = stores(metroCache);
      return (Array.isArray(resolved) ? resolved : []).concat([store]);
    };
    return true;
  }
  if (Array.isArray(stores)) {
    // Idempotent: two --require entries, or a project that already points at
    // this exact root, must not end up with the store twice.
    for (const existing of stores) {
      if (existing && typeof existing === 'object' && existing._root === root) return false;
    }
    config.cacheStores = stores.concat([store]);
    return true;
  }
  config.cacheStores = [store];
  return true;
}

function patch(metroConfig, filename) {
  if (!metroConfig || typeof metroConfig !== 'object') return;
  if (metroConfig.rnIsoSharedCacheStore) return;
  if (typeof metroConfig.loadConfig !== 'function') {
    warn('the metro-config this project loaded exports no loadConfig()');
    metroConfig.rnIsoSharedCacheStore = true;
    return;
  }

  // metro-cache is resolved from METRO-CONFIG's own location rather than from
  // the project, so the FileStore class is the one belonging to this Metro
  // rather than to some other copy of Metro in the same tree.
  let FileStore;
  try {
    FileStore = require('node:module').createRequire(filename)('metro-cache').FileStore;
  } catch (err) {
    warn('metro-cache is not resolvable from ' + filename + ': ' + (err && err.message));
    metroConfig.rnIsoSharedCacheStore = true;
    return;
  }
  if (typeof FileStore !== 'function') {
    warn('metro-cache exports no FileStore');
    metroConfig.rnIsoSharedCacheStore = true;
    return;
  }

  const original = metroConfig.loadConfig;
  const wrapped = function loadConfig() {
    const args = arguments;
    const self = this;
    return Promise.resolve()
      .then(function () {
        return original.apply(self, args);
      })
      .then(function (config) {
        try {
          appendStore(config, new FileStore({ root: STORE_ROOT }), STORE_ROOT);
        } catch (err) {
          // The config loaded fine; only the store did not. Serve without it.
          warn('the store could not be added to the loaded config: ' + (err && err.message));
        }
        return config;
      });
  };

  try {
    metroConfig.loadConfig = wrapped;
  } catch {
    // A build output that defines its exports with getters, or a frozen
    // namespace: try the explicit definition before giving up.
    try {
      Object.defineProperty(metroConfig, 'loadConfig', { value: wrapped, configurable: true, writable: true });
    } catch (err) {
      warn('metro-config.loadConfig is not writable: ' + (err && err.message));
      return;
    }
  }
  metroConfig.rnIsoSharedCacheStore = true;
}

// WHY A LOADER HOOK RATHER THAN RESOLVING metro-config OURSELVES: resolving it
// from the project can pick a different copy from the one the Expo CLI
// actually requires (a monorepo, a pnpm store, a nested @expo/cli), and
// patching the copy nobody loads is the one failure mode that would be
// SILENT -- no warning, no cache, nothing to read. Hooking the load instead
// means the module we patch is by construction the module Expo got.
function install() {
  if (!STORE_ROOT) return;
  const Module = require('node:module');
  const load = Module._load;
  if (typeof load !== 'function') {
    warn("this Node build has no Module._load to hook, so metro-config's load cannot be intercepted");
    return;
  }
  Module._load = function (request, parent, isMain) {
    const exports = load.apply(this, arguments);
    if (request === 'metro-config') {
      try {
        patch(exports, Module._resolveFilename(request, parent, isMain));
      } catch (err) {
        warn('patching metro-config failed: ' + (err && err.message));
      }
    }
    return exports;
  };
}

try {
  install();
} catch (err) {
  warn('the cache-store shim did not load: ' + (err && err.message));
}
