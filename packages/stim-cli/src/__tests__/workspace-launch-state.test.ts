import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearSupervisorState } from '../commands/stop.ts';
import {
  readWorkspaceLaunches,
  readWorkspaceState,
  writeWorkspaceLaunch,
  writeWorkspaceState,
  type WorkspaceLaunchRecord,
} from '../supervisor/state.ts';

let stimHome: string;
let root: string;

beforeEach(() => {
  stimHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  root = mkdtempSync(join(tmpdir(), 'stim-project-'));
  process.env.STIM_HOME = stimHome;
});

afterEach(() => {
  rmSync(stimHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function launch(appId: string, deviceId: string): WorkspaceLaunchRecord {
  return {
    appId,
    deviceId,
    metroPort: 8082,
    release: false,
    deepLinkUrl: null,
    launchedAt: '2026-09-04T12:00:00.000Z',
  };
}

test('workspace launch writes preserve the other platform under the state lock', () => {
  writeWorkspaceState(root, { supervisor: { pid: 42 } });
  writeWorkspaceLaunch(root, 'ios', launch('com.example.ios', 'U1'));
  writeWorkspaceLaunch(root, 'android', launch('com.example.android', 'emulator-5554'));

  expect(readWorkspaceLaunches(root)).toEqual({
    ios: launch('com.example.ios', 'U1'),
    android: launch('com.example.android', 'emulator-5554'),
  });
  expect(readWorkspaceState(root)?.supervisor).toEqual({ pid: 42 });
});

test('invalid launch entries are ignored instead of becoming reload targets', () => {
  writeWorkspaceState(root, {
    launches: {
      ios: { appId: 'com.example.ios' } as never,
      android: launch('com.example.android', 'emulator-5554'),
    },
  });

  expect(readWorkspaceLaunches(root)).toEqual({ android: launch('com.example.android', 'emulator-5554') });
});

test('stop clears launch eligibility with the supervisor record', () => {
  writeWorkspaceState(root, { supervisor: { pid: 42 } });
  writeWorkspaceLaunch(root, 'ios', launch('com.example.ios', 'U1'));

  clearSupervisorState(root);

  expect(readWorkspaceLaunches(root)).toEqual({});
  expect(readWorkspaceState(root)).toBeNull();
});
