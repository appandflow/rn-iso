import assert from 'node:assert';
import type { SpawnOptions } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNdjsonText } from '../ndjson.ts';
import {
  cleanLine,
  expoBinPath,
  expoSdkMajor,
  inferLevel,
  isBundleMarker,
  recordFromLine,
  startExpoServer,
} from '../supervisor/server-expo.ts';
import {
  expoMetroConfigPath,
  expoMetroStoreEnv,
  metroStoreConfirmedRoot,
  metroStoreRoot,
} from '../supervisor/metro-store.ts';
import { makeChildProcess } from './_factories.ts';

const ESC = '\u001B';

type ExpoExitInfo = { code: number | null; signal: NodeJS.Signals | null; error?: Error };

let root: string;
let tmpHome: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rn-iso-expo-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
  delete process.env.NODE_OPTIONS;
  delete process.env.EXPO_OVERRIDE_METRO_CONFIG;
});

function fakeBin(dir = root, sdk = 54) {
  const bin = join(dir, 'node_modules', '.bin', 'expo');
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(bin, '#!/bin/sh\n');
  chmodSync(bin, 0o755);
  const expo = join(dir, 'node_modules', 'expo');
  mkdirSync(expo, { recursive: true });
  writeFileSync(join(expo, 'package.json'), JSON.stringify({ name: 'expo', version: `${sdk}.0.0` }));
  return bin;
}

function fakeChild(pid = 999999) {
  return makeChildProcess({ pid });
}

describe('line parsing', () => {
  test('cleanLine keeps only what a terminal would show after a carriage return', () => {
    expect(cleanLine('Bundling 10%\rBundling 90%\rBundling 100%')).toBe('Bundling 100%');
    expect(cleanLine('plain line   ')).toBe('plain line');
  });

  test('inferLevel reads the leading word', () => {
    expect(inferLevel('ERROR  Something exploded')).toBe('error');
    expect(inferLevel('error: Unable to resolve module')).toBe('error');
    expect(inferLevel('Error: Unable to resolve module')).toBe('error');
    expect(inferLevel('WARN  Deprecated API')).toBe('warn');
    expect(inferLevel('warning: peer dependency')).toBe('warn');
    expect(inferLevel('Starting Metro Bundler')).toBe('info');
    expect(inferLevel('')).toBe('info');
  });

  test('inferLevel treats a Node-exception line (PluginError:, CommandError:) as an error (#30)', () => {
    expect(inferLevel('PluginError: Failed to resolve plugin for module "expo-share-intent"')).toBe('error');
    expect(inferLevel('CommandError: something broke')).toBe('error');
    expect(inferLevel('Errors were found')).toBe('info');
    expect(inferLevel('PluginErrorish text without colon')).toBe('info');
  });

  test('inferLevel reads the symbols Expo uses instead of words', () => {
    expect(inferLevel('\u2716 Metro encountered an error')).toBe('error');
    expect(inferLevel('\u274C build failed')).toBe('error');
    expect(inferLevel('\u26A0 something is off')).toBe('warn');
  });

  test('inferLevel does not read a mid-line word as a level', () => {
    expect(inferLevel('Logs for your project will appear below, including errors')).toBe('info');
  });

  const NAVIGATE_ERROR = `ERROR  The action 'NAVIGATE' with payload {"name":"expo-development-client","params":{"url":"http://10.0.2.2:8082"}} was not handled by any navigator.`;

  test('the dev-client NAVIGATE record is demoted: rn-iso own deep link is not an app error', () => {
    expect(inferLevel(NAVIGATE_ERROR)).toBe('info');
    const record = recordFromLine(NAVIGATE_ERROR);
    assert(record);
    expect(record.level).toBe('info');
    expect(record.msg).toBe(NAVIGATE_ERROR);
  });

  test('the demotion needs both halves, so real navigation bugs still surface', () => {
    expect(
      inferLevel(`ERROR  The action 'NAVIGATE' with payload {"name":"Settings"} was not handled by any navigator.`),
    ).toBe('error');
    expect(inferLevel('ERROR  expo-development-client failed to load the bundle')).toBe('error');
    expect(inferLevel(`ERROR  The action 'GO_BACK' was not handled by any navigator.`)).toBe('error');
  });

  test("the bundle line is a marker, so an Expo workspace's --errors window resets", () => {
    expect(isBundleMarker('iOS Bundled 812ms index.js (1150 modules)')).toBe(true);
    expect(isBundleMarker('Android Bundled 5401ms node_modules/expo-router/entry.js (1743 modules)')).toBe(true);
    expect(isBundleMarker('Starting Metro Bundler')).toBe(false);
  });

  test('the "Bundling failed" line is a marker AND an error', () => {
    const line = 'iOS Bundling failed 893ms index.js (4173 modules)';
    expect(isBundleMarker(line)).toBe(true);
    expect(isBundleMarker('Android Bundling failed 91ms')).toBe(true);
    expect(isBundleMarker('iOS Bundling index.js')).toBe(false);
    const record = recordFromLine(line);
    assert(record);
    expect(record.level).toBe('error');
    expect(record.marker).toBe(true);
  });

  test('recordFromLine produces a Contract-1 record flagged as inferred', () => {
    const record = recordFromLine(`${ESC}[31mERROR  boom${ESC}[39m`, { stream: 'stderr' });
    assert(record);
    expect(record.src).toBe('metro');
    expect(record.level).toBe('error');
    expect(record.msg).toBe('ERROR  boom');
    expect(record.raw).toBe(true);
    expect(record.event).toBe('expo_stderr');
    expect(record.marker).toBe(undefined);
  });

  test('a blank line produces no record at all', () => {
    expect(recordFromLine('   ')).toBe(null);
    expect(recordFromLine(`${ESC}[2K`)).toBe(null);
  });
});

describe('startExpoServer', () => {
  test('a project with no resolvable expo fails with a named code and a remedy', async () => {
    const err = await startExpoServer({ root, port: 8110, logsDir: join(root, 'logs') }).then(
      () => null,
      (e) => e,
    );
    expect(err.code).toBe('RN_ISO_EXPO_BIN');
    expect(err.message).toMatch(/not resolvable/);
    expect(err.remedy).toMatch(/workspace root/);
  });

  test('spawns `expo start --port <n>` and NOTHING else, from the project root', async () => {
    fakeBin();
    const calls: { cmd: string; args: string[]; opts: SpawnOptions }[] = [];
    await startExpoServer({
      root,
      port: 8111,
      logsDir: join(root, 'logs'),
      spawnFn: (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        return fakeChild();
      },
    });
    const seen = calls[0];
    assert(seen);
    expect(seen.cmd).toBe(expoBinPath(root));
    expect(seen.args).toEqual(['start', '--port', '8111']);
    expect(seen.opts.cwd).toBe(root);
    expect(seen.opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(seen.opts.detached).toBe(false);
  });

  test('an identical line arriving on both streams within a second is written once', async () => {
    fakeBin();
    const child = fakeChild();
    const logsDir = join(root, '.rn-iso', 'logs');
    await startExpoServer({ root, port: 8114, logsDir, spawnFn: () => child });
    child.stdout!.emit('data', 'PluginError: Failed to resolve plugin\n');
    child.stderr!.emit('data', 'PluginError: Failed to resolve plugin\n');
    child.stdout!.emit('data', 'a different line\n');
    const records = parseNdjsonText(readFileSync(join(logsDir, 'metro.ndjson'), 'utf-8')).filter(
      (r) => !String(r.event).startsWith('cache_store_'),
    );
    expect(records.map((r) => r.msg)).toEqual(['PluginError: Failed to resolve plugin', 'a different line']);
  });

  test('the child inherits the supervisor process environment (#33)', async () => {
    fakeBin();
    process.env.RN_ISO_TEST_SENTINEL = 'through';
    const calls: { opts: SpawnOptions }[] = [];
    try {
      await startExpoServer({
        root,
        port: 8113,
        logsDir: join(root, 'logs'),
        spawnFn: (_cmd, _args, opts) => {
          calls.push({ opts });
          return fakeChild();
        },
      });
    } finally {
      delete process.env.RN_ISO_TEST_SENTINEL;
    }
    const env = calls[0]?.opts.env as Record<string, string>;
    expect(env.RN_ISO_TEST_SENTINEL).toBe('through');
    expect(env.FORCE_COLOR).toBe('0');
  });

  test('stdout and stderr lines land in metro.ndjson as Contract-1 records', async () => {
    fakeBin();
    const child = fakeChild();
    const logsDir = join(root, '.rn-iso', 'logs');
    const handle = await startExpoServer({
      root,
      port: 8112,
      logsDir,
      spawnFn: () => child,
    });
    child.stdout!.emit('data', 'Starting project at /app\niOS Bundled 812ms index.js (1150 modules)\n');
    child.stderr!.emit('data', 'ERROR  Unable to resolve module ./nope\n');

    const records = parseNdjsonText(readFileSync(join(logsDir, 'metro.ndjson'), 'utf-8')).filter(
      (r) => !String(r.event).startsWith('cache_store_'),
    );
    expect(records.length).toBe(3);
    expect(records.map((r) => r.level)).toEqual(['info', 'info', 'error']);
    expect(records.every((r) => r.src === 'metro' && r.raw === true)).toBeTruthy();
    expect(records.every((r) => typeof r.ts === 'number')).toBeTruthy();
    expect(records[1]?.marker).toBe(true);
    expect(records[2]?.event).toBe('expo_stderr');
    expect(handle.serverPid).toBe(child.pid);
    expect(handle.mode).toBe('expo-child');
  });

  test('a child that dies flushes its last partial line and reports the exit', async () => {
    fakeBin();
    const child = fakeChild();
    const logsDir = join(root, '.rn-iso', 'logs');
    const handle = await startExpoServer({ root, port: 8113, logsDir, spawnFn: () => child });
    const exits: (ExpoExitInfo | null)[] = [];
    handle.onExit((info) => exits.push(info));

    child.stdout!.emit('data', 'Error: port already in use');
    child.emit('exit', 1, null);

    expect(exits).toEqual([{ code: 1, signal: null }]);
    const records = parseNdjsonText(readFileSync(join(logsDir, 'metro.ndjson'), 'utf-8'));
    const last = records.at(-1);
    assert(last);
    expect(last.msg).toBe('Error: port already in use');
    expect(last.level).toBe('error');
  });

  test('a spawn that never starts (ENOENT) reports an exit rather than hanging', async () => {
    fakeBin();
    const child = fakeChild();
    const handle = await startExpoServer({ root, port: 8114, logsDir: join(root, 'logs'), spawnFn: () => child });
    const exits: (ExpoExitInfo | null)[] = [];
    handle.onExit((info) => exits.push(info));
    child.emit('error', new Error('spawn EACCES'));
    expect(exits.length).toBe(1);
    const first = exits[0];
    assert(first);
    assert(first.error);
    expect(first.error.message).toMatch(/EACCES/);
  });

  test('onExit after the child is already gone still fires', async () => {
    fakeBin();
    const child = fakeChild();
    const handle = await startExpoServer({ root, port: 8115, logsDir: join(root, 'logs'), spawnFn: () => child });
    child.emit('exit', 0, null);
    const exits: (ExpoExitInfo | null)[] = [];
    handle.onExit((info) => exits.push(info));
    expect(exits.length).toBe(1);
  });

  test('close signals the child PID, not the process group it shares with us', async () => {
    fakeBin();
    const child = fakeChild(4242);
    const handle = await startExpoServer({
      root,
      port: 8116,
      logsDir: join(root, 'logs'),
      spawnFn: () => child,
      killTimeoutMs: 50,
    });
    const signals: Array<[number, string | number]> = [];
    const realKill = process.kill;
    process.kill = ((pid: number, sig: string | number) => {
      signals.push([pid, sig]);
      if (sig === 'SIGTERM') child.emit('exit', 0, 'SIGTERM');
      return true;
    }) as typeof process.kill;
    try {
      await handle.close();
    } finally {
      process.kill = realKill;
    }
    expect(signals).toEqual([[4242, 'SIGTERM']]);
  });

  test('a child that ignores SIGTERM is escalated to SIGKILL rather than left holding the port', async () => {
    fakeBin();
    const child = fakeChild(4243);
    const handle = await startExpoServer({
      root,
      port: 8117,
      logsDir: join(root, 'logs'),
      spawnFn: () => child,
      killTimeoutMs: 20,
    });
    const signals: Array<[number, string | number]> = [];
    const realKill = process.kill;
    process.kill = ((pid: number, sig: string | number) => {
      signals.push([pid, sig]);
      if (sig === 'SIGKILL') child.emit('exit', null, 'SIGKILL');
      return true;
    }) as typeof process.kill;
    try {
      await handle.close();
    } finally {
      process.kill = realKill;
    }
    expect(signals).toEqual([
      [4243, 'SIGTERM'],
      [4243, 'SIGKILL'],
    ]);
  });

  test('closing an already dead child signals nothing', async () => {
    fakeBin();
    const child = fakeChild(4244);
    const handle = await startExpoServer({ root, port: 8118, logsDir: join(root, 'logs'), spawnFn: () => child });
    child.emit('exit', 0, null);
    const realKill = process.kill;
    let called = 0;
    process.kill = (() => {
      called += 1;
      return true;
    }) as typeof process.kill;
    try {
      await handle.close();
    } finally {
      process.kill = realKill;
    }
    expect(called).toBe(0);
  });
});

test('inferLevel classifies Expo bundling failures as errors', () => {
  expect(inferLevel('iOS Bundling failed 6566ms apps/tlon-mobile/index.tsx (1 module)')).toBe('error');
  expect(inferLevel('Unable to resolve "./tailwind.json" from "index.tsx"')).toBe('error');
  expect(inferLevel('Failed to load app from http://localhost:8084')).toBe('error');
  expect(inferLevel('iOS Bundled 812ms index.js (1150 modules)')).toBe('info');
  expect(inferLevel('Bundling 100%')).toBe('info');
});

describe('the Metro store supplied to an Expo child', () => {
  const adapter = '/pkg/rn-iso/shim/expo-metro-config.cjs';

  test('the env additions point Expo at the adapter and preserve an existing override', () => {
    expect(
      expoMetroStoreEnv({
        root: '/w/app',
        storeRoot: '/cache/app',
        adapterPath: adapter,
        existingOverride: '/w/app/custom-metro.cjs',
      }),
    ).toEqual({
      EXPO_OVERRIDE_METRO_CONFIG: adapter,
      RN_ISO_METRO_STORE: '/cache/app',
      RN_ISO_PROJECT_ROOT: '/w/app',
      RN_ISO_EXPO_METRO_CONFIG: '/w/app/custom-metro.cjs',
    });
  });

  test('the adapter ships in this package and is found from here', () => {
    const found = expoMetroConfigPath();
    assert(found);
    expect(found.endsWith(join('shim', 'expo-metro-config.cjs'))).toBe(true);
    expect(existsSync(found)).toBe(true);
    expect(expoMetroConfigPath('file:///nowhere/at/all/x.js')).toBe(null);
  });

  test('the spawned SDK 54 child carries the adapter, store, and caller environment', async () => {
    fakeBin();
    process.env.NODE_OPTIONS = '--max-old-space-size=8192';
    process.env.EXPO_OVERRIDE_METRO_CONFIG = '/w/app/custom-metro.cjs';
    const calls: { opts: SpawnOptions }[] = [];
    await startExpoServer({
      root,
      port: 8120,
      logsDir: join(root, '.rn-iso', 'logs'),
      spawnFn: (_cmd, _args, opts) => {
        calls.push({ opts });
        return fakeChild();
      },
    });
    const env = calls[0]?.opts.env as Record<string, string>;
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=8192');
    expect(env.EXPO_OVERRIDE_METRO_CONFIG).toContain('expo-metro-config.cjs');
    expect(env.RN_ISO_EXPO_METRO_CONFIG).toBe('/w/app/custom-metro.cjs');
    expect(env.RN_ISO_METRO_STORE).toBe(metroStoreRoot(root));
    expect(env.RN_ISO_PROJECT_ROOT).toBe(root);
    expect(env.FORCE_COLOR).toBe('0');
    delete process.env.EXPO_OVERRIDE_METRO_CONFIG;
  });

  test('Expo SDK 53 runs normally without rn-iso Metro cache env', async () => {
    fakeBin(root, 53);
    const logsDir = join(root, '.rn-iso', 'logs');
    const calls: { opts: SpawnOptions }[] = [];
    await startExpoServer({
      root,
      port: 8119,
      logsDir,
      spawnFn: (_cmd, _args, opts) => {
        calls.push({ opts });
        return fakeChild();
      },
    });
    const env = calls[0]?.opts.env as Record<string, string>;
    expect(expoSdkMajor(root)).toBe(53);
    expect(env.EXPO_OVERRIDE_METRO_CONFIG).toBe(undefined);
    expect(env.RN_ISO_METRO_STORE).toBe(undefined);
    const records = parseNdjsonText(readFileSync(join(logsDir, 'metro.ndjson'), 'utf-8'));
    expect(String(records.find((record) => record.event === 'cache_store_skipped')?.msg)).toContain('predates');
  });

  test('the machine-level kill switch leaves NODE_OPTIONS exactly as the caller set it', async () => {
    writeFileSync(
      join(tmpHome, 'config.json'),
      JSON.stringify({ projects: {}, repos: {}, caches: { injectMetroStore: false } }),
    );
    fakeBin();
    process.env.NODE_OPTIONS = '--enable-source-maps';
    const logsDir = join(root, '.rn-iso', 'logs');
    const calls: { opts: SpawnOptions }[] = [];
    await startExpoServer({
      root,
      port: 8121,
      logsDir,
      spawnFn: (_cmd, _args, opts) => {
        calls.push({ opts });
        return fakeChild();
      },
    });
    const env = calls[0]?.opts.env as Record<string, string>;
    expect(env.NODE_OPTIONS).toBe('--enable-source-maps');
    expect(env.RN_ISO_METRO_STORE).toBe(undefined);
    const records = parseNdjsonText(readFileSync(join(logsDir, 'metro.ndjson'), 'utf-8'));
    expect(records.some((r) => r.event === 'cache_store_skipped')).toBe(true);
  });
});

describe('the honest record of the Metro store injection', () => {
  test('what rn-iso writes on the way in is the request, not a claim of success', async () => {
    fakeBin();
    const logsDir = join(root, '.rn-iso', 'logs');
    await startExpoServer({ root, port: 8122, logsDir, spawnFn: () => fakeChild() });
    const records = parseNdjsonText(readFileSync(join(logsDir, 'metro.ndjson'), 'utf-8'));
    const requested = records.filter((r) => r.event === 'cache_store_requested');
    expect(requested.length).toBe(1);
    expect(String(requested[0]?.msg)).toContain('asked this project');
    expect(String(requested[0]?.msg)).toContain(metroStoreRoot(root));
    expect(records.some((r) => r.event === 'cache_store_injected')).toBe(false);
    expect(records.some((r) => r.event === 'cache_store_added')).toBe(false);
  });

  test("the adapter's own line is what becomes the confirming record", () => {
    const record = recordFromLine('rn-iso-metro-store: sharing Metro transforms through /cache/app');
    assert(record);
    expect(record.event).toBe('cache_store_added');
    expect(record.level).toBe('debug');
    expect(String(record.msg)).toContain('/cache/app');
    expect(record.raw).toBe(undefined);
  });

  test('the confirmation parser only matches the adapter, and only with a root', () => {
    expect(metroStoreConfirmedRoot('rn-iso-metro-store: sharing Metro transforms through /cache/app')).toBe(
      '/cache/app',
    );
    expect(metroStoreConfirmedRoot('rn-iso-metro-store: sharing Metro transforms through ')).toBe(null);
    expect(metroStoreConfirmedRoot('warning: rn-iso could not share this project')).toBe(null);
    expect(metroStoreConfirmedRoot('iOS Bundled 812ms index.js (1150 modules)')).toBe(null);
  });

  test('the confirmation is promoted on either stream', () => {
    const line = 'rn-iso-metro-store: sharing Metro transforms through /cache/app';
    expect(recordFromLine(line, { stream: 'stderr' })?.event).toBe('cache_store_added');
    expect(recordFromLine(line, { stream: 'stdout' })?.event).toBe('cache_store_added');
  });

  test("the adapter's failure line is still an ordinary warn record", () => {
    const record = recordFromLine(
      "warning: rn-iso could not share this project's Metro transform cache (metro-cache exports no FileStore); the dev server is running with the cache it would have had anyway.",
    );
    assert(record);
    expect(record.level).toBe('warn');
    expect(record.raw).toBe(true);
  });
});
