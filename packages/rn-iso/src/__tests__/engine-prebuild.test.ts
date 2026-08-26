// engine/prebuild.js -- when CNG generation runs, and what it runs.
//
// No real prebuild is executed here: `expo prebuild` writes a native project
// into the repo it is pointed at, so every case below uses a fake spawn.
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
} from '../engine/prebuild.ts';

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
    expect(shouldPrebuild({ isExpo: true, nativeDirExists: false })).toBe(true);
    // Regenerating over committed native sources overwrites hand edits.
    expect(shouldPrebuild({ isExpo: true, nativeDirExists: true })).toBe(false);
    expect(shouldPrebuild({ isExpo: false, nativeDirExists: false })).toBe(false);
    expect(shouldPrebuild({ isExpo: false, nativeDirExists: true })).toBe(false);
  });

  test('nativeDirName maps the platform to its directory', () => {
    expect(nativeDirName('ios')).toBe('ios');
    expect(nativeDirName('android')).toBe('android');
  });

  test('needsPrebuild reads the directory off the disk', () => {
    expect(needsPrebuild(root, 'ios', true)).toBe(true);
    mkdirSync(join(root, 'ios'), { recursive: true });
    expect(needsPrebuild(root, 'ios', true)).toBe(false);
    expect(needsPrebuild(root, 'android', true)).toBe(true);
    expect(needsPrebuild(root, 'android', false)).toBe(false);
  });

  // A bare project with no ios/ has no config-plugin pipeline to generate one
  // from; `expo prebuild` there would invent a native project unrelated to
  // the app. Refusing with a remedy is the honest answer.
  test('prebuildRefusal names the bare-project case and nothing else', () => {
    const refusal = prebuildRefusal({ isExpo: false, platform: 'ios', nativeDirExists: false });
    expect(refusal.code).toBe(PREBUILD_ERROR);
    expect(refusal.message).toMatch(/no ios\/ directory and is not an Expo/);
    expect(refusal.remedy).toMatch(/expo/);
    expect(prebuildRefusal({ isExpo: true, platform: 'ios', nativeDirExists: false })).toBe(null);
    expect(prebuildRefusal({ isExpo: false, platform: 'ios', nativeDirExists: true })).toBe(null);
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
    expect(result.ok).toBe(true);
    // Never `npx expo`: npx would download whatever version is newest and
    // generate a native project that does not match the app's SDK.
    expect(spawned.cmd).toBe(bin);
    expect(spawned.args).toEqual(['prebuild', '-p', 'ios', '--no-install']);
    expect(spawned.opts.cwd).toBe(root);
    expect(writer.records.map(r => [r.src, r.level, r.msg])).toEqual([['build', 'debug', 'Creating native directory (./ios)']]);
  });

  test('a non-zero exit comes back as {failed, lastLines}', async () => {
    installFakeExpoBin();
    const result = await runPrebuild(root, 'android', collectingWriter(), {
      isExpo: true,
      spawnFn: () => fakeExpoChild({ lines: ['Error: Cannot determine the package name'], code: 1 }),
    });
    expect(result.failed).toBe(true);
    expect(result.code).toBe(PREBUILD_ERROR);
    expect(result.reason).toMatch(/exit code 1/);
    expect(result.lastLines.join('\n')).toMatch(/package name/);
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
    expect(result.failed).toBe(true);
    expect(result.reason).toMatch(/did not create ios\//);
  });

  test('refuses a bare project with no native directory, with a remedy', async () => {
    const result = await runPrebuild(root, 'ios', collectingWriter(), {
      isExpo: false,
      spawnFn: () => { throw new Error('must not spawn prebuild for a bare project'); },
    });
    expect(result.failed).toBe(true);
    expect(result.code).toBe(PREBUILD_ERROR);
    expect(result.reason).toMatch(/not an Expo/);
    expect(result.remedy).toMatch(/react-native-community/);
    expect(result.error.code).toBe(PREBUILD_ERROR);
  });

  test('reports a project from which expo cannot be resolved', async () => {
    const result = await runPrebuild(root, 'ios', collectingWriter(), {
      isExpo: true,
      spawnFn: () => { throw new Error('must not spawn'); },
    });
    expect(result.failed).toBe(true);
    expect(result.reason).toMatch(/not resolvable/);
    // Never "run npm install" again: on a hoisted monorepo the dependencies
    // ARE installed and that remedy is a wrong answer stated confidently.
    expect(result.remedy).not.toMatch(/^Run `npm install`/);
    expect(result.remedy).toMatch(/workspace root/);
  });

  test('a spawn error is a failure, not a hang', async () => {
    installFakeExpoBin();
    const result = await runPrebuild(root, 'ios', collectingWriter(), {
      isExpo: true,
      spawnFn: () => fakeExpoChild({ error: new Error('EACCES') }),
    });
    expect(result.failed).toBe(true);
    expect(result.reason).toMatch(/EACCES/);
  });
});
