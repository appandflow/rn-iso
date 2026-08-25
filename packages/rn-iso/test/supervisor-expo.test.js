// Hosting an Expo dev server as a child, and the stdout parsing that is the
// only structure this path gets.
//
// The parsing rules are pure functions because they carry the whole risk: a
// line classified as an error that is not one makes `logs --errors` -- the
// query an agent loop branches on -- report a healthy build as broken.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNdjsonText } from '../src/ndjson.js';
import {
  cleanLine,
  createLineReader,
  expoBinPath,
  inferLevel,
  isBundleMarker,
  recordFromLine,
  startExpoServer,
  stripAnsi,
} from '../src/supervisor/server-expo.js';

const ESC = '\u001B';

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rn-iso-expo-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
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
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('line parsing', () => {
  test('stripAnsi removes colour and OSC sequences', () => {
    assert.equal(stripAnsi(`${ESC}[32mStarting Metro${ESC}[39m`), 'Starting Metro');
    assert.equal(stripAnsi(`${ESC}]0;expo${ESC}\\done`), 'done');
  });

  test('cleanLine keeps only what a terminal would show after a carriage return', () => {
    assert.equal(cleanLine('Bundling 10%\rBundling 90%\rBundling 100%'), 'Bundling 100%');
    assert.equal(cleanLine('plain line   '), 'plain line');
  });

  test('inferLevel reads the leading word', () => {
    assert.equal(inferLevel('ERROR  Something exploded'), 'error');
    assert.equal(inferLevel('error: Unable to resolve module'), 'error');
    assert.equal(inferLevel('Error: Unable to resolve module'), 'error');
    assert.equal(inferLevel('WARN  Deprecated API'), 'warn');
    assert.equal(inferLevel('warning: peer dependency'), 'warn');
    assert.equal(inferLevel('Starting Metro Bundler'), 'info');
    assert.equal(inferLevel(''), 'info');
  });

  test('inferLevel reads the symbols Expo uses instead of words', () => {
    assert.equal(inferLevel('\u2716 Metro encountered an error'), 'error');
    assert.equal(inferLevel('\u274C build failed'), 'error');
    assert.equal(inferLevel('\u26A0 something is off'), 'warn');
  });

  test('inferLevel does not read a mid-line word as a level', () => {
    assert.equal(inferLevel('Logs for your project will appear below, including errors'), 'info');
  });

  test("the bundle line is a marker, so an Expo workspace's --errors window resets", () => {
    assert.equal(isBundleMarker('iOS Bundled 812ms index.js (1150 modules)'), true);
    assert.equal(isBundleMarker('Android Bundled 5401ms node_modules/expo-router/entry.js (1743 modules)'), true);
    assert.equal(isBundleMarker('Starting Metro Bundler'), false);
  });

  test('recordFromLine produces a Contract-1 record flagged as inferred', () => {
    const record = recordFromLine(`${ESC}[31mERROR  boom${ESC}[39m`, { stream: 'stderr' });
    assert.equal(record.src, 'metro');
    assert.equal(record.level, 'error');
    assert.equal(record.msg, 'ERROR  boom');
    assert.equal(record.raw, true, 'raw:true is what says the structure was inferred');
    assert.equal(record.event, 'expo_stderr');
    assert.equal(record.marker, undefined);
  });

  test('a blank line produces no record at all', () => {
    assert.equal(recordFromLine('   '), null);
    assert.equal(recordFromLine(`${ESC}[2K`), null);
  });
});

describe('createLineReader', () => {
  test('reassembles lines split across chunk boundaries', () => {
    const lines = [];
    const reader = createLineReader((l) => lines.push(l));
    reader.push('Starting ');
    reader.push('Metro\niOS Bun');
    reader.push('dled 10ms\n');
    assert.deepEqual(lines, ['Starting Metro', 'iOS Bundled 10ms']);
  });

  test('flush emits the trailing partial line, which is usually the interesting one', () => {
    const lines = [];
    const reader = createLineReader((l) => lines.push(l));
    reader.push('Error: died mid-');
    assert.deepEqual(lines, []);
    reader.push('sentence');
    reader.flush();
    assert.deepEqual(lines, ['Error: died mid-sentence']);
    reader.flush();
    assert.deepEqual(lines, ['Error: died mid-sentence'], 'flushing twice must not repeat it');
  });
});

describe('startExpoServer', () => {
  test('a project with no resolvable expo fails with a named code and a remedy', async () => {
    const err = await startExpoServer({ root, port: 8110, logsDir: join(root, 'logs') }).then(
      () => null,
      (e) => e
    );
    assert.equal(err.code, 'RN_ISO_EXPO_BIN');
    assert.match(err.message, /not resolvable/);
    // The remedy must NOT be the old "run npm install": it was printed at two
    // monorepos whose dependencies were fully installed, and it sent the
    // reader looking in the wrong place.
    assert.match(err.remedy, /workspace root/);
  });

  test('spawns `expo start --port <n>` and NOTHING else, from the project root', async () => {
    fakeBin();
    let call = null;
    await startExpoServer({
      root, port: 8111, logsDir: join(root, 'logs'),
      spawnFn: (cmd, args, opts) => { call = { cmd, args, opts }; return fakeChild(); },
    });
    assert.equal(call.cmd, expoBinPath(root));
    assert.deepEqual(call.args, ['start', '--port', '8111']);
    assert.equal(call.opts.cwd, root);
    assert.deepEqual(call.opts.stdio, ['ignore', 'pipe', 'pipe']);
    // detached:false is what keeps the child in the supervisor's process
    // group, so it can never outlive it.
    assert.equal(call.opts.detached, false);
  });

  test('stdout and stderr lines land in metro.ndjson as Contract-1 records', async () => {
    fakeBin();
    const child = fakeChild();
    const logsDir = join(root, '.rn-iso', 'logs');
    const handle = await startExpoServer({
      root, port: 8112, logsDir,
      spawnFn: () => child,
    });
    child.stdout.emit('data', 'Starting project at /app\niOS Bundled 812ms index.js (1150 modules)\n');
    child.stderr.emit('data', 'ERROR  Unable to resolve module ./nope\n');

    const records = parseNdjsonText(readFileSync(join(logsDir, 'metro.ndjson'), 'utf-8'));
    assert.equal(records.length, 3);
    assert.deepEqual(records.map((r) => r.level), ['info', 'info', 'error']);
    assert.ok(records.every((r) => r.src === 'metro' && r.raw === true));
    assert.ok(records.every((r) => typeof r.ts === 'number'));
    assert.equal(records[1].marker, true);
    assert.equal(records[2].event, 'expo_stderr');
    assert.equal(handle.serverPid, child.pid);
    assert.equal(handle.mode, 'expo-child');
  });

  test('a child that dies flushes its last partial line and reports the exit', async () => {
    fakeBin();
    const child = fakeChild();
    const logsDir = join(root, '.rn-iso', 'logs');
    const handle = await startExpoServer({ root, port: 8113, logsDir, spawnFn: () => child });
    const exits = [];
    handle.onExit((info) => exits.push(info));

    child.stdout.emit('data', 'Error: port already in use');
    child.emit('exit', 1, null);

    assert.deepEqual(exits, [{ code: 1, signal: null }]);
    const records = parseNdjsonText(readFileSync(join(logsDir, 'metro.ndjson'), 'utf-8'));
    assert.equal(records.at(-1).msg, 'Error: port already in use');
    assert.equal(records.at(-1).level, 'error');
  });

  test('a spawn that never starts (ENOENT) reports an exit rather than hanging', async () => {
    fakeBin();
    const child = fakeChild();
    const handle = await startExpoServer({ root, port: 8114, logsDir: join(root, 'logs'), spawnFn: () => child });
    const exits = [];
    handle.onExit((info) => exits.push(info));
    child.emit('error', new Error('spawn EACCES'));
    assert.equal(exits.length, 1);
    assert.match(exits[0].error.message, /EACCES/);
  });

  test('onExit after the child is already gone still fires', async () => {
    fakeBin();
    const child = fakeChild();
    const handle = await startExpoServer({ root, port: 8115, logsDir: join(root, 'logs'), spawnFn: () => child });
    child.emit('exit', 0, null);
    const exits = [];
    handle.onExit((info) => exits.push(info));
    assert.equal(exits.length, 1);
  });

  test('close signals the child PID, not the process group it shares with us', async () => {
    fakeBin();
    const child = fakeChild(4242);
    const handle = await startExpoServer({ root, port: 8116, logsDir: join(root, 'logs'), spawnFn: () => child, killTimeoutMs: 50 });
    const signals = [];
    const realKill = process.kill;
    process.kill = (pid, sig) => { signals.push([pid, sig]); if (sig === 'SIGTERM') child.emit('exit', 0, 'SIGTERM'); };
    try {
      await handle.close();
    } finally {
      process.kill = realKill;
    }
    // A negative pid would signal the group -- which contains the supervisor
    // itself, killing it before it can write its final record.
    assert.deepEqual(signals, [[4242, 'SIGTERM']]);
  });

  test('a child that ignores SIGTERM is escalated to SIGKILL rather than left holding the port', async () => {
    fakeBin();
    const child = fakeChild(4243);
    const handle = await startExpoServer({ root, port: 8117, logsDir: join(root, 'logs'), spawnFn: () => child, killTimeoutMs: 20 });
    const signals = [];
    const realKill = process.kill;
    process.kill = (pid, sig) => { signals.push([pid, sig]); if (sig === 'SIGKILL') child.emit('exit', null, 'SIGKILL'); };
    try {
      await handle.close();
    } finally {
      process.kill = realKill;
    }
    assert.deepEqual(signals, [[4243, 'SIGTERM'], [4243, 'SIGKILL']]);
  });

  test('closing an already dead child signals nothing', async () => {
    fakeBin();
    const child = fakeChild(4244);
    const handle = await startExpoServer({ root, port: 8118, logsDir: join(root, 'logs'), spawnFn: () => child });
    child.emit('exit', 0, null);
    const realKill = process.kill;
    let called = 0;
    process.kill = () => { called += 1; };
    try {
      await handle.close();
    } finally {
      process.kill = realKill;
    }
    assert.equal(called, 0);
  });
});
