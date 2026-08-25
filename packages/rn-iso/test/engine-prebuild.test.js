// engine/prebuild.js -- when CNG generation runs, and what it runs.
//
// No real prebuild is executed here: `expo prebuild` writes a native project
// into the repo it is pointed at, so every case below uses a fake spawn.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PREBUILD_ERROR,
  nativeDirName,
  needsPrebuild,
  prebuildRefusal,
  runPrebuild,
  shouldPrebuild,
} from '../src/engine/prebuild.js';

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rn-iso-prebuild-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { expo: '52.0.0' } }));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function installFakeExpoBin() {
  const dir = join(root, 'node_modules', '.bin');
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'expo');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  chmodSync(bin, 0o755);
  return bin;
}

describe('the decision', () => {
  test('shouldPrebuild is expo AND no native directory, nothing else', () => {
    assert.equal(shouldPrebuild({ isExpo: true, nativeDirExists: false }), true);
    // Regenerating over committed native sources overwrites hand edits.
    assert.equal(shouldPrebuild({ isExpo: true, nativeDirExists: true }), false);
    assert.equal(shouldPrebuild({ isExpo: false, nativeDirExists: false }), false);
    assert.equal(shouldPrebuild({ isExpo: false, nativeDirExists: true }), false);
  });

  test('nativeDirName maps the platform to its directory', () => {
    assert.equal(nativeDirName('ios'), 'ios');
    assert.equal(nativeDirName('android'), 'android');
  });

  test('needsPrebuild reads the directory off the disk', () => {
    assert.equal(needsPrebuild(root, 'ios', true), true);
    mkdirSync(join(root, 'ios'), { recursive: true });
    assert.equal(needsPrebuild(root, 'ios', true), false);
    assert.equal(needsPrebuild(root, 'android', true), true);
    assert.equal(needsPrebuild(root, 'android', false), false);
  });

  // A bare project with no ios/ has no config-plugin pipeline to generate one
  // from; `expo prebuild` there would invent a native project unrelated to
  // the app. Refusing with a remedy is the honest answer.
  test('prebuildRefusal names the bare-project case and nothing else', () => {
    const refusal = prebuildRefusal({ isExpo: false, platform: 'ios', nativeDirExists: false });
    assert.equal(refusal.code, PREBUILD_ERROR);
    assert.match(refusal.message, /no ios\/ directory and is not an Expo/);
    assert.match(refusal.remedy, /expo/);
    assert.equal(prebuildRefusal({ isExpo: true, platform: 'ios', nativeDirExists: false }), null);
    assert.equal(prebuildRefusal({ isExpo: false, platform: 'ios', nativeDirExists: true }), null);
  });
});

function fakeExpoChild({ lines = [], code = 0, signal = null, error = null, onExitSideEffect = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  setImmediate(() => {
    for (const line of lines) child.stdout.emit('data', `${line}\n`);
    if (error) { child.emit('error', error); return; }
    onExitSideEffect?.();
    child.emit('exit', code, signal);
  });
  return child;
}

function collectingWriter() {
  const records = [];
  return { records, write: (r) => { records.push(r); return true; } };
}

describe('runPrebuild', () => {
  test("runs the PROJECT's own expo bin with `prebuild -p <platform> --no-install`", async () => {
    const bin = installFakeExpoBin();
    const writer = collectingWriter();
    let spawned = null;
    const result = await runPrebuild(root, 'ios', writer, {
      isExpo: true,
      spawnFn: (cmd, args, opts) => {
        spawned = { cmd, args, opts };
        return fakeExpoChild({
          lines: ['Creating native directory (./ios)'],
          onExitSideEffect: () => mkdirSync(join(root, 'ios'), { recursive: true }),
        });
      },
    });
    assert.equal(result.ok, true);
    // Never `npx expo`: npx would download whatever version is newest and
    // generate a native project that does not match the app's SDK.
    assert.equal(spawned.cmd, bin);
    assert.deepEqual(spawned.args, ['prebuild', '-p', 'ios', '--no-install']);
    assert.equal(spawned.opts.cwd, root);
    assert.deepEqual(
      writer.records.map(r => [r.src, r.level, r.msg]),
      [['build', 'debug', 'Creating native directory (./ios)']]
    );
  });

  test('a non-zero exit comes back as {failed, lastLines}', async () => {
    installFakeExpoBin();
    const result = await runPrebuild(root, 'android', collectingWriter(), {
      isExpo: true,
      spawnFn: () => fakeExpoChild({ lines: ['Error: Cannot determine the package name'], code: 1 }),
    });
    assert.equal(result.failed, true);
    assert.equal(result.code, PREBUILD_ERROR);
    assert.match(result.reason, /exit code 1/);
    assert.match(result.lastLines.join('\n'), /package name/);
  });

  // A prebuild that exits 0 without producing the directory is a silent
  // no-op; the build that follows would fail minutes later with a far worse
  // message.
  test('an exit-0 prebuild that produced no native directory is still a failure', async () => {
    installFakeExpoBin();
    const result = await runPrebuild(root, 'ios', collectingWriter(), {
      isExpo: true,
      spawnFn: () => fakeExpoChild({ lines: ['nothing to do'] }),
    });
    assert.equal(result.failed, true);
    assert.match(result.reason, /did not create ios\//);
  });

  test('refuses a bare project with no native directory, with a remedy', async () => {
    const result = await runPrebuild(root, 'ios', collectingWriter(), {
      isExpo: false,
      spawnFn: () => { throw new Error('must not spawn prebuild for a bare project'); },
    });
    assert.equal(result.failed, true);
    assert.equal(result.code, PREBUILD_ERROR);
    assert.match(result.reason, /not an Expo/);
    assert.match(result.remedy, /react-native-community/);
    assert.equal(result.error.code, PREBUILD_ERROR);
  });

  test('reports a project whose expo binary was never installed', async () => {
    const result = await runPrebuild(root, 'ios', collectingWriter(), {
      isExpo: true,
      spawnFn: () => { throw new Error('must not spawn'); },
    });
    assert.equal(result.failed, true);
    assert.match(result.reason, /does not exist/);
    assert.match(result.remedy, /npm install/);
  });

  test('a spawn error is a failure, not a hang', async () => {
    installFakeExpoBin();
    const result = await runPrebuild(root, 'ios', collectingWriter(), {
      isExpo: true,
      spawnFn: () => fakeExpoChild({ error: new Error('EACCES') }),
    });
    assert.equal(result.failed, true);
    assert.match(result.reason, /EACCES/);
  });
});
