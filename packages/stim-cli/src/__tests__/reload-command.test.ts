import { Command } from 'commander';
import type { ProjectRecord } from '../config.ts';
import { registerReload, runReload, type ReloadDeps } from '../commands/reload.ts';
import type { WorkspaceLaunchRecord } from '../supervisor/state.ts';

const iosLaunch: WorkspaceLaunchRecord = {
  appId: 'com.example.ios',
  deviceId: 'U1',
  metroPort: 8082,
  release: false,
  deepLinkUrl: null,
  launchedAt: '2026-09-04T12:00:00.000Z',
};

const androidLaunch: WorkspaceLaunchRecord = {
  appId: 'com.example.android',
  deviceId: 'emulator-5554',
  metroPort: 8082,
  release: false,
  deepLinkUrl: null,
  launchedAt: '2026-09-04T12:00:00.000Z',
};

const project: ProjectRecord = {
  metroPort: 8082,
  platforms: {
    ios: { deviceUdid: 'U1', deviceName: 'stim-ios', owned: true },
    android: { avdName: 'stim-android', serial: 'emulator-5554', owned: true },
  },
};

function reloadDeps(overrides: Partial<ReloadDeps> = {}): Partial<ReloadDeps> {
  return {
    findProjectRoot: () => '/project',
    getProject: () => project,
    readLaunches: () => ({ android: androidLaunch }),
    resolveIos: () => ({ sim: { udid: 'U1', name: 'stim-ios', state: 'Booted' } }) as never,
    resolveAndroid: () => ({ serial: 'emulator-5554' }),
    iosProcess: () => 42,
    androidProcess: () => 43,
    resolveMetro: async () => ({ metro: { pid: 1, leader: 1, cwd: '/project' } }),
    openAndroidUrl: () => ({ ok: true }),
    openIosUrl: () => ({ ok: true }),
    reloadAndroid: () => ({ ok: true }),
    reloadIosMetro: async () => ({ ok: true, peers: 1 }),
    reloadIosFallback: () => ({ ok: true }),
    ...overrides,
  };
}

afterEach(() => {
  process.exitCode = undefined;
});

test('reload auto-selects the sole live owned app and reports its strategy', async () => {
  const result = await runReload({ root: '/project', deps: reloadDeps() });

  expect(result).toEqual({
    ok: true,
    facts: {
      platform: 'android',
      deviceId: 'emulator-5554',
      deviceName: 'stim-android',
      appId: 'com.example.android',
      metroPort: 8082,
      strategy: 'android-broadcast',
    },
  });
});

test('reload requires a platform when both owned apps are live', async () => {
  const result = await runReload({
    root: '/project',
    deps: reloadDeps({ readLaunches: () => ({ ios: iosLaunch, android: androidLaunch }) }),
  });

  expect(result).toEqual({
    ok: false,
    error: {
      code: 'STIM_RELOAD_AMBIGUOUS',
      message: 'Both the iOS and Android apps are running.',
      remedy: 'Choose one with `stim reload ios` or `stim reload android`.',
    },
  });
});

test('reload ignores a stopped platform while auto-selecting the live one', async () => {
  const result = await runReload({
    root: '/project',
    deps: reloadDeps({
      readLaunches: () => ({ ios: iosLaunch, android: androidLaunch }),
      iosProcess: () => null,
    }),
  });

  expect(result.ok && result.facts.platform).toBe('android');
});

test('reload refuses release launches before issuing a reload action', async () => {
  let called = false;
  const result = await runReload({
    root: '/project',
    platform: 'android',
    deps: reloadDeps({
      readLaunches: () => ({ android: { ...androidLaunch, release: true, metroPort: null } }),
      reloadAndroid: () => {
        called = true;
        return { ok: true };
      },
    }),
  });

  expect(result).toMatchObject({ ok: false, error: { code: 'STIM_RELOAD_RELEASE' } });
  expect(called).toBe(false);
});

test('reload refuses a launch record that no longer belongs to the configured owned device', async () => {
  const result = await runReload({
    root: '/project',
    platform: 'android',
    deps: reloadDeps({ getProject: () => ({ ...project, platforms: { android: { owned: false } } }) }),
  });

  expect(result).toMatchObject({ ok: false, error: { code: 'STIM_RELOAD_UNOWNED' } });
});

test('Expo reload resends the recorded deep link to the same device', async () => {
  const opened: { serial: string; url: string }[] = [];
  const deepLinkUrl = 'example://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8082';
  const result = await runReload({
    root: '/project',
    platform: 'android',
    deps: reloadDeps({
      readLaunches: () => ({ android: { ...androidLaunch, deepLinkUrl } }),
      openAndroidUrl: ({ serial, url }) => {
        opened.push({ serial, url });
        return { ok: true };
      },
    }),
  });

  expect(result.ok && result.facts.strategy).toBe('deep-link');
  expect(opened).toEqual([{ serial: 'emulator-5554', url: deepLinkUrl }]);
});

test('bare iOS falls back to the exact simulator startup overlay when Metro has no peer', async () => {
  const fallback: string[] = [];
  const result = await runReload({
    root: '/project',
    platform: 'ios',
    deps: reloadDeps({
      readLaunches: () => ({ ios: iosLaunch }),
      reloadIosMetro: async () => ({ failed: true, peers: 0, reason: 'No app connected.' }),
      reloadIosFallback: (udid) => {
        fallback.push(udid);
        return { ok: true };
      },
    }),
  });

  expect(result.ok && result.facts.strategy).toBe('agent-device');
  expect(fallback).toEqual(['U1']);
});

test('bare iOS prints exact recovery commands when the startup overlay cannot be driven', async () => {
  const result = await runReload({
    root: '/project',
    platform: 'ios',
    deps: reloadDeps({
      readLaunches: () => ({ ios: iosLaunch }),
      reloadIosMetro: async () => ({ failed: true, peers: 0, reason: 'No app connected.' }),
      reloadIosFallback: () => ({ failed: true, reason: 'agent-device is unavailable.' }),
    }),
  });

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: 'STIM_RELOAD_FAILED',
      remedy: expect.stringContaining('agent-device open com.example.ios --foreground --platform ios --udid U1'),
    },
  });
  expect(result).toMatchObject({
    error: { remedy: expect.stringContaining(`agent-device press 'label="Reload"' --platform ios --udid U1`) },
  });
});

test('reload --json prints exactly one parseable facts line', async () => {
  const program = new Command();
  registerReload(program, reloadDeps());
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await program.parseAsync(['node', 'stim', 'reload', 'android', '--json']);
  } finally {
    console.log = originalLog;
  }

  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({
    platform: 'android',
    deviceId: 'emulator-5554',
    metroPort: 8082,
    strategy: 'android-broadcast',
  });
});
