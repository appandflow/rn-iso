// src/supervisor/server-bare.js -- hosting a bare React Native dev server
// IN-PROCESS, which is the only way rn-iso gets structured logs out of it.
//
// Both CLIs discard a reporter set in metro.config.js (Expo's
// instantiateMetro.ts force-overrides config.reporter; RN's runServer.js
// assigns it unconditionally), so capture only happens where the hosting
// happens. Here, that is us: we load the project's config, set our own
// reporter on it, and call the project's own Metro.
//
// Every ecosystem package is resolved from the PROJECT's node_modules through
// createRequire, never from rn-iso's -- the same pattern loadFingerprinter()
// uses for @expo/fingerprint. That is what makes this version-matched by
// construction: we drive the exact Metro the project builds with, on any SDK,
// while rn-iso itself depends on neither ecosystem.
//
// This mirrors @react-native/community-cli-plugin's runServer.js. Read that
// file before changing anything here.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { NdjsonWriter } from '../ndjson.ts';
import { supervisorError } from './errors.ts';

// Every module in this file is resolved dynamically FROM THE PROJECT (metro,
// dev-middleware, the cli-server-api, the loaded Metro config, the reporter,
// the http server Metro hands back): none of it is a dependency of rn-iso, so
// there is no declaration to import. A single localized alias marks every one
// of those seams rather than a scattered `any`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BareModule = any;

// The three packages a bare RN project already has: metro through
// react-native, the other two through @react-native/community-cli-plugin.
export const BARE_PACKAGES: string[] = [
  'metro',
  '@react-native/dev-middleware',
  '@react-native-community/cli-server-api',
];

const REQUIRED_EXPORTS: Record<string, string[]> = {
  metro: ['loadConfig', 'runServer'],
  '@react-native/dev-middleware': ['createDevMiddleware'],
  '@react-native-community/cli-server-api': ['createDevServerMiddleware'],
};

export function projectRequire(root: string): NodeJS.Require {
  return createRequire(join(root, 'package.json'));
}

// Babel-compiled packages put their exports on `.default` under some interop
// settings and directly on module.exports under others, and which one you get
// varies across the Metro and RN versions this has to work with. Pick whichever
// object actually carries the functions rather than guessing from __esModule.
export function normalizeModule(mod: BareModule, names: string[]): BareModule {
  if (!mod || typeof mod !== 'object') return mod;
  const has = (obj: BareModule) => obj && names.every((n) => typeof obj[n] === 'function');
  if (has(mod)) return mod;
  if (has(mod.default)) return mod.default;
  return mod;
}

// Pure: given the loaded modules, what is missing? Returned as sentences
// rather than a boolean because the caller's whole job is to name the package
// and the export -- "cannot read property runServer of undefined" from three
// frames deep is the failure this exists to prevent.
export function checkBareApi(modules: Record<string, BareModule>): string[] {
  const problems: string[] = [];
  for (const name of BARE_PACKAGES) {
    const mod = modules?.[name];
    if (!mod) {
      problems.push(`${name} loaded but exported nothing`);
      continue;
    }
    for (const fn of REQUIRED_EXPORTS[name]) {
      if (typeof mod[fn] !== 'function') {
        problems.push(`${name} does not export ${fn}()`);
      }
    }
  }
  return problems;
}

// Three distinct failures, three distinct codes. They have different remedies,
// so collapsing them into one "could not start Metro" is what would send
// someone reinstalling node_modules over a version mismatch.
//   RN_ISO_BARE_DEPS  a package is not installed in the project
//   RN_ISO_BARE_LOAD  it is installed but threw while loading
//   RN_ISO_BARE_API   it loaded but is not the API this expects
export interface BareDeps {
  metro: BareModule;
  devMiddleware: BareModule;
  serverApi: BareModule;
}

export function resolveBareDeps(
  root: string,
  { requireFrom = projectRequire }: { requireFrom?: (root: string) => NodeJS.Require } = {},
): BareDeps {
  const require_ = requireFrom(root);
  const modules: Record<string, BareModule> = {};
  const missing: string[] = [];
  for (const name of BARE_PACKAGES) {
    let resolved: string;
    try {
      resolved = require_.resolve(name);
    } catch {
      missing.push(name);
      continue;
    }
    try {
      modules[name] = normalizeModule(require_(resolved), REQUIRED_EXPORTS[name]);
    } catch (err) {
      throw supervisorError(
        'RN_ISO_BARE_LOAD',
        `${name} is installed in ${root} but failed to load: ${(err as Error)?.message || err}`,
        `Check that ${name} matches this project's React Native version, then reinstall node_modules.`,
      );
    }
  }
  if (missing.length > 0) {
    throw supervisorError(
      'RN_ISO_BARE_DEPS',
      `Cannot host a bare React Native dev server for ${root}: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not resolvable from the project.`,
      'Run `npm install` in the project. If this is an Expo project that was detected as bare, check that `expo` is in its dependencies and that it has an Expo config.',
    );
  }
  const problems = checkBareApi(modules);
  if (problems.length > 0) {
    throw supervisorError(
      'RN_ISO_BARE_API',
      `The dev server packages in ${root} are not the API rn-iso expects: ${problems.join('; ')}.`,
      "Upgrade or reinstall the project's React Native toolchain so metro, @react-native/dev-middleware and @react-native-community/cli-server-api match.",
    );
  }
  return {
    metro: modules['metro'],
    devMiddleware: modules['@react-native/dev-middleware'],
    serverApi: modules['@react-native-community/cli-server-api'],
  };
}

// The reporter is shared with anyone hosting Metro programmatically, so there
// is exactly one implementation and it lives in @rn-iso/metro (CJS, importing
// nothing from rn-iso). Resolution follows loadFingerprinter's chain: the
// project first, then rn-iso's own install.
//
// It is deliberately NOT fatal when it cannot be found. A logging package that
// is not installed must not cost the caller a dev server -- but it must not be
// silent either, or a workspace with no logs looks like a workspace with no
// errors. The caller reports the miss and serves on.
export function loadNdjsonReporter(
  root: string,
  { requireFrom = createRequire }: { requireFrom?: (id: string) => NodeJS.Require } = {},
): ((opts: { dir: string }) => BareModule) | null {
  for (const from of [join(root, 'package.json'), import.meta.url]) {
    try {
      const factory = requireFrom(from)('@rn-iso/metro').ndjsonReporter;
      if (typeof factory === 'function') return factory;
    } catch {
      // Try the next location.
    }
  }
  return null;
}

// resolver.platforms comes from the project's own config, which through
// @react-native/metro-config is ['android', 'ios']. The community CLI adds
// 'native' to it before running the server (getCommunityCliDefaultConfig), and
// without that a `.native.js` file does not resolve -- a difference that shows
// up as a mid-bundle resolution failure rather than as a startup error, so it
// is corrected here rather than discovered later. Mutates and reports whether
// it changed anything.
export function ensureNativePlatform(config: BareModule): boolean {
  const platforms = config?.resolver?.platforms;
  if (!Array.isArray(platforms) || platforms.includes('native')) return false;
  config.resolver.platforms = [...platforms, 'native'];
  return true;
}

// @react-native/dev-middleware logs through a {info, warn, error} object. RN
// routes those into the reporter as unstable_server_log events, which is how
// they reach the same NDJSON timeline as everything else.
export function reporterLogger(reporter: BareModule): {
  info: (...data: unknown[]) => void;
  warn: (...data: unknown[]) => void;
  error: (...data: unknown[]) => void;
} {
  const at =
    (level: string) =>
    (...data: unknown[]) => {
      try {
        reporter.update({ type: 'unstable_server_log', level, data });
      } catch {
        /* a logging failure must never reach the dev server */
      }
    };
  return { info: at('info'), warn: at('warn'), error: at('error') };
}

// Closing an http server does not close established connections, and a dev
// server always has some (the client's websocket, an inspector page). Without
// closeAllConnections the close callback never fires and the supervisor hangs
// in shutdown instead of exiting -- so the wait is also bounded.
function closeHttpServer(httpServer: BareModule, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      httpServer.closeAllConnections?.();
      httpServer.close(() => {
        clearTimeout(timer);
        finish();
      });
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

export async function startBareServer({
  root,
  port,
  logsDir,
  writer = null,
  deps = null,
  reporterFactory = undefined,
  closeTimeoutMs = 5000,
}: {
  root: string;
  port: number;
  logsDir: string;
  writer?: NdjsonWriter | null;
  deps?: BareDeps | null;
  reporterFactory?: ((opts: { dir: string }) => BareModule) | null;
  closeTimeoutMs?: number;
}) {
  const { metro, devMiddleware, serverApi } = deps || resolveBareDeps(root);
  const makeReporter = reporterFactory === undefined ? loadNdjsonReporter(root) : reporterFactory;

  const config = await metro.loadConfig({ cwd: root, port });
  if (ensureNativePlatform(config)) {
    writer?.write({
      src: 'metro',
      level: 'debug',
      event: 'config_adjusted',
      msg: "added 'native' to resolver.platforms, as the React Native CLI does",
    });
  }

  let reporter;
  if (makeReporter) {
    reporter = makeReporter({ dir: logsDir });
    config.reporter = reporter;
  } else {
    // No reporter package: serve, but say so in the log the reporter would
    // have written to, so an empty timeline is never mistaken for a quiet one.
    writer?.write({
      src: 'metro',
      level: 'warn',
      event: 'reporter_missing',
      msg: '@rn-iso/metro is not installed in this project or beside rn-iso, so bundler and client logs will not be captured. Install it as a devDependency to get them.',
    });
    reporter = { update() {} };
  }

  const hostname = 'localhost';
  const devServerUrl = `http://${hostname}:${port}`;

  const { middleware: communityMiddleware, websocketEndpoints: communityWebsocketEndpoints } =
    serverApi.createDevServerMiddleware({
      host: hostname,
      port,
      watchFolders: config.watchFolders,
    });

  const { middleware, websocketEndpoints } = devMiddleware.createDevMiddleware({
    serverBaseUrl: devServerUrl,
    logger: reporterLogger(reporter),
  });

  // `host` is deliberately not passed: Metro then binds every interface, which
  // is what the RN CLI does by default and what a device on the LAN needs.
  const httpServer = await metro.runServer(config, {
    unstable_extraMiddleware: [communityMiddleware, middleware],
    websocketEndpoints: { ...communityWebsocketEndpoints, ...websocketEndpoints },
  });

  let exited = false;
  const listeners: ((info: { code: number; reason?: string }) => void)[] = [];
  httpServer.on?.('close', () => {
    if (exited) return;
    exited = true;
    for (const cb of listeners) cb({ code: 0, reason: 'the Metro http server closed' });
  });

  return {
    mode: 'bare-inproc',
    // In-process: the supervisor IS the server, so there is no separate pid to
    // record. Contract 2's serverPid is for the expo child.
    serverPid: null,
    httpServer,
    onExit(cb: (info: { code: number; reason?: string }) => void) {
      listeners.push(cb);
    },
    async close() {
      exited = true;
      await closeHttpServer(httpServer, closeTimeoutMs);
    },
  };
}
