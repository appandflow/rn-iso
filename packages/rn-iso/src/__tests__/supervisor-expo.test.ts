// Hosting an Expo dev server as a child, and the stdout parsing that is the
// only structure this path gets.
//
// The parsing rules are pure functions because they carry the whole risk: a
// line classified as an error that is not one makes `logs --errors` -- the
// query an agent loop branches on -- report a healthy build as broken.
import assert from 'node:assert';
import type { SpawnOptions } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNdjsonText } from '../ndjson.ts';
import {
  cleanLine,
  createLineReader,
  expoBinPath,
  inferLevel,
  isBundleMarker,
  recordFromLine,
  startExpoServer,
  stripAnsi,
} from '../supervisor/server-expo.ts';
import {
  composeNodeOptions,
  metroShimPath,
  metroStoreConfirmedRoot,
  metroStoreEnv,
  metroStoreRoot,
} from '../supervisor/metro-store.ts';
import { makeChildProcess } from './_factories.ts';

const ESC = '\u001B';

// Mirrors the (unexported) ExpoExitInfo shape onExit hands back.
type ExpoExitInfo = { code: number | null; signal: NodeJS.Signals | null; error?: Error };

let root: string;
// RN_ISO_HOME is redirected for every case here, not just the config-touching
// ones: startExpoServer now REGISTERS the Metro store it injects, and an
// unredirected run would rewrite the caches.json on the machine running the
// suite (CLAUDE.md item 5).
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
});

// The .bin shim, where a NON-hoisted install puts it. expoBinPath has to find
// this one by walking up (it is in the project itself here), and the hoisted
// case is covered in the monorepo-resolution suite.
function fakeBin(dir = root) {
  const bin = join(dir, 'node_modules', '.bin', 'expo');
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(bin, '#!/bin/sh\n');
  chmodSync(bin, 0o755);
  return bin;
}

function fakeChild(pid = 999999) {
  return makeChildProcess({ pid });
}

describe('line parsing', () => {
  test('stripAnsi removes colour and OSC sequences', () => {
    expect(stripAnsi(`${ESC}[32mStarting Metro${ESC}[39m`)).toBe('Starting Metro');
    expect(stripAnsi(`${ESC}]0;expo${ESC}\\done`)).toBe('done');
  });

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

  // --- the dev-client NAVIGATE demotion ------------------------------------
  //
  // FIELD PROVENANCE (release gate, 2026-08-24). On EVERY cold Android launch
  // -- a perfect one -- `rn-iso logs --errors` returned one record and
  // `status` reported "1 error since the last marker". It is rn-iso's own
  // launch doing it: Contract 6 opens the expo-dev-client deep link
  // (`<scheme>://expo-development-client/?url=...`, engine/app-install.js),
  // expo-dev-launcher forwards it into the app as a link, and React Navigation
  // logs at console.error that no navigator handled a NAVIGATE to a route
  // named `expo-development-client` -- because there is no such screen, and
  // there is not meant to be. The app is loaded and working.
  //
  // The record below is the verbatim line as it arrived in the metro stream.
  const NAVIGATE_ERROR = `ERROR  The action 'NAVIGATE' with payload {"name":"expo-development-client","params":{"url":"http://10.0.2.2:8082"}} was not handled by any navigator.`;

  test('the dev-client NAVIGATE record is demoted: rn-iso own deep link is not an app error', () => {
    expect(inferLevel(NAVIGATE_ERROR)).toBe('info');
    const record = recordFromLine(NAVIGATE_ERROR);
    assert(record);
    expect(record.level).toBe('info');
    expect(record.msg).toBe(NAVIGATE_ERROR);
  });

  // BOTH halves must match in the SAME record, or the demotion starts hiding
  // real navigation bugs -- which is the only thing this rule could break.
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

  // A FAILED bundle is an attempt boundary too (appandflow/rn-iso#13): its
  // marker is what stops back-to-back failures from accumulating in
  // `logs --errors`. The failed line is BOTH error and marker -- Expo prints
  // it before the detail lines, and logs-query's strict (<) bundle cutoff
  // keeps the line itself and its details reported.
  test('the "Bundling failed" line is a marker AND an error', () => {
    const line = 'iOS Bundling failed 893ms index.js (4173 modules)';
    expect(isBundleMarker(line)).toBe(true);
    expect(isBundleMarker('Android Bundling failed 91ms')).toBe(true);
    // In-flight progress is not a boundary: the attempt has not finished.
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

describe('createLineReader', () => {
  test('reassembles lines split across chunk boundaries', () => {
    const lines: string[] = [];
    const reader = createLineReader((l) => lines.push(l));
    reader.push('Starting ');
    reader.push('Metro\niOS Bun');
    reader.push('dled 10ms\n');
    expect(lines).toEqual(['Starting Metro', 'iOS Bundled 10ms']);
  });

  test('flush emits the trailing partial line, which is usually the interesting one', () => {
    const lines: string[] = [];
    const reader = createLineReader((l) => lines.push(l));
    reader.push('Error: died mid-');
    expect(lines).toEqual([]);
    reader.push('sentence');
    reader.flush();
    expect(lines).toEqual(['Error: died mid-sentence']);
    reader.flush();
    expect(lines).toEqual(['Error: died mid-sentence']);
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
    // The remedy must NOT be the old "run npm install": it was printed at two
    // monorepos whose dependencies were fully installed, and it sent the
    // reader looking in the wrong place.
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
    // detached:false is what keeps the child in the supervisor's process
    // group, so it can never outlive it.
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
    // The injection record start writes is dropped here: this case is about
    // the two child streams, and the cache note is not one of them.
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
    // A negative pid would signal the group -- which contains the supervisor
    // itself, killing it before it can write its final record.
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

// The tlon field test: a failed bundle was stored at info and logs --errors
// returned empty against a genuinely broken build. Expo's failure vocabulary
// has no bullet and no leading "error".
test('inferLevel classifies Expo bundling failures as errors', () => {
  expect(inferLevel('iOS Bundling failed 6566ms apps/tlon-mobile/index.tsx (1 module)')).toBe('error');
  expect(inferLevel('Unable to resolve "./tailwind.json" from "index.tsx"')).toBe('error');
  expect(inferLevel('Failed to load app from http://localhost:8084')).toBe('error');
  expect(inferLevel('iOS Bundled 812ms index.js (1150 modules)')).toBe('info');
  expect(inferLevel('Bundling 100%')).toBe('info');
});

// --- the shared transform store, injected into the Expo child --------------
//
// The bare path appends a store to the config it hosts. Here the dev server is
// the project's own `expo start`, so the only seam is the environment -- and
// the rule that matters is that NODE_OPTIONS is APPENDED to, never replaced:
// the caller may have set it for reasons rn-iso knows nothing about.
describe('the Metro store injected into an Expo child', () => {
  const shim = '/pkg/rn-iso/shim/metro-cache-store.cjs';

  test('an unset NODE_OPTIONS becomes exactly our --require', () => {
    expect(composeNodeOptions(undefined, shim)).toBe(`--require ${shim}`);
    expect(composeNodeOptions('', shim)).toBe(`--require ${shim}`);
    expect(composeNodeOptions(null, shim)).toBe(`--require ${shim}`);
  });

  test("the caller's own NODE_OPTIONS is kept and ours is APPENDED to it", () => {
    expect(composeNodeOptions('--max-old-space-size=8192', shim)).toBe(`--max-old-space-size=8192 --require ${shim}`);
    expect(composeNodeOptions('--require /other/hook.js --enable-source-maps', shim)).toBe(
      `--require /other/hook.js --enable-source-maps --require ${shim}`,
    );
  });

  test('a shim already on the line is not added twice', () => {
    expect(composeNodeOptions(`--require ${shim}`, shim)).toBe(null);
  });

  // Node parses NODE_OPTIONS shell-like and understands double quotes, so a
  // path with spaces works when it is quoted -- and a path with a quote in it
  // is refused rather than mis-parsed into arguments that break the child.
  test('a path with spaces is quoted, and a path with a quote is refused', () => {
    expect(composeNodeOptions('', '/My Apps/rn-iso/shim.cjs')).toBe('--require "/My Apps/rn-iso/shim.cjs"');
    expect(composeNodeOptions('', '/we"ird/shim.cjs')).toBe(null);
  });

  test('the env additions name the store and the project beside the require', () => {
    const env = metroStoreEnv({ root: '/w/app', storeRoot: '/cache/app', shimPath: shim, nodeOptions: '--x' });
    assert(env);
    expect(env.NODE_OPTIONS).toBe(`--x --require ${shim}`);
    expect(env.RN_ISO_METRO_STORE).toBe('/cache/app');
    expect(env.RN_ISO_PROJECT_ROOT).toBe('/w/app');
    expect(metroStoreEnv({ root: '/w/app', storeRoot: '/c', shimPath: shim, nodeOptions: `--require ${shim}` })).toBe(
      null,
    );
  });

  // The shim is a real file shipped in the package, not a string written to a
  // temp directory: it has to be require()-able by somebody else's process.
  test('the shim ships in this package and is found from here', () => {
    const found = metroShimPath();
    assert(found);
    expect(found.endsWith(join('shim', 'metro-cache-store.cjs'))).toBe(true);
    expect(existsSync(found)).toBe(true);
    expect(metroShimPath('file:///nowhere/at/all/x.js')).toBe(null);
  });

  test('the spawned child carries the require, the store and the environment it was given', async () => {
    fakeBin();
    process.env.NODE_OPTIONS = '--max-old-space-size=8192';
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
    expect(env.NODE_OPTIONS?.startsWith('--max-old-space-size=8192 --require ')).toBe(true);
    expect(env.NODE_OPTIONS).toContain('metro-cache-store.cjs');
    expect(env.RN_ISO_METRO_STORE).toBe(metroStoreRoot(root));
    expect(env.RN_ISO_PROJECT_ROOT).toBe(root);
    // Still the project's own `expo start --port N`, unchanged.
    expect(env.FORCE_COLOR).toBe('0');
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

// --- the record that used to lie (issue #73) --------------------------------
//
// rn-iso wrote `cache_store_injected` -- "sharing Metro transforms through
// ..." -- before the child was even spawned, so on tlon the timeline reported
// a shared store through three bundles while the shim inside that child was
// failing on every one of them. Nothing on this side CAN know the outcome: it
// happens in another process. So this side reports the REQUEST, and the shim
// reports the outcome in a line only a working shim writes.
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
    // The claim itself is gone: nothing says the store IS shared until the
    // process that would know says so.
    expect(records.some((r) => r.event === 'cache_store_injected')).toBe(false);
    expect(records.some((r) => r.event === 'cache_store_added')).toBe(false);
  });

  test("the shim's own line is what becomes the confirming record", () => {
    const record = recordFromLine('rn-iso-metro-store: sharing Metro transforms through /cache/app');
    assert(record);
    expect(record.event).toBe('cache_store_added');
    expect(record.level).toBe('debug');
    expect(String(record.msg)).toContain('/cache/app');
    // Reported, not inferred: this is the one line in this stream with
    // structure behind it, so it does not carry Contract 1's `raw`.
    expect(record.raw).toBe(undefined);
  });

  test('the confirmation parser only matches the shim, and only with a root', () => {
    expect(metroStoreConfirmedRoot('rn-iso-metro-store: sharing Metro transforms through /cache/app')).toBe(
      '/cache/app',
    );
    expect(metroStoreConfirmedRoot('rn-iso-metro-store: sharing Metro transforms through ')).toBe(null);
    expect(metroStoreConfirmedRoot('warning: rn-iso could not share this project')).toBe(null);
    expect(metroStoreConfirmedRoot('iOS Bundled 812ms index.js (1150 modules)')).toBe(null);
  });

  // The line arrives on the child's stderr, which the supervisor reads with
  // the same reader as stdout -- a confirmation that landed in the timeline as
  // an ordinary info line would be no better than the claim it replaced.
  test('the confirmation is promoted on either stream', () => {
    const line = 'rn-iso-metro-store: sharing Metro transforms through /cache/app';
    expect(recordFromLine(line, { stream: 'stderr' })?.event).toBe('cache_store_added');
    expect(recordFromLine(line, { stream: 'stdout' })?.event).toBe('cache_store_added');
  });

  // And the failure half still reads as a warning, so `logs --errors` and
  // `status` see a shim that could not apply.
  test("the shim's failure line is still an ordinary warn record", () => {
    const record = recordFromLine(
      "warning: rn-iso could not share this project's Metro transform cache (metro-cache exports no FileStore); the dev server is running with the cache it would have had anyway.",
    );
    assert(record);
    expect(record.level).toBe('warn');
    expect(record.raw).toBe(true);
  });
});
