import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectorProcessTitle, matchesCollectorProcess, verifyCollectorOwnership } from '../collector/ownership.ts';

const ROOT = '/w/project';
const alive = () => true;
const dead = () => false;

function titleArgs(platform: string, root: string): string[] {
  return collectorProcessTitle(platform, root).split(' ');
}

describe('matchesCollectorProcess', () => {
  test('the running collector title carries the platform and the root it was started for', () => {
    expect(collectorProcessTitle('ios', ROOT)).toBe('stim-collector-ios --root /w/project');
    expect(matchesCollectorProcess(titleArgs('ios', ROOT), { platform: 'ios', root: ROOT })).toBe(true);
    expect(matchesCollectorProcess(titleArgs('android', ROOT), { platform: 'android', root: ROOT })).toBe(true);
  });

  test('the spawned argv matches before the collector renames itself', () => {
    const argv = [
      '/usr/local/bin/node',
      '/opt/stim/dist/collector-run.mjs',
      '--platform',
      'ios',
      '--root',
      ROOT,
      '--udid',
      'U1',
      '--bundle',
      'com.example.app',
    ];
    expect(matchesCollectorProcess(argv, { platform: 'ios', root: ROOT })).toBe(true);
    expect(matchesCollectorProcess(argv, { platform: 'android', root: ROOT })).toBe(false);
  });

  test('a collector for another root is not this workspace collector', () => {
    expect(matchesCollectorProcess(titleArgs('ios', '/w/other'), { platform: 'ios', root: ROOT })).toBe(false);
    expect(matchesCollectorProcess(titleArgs('ios', '/w/project-2'), { platform: 'ios', root: ROOT })).toBe(false);
  });

  test('a collector for another platform is not this record', () => {
    expect(matchesCollectorProcess(titleArgs('android', ROOT), { platform: 'ios', root: ROOT })).toBe(false);
  });

  test('anything that is not a Stim collector is refused, including a lookalike', () => {
    expect(matchesCollectorProcess(['node', '/w/project/index.js'], { platform: 'ios', root: ROOT })).toBe(false);
    expect(matchesCollectorProcess(['vitest', '--root', ROOT], { platform: 'ios', root: ROOT })).toBe(false);
    expect(matchesCollectorProcess(['stim-supervisor', '--root', ROOT], { platform: 'ios', root: ROOT })).toBe(false);
    expect(matchesCollectorProcess(['stim-collector-ios'], { platform: 'ios', root: ROOT })).toBe(false);
    expect(matchesCollectorProcess([], { platform: 'ios', root: ROOT })).toBe(false);
    expect(matchesCollectorProcess(null, { platform: 'ios', root: ROOT })).toBe(false);
  });

  test('an unquoted root with a space still matches its own record', () => {
    const spaced = '/w/My Project';
    expect(matchesCollectorProcess(titleArgs('ios', spaced), { platform: 'ios', root: spaced })).toBe(true);
    expect(matchesCollectorProcess(titleArgs('ios', spaced), { platform: 'ios', root: '/w/My' })).toBe(false);
  });

  test('Linux procfs hands back the renamed title as one padded argument', () => {
    expect(matchesCollectorProcess([collectorProcessTitle('android', ROOT)], { platform: 'android', root: ROOT })).toBe(
      true,
    );
    expect(
      matchesCollectorProcess([collectorProcessTitle('android', '/w/other')], { platform: 'android', root: ROOT }),
    ).toBe(false);
  });

  test('a symlinked root resolves to the same collector', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stim-ownership-'));
    const target = join(dir, 'target');
    const link = join(dir, 'link');
    try {
      mkdirSync(target);
      symlinkSync(target, link);
      expect(matchesCollectorProcess(titleArgs('ios', target), { platform: 'ios', root: link })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('verifyCollectorOwnership', () => {
  test('a proven collector is ours', () => {
    expect(
      verifyCollectorOwnership({
        pid: 111,
        platform: 'ios',
        root: ROOT,
        isAlive: alive,
        readArgs: () => titleArgs('ios', ROOT),
      }),
    ).toEqual({ status: 'ours' });
  });

  test('a live pid running something else is unverified, not ours', () => {
    const result = verifyCollectorOwnership({
      pid: 111,
      platform: 'ios',
      root: ROOT,
      isAlive: alive,
      readArgs: () => ['/usr/bin/node', 'server.js'],
    });
    expect(result.status).toBe('unverified');
    expect(result).toMatchObject({
      reason: expect.stringContaining("does not run this workspace's ios log collector"),
    });
  });

  test('a collector for a different root is unverified', () => {
    expect(
      verifyCollectorOwnership({
        pid: 111,
        platform: 'ios',
        root: ROOT,
        isAlive: alive,
        readArgs: () => titleArgs('ios', '/w/other'),
      }).status,
    ).toBe('unverified');
  });

  test('an unreadable command on a live pid is unverified, never proven', () => {
    expect(
      verifyCollectorOwnership({ pid: 111, platform: 'ios', root: ROOT, isAlive: alive, readArgs: () => null }).status,
    ).toBe('unverified');
    expect(
      verifyCollectorOwnership({
        pid: 111,
        platform: 'ios',
        root: ROOT,
        isAlive: alive,
        readArgs: () => {
          throw new Error('ps failed');
        },
      }).status,
    ).toBe('unverified');
  });

  test('a pid that died between the checks is gone, not a refusal to report', () => {
    expect(
      verifyCollectorOwnership({ pid: 111, platform: 'ios', root: ROOT, isAlive: dead, readArgs: () => null }),
    ).toEqual({ status: 'gone' });
    expect(
      verifyCollectorOwnership({
        pid: 111,
        platform: 'ios',
        root: ROOT,
        isAlive: dead,
        readArgs: () => ['/usr/bin/node', 'server.js'],
      }),
    ).toEqual({ status: 'gone' });
  });
});
