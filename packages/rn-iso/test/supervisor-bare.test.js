// Hosting Metro in-process for a bare RN project.
//
// The wiring is mirrored from @react-native/community-cli-plugin's
// runServer.js, and the tests below pin the parts of that mirror that are easy
// to get subtly wrong: which packages come from the PROJECT, what a missing or
// mismatched one reports, and that the reporter and both middlewares actually
// reach Metro.runServer.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
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
} from '../src/supervisor/server-bare.js';

// assert.throws does not hand back the error, and every assertion below is
// about the error's contents.
function caught(fn) {
  try { fn(); } catch (err) { return err; }
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
      const err = new Error(`Cannot find module '${id}'`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return modules[id];
  };
  require_.resolve = (id) => {
    if (!(id in modules) && !(id in throwOnLoad)) {
      const err = new Error(`Cannot find module '${id}'`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return id;
  };
  return () => require_;
}

const OK_MODULES = () => ({
  'metro': { loadConfig: async () => ({}), runServer: async () => ({}) },
  '@react-native/dev-middleware': { createDevMiddleware: () => ({ middleware: 'dm', websocketEndpoints: {} }) },
  '@react-native-community/cli-server-api': { createDevServerMiddleware: () => ({ middleware: 'cm', websocketEndpoints: {} }) },
});

describe('resolving the project\'s own dev server packages', () => {
  test('every missing package is named at once, with an npm install remedy', () => {
    const modules = OK_MODULES();
    delete modules['@react-native/dev-middleware'];
    delete modules['@react-native-community/cli-server-api'];
    const err = caught(() => resolveBareDeps(root, { requireFrom: fakeRequire(modules) }));
    assert.equal(err.code, 'RN_ISO_BARE_DEPS');
    assert.match(err.message, /@react-native\/dev-middleware/);
    assert.match(err.message, /@react-native-community\/cli-server-api/);
    assert.ok(!err.message.includes(' metro,'), 'a package that IS installed must not be listed as missing');
    assert.match(err.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(err.remedy, /npm install/);
    // The other likely cause: an Expo project detected as bare.
    assert.match(err.remedy, /Expo/);
  });

  test('a package that is installed but throws while loading is NOT reported as missing', () => {
    const err = caught(() => resolveBareDeps(root, {
      requireFrom: fakeRequire(OK_MODULES(), { throwOnLoad: { 'metro': 'Unexpected token' } }),
    }));
    assert.equal(err.code, 'RN_ISO_BARE_LOAD');
    assert.match(err.message, /metro is installed/);
    assert.match(err.message, /Unexpected token/);
  });

  test('a package whose API does not match names the package and the export', () => {
    const modules = OK_MODULES();
    delete modules['metro'].runServer;
    const err = caught(() => resolveBareDeps(root, { requireFrom: fakeRequire(modules) }));
    assert.equal(err.code, 'RN_ISO_BARE_API');
    assert.match(err.message, /metro does not export runServer\(\)/);
    // Never a bare stack: the message says which package and what is missing.
    assert.ok(!/undefined is not a function/.test(err.message));
  });

  test('success returns the three modules', () => {
    const deps = resolveBareDeps(root, { requireFrom: fakeRequire(OK_MODULES()) });
    assert.equal(typeof deps.metro.runServer, 'function');
    assert.equal(typeof deps.devMiddleware.createDevMiddleware, 'function');
    assert.equal(typeof deps.serverApi.createDevServerMiddleware, 'function');
  });

  test('the three packages are the ones a bare RN project already has', () => {
    assert.deepEqual(BARE_PACKAGES, ['metro', '@react-native/dev-middleware', '@react-native-community/cli-server-api']);
  });
});

describe('module interop', () => {
  test('normalizeModule reaches through .default when that is where the exports are', () => {
    const mod = { __esModule: true, default: { runServer: () => {}, loadConfig: () => {} } };
    assert.equal(normalizeModule(mod, ['runServer', 'loadConfig']), mod.default);
  });

  test('normalizeModule leaves a plain CommonJS module alone', () => {
    const mod = { runServer: () => {}, loadConfig: () => {} };
    assert.equal(normalizeModule(mod, ['runServer', 'loadConfig']), mod);
  });

  test('checkBareApi reports every missing export, not just the first', () => {
    const problems = checkBareApi({
      'metro': {},
      '@react-native/dev-middleware': {},
      '@react-native-community/cli-server-api': {},
    });
    assert.equal(problems.length, 4);
    assert.ok(problems.some((p) => /metro does not export loadConfig/.test(p)));
    assert.ok(problems.some((p) => /dev-middleware does not export createDevMiddleware/.test(p)));
  });
});

describe('config adjustments', () => {
  test("ensureNativePlatform adds 'native', which the RN CLI adds and metro.config.js does not", () => {
    const config = { resolver: { platforms: ['android', 'ios'] } };
    assert.equal(ensureNativePlatform(config), true);
    assert.deepEqual(config.resolver.platforms, ['android', 'ios', 'native']);
  });

  test('ensureNativePlatform is a no-op when it is already there', () => {
    const config = { resolver: { platforms: ['ios', 'native'] } };
    assert.equal(ensureNativePlatform(config), false);
    assert.deepEqual(config.resolver.platforms, ['ios', 'native']);
  });

  test('ensureNativePlatform tolerates a config with no resolver', () => {
    assert.equal(ensureNativePlatform({}), false);
  });
});

describe('the dev-middleware logger', () => {
  test('routes info/warn/error into the reporter as unstable_server_log', () => {
    const events = [];
    const logger = reporterLogger({ update: (e) => events.push(e) });
    logger.info('hello', 'world');
    logger.warn('careful');
    logger.error('boom');
    assert.deepEqual(events.map((e) => e.type), ['unstable_server_log', 'unstable_server_log', 'unstable_server_log']);
    assert.deepEqual(events.map((e) => e.level), ['info', 'warn', 'error']);
    assert.deepEqual(events[0].data, ['hello', 'world']);
  });

  test('a throwing reporter never reaches the dev server', () => {
    const logger = reporterLogger({ update: () => { throw new Error('disk full'); } });
    assert.doesNotThrow(() => logger.error('boom'));
  });
});

describe('loadNdjsonReporter', () => {
  test('resolves the one shared implementation from @rn-iso/metro', () => {
    const factory = loadNdjsonReporter(root);
    assert.equal(typeof factory, 'function', '@rn-iso/metro should resolve beside rn-iso');
    const reporter = factory({ dir: join(root, '.rn-iso', 'logs') });
    assert.equal(typeof reporter.update, 'function');
  });

  test('returns null rather than throwing when the package is nowhere', () => {
    const nothing = () => {
      const req = (id) => { throw new Error(`Cannot find module '${id}'`); };
      req.resolve = req;
      return req;
    };
    assert.equal(loadNdjsonReporter(root, { requireFrom: nothing }), null);
  });
});

describe('startBareServer wiring', () => {
  function fakeDeps() {
    const calls = {};
    const httpServer = {
      handlers: {},
      on(event, cb) { this.handlers[event] = cb; },
      closeAllConnections() { calls.closedConnections = true; },
      close(cb) { calls.closed = true; cb?.(); },
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
      root, port: 8099, logsDir: join(root, '.rn-iso', 'logs'), deps,
      reporterFactory: (opts) => { calls.reporterDir = opts.dir; return reporter; },
    });
    assert.deepEqual(calls.loadConfig, { cwd: root, port: 8099 });
    assert.equal(calls.runServer.config.reporter, reporter, 'the reporter must reach Metro, or nothing is captured');
    assert.equal(calls.reporterDir, join(root, '.rn-iso', 'logs'));
    // The config correction the RN CLI makes and metro.config.js does not.
    assert.deepEqual(calls.runServer.config.resolver.platforms, ['android', 'ios', 'native']);
  });

  test('wires both middlewares and merges both websocket endpoint sets', async () => {
    const { deps, calls } = fakeDeps();
    await startBareServer({ root, port: 8100, logsDir: join(root, 'logs'), deps, reporterFactory: () => ({ update() {} }) });

    assert.deepEqual(calls.createDevServerMiddleware, { host: 'localhost', port: 8100, watchFolders: ['/w'] });
    assert.equal(calls.createDevMiddleware.serverBaseUrl, 'http://localhost:8100');
    assert.equal(typeof calls.createDevMiddleware.logger.error, 'function');
    assert.deepEqual(calls.runServer.options.unstable_extraMiddleware, ['community-mw', 'dev-mw']);
    assert.deepEqual(calls.runServer.options.websocketEndpoints, { '/message': 'm', '/inspector': 'i' });
    // host is deliberately absent so Metro binds every interface, as the RN
    // CLI does: a device on the LAN cannot reach a loopback-only bundler.
    assert.equal('host' in calls.runServer.options, false);
  });

  test('serves without the reporter package, and says so in the log it would have written', async () => {
    const { deps, calls } = fakeDeps();
    const written = [];
    const handle = await startBareServer({
      root, port: 8101, logsDir: join(root, 'logs'), deps,
      reporterFactory: null,
      writer: { write: (r) => written.push(r) },
    });
    assert.ok(handle.httpServer, 'a missing logging package must not cost the caller a dev server');
    // config.reporter is left as the project's own (Metro's TerminalReporter,
    // whose output still reaches supervisor.log) rather than replaced by a
    // black hole.
    assert.equal(calls.runServer.config.reporter, undefined);
    const warn = written.find((r) => r.event === 'reporter_missing');
    assert.equal(warn.level, 'warn');
    assert.match(warn.msg, /@rn-iso\/metro/);
  });

  test('the handle closes the http server, connections and all', async () => {
    const { deps, calls } = fakeDeps();
    const handle = await startBareServer({ root, port: 8102, logsDir: join(root, 'logs'), deps, reporterFactory: () => ({ update() {} }) });
    assert.equal(handle.mode, 'bare-inproc');
    assert.equal(handle.serverPid, null, 'in-process: the supervisor IS the server');
    await handle.close();
    assert.equal(calls.closed, true);
    assert.equal(calls.closedConnections, true, 'an open websocket would otherwise hang the shutdown');
  });

  test('an http server that closes on its own reports an unexpected exit', async () => {
    const { deps, httpServer } = fakeDeps();
    const handle = await startBareServer({ root, port: 8103, logsDir: join(root, 'logs'), deps, reporterFactory: () => ({ update() {} }) });
    const seen = [];
    handle.onExit((info) => seen.push(info));
    httpServer.handlers.close();
    assert.equal(seen.length, 1);
    assert.match(seen[0].reason, /closed/);
  });

  test('our own close does not report an unexpected exit', async () => {
    const { deps, httpServer } = fakeDeps();
    const handle = await startBareServer({ root, port: 8104, logsDir: join(root, 'logs'), deps, reporterFactory: () => ({ update() {} }) });
    const seen = [];
    handle.onExit((info) => seen.push(info));
    await handle.close();
    httpServer.handlers.close();
    assert.deepEqual(seen, []);
  });
});
