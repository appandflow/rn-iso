import { describe, expect, it } from 'vitest';
import { iosDevicesFromSimctl, matchesExpectedIosSimulator, selectIosCandidate } from './watch-app-selection.mjs';

const expected = {
  name: 'Trailhead run-1',
  deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
  runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
};

const device = {
  ...expected,
  udid: 'RUN-UDID',
  isAvailable: true,
};

describe('benchmark iOS simulator selection', () => {
  it('preserves each device runtime from simctl JSON', () => {
    expect(
      iosDevicesFromSimctl({
        devices: { [expected.runtimeIdentifier]: [{ ...device, runtimeIdentifier: undefined }] },
      }),
    ).toEqual([device]);
  });

  it('accepts only the exact control name, device type, and runtime', () => {
    expect(matchesExpectedIosSimulator(device, expected)).toBe(true);
    for (const mismatch of [
      { ...device, name: 'Trailhead other' },
      { ...device, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16' },
      { ...device, runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4' },
    ]) {
      expect(
        selectIosCandidate([mismatch], {
          arm: 'control',
          baseline: new Set(),
          parkedUdid: 'PARKED',
          expectedControl: expected,
        }),
      ).toMatchObject({ error: 'control-simulator-mismatch' });
    }
  });

  it('selects the exact new control simulator and the prepared Stim simulator', () => {
    expect(
      selectIosCandidate([device], {
        arm: 'control',
        baseline: new Set(),
        parkedUdid: 'PARKED',
        expectedControl: expected,
      }),
    ).toEqual({ candidate: device });
    expect(
      selectIosCandidate([{ ...device, udid: 'PARKED' }], {
        arm: 'stim',
        baseline: new Set(),
        parkedUdid: 'PARKED',
        expectedControl: expected,
      }),
    ).toEqual({ candidate: { ...device, udid: 'PARKED' } });
  });
});
