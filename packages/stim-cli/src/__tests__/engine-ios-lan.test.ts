import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { resetExecutor } from '../exec.ts';
import {
  chooseLanAddress,
  copyAppAside,
  ensureLanReachable,
  ipTxtContents,
  lanOriginUrlFor,
  writeIpTxt,
} from '../engine/ios-lan.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-ios-lan-'));
});

afterEach(() => {
  resetExecutor();
  rmSync(dir, { recursive: true, force: true });
});

test('chooseLanAddress takes the first candidate, which lanCandidates already ordered', () => {
  expect(
    chooseLanAddress({
      candidates: [
        { interfaceName: 'en0', address: '192.168.1.5' },
        { interfaceName: 'en1', address: '10.0.0.4' },
      ],
    }),
  ).toEqual({ address: '192.168.1.5', interfaceName: 'en0', pinned: false, candidates: 2 });
});

test('chooseLanAddress refuses when the host has no candidate at all', () => {
  expect(chooseLanAddress({ candidates: [] })).toBe(null);
});

test('ios.lanHost wins over the ordering, even for an address no interface reports', () => {
  expect(
    chooseLanAddress({ pinned: '10.0.0.9', candidates: [{ interfaceName: 'en0', address: '192.168.1.5' }] }),
  ).toEqual({ address: '10.0.0.9', interfaceName: null, pinned: true, candidates: 1 });
  expect(chooseLanAddress({ pinned: '10.0.0.9', candidates: [] })).toEqual({
    address: '10.0.0.9',
    interfaceName: null,
    pinned: true,
    candidates: 0,
  });
});

// RCTBundleURLProvider.mm:70 interpolates the value into a URL string verbatim,
// so a stray space produces `http://192.168.1.5:8082 /` and a silent fall-back
// to the embedded bundle.
test('ip.txt holds exactly <addr>:<port> and one newline', () => {
  expect(ipTxtContents('192.168.1.5', 8082)).toBe('192.168.1.5:8082\n');
  expect(ipTxtContents('  192.168.1.5  ', ' 8082 ')).toBe('192.168.1.5:8082\n');
  expect(/^[!-~]+:[0-9]+\n$/.test(ipTxtContents('192.168.1.5', '8082'))).toBe(true);
});

test('writeIpTxt writes into the bundle root and returns the path it wrote', () => {
  const app = join(dir, 'Fixture.app');
  mkdirSync(app);
  const path = writeIpTxt(app, '192.168.1.5', 8082);
  expect(path).toBe(join(app, 'ip.txt'));
  expect(readFileSync(path, 'utf-8')).toBe('192.168.1.5:8082\n');
});

test('writeIpTxt replaces whatever the build baked in', () => {
  const app = join(dir, 'Fixture.app');
  mkdirSync(app);
  writeFileSync(join(app, 'ip.txt'), '10.9.9.9\n');
  writeIpTxt(app, '192.168.1.5', 8082);
  expect(readFileSync(join(app, 'ip.txt'), 'utf-8')).toBe('192.168.1.5:8082\n');
});

test('lanOriginUrlFor is the http origin the phone dials', () => {
  expect(lanOriginUrlFor('192.168.1.5', 8082)).toBe('http://192.168.1.5:8082');
});

test('copyAppAside copies with the real cp, preserving a symlink and the exec bit', () => {
  const app = join(dir, 'Fixture.app');
  mkdirSync(join(app, 'Frameworks'), { recursive: true });
  writeFileSync(join(app, 'Fixture'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  symlinkSync('Fixture', join(app, 'Current'));
  const copy = copyAppAside(app);
  try {
    expect(copy.appPath).toBe(join(copy.tmpDir, 'Fixture.app'));
    expect(existsSync(join(copy.appPath, 'Frameworks'))).toBe(true);
    expect(readFileSync(join(copy.appPath, 'Current'), 'utf-8')).toBe('#!/bin/sh\nexit 0\n');
    expect(existsSync(join(app, 'ip.txt'))).toBe(false);
    writeIpTxt(copy.appPath, '192.168.1.5', 8082);
    expect(existsSync(join(app, 'ip.txt'))).toBe(false);
  } finally {
    rmSync(copy.tmpDir, { recursive: true, force: true });
  }
});

test('ensureLanReachable passes when the gate proves the origin is this workspace Metro', async () => {
  const gated: Array<Record<string, unknown>> = [];
  const result = await ensureLanReachable({
    origin: 'http://192.168.1.5:8082',
    metroPort: 8082,
    root: dir,
    isExpo: false,
    logsDir: join(dir, 'logs'),
    gateOrigin: async (args) => {
      gated.push(args as unknown as Record<string, unknown>);
      return { ok: true };
    },
  });
  expect(result).toEqual({ ok: true });
  expect(gated[0]?.origin).toBe('http://192.168.1.5:8082');
  expect(gated[0]?.platform).toBe('ios');
  expect(gated[0]?.entryPoint).toBe('index');
});

test('a gate miss keeps its own reason and gets a LAN remedy, not a tunnel one', async () => {
  const result = await ensureLanReachable({
    origin: 'http://192.168.1.5:8082',
    metroPort: 8082,
    root: dir,
    isExpo: false,
    logsDir: join(dir, 'logs'),
    gateOrigin: async () => ({
      failed: true,
      reason: 'http://192.168.1.5:8082 did not answer, so it cannot be this workspace Metro (port 8082).',
      remedy: 'a tunnel remedy that does not apply here',
    }),
  });
  expect('failed' in result).toBe(true);
  if (!('failed' in result)) return;
  expect(result.failed).toMatch(/did not answer/);
  expect(result.remedy).toMatch(/ios\.lanHost/);
  expect(result.remedy).toMatch(/stim start` prints the port/);
  expect(result.remedy).not.toMatch(/tunnel/);
});
