import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import type { StimCliConfig } from '../types.ts';
import type { CacheDescriptor } from '../caches.ts';
import type { EnvironmentState } from '../status.ts';
import type { IosSimRecord } from '../sim/ios.ts';
import type { AdbDevices } from '../sim/android.ts';
import type { Executor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import type { MetroResolution } from '../metro.ts';
import type { BuildLockInfo } from '../engine/build-lock.ts';
import type { BuildSlotInfo } from '../engine/build-slots.ts';

export function makeConfig(overrides: Partial<StimCliConfig> = {}): StimCliConfig {
  return { version: 2, projects: {}, repos: {}, ...overrides };
}

export function makeCacheDescriptor(overrides: Partial<CacheDescriptor> = {}): CacheDescriptor {
  return {
    name: 'test cache',
    dir: '/tmp/stim-cli-test-cache',
    prune: 'entries',
    note: 'a test cache',
    ...overrides,
  };
}

export function makeEnvironmentState(overrides: Partial<EnvironmentState> = {}): EnvironmentState {
  return { path: '/w/project', live: true, memoryMb: 0, warnings: [], ...overrides };
}

export function makeIosSim(overrides: Partial<IosSimRecord> = {}): IosSimRecord {
  return {
    udid: 'BF2A1C3D-4E5F-6071-8293-A4B5C6D7E8F9',
    name: 'stim-cli-fixture',
    state: 'Booted',
    runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0',
    deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
    ...overrides,
  };
}

export function makeAdbDevices(overrides: Partial<AdbDevices> = {}): AdbDevices {
  return { emulators: [], physical: [], unhealthy: [], ...overrides };
}

export function makeBuildLock(overrides: Partial<BuildLockInfo> = {}): BuildLockInfo {
  return {
    path: '/h/build-locks/ios-abc.lock',
    name: 'ios-abc.lock',
    platform: 'ios',
    key: 'abc-debug-sim',
    pid: 4242,
    projectRoot: '/w/project',
    startedAt: '2026-01-01T00:00:00.000Z',
    logFile: '/w/.stim-cli/logs/build.log',
    alive: true,
    ...overrides,
  };
}

export function makeBuildSlot(overrides: Partial<BuildSlotInfo> = {}): BuildSlotInfo {
  return {
    path: '/h/build-slots/slot-0',
    name: 'slot-0',
    index: 0,
    pid: 4242,
    projectRoot: '/w/project',
    startedAt: '2026-01-01T00:00:00.000Z',
    logFile: '/w/.stim-cli/logs/build.log',
    alive: true,
    ...overrides,
  };
}

export const makeMetroResolution = {
  identified(overrides: Partial<MetroResolution> = {}): MetroResolution {
    return { metro: { pid: 1, leader: 1, cwd: '/w/project' }, ...overrides };
  },
  missing(overrides: Partial<MetroResolution> = {}): MetroResolution {
    return { missing: true, ...overrides };
  },
  notOurs(overrides: Partial<MetroResolution> = {}): MetroResolution {
    return {
      notOurs: "pid 42 on port 8082 does not answer Metro's /status",
      kind: 'unresponsive',
      pid: 42,
      ...overrides,
    };
  },
};

export function makeWriter(overrides: Partial<NdjsonWriter> = {}): NdjsonWriter {
  const records: unknown[] = [];
  const state = { written: 0, dropped: 0, lastError: null as Error | null };
  const file = '/tmp/stim-cli-test.ndjson';
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

export function makeExecutor(overrides: Partial<Executor> = {}): Executor {
  const base: Executor = {
    run: () => '',
    runFile: () => '',
    runQuiet: () => null,
    spawn: () => makeChildProcess(),
  };
  return { ...base, ...overrides };
}

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

export function asRequire(fn: (id: string) => unknown): NodeJS.Require {
  return fn as unknown as NodeJS.Require;
}

export function asProcessExit(fn: (code?: string | number | null) => void): typeof process.exit {
  return fn as unknown as typeof process.exit;
}

export function makeError<T extends Record<string, unknown>>(message: string, props: T = {} as T): Error & T {
  return Object.assign(new Error(message), props);
}
