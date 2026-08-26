// engine/device-remote.js -- the four dep overrides remote mode installs.
//
// These are asserted as exact argv against a mock executor, for the reason
// CLAUDE.md item 9 gives: a mocked exec proves the right arguments were
// composed, and that is the half a unit test can prove. The other half --
// that `eas sim` and `agent-device` accept them -- is the field test.
//
// The ORDERING property is the one worth guarding. Locally the Metro gate
// sits between ensureOwnedDevice (cheap) and ensureBooted (slow). Remote
// inverts which step is expensive, so the session must be created in
// ensureBooted, after the gate, and never in ensureOwnedDevice.
import { setExecutor, resetExecutor, type Executor } from '../exec.ts';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MAX_DURATION_MINUTES, remoteIosDeps, teardownRemote } from '../engine/device-remote.ts';
import { stopSessionArgs } from '../engine/eas-simulator.ts';

const CREATED = JSON.stringify({
  id: 'drs_42',
  name: 'rn-iso-wt',
  type: 'agent-device',
  deviceRunSessionUrl: 'https://expo.dev/x',
  remoteConfig: {
    __typename: 'AgentDeviceRunSessionRemoteConfig',
    agentDeviceRemoteSessionUrl: 'https://sim-42.eas.dev/daemon',
    agentDeviceRemoteSessionToken: 'tok_secret',
  },
});

interface Call {
  file: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

function mockExec({ fail = null, outputs = {} }: { fail?: string | null; outputs?: Record<string, string> } = {}) {
  const calls: Call[] = [];
  const exec: Executor & { calls: Call[] } = {
    calls,
    runFile(file: string, args: string[] = [], opts = {}) {
      const o = opts as { env?: Record<string, string>; cwd?: string };
      calls.push({ file, args, env: o.env, cwd: o.cwd });
      const key = [file, ...args].join(' ');
      if (fail && key.includes(fail)) throw new Error(`Command failed: ${key}`);
      for (const [match, value] of Object.entries(outputs)) {
        if (key.includes(match)) return value;
      }
      return '';
    },
    run() {
      throw new Error('device-remote must use runFile, not the shell');
    },
    runQuiet() {
      throw new Error('device-remote must use runFile, not the shell');
    },
    spawn() {
      throw new Error('device-remote does not spawn');
    },
  };
  setExecutor(exec);
  return exec;
}

let root: string;
function ctx(overrides: Partial<Parameters<typeof remoteIosDeps>[0]> = {}) {
  return { root, label: 'wt', easBin: '/bin/eas', agentDeviceBin: '/bin/agent-device', ...overrides };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rn-iso-remote-'));
});
afterEach(() => {
  resetExecutor();
  rmSync(root, { recursive: true, force: true });
});

describe('the expensive step happens after the Metro gate', () => {
  test('ensureOwnedDevice creates no session and runs no command', async () => {
    // The gate runs between ensureOwnedDevice and ensureBooted. Creating a
    // billable cloud session in the first would mean paying for it and only
    // then discovering the dev server is dead.
    const exec = mockExec();
    const deps = remoteIosDeps(ctx());
    const device = await deps.ensureOwnedDevice();
    expect(exec.calls).toEqual([]);
    expect(device.remote).toBe(true);
    expect(deps.createdSessionId()).toBeNull();
  });

  test('ensureBooted is what creates the session', async () => {
    const exec = mockExec({ outputs: { sim: CREATED } });
    const deps = remoteIosDeps(ctx());
    const booted = await deps.ensureBooted({});
    expect(booted.ok).toBe(true);
    expect(booted.udid).toBe('drs_42');
    expect(deps.createdSessionId()).toBe('drs_42');
    expect(exec.calls[0]?.args[0]).toBe('sim');
  });
});

describe('session creation', () => {
  test('runs in the project directory, because eas sim resolves it from cwd', async () => {
    const exec = mockExec({ outputs: { sim: CREATED } });
    await remoteIosDeps(ctx()).ensureBooted({});
    expect(exec.calls[0]?.cwd).toBe(root);
  });

  test('bounds the session, so a forgotten one stops billing', async () => {
    const exec = mockExec({ outputs: { sim: CREATED } });
    await remoteIosDeps(ctx()).ensureBooted({});
    const args = exec.calls[0]?.args ?? [];
    expect(args[args.indexOf('--max-duration-minutes') + 1]).toBe(String(DEFAULT_MAX_DURATION_MINUTES));
  });

  test('a session of a type rn-iso cannot drive is refused, not half-used', async () => {
    const appium = JSON.stringify({
      id: 'drs_9',
      remoteConfig: { __typename: 'AppiumRunSessionRemoteConfig', appiumUrl: 'https://x' },
    });
    // The get re-read returns the same unusable config.
    mockExec({ outputs: { sim: appium, 'simulator:get': appium } });
    const booted = await remoteIosDeps(ctx()).ensureBooted({});
    expect(booted.failed).toBe(true);
    expect(booted.reason).toContain('drs_9');
  });

  test('a failing eas sim is a reason, never a throw', async () => {
    mockExec({ fail: 'sim' });
    const booted = await remoteIosDeps(ctx()).ensureBooted({});
    expect(booted.failed).toBe(true);
    expect(booted.reason).toContain('eas sim failed');
  });

  test('an operator-supplied daemon creates no session at all', async () => {
    // The `agent-device proxy` case: rn-iso is a guest on someone else's
    // device, so it must not create a session and must not destroy one.
    const exec = mockExec();
    const deps = remoteIosDeps(ctx({ existingDaemon: { baseUrl: 'https://proxy.local/daemon', token: 'tok_proxy' } }));
    const booted = await deps.ensureBooted({});
    expect(booted.ok).toBe(true);
    expect(deps.createdSessionId()).toBeNull();
    expect(exec.calls.map((c) => c.args[0])).toEqual(['connect']);
  });
});

describe('the token never reaches disk', () => {
  test('the profile written next to it contains no credential', async () => {
    mockExec({ outputs: { sim: CREATED } });
    await remoteIosDeps(ctx()).ensureBooted({});
    const profilePath = join(root, '.rn-iso', 'agent-device.remote.json');
    expect(existsSync(profilePath)).toBe(true);
    const written = readFileSync(profilePath, 'utf-8');
    expect(written).not.toContain('tok_secret');
    expect(JSON.parse(written).daemonBaseUrl).toBe('https://sim-42.eas.dev/daemon');
  });

  test('it travels as an env var on every agent-device call instead', async () => {
    const exec = mockExec({ outputs: { sim: CREATED } });
    const deps = remoteIosDeps(ctx());
    await deps.ensureBooted({});
    deps.installIosApp({ udid: 'drs_42', appPath: '/tmp/My App.app' });
    deps.launchIosApp({ udid: 'drs_42', bundleId: 'com.example.app', metroPort: 8082 });
    const agentCalls = exec.calls.filter((c) => c.file === '/bin/agent-device');
    expect(agentCalls.length).toBe(3);
    for (const call of agentCalls) {
      expect(call.env?.AGENT_DEVICE_DAEMON_AUTH_TOKEN).toBe('tok_secret');
    }
  });

  test('the profile lives under .rn-iso/, never in the project itself', async () => {
    mockExec({ outputs: { sim: CREATED } });
    await remoteIosDeps(ctx()).ensureBooted({});
    expect(existsSync(join(root, 'agent-device.remote.json'))).toBe(false);
    expect(existsSync(join(root, '.env.eas-simulator'))).toBe(false);
  });
});

describe('install and launch match their local counterparts', () => {
  test('installIosApp passes the .app path as one literal argv element', async () => {
    const exec = mockExec({ outputs: { sim: CREATED } });
    const deps = remoteIosDeps(ctx());
    await deps.ensureBooted({});
    const result = deps.installIosApp({ udid: 'drs_42', appPath: '/tmp/My App.app' });
    expect(result).toEqual({ ok: true, appPath: '/tmp/My App.app' });
    const install = exec.calls.find((c) => c.args[0] === 'install');
    expect(install?.args[1]).toBe('/tmp/My App.app');
  });

  test('a dev-client launch sends rn-iso own deep link, not agent-device metro hint', async () => {
    // agent-device#1245: its hint writes bare-RN RCT_jsLocation, which a
    // dev-client ignores. open <app> <url> runs simctl openurl verbatim.
    const exec = mockExec({ outputs: { sim: CREATED } });
    const deps = remoteIosDeps(ctx());
    await deps.ensureBooted({});
    const result = deps.launchIosApp({
      udid: 'drs_42',
      bundleId: 'com.example.app',
      metroPort: 8082,
      devClientScheme: 'myapp',
    });
    expect(result.mode).toBe('openurl');
    const open = exec.calls.find((c) => c.args[0] === 'open');
    expect(open?.args[2]).toBe('myapp://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082');
  });

  test('a bare RN launch has no url positional', async () => {
    const exec = mockExec({ outputs: { sim: CREATED } });
    const deps = remoteIosDeps(ctx());
    await deps.ensureBooted({});
    expect(deps.launchIosApp({ udid: 'drs_42', bundleId: 'com.example.app', metroPort: 8082 }).mode).toBe('launch');
    const open = exec.calls.find((c) => c.args[0] === 'open');
    expect(open?.args[1]).toBe('com.example.app');
    expect(open?.args[2]).toBe('--relaunch');
  });

  test('install before a connection is a reason, not a crash', () => {
    mockExec();
    const result = remoteIosDeps(ctx()).installIosApp({ udid: 'x', appPath: '/tmp/a.app' });
    expect(result.failed).toBe(true);
    expect(result.reason).toContain('No remote session');
  });

  test('a failing install is a reason, never a throw', async () => {
    mockExec({ outputs: { sim: CREATED }, fail: 'install' });
    const deps = remoteIosDeps(ctx());
    await deps.ensureBooted({});
    const result = deps.installIosApp({ udid: 'drs_42', appPath: '/tmp/a.app' });
    expect(result.failed).toBe(true);
    expect(result.code).toBe('RN_ISO_INSTALL_FAILED');
  });
});

describe('the local device cap does not apply', () => {
  test('checkDeviceCapacity never refuses', () => {
    // maxDevices caps booted sims on THIS machine. Escaping that ceiling is
    // the reason to go remote, so enforcing it here refuses the request.
    expect(remoteIosDeps(ctx()).checkDeviceCapacity()).toBeNull();
  });
});

describe('teardown', () => {
  test('disconnects first, then stops the session', () => {
    const exec = mockExec();
    const result = teardownRemote(ctx(), { sessionId: 'drs_42', stopArgs: stopSessionArgs('drs_42') });
    expect(result.status).toBe('torn-down');
    expect(exec.calls.map((c) => c.args[0])).toEqual(['disconnect', 'simulator:stop']);
  });

  test('a failed disconnect does not prevent the stop, because the session is what bills', () => {
    const exec = mockExec({ fail: 'disconnect' });
    const result = teardownRemote(ctx(), { sessionId: 'drs_42', stopArgs: stopSessionArgs('drs_42') });
    expect(result.status).toBe('torn-down');
    expect(exec.calls.some((c) => c.args[0] === 'simulator:stop')).toBe(true);
  });

  test('a failed stop is reported, so the caller says leaked rather than torn down', () => {
    mockExec({ fail: 'simulator:stop' });
    const result = teardownRemote(ctx(), { sessionId: 'drs_42', stopArgs: stopSessionArgs('drs_42') });
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('drs_42');
  });

  test('an operator-owned daemon has no session to stop', () => {
    const exec = mockExec();
    const result = teardownRemote(ctx(), { sessionId: null, stopArgs: [] });
    expect(result.status).toBe('torn-down');
    expect(exec.calls.some((c) => c.args[0] === 'simulator:stop')).toBe(false);
  });
});
