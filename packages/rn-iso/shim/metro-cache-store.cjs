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

// The property a shim marks its own substitute with, so a SECOND copy of this
// file (an outer rn-iso, a different version in a nested install) recognizes
// an already-wrapped metro-config and leaves it alone rather than stacking a
// proxy on a proxy.
const MARKER = 'rnIsoSharedCacheStore';

// THE SUCCESS LINE, and the only thing this file prints when it works. It is
// the machine-readable half of the contract with the supervisor: rn-iso can
// only ever know that it ASKED for the injection (it set NODE_OPTIONS in
// another process), so the record that says the store is actually in the
// config Metro loaded has to come from HERE, after the store is in it.
// server-expo.ts parses this exact prefix (metroStoreConfirmedRoot in
// src/supervisor/metro-store.ts) into the `cache_store_added` record; anything
// that changes it must change there too.
const OK_PREFIX = 'rn-iso-metro-store: sharing Metro transforms through ';

// The property every store rn-iso installs carries, so a second appender can
// recognize it. Duplicated from @rn-iso/core's STORE_ROOT_TAG for the reason
// the env var names are duplicated: this file may have no dependencies at all.
// Metro made FileStore's `_root` private in metro-cache 0.83.0, so reading the
// store's own field is not an option on anything current -- `_root` is still
// read as a fallback for 0.82 and older, where it was public.
const STORE_ROOT_TAG = 'rnIsoStoreRoot';

function storeRootOf(store) {
  if (!store || typeof store !== 'object') return null;
  if (typeof store[STORE_ROOT_TAG] === 'string') return store[STORE_ROOT_TAG];
  return typeof store._root === 'string' ? store._root : null;
}

// A tagged FileStore, or an untagged one if the instance refuses the property:
// untaggable means undetectable, which costs a duplicate entry at worst.
function makeStore(FileStore, root) {
  const store = new FileStore({ root: root });
  try {
    Object.defineProperty(store, STORE_ROOT_TAG, { value: root, enumerable: false, configurable: true });
  } catch {
    // See above.
  }
  return store;
}

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

// Once per process, however many times loadConfig is called (Expo calls it per
// platform on some paths). The timeline wants the fact, not a repetition of it.
let announced = false;
function announce(root) {
  if (announced) return;
  announced = true;
  try {
    process.stderr.write(OK_PREFIX + root + '\n');
  } catch {
    // See warn(): a dead stderr is not a reason to throw at a dev server.
  }
}

// Append, never replace. A project that configured its own cacheStores keeps
// every one of them -- rn-iso's store is one more place to look, not a
// substitute for the project's decision. `cacheStores` may also be a FUNCTION
// of Metro's cache module (Metro supports that form), which is wrapped rather
// than flattened, because calling it here would evaluate it at the wrong time.
//
// Returns whether the resolved config will consult our store, which is TRUE
// for the already-present case too: a project that points at this same root by
// hand is sharing the store, and that is the fact the success line reports.
function appendStore(config, FileStore, root) {
  if (!config || typeof config !== 'object') return false;
  const stores = config.cacheStores;
  if (typeof stores === 'function') {
    config.cacheStores = function (metroCache) {
      const resolved = stores(metroCache);
      return (Array.isArray(resolved) ? resolved : []).concat([makeStore(FileStore, root)]);
    };
    return true;
  }
  if (Array.isArray(stores)) {
    // Idempotent: two --require entries, or a project that already points at
    // this exact root, must not end up with the store twice.
    for (const existing of stores) {
      if (storeRootOf(existing) === root) return true;
    }
    config.cacheStores = stores.concat([makeStore(FileStore, root)]);
    return true;
  }
  config.cacheStores = [makeStore(FileStore, root)];
  return true;
}

// The wrapper around the real loadConfig: await it, add the store to what came
// back, hand the same config on. Every failure inside is a warning and the
// UNTOUCHED config, never a rejected promise -- a dev server that cannot start
// is strictly worse than one with a cold cache.
function wrapLoadConfig(original, FileStore) {
  return function loadConfig() {
    const args = arguments;
    const self = this;
    return Promise.resolve()
      .then(function () {
        return original.apply(self, args);
      })
      .then(function (config) {
        try {
          if (appendStore(config, FileStore, STORE_ROOT)) announce(STORE_ROOT);
        } catch (err) {
          // The config loaded fine; only the store did not. Serve without it.
          warn('the store could not be added to the loaded config: ' + (err && err.message));
        }
        return config;
      });
  };
}

// WHY A PROXY AND NOT AN ASSIGNMENT (issue #73, field-verified broken):
// metro-config is Babel-transpiled ESM->CJS, so every export is an ACCESSOR
// property defined with `configurable: false` (measured identical on
// metro-config 0.84.4 and 0.87.0). `ns.loadConfig = wrapped` throws in strict
// mode and `Object.defineProperty` throws "Cannot redefine property", so the
// old mutate-the-namespace shim could never apply on any current Expo project.
//
// This file already controls what `require('metro-config')` RETURNS, so it
// returns a SUBSTITUTE instead of editing the original: a Proxy whose `get`
// trap answers `loadConfig` with the wrapper and forwards everything else.
// That sidesteps configurable:false entirely and does not depend on Metro's
// transpilation shape.
//
// Three properties of the handler are deliberate:
//   - LAZINESS IS PRESERVED. A shallow copy (`{ ...ns }`) would work too and
//     is what not to do: it evaluates every lazy getter at require time, which
//     is Babel's whole reason for emitting them. `get` forwards one property at
//     a time, and even `loadConfig` is only read from the target when somebody
//     asks for it.
//   - `Reflect.get(target, prop)` DROPS THE RECEIVER on purpose, so a
//     forwarded getter runs with `this === target`, exactly as it would if the
//     proxy were not there.
//   - `getOwnPropertyDescriptor` reports the TARGET's descriptor for
//     `loadConfig`, not ours. It has no choice: a proxy may not report a
//     different `[[Get]]` for a non-configurable accessor property (the
//     invariant check throws TypeError). So `Object.keys`, spread and
//     `Object.getOwnPropertyDescriptors` see the real shape, while every
//     ordinary read -- `ns.loadConfig`, `const { loadConfig } = ns` -- goes
//     through `get` and gets the wrapper. That is the shape every consumer
//     uses; the descriptor is not.
function makeSubstitute(metroConfig, FileStore) {
  let wrapped = null;
  return new Proxy(metroConfig, {
    get(target, prop) {
      if (prop === MARKER) return true;
      if (prop !== 'loadConfig') return Reflect.get(target, prop);
      if (wrapped) return wrapped;
      const original = Reflect.get(target, prop);
      if (typeof original !== 'function') {
        // Discovered late (the property exists but is not callable). Hand back
        // exactly what the module has, so nothing changes shape underneath the
        // consumer.
        warn('the metro-config this project loaded exports a loadConfig that is not a function');
        return original;
      }
      // Memoized so `ns.loadConfig === ns.loadConfig`: consumers bind it,
      // store it and compare it.
      wrapped = wrapLoadConfig(original, FileStore);
      return wrapped;
    },
    // The remaining three traps are explicit forwards. They are the default
    // behaviour, written out because they are the ones a consumer walking the
    // namespace (`Object.keys`, `'loadConfig' in ns`, a spread) goes through,
    // and because the descriptor trap above is the one place where forwarding
    // is a decision rather than a default.
    has(target, prop) {
      return Reflect.has(target, prop);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, prop) {
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
}

// One decision per loaded metro-config, remembered: Module._load runs on every
// require, and both the proxy's identity (`require('metro-config') ===
// require('metro-config')`) and the warning's ONE-line contract depend on
// deciding once. Weak so a module that goes away can be collected.
const decided = new WeakMap();

// Returns what `require('metro-config')` should hand back: the substitute, or
// the original module untouched when the substitute cannot be built. Never
// throws, never mutates the module.
function substitute(metroConfig, filename) {
  if (!metroConfig || typeof metroConfig !== 'object') return metroConfig;
  if (decided.has(metroConfig)) return decided.get(metroConfig);
  const replacement = decide(metroConfig, filename);
  decided.set(metroConfig, replacement);
  return replacement;
}

function decide(metroConfig, filename) {
  // Already substituted by another copy of this shim. Reading the marker is a
  // property GET, which its proxy answers without touching the module.
  if (metroConfig[MARKER]) return metroConfig;

  // `in` rather than a read: it reports the property without evaluating the
  // lazy getter behind it, so the diagnostic stays early and the laziness
  // stays intact.
  if (!('loadConfig' in metroConfig)) {
    warn('the metro-config this project loaded exports no loadConfig()');
    return metroConfig;
  }

  // The one shape a `get` trap may not lie about: a non-configurable,
  // non-writable DATA property must read back as itself, so returning the
  // wrapper would throw a TypeError at the consumer. No metro-config observed
  // does this (0.81.5 is a writable data property, 0.84.4 and 0.87.0 are
  // accessors) -- it is checked because a proxy invariant violation would
  // break the dev server, which is the one outcome this file may not have.
  const descriptor = Object.getOwnPropertyDescriptor(metroConfig, 'loadConfig');
  if (descriptor && 'value' in descriptor && !descriptor.writable && !descriptor.configurable) {
    warn('metro-config.loadConfig is a non-configurable, non-writable value and cannot be substituted');
    return metroConfig;
  }

  // metro-cache is resolved from METRO-CONFIG's own location rather than from
  // the project, so the FileStore class is the one belonging to this Metro
  // rather than to some other copy of Metro in the same tree.
  let FileStore;
  try {
    FileStore = require('node:module').createRequire(filename)('metro-cache').FileStore;
  } catch (err) {
    warn('metro-cache is not resolvable from ' + filename + ': ' + (err && err.message));
    return metroConfig;
  }
  if (typeof FileStore !== 'function') {
    warn('metro-cache exports no FileStore');
    return metroConfig;
  }

  return makeSubstitute(metroConfig, FileStore);
}

// WHY A LOADER HOOK RATHER THAN RESOLVING metro-config OURSELVES: resolving it
// from the project can pick a different copy from the one the Expo CLI
// actually requires (a monorepo, a pnpm store, a nested @expo/cli), and
// patching the copy nobody loads is the one failure mode that would be
// SILENT -- no warning, no cache, nothing to read. Hooking the load instead
// means the module we substitute for is by construction the module Expo got.
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
    if (request !== 'metro-config') return exports;
    try {
      return substitute(exports, Module._resolveFilename(request, parent, isMain));
    } catch (err) {
      warn('substituting metro-config failed: ' + (err && err.message));
      return exports;
    }
  };
}

try {
  install();
} catch (err) {
  warn('the cache-store shim did not load: ' + (err && err.message));
}
