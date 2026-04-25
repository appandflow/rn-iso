import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { parseSimctlList, selectIosDevice, listAllIosSims, listBootedIosSims } from '../src/sim/ios.js';

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
  assert.deepEqual(result, { kind: 'reuse', udid: 'UDID-B', state: 'Shutdown' });
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

test('selectIosDevice returns needsBoot only when ALL sims are claimed', () => {
  setExecutor({ run: () => SIMCTL_OUTPUT, runQuiet: () => null, spawn: () => null });
  const result = selectIosDevice({
    existingUdid: null,
    claimedUdids: ['UDID-A', 'UDID-B', 'UDID-C'],
  });
  assert.equal(result.kind, 'needsBoot');
});

test('parseRuntimeVersion extracts major.minor from runtime id', async () => {
  const { parseRuntimeVersion } = await import('../src/sim/ios.js');
  assert.equal(parseRuntimeVersion('com.apple.CoreSimulator.SimRuntime.iOS-26-2'), '26.2');
  assert.equal(parseRuntimeVersion('com.apple.CoreSimulator.SimRuntime.iOS-18'), '18');
  assert.equal(parseRuntimeVersion('weird-id'), 'weird-id');
});
