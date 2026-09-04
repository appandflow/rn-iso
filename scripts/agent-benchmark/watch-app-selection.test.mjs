import { describe, expect, it } from 'vitest';
import {
  androidApplicationLabelFromBadging,
  androidDevicesFromAdb,
  iosDevicesFromSimctl,
  matchesExpectedAndroidEmulator,
  matchesExpectedIosSimulator,
  selectAndroidCandidate,
  selectIosCandidate,
} from './watch-app-selection.mjs';

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

describe('benchmark Android emulator selection', () => {
  const expectedAndroid = {
    name: 'Trailhead_run-1',
    deviceTypeIdentifier: 'pixel_6',
    runtimeIdentifier: 'Android-36',
    systemImage: 'system-images;android-36;google_apis_playstore_ps16k;arm64-v8a',
  };
  const androidDevice = {
    ...expectedAndroid,
    udid: 'emulator-5554',
    isAvailable: true,
  };

  it('parses only online emulator transports', () => {
    expect(
      androidDevicesFromAdb(
        'List of devices attached\nemulator-5554 device product:sdk\nemulator-5556 offline\nphone device\n',
        () => expectedAndroid,
      ),
    ).toEqual([androidDevice]);
  });

  it('parses the installed application label from aapt badging output', () => {
    expect(
      androidApplicationLabelFromBadging(
        "package: name='com.appandflow.trailhead'\napplication-label:'Trailhead run-1'\n",
      ),
    ).toBe('Trailhead run-1');
    expect(androidApplicationLabelFromBadging("package: name='com.appandflow.trailhead'\n")).toBeNull();
  });

  it('accepts only the exact new Android emulator', () => {
    expect(matchesExpectedAndroidEmulator(androidDevice, expectedAndroid)).toBe(true);
    expect(
      selectAndroidCandidate([androidDevice], {
        arm: 'control',
        baseline: new Set(),
        expectedControl: expectedAndroid,
        expectedStim: { ...expectedAndroid, name: undefined, namePrefix: 'stim-' },
      }),
    ).toEqual({ candidate: androidDevice });
    expect(
      selectAndroidCandidate([{ ...androidDevice, runtimeIdentifier: 'Android-35' }], {
        arm: 'control',
        baseline: new Set(),
        expectedControl: expectedAndroid,
        expectedStim: { ...expectedAndroid, name: undefined, namePrefix: 'stim-' },
      }),
    ).toMatchObject({ error: 'control-emulator-mismatch' });
    expect(
      selectAndroidCandidate([{ ...androidDevice, systemImage: 'system-images;android-35;google_apis;arm64-v8a' }], {
        arm: 'control',
        baseline: new Set(),
        expectedControl: expectedAndroid,
        expectedStim: { ...expectedAndroid, name: undefined, namePrefix: 'stim-' },
      }),
    ).toMatchObject({ error: 'control-emulator-mismatch' });
  });

  it('rejects baseline and ambiguous Android emulators', () => {
    expect(
      selectAndroidCandidate([androidDevice], {
        arm: 'control',
        baseline: new Set(['emulator-5554']),
        expectedControl: expectedAndroid,
        expectedStim: expectedAndroid,
      }),
    ).toEqual({ candidate: null });
    expect(
      selectAndroidCandidate([androidDevice, { ...androidDevice, udid: 'emulator-5556' }], {
        arm: 'stim',
        baseline: new Set(),
        expectedControl: expectedAndroid,
        expectedStim: expectedAndroid,
      }),
    ).toMatchObject({ error: 'multiple-candidate-emulators' });
  });
});
