import assert from 'node:assert';
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
import { makeChildProcess, makeWriter } from './_factories.ts';

type WriteRecord = { src: string; level: string; msg: string };

type SpawnCall = { cmd: string; args: string[]; opts: Record<string, unknown> };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-cli-prebuild-'));
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

  test('prebuildRefusal names the bare-project case and nothing else', () => {
    const refusal = prebuildRefusal({ isExpo: false, platform: 'ios', nativeDirExists: false });
    assert(refusal);
    expect(refusal.code).toBe(PREBUILD_ERROR);
    expect(refusal.message).toMatch(/no ios\/ directory and is not an Expo/);
    expect(refusal.remedy).toMatch(/expo/);
    expect(prebuildRefusal({ isExpo: true, platform: 'ios', nativeDirExists: false })).toBe(null);
    expect(prebuildRefusal({ isExpo: false, platform: 'ios', nativeDirExists: true })).toBe(null);
  });
});

function fakeExpoChild({
  lines = [],
  code = 0,
  signal = null,
  error = null,
  onExitSideEffect = null,
}: {
  lines?: string[];
  code?: number;
  signal?: NodeJS.Signals | null;
  error?: Error | null;
  onExitSideEffect?: (() => void) | null;
} = {}) {
  const child = makeChildProcess();
  setImmediate(() => {
    for (const line of lines) child.stdout?.emit('data', `${line}\n`);
    if (error) {
      child.emit('error', error);
      return;
    }
    onExitSideEffect?.();
    child.emit('exit', code, signal);
  });
  return child;
}

function collectingWriter() {
  const records: WriteRecord[] = [];
  const writer = makeWriter({
    write: (r: WriteRecord) => {
      records.push(r);
      return true;
    },
  });
  return Object.assign(writer, { records });
}

describe('runPrebuild', () => {
  test("runs the PROJECT's own expo bin with `prebuild -p <platform> --no-install`", async () => {
    const bin = installFakeExpoBin();
    const writer = collectingWriter();
    const spawnCalls: SpawnCall[] = [];
    const result = await runPrebuild(root, 'ios', writer, {
      isExpo: true,
      spawnFn: (cmd, args, opts) => {
        spawnCalls.push({ cmd, args, opts });
        return fakeExpoChild({
          lines: ['Creating native directory (./ios)'],
          onExitSideEffect: () => mkdirSync(join(root, 'ios'), { recursive: true }),
        });
      },
    });
    expect(result.ok).toBe(true);
    const spawned = spawnCalls[0];
    assert(spawned);
    expect(spawned.cmd).toBe(bin);
    expect(spawned.args).toEqual(['prebuild', '-p', 'ios', '--no-install']);
    expect(spawned.opts.cwd).toBe(root);
    expect(writer.records.map((r) => [r.src, r.level, r.msg])).toEqual([
      ['build', 'debug', 'Creating native directory (./ios)'],
    ]);
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
    assert(result.lastLines);
    expect(result.lastLines.join('\n')).toMatch(/package name/);
  });

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
      spawnFn: () => {
        throw new Error('must not spawn prebuild for a bare project');
      },
    });
    expect(result.failed).toBe(true);
    expect(result.code).toBe(PREBUILD_ERROR);
    expect(result.reason).toMatch(/not an Expo/);
    expect(result.remedy).toMatch(/react-native-community/);
    assert(result.error);
    expect(result.error.code).toBe(PREBUILD_ERROR);
  });

  test('reports a project from which expo cannot be resolved', async () => {
    const result = await runPrebuild(root, 'ios', collectingWriter(), {
      isExpo: true,
      spawnFn: () => {
        throw new Error('must not spawn');
      },
    });
    expect(result.failed).toBe(true);
    expect(result.reason).toMatch(/not resolvable/);
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
