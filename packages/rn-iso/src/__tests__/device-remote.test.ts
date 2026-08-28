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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureMetroReachable,
  PUBLIC_METRO_ENV,
  remoteAndroidDeps,
  remoteIosDeps,
  resolveMetroOrigin,
  teardownRemote,
} from '../engine/device-remote.ts';
import { stopSessionArgs } from '../engine/eas-simulator.ts';

// The same-machine proxy: the simulator shares this host's loopback, so
// localhost in the deep link reaches rn-iso's own Metro. Live-verified.
// A same-machine `agent-device proxy`. The device sharing this host is now
// ASSERTED with tunnelMode 'off' rather than inferred from the loopback URL --
// `ssh -L` makes that inference false. See engine/metro-reach.ts.
const LOOPBACK = { baseUrl: 'http://127.0.0.1:4310', token: 'tok_proxy' };

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

function mockExec({
  fail = null,
  outputs = {},
}: { fail?: string | null; outputs?: Record<string, string>; existingDaemonMode?: boolean } = {}) {
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
  return {
    root,
    label: 'wt',
    easBin: '/bin/eas',
    agentDeviceBin: '/bin/agent-device',
    // The readiness poll is bounded at three minutes of real time; a test
    // asserting the give-up path must not pay it.
    sleep: async () => {},
    ...overrides,
  };
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

  test('sends no duration of its own, because the cap is per-account', async () => {
    // Live: a hardcoded 120 was rejected with "must not exceed 115 minutes
    // for this account", failing the command before a session existed. EAS
    // has its own default; teardown is what bounds the cost.
    const exec = mockExec({ outputs: { sim: CREATED } });
    await remoteIosDeps(ctx()).ensureBooted({});
    expect(exec.calls[0]?.args ?? []).not.toContain('--max-duration-minutes');
  });

  test('a caller-chosen duration is still sent', async () => {
    const exec = mockExec({ outputs: { sim: CREATED } });
    await remoteIosDeps(ctx({ maxDurationMinutes: 30 })).ensureBooted({});
    const args = exec.calls[0]?.args ?? [];
    expect(args[args.indexOf('--max-duration-minutes') + 1]).toBe('30');
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
    // close runs first, best-effort, to release any claim a previous run
    // left on the device. See closeArgs.
    expect(exec.calls.map((c) => c.args[0])).toEqual(['close', 'connect']);
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
    const deps = remoteIosDeps(ctx({ existingDaemon: LOOPBACK, tunnelMode: 'off' }));
    await deps.ensureBooted({});
    deps.installIosApp({ udid: 'drs_42', appPath: '/tmp/My App.app' });
    deps.launchIosApp({ udid: 'drs_42', bundleId: 'com.example.app', metroPort: 8082 });
    const agentCalls = exec.calls.filter((c) => c.file === '/bin/agent-device');
    expect(agentCalls.length).toBe(4);
    for (const call of agentCalls) {
      expect(call.env?.AGENT_DEVICE_DAEMON_AUTH_TOKEN).toBe('tok_proxy');
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
    const deps = remoteIosDeps(ctx({ existingDaemon: LOOPBACK, tunnelMode: 'off' }));
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
    const deps = remoteIosDeps(ctx({ existingDaemon: LOOPBACK, tunnelMode: 'off' }));
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

describe('Metro reachability', () => {
  // The hard part of a remote device, and the one agent-device does NOT solve
  // for a self-hosted proxy: verified against 0.20.10, `agent-device proxy`
  // serves no /api/metro route at all, so there is no bridge to lean on.
  //
  // Which address to use is now DECLARED (engine/metro-reach.ts), not inferred
  // from the daemon's URL -- `ssh -L` made that inference false. These cover
  // the wiring; the policy itself is pinned in metro-reach.test.ts.
  test('an asserted-local device uses localhost and needs no gate', () => {
    expect(resolveMetroOrigin({ metroPort: 8082, mode: 'off' })).toEqual({
      origin: 'http://localhost:8082',
      gate: false,
    });
  });

  test('a named public url is used, and IS gated', () => {
    expect(resolveMetroOrigin({ metroPort: 8082, publicUrl: 'https://abc.trycloudflare.com/' })).toEqual({
      origin: 'https://abc.trycloudflare.com',
      gate: true,
    });
  });

  test('no address and nothing to build one with is a refusal, never localhost', () => {
    // The bug this replaced: `localhost` sent to a device on another machine
    // resolves there, and the run reads as merely unverified.
    const r = resolveMetroOrigin({ metroPort: 8082, mode: 'auto', isExpo: false, available: [] });
    expect('failed' in r).toBe(true);
    if ('failed' in r) expect(r.remedy).toContain('"off"');
  });

  test('launching against an unreachable Metro refuses instead of opening the app', async () => {
    mockExec({ outputs: { sim: CREATED } });
    const deps = remoteIosDeps(ctx());
    await deps.ensureBooted({});
    const result = deps.launchIosApp({
      udid: 'drs_42',
      bundleId: 'com.example.app',
      metroPort: 8082,
      devClientScheme: 'myapp',
    });
    expect(result.failed).toBe(true);
    expect(result.code).toBe('RN_ISO_REMOTE_METRO_UNREACHABLE');
  });

  test('the named url is what the deep link carries', async () => {
    const exec = mockExec({ outputs: { sim: CREATED } });
    const deps = remoteIosDeps(ctx({ publicMetroUrl: 'https://abc.trycloudflare.com' }));
    await deps.ensureBooted({});
    deps.launchIosApp({ udid: 'drs_42', bundleId: 'com.example.app', metroPort: 8082, devClientScheme: 'myapp' });
    const open = exec.calls.find((c) => c.args[0] === 'open');
    expect(open?.args[2]).toBe('myapp://expo-development-client/?url=https%3A%2F%2Fabc.trycloudflare.com');
  });
});

// Reach planning, the tunnel and the gate run in ensureMetroReachable, which
// commands/ios.ts calls AFTER the reserved port is known and the local Metro
// gate has confirmed a dev server is on it -- and still before ensureBooted,
// which is what creates the billable session.
async function reach(over: Record<string, unknown> = {}) {
  const ctx = {
    root,
    label: 'wt',
    platform: 'ios' as const,
    easBin: '/bin/eas',
    agentDeviceBin: '/bin/agent-device',
    publicMetroUrl: null as string | null,
  };
  const result = await ensureMetroReachable({
    ctx,
    metroPort: 8085,
    isExpo: false,
    env: {},
    gateOrigin: async () => ({ ok: true as const }),
    ...over,
  } as unknown as Parameters<typeof ensureMetroReachable>[0]);
  return { result, ctx };
}

describe('the Metro refusal comes before anything billable', () => {
  test('no address and nothing to build one with is refused', async () => {
    const { result, ctx } = await reach({ available: [] });
    expect('failed' in result).toBe(true);
    expect(ctx.publicMetroUrl).toBeNull();
  });

  test('a loopback daemon is NOT taken as proof the device is local', async () => {
    // `ssh -L 4310:localhost:4310 macmini` is exactly this shape and the
    // device is on the other machine, so nothing may infer "local" from it.
    const { result } = await reach({ available: [] });
    expect('failed' in result).toBe(true);
  });

  test('asserting the device is local needs no tunnel and no gate', async () => {
    let gated = false;
    const { result, ctx } = await reach({
      tunnelMode: 'off',
      gateOrigin: async () => {
        gated = true;
        return { ok: true as const };
      },
    });
    expect('ok' in result).toBe(true);
    expect(ctx.publicMetroUrl).toBe('http://localhost:8085');
    expect(gated).toBe(false);
  });

  test('naming a public url is what unblocks it, and it IS gated', async () => {
    let gatedOrigin: string | null = null;
    const { result, ctx } = await reach({
      env: { [PUBLIC_METRO_ENV]: 'https://abc.ngrok.app' },
      gateOrigin: async ({ origin }: { origin: string }) => {
        gatedOrigin = origin;
        return { ok: true as const };
      },
    });
    expect('ok' in result).toBe(true);
    expect(ctx.publicMetroUrl).toBe('https://abc.ngrok.app');
    expect(gatedOrigin).toBe('https://abc.ngrok.app');
  });
});

describe('a tunnel rn-iso starts for itself', () => {
  test('reuses the tunnel recorded by start and gates it', async () => {
    let started = false;
    const { result, ctx } = await reach({
      available: ['cloudflared'],
      startManagedTunnel: async () => {
        started = true;
        return { url: 'https://t.trycloudflare.com', pid: 4242 };
      },
      readTunnelRecord: () => ({
        kind: 'managed',
        provider: 'cloudflared',
        pid: 4242,
        url: 'https://t.trycloudflare.com',
        port: 8085,
        startedAt: 'T',
      }),
      isTunnelAlive: () => true,
    });
    expect('ok' in result).toBe(true);
    expect(started).toBe(false);
    expect(ctx.publicMetroUrl).toBe('https://t.trycloudflare.com');
  });

  test('a gate failure refuses with the gate stable code, and sets no origin', async () => {
    const { result, ctx } = await reach({
      available: ['cloudflared'],
      readTunnelRecord: () => ({
        kind: 'managed',
        provider: 'cloudflared',
        pid: 1,
        url: 'https://t.trycloudflare.com',
        port: 8085,
        startedAt: 'T',
      }),
      isTunnelAlive: () => true,
      gateOrigin: async () => ({
        failed: true as const,
        code: 'RN_ISO_REMOTE_METRO_WRONG',
        reason: 'wrong',
        remedy: 'fix',
      }),
    });
    expect('failed' in result).toBe(true);
    if ('failed' in result) expect(result.code).toBe('RN_ISO_REMOTE_METRO_WRONG');
    // Nothing downstream may treat this run as reachable.
    expect(ctx.publicMetroUrl).toBeNull();
  });

  test('a missing managed tunnel requires start --remote and never starts a duplicate', async () => {
    let started = false;
    const { result } = await reach({
      available: ['cloudflared'],
      startManagedTunnel: async () => {
        started = true;
        return { url: 'https://duplicate.trycloudflare.com', pid: 4242 };
      },
      readTunnelRecord: () => null,
    });
    expect('failed' in result).toBe(true);
    if ('failed' in result) expect(result.remedy).toContain('start --remote');
    expect(started).toBe(false);
  });
});

describe('a session rn-iso created is never abandoned', () => {
  // The window this closes: between `eas sim` succeeding and ensureBooted
  // returning, the session exists and bills but its id is recorded nowhere,
  // so stop/gc/worktree-remove cannot find it. Observed live -- a session
  // with no endpoint yet left an IN_PROGRESS session nothing could reach.
  const NO_ENDPOINT = JSON.stringify({ id: 'drs_9', remoteConfig: null });

  test('a session that never becomes reachable is stopped, not left running', async () => {
    const exec = mockExec({ outputs: { sim: NO_ENDPOINT, 'simulator:get': NO_ENDPOINT } });
    const deps = remoteIosDeps(ctx({ existingDaemon: null }));
    const booted = await deps.ensureBooted({});
    expect(booted.failed).toBe(true);
    expect(booted.reason).toContain('The session was stopped.');
    const stop = exec.calls.find((c) => c.args[0] === 'simulator:stop');
    expect(stop?.args).toContain('drs_9');
  });

  test('when the stop also fails, the id and the manual command are reported', async () => {
    // A leak nobody is told about is the worst outcome, so the message has to
    // carry enough to fix it by hand.
    mockExec({ outputs: { sim: NO_ENDPOINT, 'simulator:get': NO_ENDPOINT }, fail: 'simulator:stop' });
    const booted = await remoteIosDeps(ctx({ existingDaemon: null })).ensureBooted({});
    expect(booted.reason).toContain('eas simulator:stop --id drs_9');
    expect(booted.reason).toContain('bills until its cap');
  });

  test('a connect failure after a create also ends the session', async () => {
    const exec = mockExec({ outputs: { sim: CREATED }, fail: 'connect' });
    const booted = await remoteIosDeps(ctx()).ensureBooted({});
    expect(booted.failed).toBe(true);
    expect(exec.calls.some((c) => c.args[0] === 'simulator:stop')).toBe(true);
  });

  test('a connect failure against an operator daemon stops nothing', async () => {
    // rn-iso created no session here, so it has none to end -- and ending
    // someone else's would be destroying a device it does not own.
    const exec = mockExec({ existingDaemonMode: true, fail: 'connect' });
    const booted = await remoteIosDeps(ctx({ existingDaemon: LOOPBACK, tunnelMode: 'off' })).ensureBooted({});
    expect(booted.failed).toBe(true);
    expect(exec.calls.some((c) => c.args[0] === 'simulator:stop')).toBe(false);
  });
});

describe('a re-run does not orphan the session it already has', () => {
  // `eas sim` defaults to --force, so without this every run minted a fresh
  // session while the previous one stayed live, unrecorded (state.json's id is
  // overwritten) and billing to its cap. The documented loop re-runs `ios`
  // after every native change, so it fired constantly.
  function recordSession(id: string): void {
    mkdirSync(join(root, '.rn-iso'), { recursive: true });
    writeFileSync(join(root, '.rn-iso', 'state.json'), JSON.stringify({ remoteDevice: { sessionId: id } }));
  }

  const LIVE = JSON.stringify({
    id: 'drs_old',
    status: 'IN_PROGRESS',
    remoteConfig: {
      agentDeviceRemoteSessionUrl: 'https://old.eas.dev/daemon',
      agentDeviceRemoteSessionToken: 'tok_old',
    },
  });

  test('a live recorded session is reused, and no new one is created', async () => {
    recordSession('drs_old');
    const exec = mockExec({ outputs: { 'simulator:get': LIVE, sim: CREATED } });
    const deps = remoteIosDeps(ctx());
    const booted = await deps.ensureBooted({});
    expect(booted.ok).toBe(true);
    expect(deps.createdSessionId()).toBe('drs_old');
    // The whole point: `eas sim` never ran.
    expect(exec.calls.some((c) => c.args[0] === 'sim')).toBe(false);
  });

  test('a STOPPED session is not reused, even though it still reports a config', async () => {
    // eas still returns remoteConfig for a stopped session, so reusing on
    // config alone would connect to a daemon that is gone.
    recordSession('drs_dead');
    const dead = JSON.stringify({
      id: 'drs_dead',
      status: 'STOPPED',
      remoteConfig: {
        agentDeviceRemoteSessionUrl: 'https://dead.eas.dev/daemon',
        agentDeviceRemoteSessionToken: 'tok_dead',
      },
    });
    const exec = mockExec({ outputs: { 'simulator:get': dead, sim: CREATED } });
    const deps = remoteIosDeps(ctx());
    await deps.ensureBooted({});
    expect(deps.createdSessionId()).toBe('drs_42');
    expect(exec.calls.some((c) => c.args[0] === 'sim')).toBe(true);
  });

  test('an unusable recorded session is STOPPED before another is created', async () => {
    // Otherwise it keeps billing with nothing left pointing at it.
    recordSession('drs_dead');
    const exec = mockExec({ outputs: { 'simulator:get': '{"status":"ERRORED"}', sim: CREATED } });
    await remoteIosDeps(ctx()).ensureBooted({});
    const stop = exec.calls.find((c) => c.args[0] === 'simulator:stop');
    expect(stop?.args).toContain('drs_dead');
  });

  test('an operator-supplied daemon touches no recorded session at all', async () => {
    // rn-iso is a guest there: it did not create that device and must not
    // stop anything on the way in.
    recordSession('drs_old');
    const exec = mockExec();
    await remoteIosDeps(ctx({ existingDaemon: LOOPBACK, tunnelMode: 'off' })).ensureBooted({});
    expect(exec.calls.some((c) => c.file === '/bin/eas')).toBe(false);
  });
});

describe("the alert rn-iso's own url open raises", () => {
  // A cloud simulator is always fresh, so iOS asks "Open in <app>?" in front
  // of the deep link on EVERY remote run. Nothing requests a bundle until it
  // is answered, which made `verify` report UNVERIFIED on launches that were
  // fine. Observed on a real EAS Simulator.
  test('a dev-client launch accepts it, so the bundle can actually load', async () => {
    const exec = mockExec({ outputs: { sim: CREATED } });
    const deps = remoteIosDeps(ctx({ existingDaemon: LOOPBACK, tunnelMode: 'off' }));
    await deps.ensureBooted({});
    deps.launchIosApp({ udid: 'drs_42', bundleId: 'com.example.app', metroPort: 8082, devClientScheme: 'myapp' });
    const after = exec.calls.map((c) => c.args.slice(0, 2).join(' '));
    expect(after).toContain('alert accept');
    // Order matters: the alert exists only because `open` raised it.
    expect(after.indexOf('alert accept')).toBeGreaterThan(after.indexOf('open com.example.app'));
  });

  test('a bare RN launch opens no url, so it does not reach for an alert', async () => {
    const exec = mockExec({ outputs: { sim: CREATED } });
    const deps = remoteIosDeps(ctx({ existingDaemon: LOOPBACK, tunnelMode: 'off' }));
    await deps.ensureBooted({});
    deps.launchIosApp({ udid: 'drs_42', bundleId: 'com.example.app', metroPort: 8082 });
    expect(exec.calls.some((c) => c.args[0] === 'alert')).toBe(false);
  });

  test('no alert to accept still leaves the launch successful', async () => {
    // The ordinary case once a device has seen one. `alert accept` exits
    // non-zero with nothing showing, and that must not fail a good launch.
    const exec = mockExec({ outputs: { sim: CREATED }, fail: 'alert accept' });
    const deps = remoteIosDeps(ctx({ existingDaemon: LOOPBACK, tunnelMode: 'off' }));
    await deps.ensureBooted({});
    const result = deps.launchIosApp({
      udid: 'drs_42',
      bundleId: 'com.example.app',
      metroPort: 8082,
      devClientScheme: 'myapp',
    });
    expect(result.ok).toBe(true);
    expect(exec.calls.some((c) => c.args.slice(0, 2).join(' ') === 'alert accept')).toBe(true);
  });
});

describe('the android adapter', () => {
  // On a REMOTE device the launch is the same operation as iOS: locally
  // Android points the app at 10.0.2.2 (the emulator's route to its OWN host)
  // and iOS at localhost, and the one public origin replaces both. So this is
  // an adapter over the same core, not a second implementation.
  test('android creates its session with --platform android', async () => {
    const exec = mockExec({ outputs: { sim: CREATED } });
    const deps = remoteAndroidDeps(ctx());
    await deps.ensureDeviceBooted({});
    const args = exec.calls[0]?.args ?? [];
    expect(args[args.indexOf('--platform') + 1]).toBe('android');
  });

  test('the boot result names a serial, which is what android.ts reads', async () => {
    mockExec({ outputs: { sim: CREATED } });
    const booted = await remoteAndroidDeps(ctx()).ensureDeviceBooted({});
    expect(booted.ok).toBe(true);
    expect(booted.serial).toBe('drs_42');
  });

  test('a failed boot keeps its reason rather than reporting a serial', async () => {
    mockExec({ fail: 'sim' });
    const booted = await remoteAndroidDeps(ctx()).ensureDeviceBooted({});
    expect(booted.failed).toBe(true);
    expect(booted.serial).toBeUndefined();
  });

  test('install takes the apk path', async () => {
    const exec = mockExec({ outputs: { sim: CREATED } });
    const deps = remoteAndroidDeps(ctx());
    await deps.ensureDeviceBooted({});
    deps.install({ serial: 'drs_42', apkPath: '/tmp/My App.apk' });
    const call = exec.calls.find((c) => c.args[0] === 'install');
    expect(call?.args[1]).toBe('/tmp/My App.apk');
  });

  test('the launch points at the public origin, never 10.0.2.2 or a reverse', async () => {
    // Both local mechanisms are host-relative: a reverse maps to the host
    // running adb, and 10.0.2.2 is the emulator's own host. On a remote
    // emulator both name the wrong machine.
    const exec = mockExec({ outputs: { sim: CREATED } });
    const deps = remoteAndroidDeps(ctx({ publicMetroUrl: 'https://abc.trycloudflare.com' }));
    await deps.ensureDeviceBooted({});
    deps.launch({ serial: 'drs_42', packageName: 'com.example.app', metroPort: 8082, devClientScheme: 'myapp' });
    const open = exec.calls.find((c) => c.args[0] === 'open');
    expect(open?.args[1]).toBe('com.example.app');
    expect(open?.args[2]).toBe('myapp://expo-development-client/?url=https%3A%2F%2Fabc.trycloudflare.com');
    const flat = (open?.args ?? []).join(' ');
    expect(flat).not.toContain('10.0.2.2');
    expect(flat).not.toContain('reverse');
    // The hint agent-device turns into debug_http_host on the device.
    expect(open?.args[open.args.indexOf('--metro-host') + 1]).toBe('abc.trycloudflare.com');
    expect(open?.args[open.args.indexOf('--metro-port') + 1]).toBe('443');
  });

  test('android refuses an unreachable Metro for the same reason iOS does', async () => {
    mockExec({ outputs: { sim: CREATED } });
    const deps = remoteAndroidDeps(ctx());
    await deps.ensureDeviceBooted({});
    const r = deps.launch({ serial: 'drs_42', packageName: 'com.example.app', metroPort: 8082 });
    expect(r.failed).toBe(true);
    expect(r.code).toBe('RN_ISO_REMOTE_METRO_UNREACHABLE');
  });

  test('the local device cap does not apply to a remote emulator either', () => {
    expect(remoteAndroidDeps(ctx()).checkCapacity()).toBeNull();
  });
});

describe('a release-shaped remote launch', () => {
  // Upstream's release flow passes metroPort: null -- the JS is embedded and
  // Metro is not part of the run. The reachability refusal below exists only
  // for a dev build, so it must not fire here and turn a launch that needs no
  // dev server into a failure.
  test('a null port launches without asking where Metro is', async () => {
    const exec = mockExec({ outputs: { sim: CREATED } });
    const deps = remoteIosDeps(ctx());
    await deps.ensureBooted({});
    const result = deps.launchIosApp({ udid: 'drs_42', bundleId: 'com.example.app', metroPort: null });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('launch');
    const open = exec.calls.find((c) => c.args[0] === 'open');
    // No url, and no Metro hint: there is no dev server to point at.
    expect(open?.args[1]).toBe('com.example.app');
    expect(open?.args).not.toContain('--metro-host');
  });

  test('a dev launch on an unreachable device still refuses', async () => {
    // The guard is not simply removed -- it still fires when a port IS given.
    mockExec({ outputs: { sim: CREATED } });
    const deps = remoteIosDeps(ctx());
    await deps.ensureBooted({});
    const r = deps.launchIosApp({ udid: 'drs_42', bundleId: 'com.example.app', metroPort: 8082 });
    expect(r.failed).toBe(true);
    expect(r.code).toBe('RN_ISO_REMOTE_METRO_UNREACHABLE');
  });

  test('android release launches the same way', async () => {
    const exec = mockExec({ outputs: { sim: CREATED } });
    const deps = remoteAndroidDeps(ctx());
    await deps.ensureDeviceBooted({});
    const r = deps.launch({ serial: 'drs_42', packageName: 'com.example.app', metroPort: null });
    expect(r.ok).toBe(true);
    expect(exec.calls.find((c) => c.args[0] === 'open')?.args).not.toContain('--metro-host');
  });
});
