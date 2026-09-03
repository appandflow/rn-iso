import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProject, loadConfig, upsertProject } from '../config.ts';
import {
  DEFAULT_PARKED_MAX,
  adoptParked,
  evictOverflow,
  parkSim,
  parkedMaxSetting,
  readParked,
  selectParked,
  type ParkedSim,
} from '../sim-pool.ts';

const first: ParkedSim = {
  udid: 'FIRST',
  name: 'stim-parked (iPhone 17 26.5) firs',
  deviceTypeIdentifier: 'iphone-17',
  runtimeIdentifier: 'ios-26-5',
  parkedAt: '2026-09-01T10:00:00.000Z',
  simslimManaged: false,
};

const second: ParkedSim = {
  ...first,
  udid: 'SECOND',
  name: 'stim-parked (iPhone 17 26.5) seco',
  parkedAt: '2026-09-01T11:00:00.000Z',
};

let stimHome: string;

beforeEach(() => {
  stimHome = mkdtempSync(join(tmpdir(), 'stim-pool-test-'));
  process.env.STIM_HOME = stimHome;
});

afterEach(() => {
  rmSync(stimHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('the machine pool defaults to three but redirected homes default to off', () => {
  expect(parkedMaxSetting('ios', { config: null, env: {} })).toEqual({ max: DEFAULT_PARKED_MAX, error: null });
  expect(parkedMaxSetting('ios', { config: null, env: { STIM_HOME: '/tmp/scoped' } })).toEqual({
    max: 0,
    error: null,
  });
});

test('only the environment opts a redirected home into pooling', () => {
  const config = { version: 2, projects: {}, repos: {}, pool: { iosParkedMax: 2 } };
  expect(parkedMaxSetting('ios', { config, env: { STIM_HOME: '/tmp/scoped' } }).max).toBe(0);
  expect(
    parkedMaxSetting('ios', {
      config,
      env: { STIM_HOME: '/tmp/scoped', STIM_POOL_IOS_PARKED_MAX: '4' },
    }),
  ).toEqual({ max: 4, error: null });
});

test('invalid pool bounds fail closed', () => {
  expect(
    parkedMaxSetting('ios', {
      config: { version: 2, projects: {}, repos: {} },
      env: { STIM_POOL_IOS_PARKED_MAX: '-1' },
    }),
  ).toMatchObject({ max: 0, error: expect.stringContaining('Expected a whole number') });
  expect(
    parkedMaxSetting('ios', {
      config: { version: 2, projects: {}, repos: {}, pool: { iosParkedMax: '3' } },
      env: {},
    }),
  ).toMatchObject({ max: 0, error: expect.stringContaining('pool.iosParkedMax') });
});

test('selection is exact by model and runtime and oldest first', () => {
  const wrongModel = { ...first, udid: 'OTHER-MODEL', deviceTypeIdentifier: 'ipad-pro' };
  const wrongRuntime = { ...first, udid: 'OTHER-RUNTIME', runtimeIdentifier: 'ios-18-5' };
  expect(
    selectParked([second, wrongModel, first, wrongRuntime], {
      deviceTypeIdentifier: 'iphone-17',
      runtimeIdentifier: 'ios-26-5',
    }).map((record) => record.udid),
  ).toEqual(['FIRST', 'SECOND']);
});

test('overflow eviction removes the oldest records regardless of insertion order', () => {
  const third = { ...second, udid: 'THIRD', parkedAt: '2026-09-01T12:00:00.000Z' };
  const result = evictOverflow([third, first, second], 1);
  expect(result.keep.map((record) => record.udid)).toEqual(['THIRD']);
  expect(result.evicted.map((record) => record.udid)).toEqual(['FIRST', 'SECOND']);
});

test('parking moves a device claim into the pool in one persisted update', () => {
  upsertProject('/tmp/project', {
    platforms: { ios: { deviceUdid: first.udid, deviceName: 'stim-project', owned: true } },
  });
  expect(parkSim({ platform: 'ios', projectPath: '/tmp/project', record: first, max: 3 })).toEqual([]);
  expect(getProject('/tmp/project')?.platforms?.ios).toBeUndefined();
  expect(readParked('ios').map((record) => record.udid)).toEqual(['FIRST']);
});

test('adoption takes a pool record and creates the owned project claim in one persisted update', () => {
  upsertProject('/tmp/project', { platforms: {} });
  parkSim({ platform: 'ios', projectPath: '/tmp/project', record: first, max: 3 });
  const device = {
    deviceUdid: first.udid,
    deviceName: 'stim-project (iPhone 17 26.5)',
    owned: true,
    adoptionPending: true,
  };
  expect(adoptParked({ platform: 'ios', projectPath: '/tmp/project', udid: first.udid, device })).toEqual(first);
  expect(readParked('ios')).toEqual([]);
  expect(loadConfig()?.projects['/tmp/project']?.platforms?.ios).toEqual(device);
});

test('malformed and non-Stim pool records are ignored', () => {
  const config = {
    version: 2,
    projects: {},
    repos: {},
    parked: { ios: [{ ...first, name: 'My iPhone' }, { nope: true }, first] },
  };
  expect(readParked('ios', { config }).map((record) => record.udid)).toEqual(['FIRST']);
});
