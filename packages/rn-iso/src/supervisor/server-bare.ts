import { createRequire } from 'node:module';
import { join } from 'node:path';
import { metroStoreInjectionEnabled } from '../config.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { appendCacheStore, metroStoreRoot, registerMetroStore } from './metro-store.ts';
import { supervisorError } from './errors.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BareModule = any;

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

export function normalizeModule(mod: BareModule, names: string[]): BareModule {
  if (!mod || typeof mod !== 'object') return mod;
  const has = (obj: BareModule) => obj && names.every((n) => typeof obj[n] === 'function');
  if (has(mod)) return mod;
  if (has(mod.default)) return mod.default;
  return mod;
}

export function checkBareApi(modules: Record<string, BareModule>): string[] {
  const problems: string[] = [];
  for (const name of BARE_PACKAGES) {
    const mod = modules?.[name];
    if (!mod) {
      problems.push(`${name} loaded but exported nothing`);
      continue;
    }
    for (const fn of REQUIRED_EXPORTS[name] ?? []) {
      if (typeof mod[fn] !== 'function') {
        problems.push(`${name} does not export ${fn}()`);
      }
    }
  }
  return problems;
}

export interface BareDeps {
  metro: BareModule;
  devMiddleware: BareModule;
  serverApi: BareModule;
}

export function resolveBareDeps(
  root: string,
  { requireFrom = projectRequire }: { requireFrom?: (root: string) => NodeJS.Require } = {},
): BareDeps {
  const localRequire = requireFrom(root);
  const modules: Record<string, BareModule> = {};
  const missing: string[] = [];
  for (const name of BARE_PACKAGES) {
    let resolved: string;
    try {
      resolved = localRequire.resolve(name);
    } catch {
      missing.push(name);
      continue;
    }
    try {
      modules[name] = normalizeModule(localRequire(resolved), REQUIRED_EXPORTS[name] ?? []);
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

export function loadNdjsonReporter(
  root: string,
  { requireFrom = createRequire }: { requireFrom?: (id: string) => NodeJS.Require } = {},
): ((opts: { dir: string }) => BareModule) | null {
  for (const from of [join(root, 'package.json'), import.meta.url]) {
    try {
      const factory = requireFrom(from)('@rn-iso/metro').ndjsonReporter;
      if (typeof factory === 'function') return factory;
    } catch {}
  }
  return null;
}

export function loadFileStore(
  root: string,
  { requireFrom = projectRequire }: { requireFrom?: (root: string) => NodeJS.Require } = {},
): (new (options: { root: string }) => { _root?: string }) | null {
  try {
    const Store = requireFrom(root)('metro-cache').FileStore;
    return typeof Store === 'function' ? Store : null;
  } catch {
    return null;
  }
}

function installSharedCacheStore({
  root,
  config,
  writer,
  enabled,
  FileStore,
}: {
  root: string;
  config: BareModule;
  writer?: NdjsonWriter | null;
  enabled: boolean;
  FileStore: (new (options: { root: string }) => { _root?: string }) | null;
}): void {
  if (!enabled) {
    writer?.write({
      src: 'metro',
      level: 'debug',
      event: 'cache_store_skipped',
      msg: 'the shared Metro transform store is off (caches.injectMetroStore is false in ~/.rn-iso/config.json)',
    });
    return;
  }
  if (!FileStore) {
    writer?.write({
      src: 'metro',
      level: 'warn',
      event: 'cache_store_skipped',
      msg: `metro-cache is not resolvable from ${root}, so this dev server runs on whatever transform cache the project configured`,
    });
    return;
  }
  const storeRoot = metroStoreRoot(root);
  const result = appendCacheStore(config, { storeRoot, FileStore });
  if (!result.added) {
    writer?.write({
      src: 'metro',
      level: 'debug',
      event: 'cache_store_present',
      msg: `the shared Metro transform store at ${storeRoot} was already configured (${result.reason})`,
    });
    return;
  }
  registerMetroStore(storeRoot);
  writer?.write({
    src: 'metro',
    level: 'debug',
    event: 'cache_store_added',
    msg: `appended the shared Metro transform store at ${storeRoot} to this project's cacheStores`,
  });
}

export function ensureNativePlatform(config: BareModule): boolean {
  const platforms = config?.resolver?.platforms;
  if (!Array.isArray(platforms) || platforms.includes('native')) return false;
  config.resolver.platforms = [...platforms, 'native'];
  return true;
}

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
      } catch {}
    };
  return { info: at('info'), warn: at('warn'), error: at('error') };
}

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

export interface BareServerHandle {
  mode: string;
  serverPid: null;
  httpServer: BareModule;
  onExit(cb: (info: { code: number; reason?: string }) => void): void;
  close(): Promise<void>;
}

export async function startBareServer({
  root,
  port,
  logsDir,
  writer = null,
  deps = null,
  reporterFactory = undefined,
  cacheStore = undefined,
  fileStore = undefined,
  closeTimeoutMs = 5000,
}: {
  root: string;
  port: number;
  logsDir: string;
  writer?: NdjsonWriter | null;
  deps?: BareDeps | null;
  reporterFactory?: ((opts: { dir: string }) => BareModule) | null;
  cacheStore?: boolean;
  fileStore?: (new (options: { root: string }) => { _root?: string }) | null;
  closeTimeoutMs?: number;
}): Promise<BareServerHandle> {
  const { metro, devMiddleware, serverApi } = deps || resolveBareDeps(root);
  const makeReporter = reporterFactory === undefined ? loadNdjsonReporter(root) : reporterFactory;

  const config = await metro.loadConfig({ cwd: root, port });
  installSharedCacheStore({
    root,
    config,
    writer,
    enabled: cacheStore === undefined ? metroStoreInjectionEnabled() : cacheStore,
    FileStore: fileStore === undefined ? loadFileStore(root) : fileStore,
  });
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
