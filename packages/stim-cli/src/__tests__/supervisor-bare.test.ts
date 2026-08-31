import assert from 'node:assert';
import { METRO_NAMED_CACHE_LAYOUT } from '@stim-cli/core';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendCacheStore,
  hasStoreAt,
  metroStoreName,
  metroStoreRoot,
  registerMetroStore,
} from '../supervisor/metro-store.ts';
import { readManifest } from '../cache-manifest.ts';
import {
  BARE_PACKAGES,
  checkBareApi,
  ensureNativePlatform,
  loadNdjsonReporter,
  normalizeMetroTransformerPaths,
  normalizeModule,
  reporterLogger,
  resolveBareDeps,
  startBareServer,
} from '../supervisor/server-bare.ts';
import type { NdjsonRecord, NdjsonWriter } from '../ndjson.ts';
import { asRequire, makeError, makeWriter } from './_factories.ts';

function caught(fn: () => unknown): Error & Record<string, unknown> {
  try {
    fn();
  } catch (err) {
    return err as Error & Record<string, unknown>;
  }
  throw new Error('expected a throw');
}

let root: string;
let tmpHome: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-bare-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'bare' }));
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  delete process.env.STIM_METRO_CACHE;
});

function fakeRequire(
  modules: Record<string, unknown>,
  { throwOnLoad = {} }: { throwOnLoad?: Record<string, string> } = {},
) {
  const localRequire = (id: string) => {
    if (throwOnLoad[id]) throw new Error(throwOnLoad[id]);
    if (!(id in modules)) {
      throw makeError(`Cannot find module '${id}'`, { code: 'MODULE_NOT_FOUND' });
    }
    return modules[id];
  };
  localRequire.resolve = (id: string) => {
    if (!(id in modules) && !(id in throwOnLoad)) {
      throw makeError(`Cannot find module '${id}'`, { code: 'MODULE_NOT_FOUND' });
    }
    return id;
  };
  return () => asRequire(localRequire);
}

type OkModules = {
  metro: { loadConfig: () => Promise<unknown>; runServer?: () => Promise<unknown> };
  '@react-native/dev-middleware'?: { createDevMiddleware: () => unknown };
  '@react-native-community/cli-server-api'?: { createDevServerMiddleware: () => unknown };
};

const OK_MODULES = (): OkModules => ({
  metro: { loadConfig: async () => ({}), runServer: async () => ({}) },
  '@react-native/dev-middleware': { createDevMiddleware: () => ({ middleware: 'dm', websocketEndpoints: {} }) },
  '@react-native-community/cli-server-api': {
    createDevServerMiddleware: () => ({ middleware: 'cm', websocketEndpoints: {} }),
  },
});

describe("resolving the project's own dev server packages", () => {
  test('every missing package is named at once, with an npm install remedy', () => {
    const modules = OK_MODULES();
    delete modules['@react-native/dev-middleware'];
    delete modules['@react-native-community/cli-server-api'];
    const err = caught(() => resolveBareDeps(root, { requireFrom: fakeRequire(modules) }));
    expect(err.code).toBe('STIM_BARE_DEPS');
    expect(err.message).toMatch(/@react-native\/dev-middleware/);
    expect(err.message).toMatch(/@react-native-community\/cli-server-api/);
    expect(!err.message.includes(' metro,')).toBeTruthy();
    expect(err.message).toMatch(new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(err.remedy).toMatch(/npm install/);
    expect(err.remedy).toMatch(/Expo/);
  });

  test('a package that is installed but throws while loading is NOT reported as missing', () => {
    const err = caught(() =>
      resolveBareDeps(root, {
        requireFrom: fakeRequire(OK_MODULES(), { throwOnLoad: { metro: 'Unexpected token' } }),
      }),
    );
    expect(err.code).toBe('STIM_BARE_LOAD');
    expect(err.message).toMatch(/metro is installed/);
    expect(err.message).toMatch(/Unexpected token/);
  });

  test('a package whose API does not match names the package and the export', () => {
    const modules = OK_MODULES();
    delete modules['metro'].runServer;
    const err = caught(() => resolveBareDeps(root, { requireFrom: fakeRequire(modules) }));
    expect(err.code).toBe('STIM_BARE_API');
    expect(err.message).toMatch(/metro does not export runServer\(\)/);
    expect(!/undefined is not a function/.test(err.message)).toBeTruthy();
  });

  test('success returns the three modules', () => {
    const deps = resolveBareDeps(root, { requireFrom: fakeRequire(OK_MODULES()) });
    expect(typeof deps.metro.runServer).toBe('function');
    expect(typeof deps.devMiddleware.createDevMiddleware).toBe('function');
    expect(typeof deps.serverApi.createDevServerMiddleware).toBe('function');
  });

  test('the three packages are the ones a bare RN project already has', () => {
    expect(BARE_PACKAGES).toEqual(['metro', '@react-native/dev-middleware', '@react-native-community/cli-server-api']);
  });
});

describe('module interop', () => {
  test('normalizeModule reaches through .default when that is where the exports are', () => {
    const mod = { __esModule: true, default: { runServer: () => {}, loadConfig: () => {} } };
    expect(normalizeModule(mod, ['runServer', 'loadConfig'])).toBe(mod.default);
  });

  test('normalizeModule leaves a plain CommonJS module alone', () => {
    const mod = { runServer: () => {}, loadConfig: () => {} };
    expect(normalizeModule(mod, ['runServer', 'loadConfig'])).toBe(mod);
  });

  test('checkBareApi reports every missing export, not just the first', () => {
    const problems = checkBareApi({
      metro: {},
      '@react-native/dev-middleware': {},
      '@react-native-community/cli-server-api': {},
    });
    expect(problems.length).toBe(4);
    expect(problems.some((p) => /metro does not export loadConfig/.test(p))).toBeTruthy();
    expect(problems.some((p) => /dev-middleware does not export createDevMiddleware/.test(p))).toBeTruthy();
  });
});

describe('config adjustments', () => {
  test("ensureNativePlatform adds 'native', which the RN CLI adds and metro.config.js does not", () => {
    const config = { resolver: { platforms: ['android', 'ios'] } };
    expect(ensureNativePlatform(config)).toBe(true);
    expect(config.resolver.platforms).toEqual(['android', 'ios', 'native']);
  });

  test('ensureNativePlatform is a no-op when it is already there', () => {
    const config = { resolver: { platforms: ['ios', 'native'] } };
    expect(ensureNativePlatform(config)).toBe(false);
    expect(config.resolver.platforms).toEqual(['ios', 'native']);
  });

  test('ensureNativePlatform tolerates a config with no resolver', () => {
    expect(ensureNativePlatform({})).toBe(false);
  });

  test('normalizes a project-local Metro transformer path across worktrees', () => {
    const config = {
      transformer: {
        asyncRequireModulePath: join(root, 'node_modules', 'metro-runtime', 'src', 'modules', 'asyncRequire.js'),
      },
    };
    expect(normalizeMetroTransformerPaths(config, root)).toBe(true);
    expect(config.transformer.asyncRequireModulePath).toBe('./node_modules/metro-runtime/src/modules/asyncRequire.js');
  });

  test('keeps a Metro transformer path outside the project root', () => {
    const config = { transformer: { asyncRequireModulePath: '/shared/metro-runtime/asyncRequire.js' } };
    expect(normalizeMetroTransformerPaths(config, root)).toBe(false);
    expect(config.transformer.asyncRequireModulePath).toBe('/shared/metro-runtime/asyncRequire.js');
  });
});

describe('the dev-middleware logger', () => {
  test('routes info/warn/error into the reporter as unstable_server_log', () => {
    const events: Array<{ type: string; level: string; data: unknown[] }> = [];
    const logger = reporterLogger({
      update: (e: { type: string; level: string; data: unknown[] }) => events.push(e),
    });
    logger.info('hello', 'world');
    logger.warn('careful');
    logger.error('boom');
    expect(events.map((e) => e.type)).toEqual(['unstable_server_log', 'unstable_server_log', 'unstable_server_log']);
    expect(events.map((e) => e.level)).toEqual(['info', 'warn', 'error']);
    expect(events[0]?.data).toEqual(['hello', 'world']);
  });

  test('a throwing reporter never reaches the dev server', () => {
    const logger = reporterLogger({
      update: () => {
        throw new Error('disk full');
      },
    });
    expect(() => logger.error('boom')).not.toThrow();
  });
});

describe('loadNdjsonReporter', () => {
  test('resolves the one shared implementation from @stim-cli/metro', () => {
    const factory = loadNdjsonReporter(root);
    expect(typeof factory).toBe('function');
    assert(factory);
    const reporter = factory({ dir: join(root, '.stim', 'logs') });
    expect(typeof reporter.update).toBe('function');
  });

  test('returns null rather than throwing when the package is nowhere', () => {
    const nothing = () => {
      const req = (id: string) => {
        throw new Error(`Cannot find module '${id}'`);
      };
      req.resolve = req;
      return asRequire(req);
    };
    expect(loadNdjsonReporter(root, { requireFrom: nothing })).toBe(null);
  });

  test('prefers the reporter bundled with this CLI over an older project copy', () => {
    const projectPackage = join(root, 'package.json');
    const bundled = () => ({ update() {} });
    const projectLocal = () => ({ update() {} });
    const seen: string[] = [];
    const factory = loadNdjsonReporter(root, {
      requireFrom: (from) => {
        seen.push(from);
        return asRequire(() => ({ ndjsonReporter: from === projectPackage ? projectLocal : bundled }));
      },
    });

    expect(factory).toBe(bundled);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(projectPackage);
  });
});

describe('startBareServer wiring', () => {
  function fakeDeps() {
    interface FakeCalls {
      loadConfig?: { cwd: string; port: number };
      runServer: {
        config: { reporter?: unknown; resolver: { platforms: unknown } };
        options: { unstable_extraMiddleware?: unknown; websocketEndpoints?: unknown; host?: unknown };
      };
      createDevMiddleware: { serverBaseUrl?: unknown; logger: { error?: unknown } };
      createDevServerMiddleware?: unknown;
      reporterDir?: unknown;
      closed?: boolean;
      closedConnections?: boolean;
    }
    const calls = {} as FakeCalls;
    const httpServer = {
      handlers: {} as Record<string, (...args: unknown[]) => void>,
      on(event: string, cb: (...args: unknown[]) => void) {
        this.handlers[event] = cb;
      },
      closeAllConnections() {
        calls.closedConnections = true;
      },
      close(cb?: () => void) {
        calls.closed = true;
        cb?.();
      },
    };
    const deps = {
      metro: {
        async loadConfig(argv: { cwd: string; port: number }) {
          calls.loadConfig = argv;
          return { resolver: { platforms: ['android', 'ios'] }, watchFolders: ['/w'], server: {} };
        },
        async runServer(config: FakeCalls['runServer']['config'], options: FakeCalls['runServer']['options']) {
          calls.runServer = { config, options };
          return httpServer;
        },
      },
      devMiddleware: {
        createDevMiddleware(args: FakeCalls['createDevMiddleware']) {
          calls.createDevMiddleware = args;
          return { middleware: 'dev-mw', websocketEndpoints: { '/inspector': 'i' } };
        },
      },
      serverApi: {
        createDevServerMiddleware(args: unknown) {
          calls.createDevServerMiddleware = args;
          return { middleware: 'community-mw', websocketEndpoints: { '/message': 'm' } };
        },
      },
    };
    return { deps, calls, httpServer };
  }

  test('loads the project config with the port override and sets our reporter on it', async () => {
    const { deps, calls } = fakeDeps();
    const reporter = { update() {} };
    await startBareServer({
      root,
      port: 8099,
      logsDir: join(root, '.stim', 'logs'),
      deps,
      reporterFactory: (opts) => {
        calls.reporterDir = opts.dir;
        return reporter;
      },
    });
    expect(calls.loadConfig).toEqual({ cwd: root, port: 8099 });
    expect(calls.runServer.config.reporter).toBe(reporter);
    expect(calls.reporterDir).toBe(join(root, '.stim', 'logs'));
    expect(calls.runServer.config.resolver.platforms).toEqual(['android', 'ios', 'native']);
  });

  test('wires both middlewares and merges both websocket endpoint sets', async () => {
    const { deps, calls } = fakeDeps();
    await startBareServer({
      root,
      port: 8100,
      logsDir: join(root, 'logs'),
      deps,
      reporterFactory: () => ({ update() {} }),
    });

    expect(calls.createDevServerMiddleware).toEqual({ host: 'localhost', port: 8100, watchFolders: ['/w'] });
    expect(calls.createDevMiddleware.serverBaseUrl).toBe('http://localhost:8100');
    expect(typeof calls.createDevMiddleware.logger.error).toBe('function');
    expect(calls.runServer.options.unstable_extraMiddleware).toEqual(['community-mw', 'dev-mw']);
    expect(calls.runServer.options.websocketEndpoints).toEqual({ '/message': 'm', '/inspector': 'i' });
    expect('host' in calls.runServer.options).toBe(false);
  });

  test('serves without the reporter package, and says so in the log it would have written', async () => {
    const { deps, calls } = fakeDeps();
    const written: Array<{ src: string; level: string; event: string; msg: string }> = [];
    const handle = await startBareServer({
      root,
      port: 8101,
      logsDir: join(root, 'logs'),
      deps,
      reporterFactory: null,
      writer: makeWriter({
        write: (r: { src: string; level: string; event: string; msg: string }) => {
          written.push(r);
          return true;
        },
      }),
    });
    expect(handle.httpServer).toBeTruthy();
    expect(calls.runServer.config.reporter).toBe(undefined);
    const warn = written.find((r) => r.event === 'reporter_missing');
    assert(warn);
    expect(warn.level).toBe('warn');
    expect(warn.msg).toMatch(/@stim-cli\/metro/);
  });

  test('the handle closes the http server, connections and all', async () => {
    const { deps, calls } = fakeDeps();
    const handle = await startBareServer({
      root,
      port: 8102,
      logsDir: join(root, 'logs'),
      deps,
      reporterFactory: () => ({ update() {} }),
    });
    expect(handle.mode).toBe('bare-inproc');
    expect(handle.serverPid).toBe(null);
    await handle.close();
    expect(calls.closed).toBe(true);
    expect(calls.closedConnections).toBe(true);
  });

  test('an http server that closes on its own reports an unexpected exit', async () => {
    const { deps, httpServer } = fakeDeps();
    const handle = await startBareServer({
      root,
      port: 8103,
      logsDir: join(root, 'logs'),
      deps,
      reporterFactory: () => ({ update() {} }),
    });
    const seen: Array<{ code: number; reason?: string }> = [];
    handle.onExit((info) => seen.push(info));
    httpServer.handlers.close?.();
    expect(seen.length).toBe(1);
    expect(seen[0]?.reason).toMatch(/closed/);
  });

  test('our own close does not report an unexpected exit', async () => {
    const { deps, httpServer } = fakeDeps();
    const handle = await startBareServer({
      root,
      port: 8104,
      logsDir: join(root, 'logs'),
      deps,
      reporterFactory: () => ({ update() {} }),
    });
    const seen: Array<{ code: number; reason?: string }> = [];
    handle.onExit((info) => seen.push(info));
    await handle.close();
    httpServer.handlers.close?.();
    expect(seen).toEqual([]);
  });
});

describe('the shared Metro cache store', () => {
  class FakeStore {
    _root: string;
    constructor(options: { root: string }) {
      this._root = options.root;
    }
  }

  test('appends to the stores the project configured, keeping them and their order', () => {
    const projectStore = { name: 'the project own store' };
    const config: { cacheStores?: unknown } = { cacheStores: [projectStore] };
    const result = appendCacheStore(config, { storeRoot: '/cache/app', FileStore: FakeStore });
    expect(result.added).toBe(true);
    const stores = config.cacheStores as unknown[];
    expect(stores.length).toBe(2);
    expect(stores[0]).toBe(projectStore);
    expect((stores[1] as FakeStore)._root).toBe('/cache/app');
  });

  test('a config with no stores at all gets exactly ours', () => {
    const config: { cacheStores?: unknown } = {};
    expect(appendCacheStore(config, { storeRoot: '/cache/app', FileStore: FakeStore }).added).toBe(true);
    expect((config.cacheStores as FakeStore[]).map((s) => s._root)).toEqual(['/cache/app']);
  });

  test('a store already pointing at our root is not added a second time', () => {
    const config: { cacheStores?: unknown } = { cacheStores: [new FakeStore({ root: '/cache/app' })] };
    const result = appendCacheStore(config, { storeRoot: '/cache/app', FileStore: FakeStore });
    expect(result.added).toBe(false);
    expect(result.reason).toMatch(/already/);
    expect((config.cacheStores as unknown[]).length).toBe(1);
    expect(hasStoreAt(config.cacheStores, '/cache/app')).toBe(true);
    expect(hasStoreAt(config.cacheStores, '/cache/other')).toBe(false);
    expect(hasStoreAt(undefined, '/cache/app')).toBe(false);
  });

  test('a store with no public root is still recognized, by the tag Stim puts on it', () => {
    class PrivateRootStore {
      #root: string;
      constructor(options: { root: string }) {
        this.#root = options.root;
      }
      get root() {
        return this.#root;
      }
    }
    const config: { cacheStores?: unknown } = {};
    expect(appendCacheStore(config, { storeRoot: '/cache/app', FileStore: PrivateRootStore }).added).toBe(true);
    const stores = config.cacheStores as unknown[];
    expect(stores.length).toBe(1);
    expect((stores[0] as { _root?: unknown })._root).toBe(undefined);
    expect(hasStoreAt(stores, '/cache/app')).toBe(true);
    expect(hasStoreAt(stores, '/cache/other')).toBe(false);
    expect(appendCacheStore(config, { storeRoot: '/cache/app', FileStore: PrivateRootStore }).added).toBe(false);
    expect((config.cacheStores as unknown[]).length).toBe(1);
  });

  test('a function-shaped cacheStores is wrapped, not evaluated', () => {
    let calledWith: unknown = null;
    const config: { cacheStores?: unknown } = {
      cacheStores: (cache: unknown) => {
        calledWith = cache;
        return [{ name: 'lazy' }];
      },
    };
    expect(appendCacheStore(config, { storeRoot: '/cache/app', FileStore: FakeStore }).added).toBe(true);
    expect(calledWith).toBe(null);
    const resolved = (config.cacheStores as (c: unknown) => unknown[])({ marker: 1 });
    expect(calledWith).toEqual({ marker: 1 });
    expect(resolved.length).toBe(2);
    expect((resolved[1] as FakeStore)._root).toBe('/cache/app');
  });

  test('the store root is the shared Metro cache root, partitioned by the package name', () => {
    expect(metroStoreName(root)).toBe('bare');
    expect(metroStoreRoot(root)).toBe(join(tmpHome, 'metro-cache', 'bare'));
    const nameless = mkdtempSync(join(tmpdir(), 'stim-bare-nameless-'));
    try {
      writeFileSync(join(nameless, 'package.json'), '{}');
      expect(metroStoreName(nameless)).toBe('app');
    } finally {
      rmSync(nameless, { recursive: true, force: true });
    }
  });

  test('the CLI replaces a legacy flat override registration with the named store', () => {
    const parent = join(tmpHome, 'overridden-metro');
    process.env.STIM_METRO_CACHE = parent;
    writeFileSync(
      join(tmpHome, 'caches.json'),
      JSON.stringify({
        version: 1,
        caches: [
          { dir: parent, name: 'Metro transform cache', prune: 'entries', entriesDepth: 2 },
          {
            dir: parent,
            name: 'Metro transform cache',
            prune: 'entries',
            entriesDepth: 2,
            layout: METRO_NAMED_CACHE_LAYOUT,
          },
        ],
      }),
    );

    const storeRoot = metroStoreRoot(root);
    expect(storeRoot).toBe(join(parent, 'bare'));
    registerMetroStore(storeRoot);

    const caches = readManifest().caches;
    expect(caches.some((cache) => cache.dir === parent && cache.layout === undefined)).toBe(false);
    expect(caches.some((cache) => cache.dir === parent && cache.layout === METRO_NAMED_CACHE_LAYOUT)).toBe(true);
    expect(caches.find((cache) => cache.dir === storeRoot)).toMatchObject({
      entriesDepth: 2,
      prune: 'entries',
      layout: METRO_NAMED_CACHE_LAYOUT,
    });
  });
});

describe('startBareServer and the shared store', () => {
  function recordingWriter(): NdjsonWriter & { records: NdjsonRecord[] } {
    const records: NdjsonRecord[] = [];
    const writer = makeWriter({
      write(record) {
        records.push(record as NdjsonRecord);
        return true;
      },
    });
    return Object.assign(writer, { records });
  }

  class FakeStore {
    _root: string;
    constructor(options: { root: string }) {
      this._root = options.root;
    }
  }

  function configuringDeps(initialStores: unknown) {
    const seen: { config?: { cacheStores?: unknown } } = {};
    return {
      seen,
      deps: {
        metro: {
          async loadConfig() {
            return { resolver: { platforms: ['ios'] }, watchFolders: [], cacheStores: initialStores };
          },
          async runServer(config: { cacheStores?: unknown }) {
            seen.config = config;
            return {
              on() {},
              close(cb?: () => void) {
                cb?.();
              },
            };
          },
        },
        devMiddleware: { createDevMiddleware: () => ({ middleware: 'm', websocketEndpoints: {} }) },
        serverApi: { createDevServerMiddleware: () => ({ middleware: 'c', websocketEndpoints: {} }) },
      },
    };
  }

  test('the hosted config reaches runServer with the project stores plus ours, and says so once', async () => {
    const projectStore = { name: 'project store' };
    const { deps, seen } = configuringDeps([projectStore]);
    const writer = recordingWriter();
    await startBareServer({
      root,
      port: 8200,
      logsDir: join(root, 'logs'),
      deps,
      writer,
      reporterFactory: () => ({ update() {} }),
      fileStore: FakeStore,
    });
    const stores = seen.config?.cacheStores as unknown[];
    expect(stores[0]).toBe(projectStore);
    expect((stores[1] as FakeStore)._root).toBe(metroStoreRoot(root));
    const added = writer.records.filter((r) => r.event === 'cache_store_added');
    expect(added.length).toBe(1);
    expect(added[0]?.msg).toContain(metroStoreRoot(root));
  });

  test('the machine-level kill switch leaves the project config exactly as loaded', async () => {
    writeFileSync(
      join(tmpHome, 'config.json'),
      JSON.stringify({ projects: {}, repos: {}, caches: { injectMetroStore: false } }),
    );
    const projectStore = { name: 'project store' };
    const { deps, seen } = configuringDeps([projectStore]);
    const writer = recordingWriter();
    await startBareServer({
      root,
      port: 8201,
      logsDir: join(root, 'logs'),
      deps,
      writer,
      reporterFactory: () => ({ update() {} }),
      fileStore: FakeStore,
    });
    expect(seen.config?.cacheStores).toEqual([projectStore]);
    expect(writer.records.some((r) => r.event === 'cache_store_skipped')).toBe(true);
  });

  test('an unresolvable metro-cache is a warn record, not a failure to serve', async () => {
    const projectStore = { name: 'project store' };
    const { deps, seen } = configuringDeps([projectStore]);
    const writer = recordingWriter();
    const handle = await startBareServer({
      root,
      port: 8202,
      logsDir: join(root, 'logs'),
      deps,
      writer,
      reporterFactory: () => ({ update() {} }),
      fileStore: null,
    });
    expect(handle.mode).toBe('bare-inproc');
    expect(seen.config?.cacheStores).toEqual([projectStore]);
    const skipped = writer.records.filter((r) => r.event === 'cache_store_skipped');
    expect(skipped.length).toBe(1);
    expect(skipped[0]?.level).toBe('warn');
  });
});
