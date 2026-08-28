'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const projectRoot = process.env.RN_ISO_PROJECT_ROOT;
const storeRoot = process.env.RN_ISO_METRO_STORE;
const priorOverride = process.env.RN_ISO_EXPO_METRO_CONFIG;
const adapterPath = __filename;
const STORE_ROOT_TAG = 'rnIsoStoreRoot';
const OK_PREFIX = 'rn-iso-metro-store: sharing Metro transforms through ';

let announced = false;
let warned = false;

function warn(reason) {
  if (warned) return;
  warned = true;
  process.stderr.write(
    `warning: rn-iso could not share this project's Metro transform cache (${String(reason).replace(/\s+/g, ' ')}); ` +
      'the dev server is running with its normal cache.\n',
  );
}

function announce() {
  if (announced) return;
  announced = true;
  process.stderr.write(`${OK_PREFIX}${storeRoot}\n`);
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function packageHasMetro(file) {
  try {
    return Object.prototype.hasOwnProperty.call(JSON.parse(fs.readFileSync(file, 'utf8')), 'metro');
  } catch {
    return false;
  }
}

const searchPlaces = [
  'metro.config.js',
  'metro.config.cjs',
  'metro.config.mjs',
  'metro.config.json',
  'metro.config.ts',
  'metro.config.cts',
  'metro.config.mts',
  path.join('.config', 'metro.js'),
  path.join('.config', 'metro.cjs'),
  path.join('.config', 'metro.mjs'),
  path.join('.config', 'metro.json'),
  path.join('.config', 'metro.ts'),
  path.join('.config', 'metro.cts'),
  path.join('.config', 'metro.mts'),
  'package.json',
];

function findProjectConfig() {
  if (priorOverride) {
    let candidate;
    try {
      candidate = createRequire(path.join(projectRoot, 'package.json')).resolve(priorOverride);
    } catch {
      candidate = path.isAbsolute(priorOverride) ? priorOverride : path.resolve(projectRoot, priorOverride);
    }
    if (path.resolve(candidate) !== path.resolve(adapterPath)) return candidate;
  }

  const stop = os.homedir();
  let dir = path.resolve(projectRoot);
  while (true) {
    for (const relative of searchPlaces) {
      const candidate = path.join(dir, relative);
      if (!isFile(candidate)) continue;
      if (relative === 'package.json' && !packageHasMetro(candidate)) continue;
      return candidate;
    }
    if (dir === stop || dir === path.dirname(dir)) return null;
    dir = path.dirname(dir);
  }
}

function unwrap(file, value) {
  if (file.endsWith(`${path.sep}package.json`)) return value.metro;
  return value && value['__esModule'] ? value.default : value;
}

function loadProjectConfig(file) {
  if (!file) return {};
  try {
    return unwrap(file, require(file));
  } catch (error) {
    if (error && (error.code === 'ERR_REQUIRE_ESM' || error.code === 'ERR_UNKNOWN_FILE_EXTENSION')) {
      return import(pathToFileURL(file).href).then((module) => unwrap(file, module));
    }
    throw error;
  }
}

function then(value, next) {
  // oxlint-disable-next-line promise/no-callback-in-promise -- Metro accepts synchronous values and promises.
  return value && typeof value.then === 'function' ? value.then(next) : next(value);
}

function storeAtRoot(store) {
  if (!store || typeof store !== 'object') return false;
  return store[STORE_ROOT_TAG] === storeRoot || store['_root'] === storeRoot;
}

function appendStore(config, defaultConfig) {
  const output = config && typeof config === 'object' ? config : {};
  const configuredStores = output.cacheStores != null ? output.cacheStores : defaultConfig.cacheStores;

  return {
    ...output,
    cacheStores(MetroCache) {
      const resolved = typeof configuredStores === 'function' ? configuredStores(MetroCache) : configuredStores;
      const stores = Array.isArray(resolved) ? resolved : [];
      if (stores.some(storeAtRoot)) {
        announce();
        return stores;
      }
      if (!MetroCache || typeof MetroCache.FileStore !== 'function') {
        warn('Metro exposes no FileStore constructor');
        return stores;
      }
      try {
        const store = new MetroCache.FileStore({ root: storeRoot });
        try {
          Object.defineProperty(store, STORE_ROOT_TAG, { value: storeRoot, configurable: true });
        } catch {}
        announce();
        return [...stores, store];
      } catch (error) {
        warn(error instanceof Error ? error.message : error);
        return stores;
      }
    },
  };
}

if (!projectRoot || !storeRoot) {
  module.exports = {};
} else {
  const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
  const expoMetroConfig = projectRequire('expo/metro-config');
  const defaultConfig = expoMetroConfig.getDefaultConfig(projectRoot);
  const projectConfig = loadProjectConfig(findProjectConfig());

  module.exports = then(defaultConfig, (base) =>
    then(projectConfig, (loaded) =>
      then(typeof loaded === 'function' ? loaded(base) : loaded, (resolved) => appendStore(resolved, base)),
    ),
  );
}
