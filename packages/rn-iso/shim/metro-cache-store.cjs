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
// WHERE THE GUARANTEE LIVES -- READ THIS BEFORE MOVING ANYTHING (issue #80).
// This shim has now aimed at the wrong function twice. Attempt one mutated
// `metro-config`'s namespace, which is impossible (configurable:false
// accessors). Attempt two returned a Proxy that wrapped `loadConfig` -- right
// technique, wrong target: Expo SDK 54+ never calls `loadConfig`. `@expo/cli`
// calls `loadUserConfig` from `@expo/metro-config`, which borrows only
// `mergeConfig`. Field-measured on expo 57 / @expo/metro 56 / RN 0.86: the
// proxy WAS installed, 9,946 modules bundled, the store gained zero files, and
// nothing warned.
//
// So the guarantee moved to where Metro CONSUMES the stores rather than to
// where the config is built. However the config is assembled -- loadConfig,
// loadUserConfig, mergeConfig, or whatever Expo invents next -- Metro reaches
// exactly one line before it can transform anything:
//
//   metro/src/DeltaBundler/Transformer.js
//     var _metroCache = require("metro-cache");
//     this._cache = new _metroCache.Cache(config.cacheStores);
//
// (verified on metro 0.84.4 and 0.84.5; `@expo/metro/metro-cache/index.js` is
// `module.exports = require("metro-cache")`, so Expo's copy funnels through
// the same request). Hooking THAT is what this file does now: the namespace
// `require('metro-cache')` hands back is a substitute whose `Cache` appends
// rn-iso's FileStore to the store list it is constructed with. A config path
// that skips every wrapper below still cannot skip this one, because a Metro
// that never builds a Cache never transforms a module.
//
// The `loadConfig` and `mergeConfig` wrappers are KEPT as belt and braces (a
// bare `react-native start`, an older Metro, a tool that reads cacheStores off
// the config itself), but nothing depends on them any more. Appending twice is
// impossible either way: every store rn-iso creates carries STORE_ROOT_TAG and
// every appender checks for it first.
//
// The two inputs arrive in the environment rather than in the argv, because
// `--require` has no argv:
//   RN_ISO_METRO_STORE   absolute path of the FileStore root. Unset means
//                        "do nothing" -- that is also the kill switch's effect
//                        (caches.injectMetroStore: false in ~/.rn-iso/config.json).
//   RN_ISO_PROJECT_ROOT  the project, for the module resolution below.

const STORE_ROOT = process.env.RN_ISO_METRO_STORE;

// The property a shim marks its own substitutes with, so a SECOND copy of this
// file (an outer rn-iso, a different version in a nested install) recognizes
// an already-wrapped module and leaves it alone rather than stacking a proxy
// on a proxy. One per module, because the two are substituted independently.
const CONFIG_MARKER = 'rnIsoSharedCacheStore';
const CACHE_MARKER = 'rnIsoSharedCacheHook';

// THE SUCCESS LINE, and the only thing this file prints when it works. It is
// the machine-readable half of the contract with the supervisor: rn-iso can
// only ever know that it ASKED for the injection (it set NODE_OPTIONS in
// another process), so the record that says the store is really in play has to
// come from HERE.
//
// It is written from ONE place -- the Cache construction -- and that is the
// point. A store sitting in a config object is not evidence: the field failure
// was a config that got merged over. This line means "the Cache object Metro
// is about to transform through was constructed with our store in its list",
// which is the last moment at which the claim can still be wrong.
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
//
// At most ONE warning per process, whatever goes wrong and however many times:
// the config wrappers and the cache hook can fail for the same underlying
// reason (a metro-cache that is not there), and a dev server log that says it
// twice reads like two faults.
let warned = false;
function warn(reason) {
  if (warned) return;
  warned = true;
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

// Once per process, however many Caches Metro builds. The timeline wants the
// fact, not a repetition of it.
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

// --- the choke point: metro-cache's Cache ----------------------------------

// PURE-ish. The store list a Cache should actually be constructed with:
// whatever it was handed, plus ours, unless ours is already in there.
//
// APPEND, NEVER REPLACE, and never reorder: a project that configured its own
// cacheStores keeps every one of them in the order it chose (Metro reads them
// in order and writes back only to the ones ahead of the hit), and rn-iso's is
// one more place to look at the end.
//
// A non-array is handed back UNTOUCHED. Metro's Cache does `stores.length` and
// nothing else, so a non-array is a config that is already broken; turning it
// into an array here would replace somebody else's bug with ours.
function storesWithOurs(stores, metroCache) {
  if (!Array.isArray(stores)) {
    warn('the stores Metro built its cache from are not an array, so ours could not be appended');
    return stores;
  }
  for (const existing of stores) {
    // Idempotent: the mergeConfig/loadConfig wrappers below may already have
    // put it in the config, and a project may point at this same root by hand.
    // Either is "the transforms are shared", which is what the line reports.
    if (storeRootOf(existing) === STORE_ROOT) {
      announce(STORE_ROOT);
      return stores;
    }
  }
  const FileStore = metroCache && metroCache.FileStore;
  if (typeof FileStore !== 'function') {
    warn('the metro-cache Metro built its cache from exports no FileStore');
    return stores;
  }
  const appended = stores.concat([makeStore(FileStore, STORE_ROOT)]);
  announce(STORE_ROOT);
  return appended;
}

// The substitute for the Cache CLASS: a Proxy with a construct trap, so
// `instanceof`, statics and subclassing all keep working and only the argument
// changes. Every failure inside is the ORIGINAL argument -- a Metro that
// cannot build its cache is a dev server that does not start.
function wrapCacheClass(RealCache, metroCache) {
  return new Proxy(RealCache, {
    construct(target, args, newTarget) {
      let patched = args;
      try {
        patched = [storesWithOurs(args[0], metroCache)].concat(Array.prototype.slice.call(args, 1));
      } catch (err) {
        warn('the store could not be added to the cache Metro was building: ' + (err && err.message));
        patched = args;
      }
      return Reflect.construct(target, patched, newTarget);
    },
  });
}

// The substitute for the metro-cache NAMESPACE. Same Proxy reasoning as
// makeConfigSubstitute below (metro-cache is Babel-transpiled ESM->CJS too:
// every export is a non-configurable accessor, measured on 0.84.4 and 0.84.5),
// so the class is swapped by answering one `get` rather than by assigning to a
// property that refuses assignment.
function makeCacheSubstitute(metroCache) {
  let wrapped = null;
  return new Proxy(metroCache, {
    get(target, prop) {
      if (prop === CACHE_MARKER) return true;
      if (prop !== 'Cache') return Reflect.get(target, prop);
      if (wrapped) return wrapped;
      const RealCache = Reflect.get(target, prop);
      if (typeof RealCache !== 'function') {
        warn('the metro-cache this project loaded exports a Cache that is not a constructor');
        return RealCache;
      }
      // Memoized so `ns.Cache === ns.Cache`: consumers destructure it, store
      // it and compare it.
      wrapped = wrapCacheClass(RealCache, target);
      return wrapped;
    },
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

// `require('metro-cache/private/Cache')` -- the OTHER resolvable way to the
// same class, and the one `@expo/metro/metro-cache/Cache.js` is literally
// written as. Nothing in metro 0.84 constructs through it, but the entry point
// exists in the package layout Expo ships, and "cover every path by
// construction" is the whole reason this hook moved here. The exports of that
// module are the class itself (`exports.default = Cache` plus interop), so the
// namespace trick does not apply: the class is wrapped directly, with FileStore
// resolved from the same location.
function makeCacheClassSubstitute(exports, filename) {
  const RealCache = typeof exports === 'function' ? exports : exports && exports.default;
  if (typeof RealCache !== 'function') return exports;
  let metroCache;
  try {
    metroCache = require('node:module').createRequire(filename)('metro-cache');
  } catch (err) {
    warn('metro-cache is not resolvable from ' + filename + ': ' + (err && err.message));
    return exports;
  }
  const wrapped = wrapCacheClass(RealCache, metroCache);
  if (typeof exports === 'function') return wrapped;
  // The interop shape: same object, with `default` answered by the wrapper.
  return new Proxy(exports, {
    get(target, prop) {
      if (prop === CACHE_MARKER) return true;
      return prop === 'default' ? wrapped : Reflect.get(target, prop);
    },
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

// --- belt and braces: the config-level wrappers ----------------------------

// Append, never replace, on a CONFIG OBJECT this time. `cacheStores` may also
// be a FUNCTION of Metro's cache module (Metro supports that form), which is
// wrapped rather than flattened, because calling it here would evaluate it at
// the wrong time.
//
// Nothing announces from here any more, deliberately. A store in a config is
// not proof the transforms are shared -- `mergeConfig(base, userConfig)`
// replaces `cacheStores` wholesale when the user's config defines it, so this
// append can be silently undone one line later. The Cache hook says the word.
function appendStore(config, FileStore, root) {
  if (!config || typeof config !== 'object') return false;
  const stores = config.cacheStores;
  if (typeof stores === 'function') {
    config.cacheStores = function (metroCache) {
      const resolved = stores(metroCache);
      if (Array.isArray(resolved)) {
        for (const existing of resolved) {
          if (storeRootOf(existing) === root) return resolved;
        }
        return resolved.concat([makeStore(FileStore, root)]);
      }
      return [makeStore(FileStore, root)];
    };
    return true;
  }
  if (Array.isArray(stores)) {
    // Idempotent: two --require entries, a mergeConfig called twice, or a
    // project that already points at this exact root.
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
// back, hand the same config on. Every failure inside is the UNTOUCHED config,
// never a rejected promise -- a dev server that cannot start is strictly worse
// than one with a cold cache.
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
          appendStore(config, FileStore, STORE_ROOT);
        } catch (err) {
          // The config loaded fine; only the store did not. The Cache hook is
          // still ahead of us, so this is not even a warning.
          void err;
        }
        return config;
      });
  };
}

// The wrapper around mergeConfig -- Expo's path, through
// `@expo/metro-config`'s loadUserConfig. Synchronous, and it appends to the
// RESULT, which is a fresh object mergeConfig just built.
function wrapMergeConfig(original, FileStore) {
  return function mergeConfig() {
    const merged = original.apply(this, arguments);
    try {
      appendStore(merged, FileStore, STORE_ROOT);
    } catch (err) {
      void err;
    }
    return merged;
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
// trap answers the wrapped names with wrappers and forwards everything else.
// That sidesteps configurable:false entirely and does not depend on Metro's
// transpilation shape.
//
// Three properties of the handler are deliberate:
//   - LAZINESS IS PRESERVED. A shallow copy (`{ ...ns }`) would work too and
//     is what not to do: it evaluates every lazy getter at require time, which
//     is Babel's whole reason for emitting them. `get` forwards one property at
//     a time, and even the wrapped names are only read from the target when
//     somebody asks for them.
//   - `Reflect.get(target, prop)` DROPS THE RECEIVER on purpose, so a
//     forwarded getter runs with `this === target`, exactly as it would if the
//     proxy were not there.
//   - `getOwnPropertyDescriptor` reports the TARGET's descriptor, not ours. It
//     has no choice: a proxy may not report a different `[[Get]]` for a
//     non-configurable accessor property (the invariant check throws
//     TypeError). So `Object.keys`, spread and
//     `Object.getOwnPropertyDescriptors` see the real shape, while every
//     ordinary read -- `ns.loadConfig`, `const { mergeConfig } = ns` -- goes
//     through `get` and gets the wrapper. That is the shape every consumer
//     uses; the descriptor is not.
function makeConfigSubstitute(metroConfig, FileStore, wrappable) {
  const wrappers = { loadConfig: wrapLoadConfig, mergeConfig: wrapMergeConfig };
  const memo = Object.create(null);
  return new Proxy(metroConfig, {
    get(target, prop) {
      if (prop === CONFIG_MARKER) return true;
      if (typeof prop !== 'string' || wrappable.indexOf(prop) === -1) return Reflect.get(target, prop);
      if (memo[prop]) return memo[prop];
      const original = Reflect.get(target, prop);
      if (typeof original !== 'function') {
        // Discovered late (the property exists but is not callable). Hand back
        // exactly what the module has, so nothing changes shape underneath the
        // consumer.
        warn('the metro-config this project loaded exports a ' + prop + ' that is not a function');
        return original;
      }
      // Memoized so `ns.loadConfig === ns.loadConfig`: consumers bind it,
      // store it and compare it.
      memo[prop] = wrappers[prop](original, FileStore);
      return memo[prop];
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

// One decision per loaded module, remembered: Module._load runs on every
// require, and both the substitute's identity (`require('metro-cache') ===
// require('metro-cache')`) and the ONE-line warning contract depend on
// deciding once. Weak so a module that goes away can be collected.
const decided = new WeakMap();

// Returns what a require() should hand back: the substitute, or the original
// module untouched when the substitute cannot be built. Never throws, never
// mutates the module.
function substitute(exports, decider, filename) {
  if (!exports || (typeof exports !== 'object' && typeof exports !== 'function')) return exports;
  if (decided.has(exports)) return decided.get(exports);
  const replacement = decider(exports, filename);
  decided.set(exports, replacement);
  return replacement;
}

function decideCache(metroCache) {
  // Already substituted by another copy of this shim. Reading the marker is a
  // property GET, which its proxy answers without touching the module.
  if (metroCache[CACHE_MARKER]) return metroCache;
  // `in` rather than a read: it reports the property without evaluating the
  // lazy getter behind it, so the diagnostic stays early and the laziness
  // stays intact.
  if (!('Cache' in metroCache)) {
    warn('the metro-cache this project loaded exports no Cache');
    return metroCache;
  }
  // The one shape a `get` trap may not lie about: a non-configurable,
  // non-writable DATA property must read back as itself, so returning the
  // wrapper would throw a TypeError at the consumer.
  if (unsubstitutable(metroCache, 'Cache')) {
    warn('metro-cache.Cache is a non-configurable, non-writable value and cannot be substituted');
    return metroCache;
  }
  return makeCacheSubstitute(metroCache);
}

function decideConfig(metroConfig, filename) {
  if (metroConfig[CONFIG_MARKER]) return metroConfig;

  const wrappable = ['loadConfig', 'mergeConfig'].filter(
    (name) => name in metroConfig && !unsubstitutable(metroConfig, name),
  );
  if (wrappable.length === 0) {
    warn('the metro-config this project loaded exports neither a substitutable loadConfig() nor mergeConfig()');
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

  return makeConfigSubstitute(metroConfig, FileStore, wrappable);
}

// A non-configurable, non-writable DATA property: a proxy get trap may not
// report anything but its own value for one, so substituting would throw a
// TypeError at the consumer. No Metro observed does this (0.81.5 is a writable
// data property, everything since is an accessor) -- it is checked because a
// proxy invariant violation would break the dev server, which is the one
// outcome this file may not have.
function unsubstitutable(ns, prop) {
  const descriptor = Object.getOwnPropertyDescriptor(ns, prop);
  return !!descriptor && 'value' in descriptor && !descriptor.writable && !descriptor.configurable;
}

// WHY A LOADER HOOK RATHER THAN RESOLVING THESE MODULES OURSELVES: resolving
// from the project can pick a different copy from the one the Expo CLI
// actually requires (a monorepo, a pnpm store, a nested @expo/cli), and
// patching the copy nobody loads is the one failure mode that would be
// SILENT -- no warning, no cache, nothing to read. Hooking the load instead
// means the module we substitute for is by construction the module Metro got.
//
// The request STRINGS are matched rather than resolved paths, and the suffix
// form is there for Expo's meta-package: `@expo/metro/metro-cache` is a
// one-line re-export of `metro-cache`, so either request may be the one that
// reaches us first. Substituting both is free -- the second sees the first's
// marker and hands the same object back.
// The suffix form is `<meta-package>/metro/<name>`, NOT a bare `/<name>`, and
// the difference is a bug this file shipped for exactly one live run.
// `@expo/metro-config` ALSO ends in `/metro-config`, and it is a DIFFERENT
// package -- Expo's own, exporting loadUserConfig and getDefaultConfig and
// neither of the two names wrapped here. Matching it earned a "exports neither
// loadConfig nor mergeConfig" warning on a dev server where the store was
// being shared perfectly well, which is the exact crying-wolf this change
// exists to remove. `@expo/metro/metro-config` -- the one-line re-export of
// the real thing -- still matches, and so would any future meta-package laid
// out the same way. A relative or absolute request cannot match at all.
function isMetroSubpath(request, name) {
  return request === name || request.endsWith('/metro/' + name);
}
function isCacheRequest(request) {
  return isMetroSubpath(request, 'metro-cache');
}
function isCacheClassRequest(request) {
  return request === 'metro-cache/private/Cache' || request.endsWith('/metro/metro-cache/Cache');
}
function isConfigRequest(request) {
  return isMetroSubpath(request, 'metro-config');
}

function install() {
  if (!STORE_ROOT) return;
  const Module = require('node:module');
  const load = Module._load;
  if (typeof load !== 'function') {
    warn("this Node build has no Module._load to hook, so Metro's cache cannot be intercepted");
    return;
  }
  Module._load = function (request, parent, isMain) {
    const exports = load.apply(this, arguments);
    if (typeof request !== 'string') return exports;
    let decider = null;
    if (isCacheRequest(request)) decider = decideCache;
    else if (isCacheClassRequest(request)) decider = makeCacheClassSubstitute;
    else if (isConfigRequest(request)) decider = decideConfig;
    if (!decider) return exports;
    try {
      return substitute(exports, decider, Module._resolveFilename(request, parent, isMain));
    } catch (err) {
      warn('substituting ' + request + ' failed: ' + (err && err.message));
      return exports;
    }
  };
}

try {
  install();
} catch (err) {
  warn('the cache-store shim did not load: ' + (err && err.message));
}
