// Test factories for rn-iso.
//
// The underscore prefix keeps this file out of vitest's `*.test.ts` glob, so it
// is a plain module the suites import, never a suite itself.
//
// Every builder returns a FULL, VALID instance of the named domain type merged
// with the caller's `overrides`, so a test can pass a real object to a strict
// production function without a per-site cast and override only the one field
// the test is about. The producer/owner of each shape is named on its builder.
//
// The few unavoidable casts (Node's ChildProcess and Require are enormous
// built-in interfaces a stub cannot fully implement) are CENTRALIZED here,
// inside the helper, rather than smeared across call sites.

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import type { RnIsoConfig } from '../types.ts';
import type { CacheDescriptor } from '../caches.ts';
import type { EnvironmentState } from '../status.ts';
import type { IosSimRecord } from '../sim/ios.ts';
import type { AdbDevices } from '../sim/android.ts';
import type { Executor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import type { MetroResolution } from '../metro.ts';
import type { BuildLockInfo } from '../engine/build-lock.ts';
import type { BuildSlotInfo } from '../engine/build-slots.ts';

// --- DATA builders (no cast) -----------------------------------------------

// RnIsoConfig -- the whole ~/.rn-iso/config.json. Producer: src/config.ts.
// `projects` and `repos` are the two required maps; version tracks the current
// on-disk schema. Overriding `projects` replaces the map wholesale, which is
// what device-sweep tests want.
export function makeConfig(overrides: Partial<RnIsoConfig> = {}): RnIsoConfig {
  return { version: 2, projects: {}, repos: {}, ...overrides };
}

// CacheDescriptor -- the shared shape every cache in src/caches.ts carries.
// Producers: discoverCaches / sizeCaches / registeredCaches. `name`, `dir`,
// `prune` and `note` are all required; the rest are filled in later.
export function makeCacheDescriptor(overrides: Partial<CacheDescriptor> = {}): CacheDescriptor {
  return {
    name: 'test cache',
    dir: '/tmp/rn-iso-test-cache',
    prune: 'entries',
    note: 'a test cache',
    ...overrides,
  };
}

// EnvironmentState -- the per-project report `status` builds. Producer:
// environmentState in src/status.ts.
export function makeEnvironmentState(overrides: Partial<EnvironmentState> = {}): EnvironmentState {
  return { path: '/w/project', live: true, memoryMb: 0, warnings: [], ...overrides };
}

// IosSimRecord -- a live simulator as parseSimctlList shapes it. Producer:
// src/sim/ios.ts. gc's device sweeps take arrays of these.
export function makeIosSim(overrides: Partial<IosSimRecord> = {}): IosSimRecord {
  return {
    udid: 'BF2A1C3D-4E5F-6071-8293-A4B5C6D7E8F9',
    name: 'rn-iso-fixture',
    state: 'Booted',
    runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0',
    deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
    ...overrides,
  };
}

// AdbDevices -- the parsed `adb devices` buckets. Producer: parseAdbDevices in
// src/sim/android.ts.
export function makeAdbDevices(overrides: Partial<AdbDevices> = {}): AdbDevices {
  return { emulators: [], physical: [], unhealthy: [], ...overrides };
}

// BuildLockInfo -- a single-flight build lock gc reports on. Producer:
// src/engine/build-lock.ts.
export function makeBuildLock(overrides: Partial<BuildLockInfo> = {}): BuildLockInfo {
  return {
    path: '/h/build-locks/ios-abc.lock',
    name: 'ios-abc.lock',
    platform: 'ios',
    key: 'abc-debug-sim',
    pid: 4242,
    projectRoot: '/w/project',
    startedAt: '2026-01-01T00:00:00.000Z',
    logFile: '/w/.rn-iso/logs/build.log',
    alive: true,
    ...overrides,
  };
}

// BuildSlotInfo -- a concurrency-slot record gc reports on. Producer:
// src/engine/build-slots.ts.
export function makeBuildSlot(overrides: Partial<BuildSlotInfo> = {}): BuildSlotInfo {
  return {
    path: '/h/build-slots/slot-0',
    name: 'slot-0',
    index: 0,
    pid: 4242,
    projectRoot: '/w/project',
    startedAt: '2026-01-01T00:00:00.000Z',
    logFile: '/w/.rn-iso/logs/build.log',
    alive: true,
    ...overrides,
  };
}

// MetroResolution -- port-to-process identity for a Metro server. Producer:
// resolveProjectMetro in src/metro.ts. Exactly one field group is ever
// populated; these three variants build each of the outcomes readers branch on.
export const makeMetroResolution = {
  // Found and proven to be this workspace's dev server.
  identified(overrides: Partial<MetroResolution> = {}): MetroResolution {
    return { metro: { pid: 1, leader: 1, cwd: '/w/project' }, ...overrides };
  },
  // Nothing is listening on the port.
  missing(overrides: Partial<MetroResolution> = {}): MetroResolution {
    return { missing: true, ...overrides };
  },
  // Someone is listening, but it is not ours (unresponsive / foreign cwd / ...).
  notOurs(overrides: Partial<MetroResolution> = {}): MetroResolution {
    return {
      notOurs: "pid 42 on port 8082 does not answer Metro's /status",
      kind: 'unresponsive',
      pid: 42,
      ...overrides,
    };
  },
};

// --- MOCK builders (the one cast lives inside) -----------------------------

// NdjsonWriter -- a working in-memory writer. Producer of the real one:
// createNdjsonWriter in src/ndjson.ts. This is a full, honest implementation
// (records are kept in a closure), so NO cast is needed; a test that wants to
// spy passes its own `write`.
export function makeWriter(overrides: Partial<NdjsonWriter> = {}): NdjsonWriter {
  const records: unknown[] = [];
  const state = { written: 0, dropped: 0, lastError: null as Error | null };
  const file = '/tmp/rn-iso-test.ndjson';
  const writer: NdjsonWriter = {
    file,
    write(record: unknown): boolean {
      records.push(record);
      state.written += 1;
      return true;
    },
    close() {
      return { file, written: state.written, dropped: state.dropped, lastError: state.lastError };
    },
    get written() {
      return state.written;
    },
    get dropped() {
      return state.dropped;
    },
    get lastError() {
      return state.lastError;
    },
    ...overrides,
  };
  return writer;
}

// Executor -- the single child_process seam. Producer: src/exec.ts. All four
// methods are present, so no cast: `spawn` returns a ChildProcess stub (whose
// own cast is centralized in makeChildProcess). Tests inject via setExecutor()
// or pass this straight to a dep expecting an Executor.
export function makeExecutor(overrides: Partial<Executor> = {}): Executor {
  const base: Executor = {
    run: () => '',
    runFile: () => '',
    runQuiet: () => null,
    spawn: () => makeChildProcess(),
  };
  return { ...base, ...overrides };
}

// ChildProcess -- an EventEmitter-based stub. ChildProcess is a very large Node
// interface a test stub cannot fully implement, so the ONE honest
// `as unknown as ChildProcess` cast is centralized here.
export function makeChildProcess(overrides: Partial<ChildProcess> = {}): ChildProcess {
  const emitter = new EventEmitter();
  const stub = Object.assign(emitter, {
    pid: 4242,
    stdin: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    connected: false,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: () => true,
    ref() {
      return stub;
    },
    unref() {
      return stub;
    },
    send: () => true,
    disconnect: () => {},
  });
  return Object.assign(stub, overrides) as unknown as ChildProcess;
}

// --- shared casts a stub genuinely cannot avoid -----------------------------

// Node's Require is a large built-in interface a require-stub cannot fully
// implement; the single unavoidable cast is centralized here.
export function asRequire(fn: (id: string) => unknown): NodeJS.Require {
  return fn as unknown as NodeJS.Require;
}

// process.exit is typed `(code?) => never`; a test that only records the code
// cannot return `never`. The single cast for that global stub lives here.
export function asProcessExit(fn: (code?: string | number | null) => void): typeof process.exit {
  return fn as unknown as typeof process.exit;
}

// A plain Error carrying the extra own-properties (`code`, `lockPath`, ...) that
// Node's errno errors and rn-iso's coded errors attach. Returns `Error & T` so
// reads of those properties typecheck without a per-site cast.
export function makeError<T extends Record<string, unknown>>(message: string, props: T = {} as T): Error & T {
  return Object.assign(new Error(message), props);
}
