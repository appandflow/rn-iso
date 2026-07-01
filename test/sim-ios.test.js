import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { parseSimctlList, selectIosDevice, listAllIosSims, listBootedIosSims, sortSims, deviceFamilyRank } from '../src/sim/ios.js';

let tmpHome;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
  resetExecutor();
});

const SIMCTL_OUTPUT = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-17-2': [
      { udid: 'UDID-A', name: 'iPhone 15', state: 'Booted', isAvailable: true },
      { udid: 'UDID-B', name: 'iPhone 15 Pro', state: 'Shutdown', isAvailable: true },
      { udid: 'UDID-C', name: 'iPhone 14', state: 'Booted', isAvailable: true },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-16-0': [
      { udid: 'UDID-OLD', name: 'iPhone 13', state: 'Shutdown', isAvailable: false },
    ],
  },
});

test('parseSimctlList flattens devices and filters unavailable', () => {
  const sims = parseSimctlList(SIMCTL_OUTPUT);
  assert.equal(sims.length, 3);
  assert.deepEqual(sims.map(s => s.udid).sort(), ['UDID-A', 'UDID-B', 'UDID-C']);
});

test('parseSimctlList includes runtime in each entry', () => {
  const sims = parseSimctlList(SIMCTL_OUTPUT);
  const a = sims.find(s => s.udid === 'UDID-A');
  assert.equal(a.runtime, 'com.apple.CoreSimulator.SimRuntime.iOS-17-2');
});

test('listAllIosSims uses simctl via executor', () => {
  setExecutor({
    run: (cmd) => {
      assert.match(cmd, /xcrun simctl list devices --json/);
      return SIMCTL_OUTPUT;
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  const sims = listAllIosSims();
  assert.equal(sims.length, 3);
});

test('listBootedIosSims filters by state', () => {
  setExecutor({
    run: () => SIMCTL_OUTPUT,
    runQuiet: () => null,
    spawn: () => null,
  });
  const booted = listBootedIosSims();
  assert.deepEqual(booted.map(s => s.udid).sort(), ['UDID-A', 'UDID-C']);
});

test('selectIosDevice prefers existing assignment when sim still exists', () => {
  setExecutor({ run: () => SIMCTL_OUTPUT, runQuiet: () => null, spawn: () => null });
  const result = selectIosDevice({
    existingUdid: 'UDID-B',
    claimedUdids: [],
  });
  assert.deepEqual(result, { kind: 'reuse', udid: 'UDID-B', name: 'iPhone 15 Pro', state: 'Shutdown' });
});

test('selectIosDevice ignores existing assignment when sim no longer exists', () => {
  setExecutor({ run: () => SIMCTL_OUTPUT, runQuiet: () => null, spawn: () => null });
  const result = selectIosDevice({
    existingUdid: 'GHOST-UDID',
    claimedUdids: [],
  });
  assert.equal(result.kind, 'allocate');
  assert.ok(Array.isArray(result.candidates));
});

test('selectIosDevice returns all unclaimed sims, booted first', () => {
  // SIMCTL_OUTPUT: UDID-A iPhone 15 booted, UDID-B iPhone 15 Pro shutdown, UDID-C iPhone 14 booted.
  setExecutor({ run: () => SIMCTL_OUTPUT, runQuiet: () => null, spawn: () => null });
  const result = selectIosDevice({
    existingUdid: null,
    claimedUdids: [],
  });
  assert.equal(result.kind, 'allocate');
  // Booted sims first (sorted by name within state), then shutdown sims.
  assert.deepEqual(result.candidates.map(s => s.udid), ['UDID-C', 'UDID-A', 'UDID-B']);
});

test('selectIosDevice excludes claimed sims from candidates', () => {
  setExecutor({ run: () => SIMCTL_OUTPUT, runQuiet: () => null, spawn: () => null });
  const result = selectIosDevice({
    existingUdid: null,
    claimedUdids: ['UDID-A', 'UDID-C'],
  });
  assert.equal(result.kind, 'allocate');
  assert.deepEqual(result.candidates.map(s => s.udid), ['UDID-B']);
});

test('selectIosDevice returns allClaimed when sims exist but every one is claimed', () => {
  setExecutor({ run: () => SIMCTL_OUTPUT, runQuiet: () => null, spawn: () => null });
  const result = selectIosDevice({
    existingUdid: null,
    claimedUdids: ['UDID-A', 'UDID-B', 'UDID-C'],
  });
  assert.equal(result.kind, 'allClaimed');
  // candidates contains every sim, sorted, so the picker can offer to steal any.
  assert.deepEqual(result.candidates.map(s => s.udid).sort(), ['UDID-A', 'UDID-B', 'UDID-C']);
});

test('selectIosDevice returns noSims when no iOS simulators exist at all', () => {
  const empty = JSON.stringify({ devices: {} });
  setExecutor({ run: () => empty, runQuiet: () => null, spawn: () => null });
  const result = selectIosDevice({ existingUdid: null, claimedUdids: [] });
  assert.equal(result.kind, 'noSims');
});

test('parseRuntimeVersion extracts major.minor from runtime id', async () => {
  const { parseRuntimeVersion } = await import('../src/sim/ios.js');
  assert.equal(parseRuntimeVersion('com.apple.CoreSimulator.SimRuntime.iOS-26-2'), '26.2');
  assert.equal(parseRuntimeVersion('com.apple.CoreSimulator.SimRuntime.iOS-18'), '18');
  assert.equal(parseRuntimeVersion('weird-id'), 'weird-id');
});

test('parseSimctlList drops non-iOS runtimes (watchOS, tvOS, visionOS)', () => {
  const out = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [
        { udid: 'IOS-1', name: 'iPhone 17', state: 'Booted', isAvailable: true },
      ],
      'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [
        { udid: 'WATCH-1', name: 'Apple Watch S10', state: 'Booted', isAvailable: true },
      ],
      'com.apple.CoreSimulator.SimRuntime.tvOS-18-0': [
        { udid: 'TV-1', name: 'Apple TV 4K', state: 'Booted', isAvailable: true },
      ],
      'com.apple.CoreSimulator.SimRuntime.xrOS-2-0': [
        { udid: 'VISION-1', name: 'Apple Vision Pro', state: 'Booted', isAvailable: true },
      ],
    },
  });
  const sims = parseSimctlList(out);
  assert.deepEqual(sims.map(s => s.udid), ['IOS-1']);
});

test('deviceFamilyRank ranks iPhone < iPad < other', () => {
  assert.equal(deviceFamilyRank('iPhone 17 Pro'), 0);
  assert.equal(deviceFamilyRank('iPad Pro 11-inch'), 1);
  assert.equal(deviceFamilyRank('Apple TV'), 2);
});

test('sortSims orders by family, then state, then usage, then name', () => {
  const sims = [
    { udid: 'A', name: 'iPad Pro', state: 'Booted', runtime: 'r' },
    { udid: 'B', name: 'iPhone 17 Pro', state: 'Shutdown', runtime: 'r' },
    { udid: 'C', name: 'iPhone 16 Pro', state: 'Booted', runtime: 'r' },
    { udid: 'D', name: 'iPhone 15 Pro', state: 'Booted', runtime: 'r' },
  ];
  // Without usage: iPhones first (booted before shutdown), then iPad.
  // C and D are both iPhone+booted with usage 0 -> alpha sort: D ("15 Pro") before C ("16 Pro").
  let sorted = sortSims(sims);
  assert.deepEqual(sorted.map(s => s.udid), ['D', 'C', 'B', 'A']);
  // With C used 5 times: C floats above D within iPhone+booted.
  sorted = sortSims(sims, { C: 5 });
  assert.deepEqual(sorted.map(s => s.udid), ['C', 'D', 'B', 'A']);
});

test('sortSims keeps a booted sim ahead of a shutdown newer-runtime one', () => {
  const rNew = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
  const rOld = 'com.apple.CoreSimulator.SimRuntime.iOS-17-5';
  const sims = [
    { udid: 'OLD-BOOTED', name: 'iPhone 15', state: 'Booted', runtime: rOld },
    { udid: 'NEW-SHUTDOWN', name: 'iPhone 17 Pro', state: 'Shutdown', runtime: rNew },
  ];
  // Booted state outranks runtime: reuse the running sim rather than boot another.
  const sorted = sortSims(sims);
  assert.deepEqual(sorted.map(s => s.udid), ['OLD-BOOTED', 'NEW-SHUTDOWN']);
});

test('sortSims prefers newest runtime among sims in the same state', () => {
  const rNew = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
  const rOld = 'com.apple.CoreSimulator.SimRuntime.iOS-17-5';
  const sims = [
    { udid: 'OLD', name: 'iPhone 15', state: 'Shutdown', runtime: rOld },
    { udid: 'NEW', name: 'iPhone 17 Pro', state: 'Shutdown', runtime: rNew },
  ];
  const sorted = sortSims(sims);
  assert.deepEqual(sorted.map(s => s.udid), ['NEW', 'OLD']);
});

test('sortSims uses numeric runtime compare (26.10 newer than 26.5)', () => {
  const sims = [
    { udid: 'V5', name: 'iPhone 17', state: 'Shutdown', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5' },
    { udid: 'V10', name: 'iPhone 17', state: 'Shutdown', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-10' },
  ];
  const sorted = sortSims(sims);
  assert.deepEqual(sorted.map(s => s.udid), ['V10', 'V5']);
});
