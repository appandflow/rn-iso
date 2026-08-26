// Hosting Metro in-process for a bare RN project.
//
// The wiring is mirrored from @react-native/community-cli-plugin's
// runServer.js, and the tests below pin the parts of that mirror that are easy
// to get subtly wrong: which packages come from the PROJECT, what a missing or
// mismatched one reports, and that the reporter and both middlewares actually
// reach Metro.runServer.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BARE_PACKAGES,
  checkBareApi,
  ensureNativePlatform,
  loadNdjsonReporter,
  normalizeModule,
  reporterLogger,
  resolveBareDeps,
  startBareServer,
} from '../supervisor/server-bare.ts';
import { asRequire, makeError, makeWriter } from './_factories.ts';

// assert.throws does not hand back the error, and every assertion below is
// about the error's contents.
function caught(fn: () => unknown): Error & Record<string, unknown> {
  try {
    fn();
  } catch (err) {
    // The thrown value is unknown; every assertion below reads a coded-error
    // property, so the single cast for that is centralized in this helper.
    return err as Error & Record<string, unknown>;
  }
  throw new Error('expected a throw');
}

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rn-iso-bare-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'bare' }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// A require() that resolves only the modules it is given, so a project's
// node_modules can be simulated without one existing.
function fakeRequire(modules, { throwOnLoad = {} } = {}) {
  const require_ = (id) => {
    if (throwOnLoad[id]) throw new Error(throwOnLoad[id]);
    if (!(id in modules)) {
      throw makeError(`Cannot find module '${id}'`, { code: 'MODULE_NOT_FOUND' });
    }
    return modules[id];
  };
  require_.resolve = (id) => {
    if (!(id in modules) && !(id in throwOnLoad)) {
      throw makeError(`Cannot find module '${id}'`, { code: 'MODULE_NOT_FOUND' });
    }
    return id;
  };
  return () => asRequire(require_);
}

const OK_MODULES = () => ({
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
    expect(err.code).toBe('RN_ISO_BARE_DEPS');
    expect(err.message).toMatch(/@react-native\/dev-middleware/);
    expect(err.message).toMatch(/@react-native-community\/cli-server-api/);
    expect(!err.message.includes(' metro,')).toBeTruthy();
    expect(err.message).toMatch(new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(err.remedy).toMatch(/npm install/);
    // The other likely cause: an Expo project detected as bare.
    expect(err.remedy).toMatch(/Expo/);
  });

  test('a package that is installed but throws while loading is NOT reported as missing', () => {
    const err = caught(() =>
      resolveBareDeps(root, {
        requireFrom: fakeRequire(OK_MODULES(), { throwOnLoad: { metro: 'Unexpected token' } }),
      }),
    );
    expect(err.code).toBe('RN_ISO_BARE_LOAD');
    expect(err.message).toMatch(/metro is installed/);
    expect(err.message).toMatch(/Unexpected token/);
  });

  test('a package whose API does not match names the package and the export', () => {
    const modules = OK_MODULES();
    delete modules['metro'].runServer;
    const err = caught(() => resolveBareDeps(root, { requireFrom: fakeRequire(modules) }));
    expect(err.code).toBe('RN_ISO_BARE_API');
    expect(err.message).toMatch(/metro does not export runServer\(\)/);
    // Never a bare stack: the message says which package and what is missing.
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
});

describe('the dev-middleware logger', () => {
  test('routes info/warn/error into the reporter as unstable_server_log', () => {
    const events = [];
    const logger = reporterLogger({ update: (e) => events.push(e) });
    logger.info('hello', 'world');
    logger.warn('careful');
    logger.error('boom');
    expect(events.map((e) => e.type)).toEqual(['unstable_server_log', 'unstable_server_log', 'unstable_server_log']);
    expect(events.map((e) => e.level)).toEqual(['info', 'warn', 'error']);
    expect(events[0].data).toEqual(['hello', 'world']);
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
  test('resolves the one shared implementation from @rn-iso/metro', () => {
    const factory = loadNdjsonReporter(root);
    expect(typeof factory).toBe('function');
    const reporter = factory({ dir: join(root, '.rn-iso', 'logs') });
    expect(typeof reporter.update).toBe('function');
  });

  test('returns null rather than throwing when the package is nowhere', () => {
    const nothing = () => {
      const req = (id) => {
        throw new Error(`Cannot find module '${id}'`);
      };
      req.resolve = req;
      return asRequire(req);
    };
    expect(loadNdjsonReporter(root, { requireFrom: nothing })).toBe(null);
  });
});

describe('startBareServer wiring', () => {
  function fakeDeps() {
    const calls: Record<string, any> = {};
    const httpServer = {
      handlers: {} as Record<string, (...args: any[]) => void>,
      on(event, cb) {
        this.handlers[event] = cb;
      },
      closeAllConnections() {
        calls.closedConnections = true;
      },
      close(cb) {
        calls.closed = true;
        cb?.();
      },
    };
    const deps = {
      metro: {
        async loadConfig(argv) {
          calls.loadConfig = argv;
          return { resolver: { platforms: ['android', 'ios'] }, watchFolders: ['/w'], server: {} };
        },
        async runServer(config, options) {
          calls.runServer = { config, options };
          return httpServer;
        },
      },
      devMiddleware: {
        createDevMiddleware(args) {
          calls.createDevMiddleware = args;
          return { middleware: 'dev-mw', websocketEndpoints: { '/inspector': 'i' } };
        },
      },
      serverApi: {
        createDevServerMiddleware(args) {
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
      logsDir: join(root, '.rn-iso', 'logs'),
      deps,
      reporterFactory: (opts) => {
        calls.reporterDir = opts.dir;
        return reporter;
      },
    });
    expect(calls.loadConfig).toEqual({ cwd: root, port: 8099 });
    expect(calls.runServer.config.reporter).toBe(reporter);
    expect(calls.reporterDir).toBe(join(root, '.rn-iso', 'logs'));
    // The config correction the RN CLI makes and metro.config.js does not.
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
    // host is deliberately absent so Metro binds every interface, as the RN
    // CLI does: a device on the LAN cannot reach a loopback-only bundler.
    expect('host' in calls.runServer.options).toBe(false);
  });

  test('serves without the reporter package, and says so in the log it would have written', async () => {
    const { deps, calls } = fakeDeps();
    const written = [];
    const handle = await startBareServer({
      root,
      port: 8101,
      logsDir: join(root, 'logs'),
      deps,
      reporterFactory: null,
      writer: makeWriter({
        write: (r) => {
          written.push(r);
          return true;
        },
      }),
    });
    expect(handle.httpServer).toBeTruthy();
    // config.reporter is left as the project's own (Metro's TerminalReporter,
    // whose output still reaches supervisor.log) rather than replaced by a
    // black hole.
    expect(calls.runServer.config.reporter).toBe(undefined);
    const warn = written.find((r) => r.event === 'reporter_missing');
    expect(warn.level).toBe('warn');
    expect(warn.msg).toMatch(/@rn-iso\/metro/);
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
    const seen = [];
    handle.onExit((info) => seen.push(info));
    httpServer.handlers.close();
    expect(seen.length).toBe(1);
    expect(seen[0].reason).toMatch(/closed/);
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
    const seen = [];
    handle.onExit((info) => seen.push(info));
    await handle.close();
    httpServer.handlers.close();
    expect(seen).toEqual([]);
  });
});
