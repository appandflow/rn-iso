// engine/tunnel.ts -- starting, waiting out, and reaping a tunnel rn-iso
// starts for itself.
//
// The property this file pins hardest is the one recorded in tunnel.ts's own
// header: a provider PRINTING its URL is not the same fact as that URL being
// routable, so startTunnel must never report success before a probe actually
// confirms reachability -- and that confirmation must be provable on a fake
// clock, because the real timeout is minutes long.
import {
  startTunnel,
  stopTunnel,
  parseCloudflaredLine,
  parseNgrokLine,
  tunnelArgv,
  type TunnelRecord,
} from '../engine/tunnel.ts';
import { makeChildProcess } from './_factories.ts';

// A clock the test drives, so a multi-minute timeout costs nothing and
// cannot flake. Same shape as engine/metro-gate.test.ts's clock().
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe('tunnelArgv', () => {
  test('cloudflared: a quick tunnel at the local port', () => {
    expect(tunnelArgv('cloudflared', 8081)).toEqual({
      bin: 'cloudflared',
      args: ['tunnel', '--url', 'http://127.0.0.1:8081'],
    });
  });

  test('ngrok: JSON-formatted logs on stdout, so the URL can be parsed', () => {
    expect(tunnelArgv('ngrok', 8081)).toEqual({
      bin: 'ngrok',
      args: ['http', '8081', '--log=stdout', '--log-format=json'],
    });
  });
});

describe('parseCloudflaredLine', () => {
  test("finds the URL inside cloudflared's banner line", () => {
    const line = '2026-01-01T00:00:00Z INF |  https://random-words-1234.trycloudflare.com  |';
    expect(parseCloudflaredLine(line)).toBe('https://random-words-1234.trycloudflare.com');
  });

  test('a line with no URL is not a match', () => {
    expect(parseCloudflaredLine('2026-01-01T00:00:00Z INF Starting tunnel')).toBeNull();
  });

  test('a URL for a different host is not matched', () => {
    expect(parseCloudflaredLine('see https://example.com for docs')).toBeNull();
  });
});

describe('parseNgrokLine', () => {
  test('reads the url field from a JSON log line', () => {
    const line = JSON.stringify({ lvl: 'info', msg: 'started tunnel', url: 'https://abcd1234.ngrok-free.app' });
    expect(parseNgrokLine(line)).toBe('https://abcd1234.ngrok-free.app');
  });

  test('a JSON line with no url field is not a match', () => {
    expect(parseNgrokLine(JSON.stringify({ lvl: 'info', msg: 'client session established' }))).toBeNull();
  });

  test('a non-JSON line does not throw -- this is untrusted output', () => {
    expect(parseNgrokLine('not json at all')).toBeNull();
  });

  test('a url field that is not a string is ignored rather than trusted', () => {
    expect(parseNgrokLine(JSON.stringify({ url: 12345 }))).toBeNull();
  });

  test('a url field with no scheme is ignored', () => {
    expect(parseNgrokLine(JSON.stringify({ url: 'abcd1234.ngrok-free.app' }))).toBeNull();
  });

  test('a JSON line that is not an object (a bare array or scalar) is not a match', () => {
    expect(parseNgrokLine('42')).toBeNull();
    expect(parseNgrokLine('[1,2,3]')).toBeNull();
  });
});

describe('startTunnel: the happy path', () => {
  test('cloudflared: the URL from stderr, confirmed reachable, is returned with the pid', async () => {
    const child = makeChildProcess();
    const promise = startTunnel({
      provider: 'cloudflared',
      port: 8081,
      spawnFn: () => child,
      probeReachable: async () => true,
    });
    child.stderr?.emit('data', 'banner |  https://random-words.trycloudflare.com  |\n');
    await expect(promise).resolves.toEqual({ url: 'https://random-words.trycloudflare.com', pid: 4242 });
  });

  test('ngrok: the URL from a JSON stdout line, confirmed reachable', async () => {
    const child = makeChildProcess();
    const promise = startTunnel({
      provider: 'ngrok',
      port: 8081,
      spawnFn: () => child,
      probeReachable: async () => true,
    });
    child.stdout?.emit('data', `${JSON.stringify({ msg: 'started tunnel', url: 'https://abcd.ngrok-free.app' })}\n`);
    await expect(promise).resolves.toEqual({ url: 'https://abcd.ngrok-free.app', pid: 4242 });
  });

  test("the child is unref'd on success so it can outlive the caller", async () => {
    let unrefed = false;
    const child = makeChildProcess({
      unref() {
        unrefed = true;
        return child;
      },
    });
    const promise = startTunnel({
      provider: 'ngrok',
      port: 8081,
      spawnFn: () => child,
      probeReachable: async () => true,
    });
    child.stdout?.emit('data', `${JSON.stringify({ url: 'https://abcd.ngrok-free.app' })}\n`);
    await promise;
    expect(unrefed).toBe(true);
  });
});

describe('startTunnel: nothing here throws -- every failure is a returned value', () => {
  test('a binary that will not even start', async () => {
    const result = await startTunnel({
      provider: 'ngrok',
      port: 8081,
      spawnFn: () => {
        throw Object.assign(new Error('spawn ngrok ENOENT'), { code: 'ENOENT' });
      },
    });
    expect(result).toEqual({ failed: true, reason: expect.stringContaining('Could not start ngrok') });
  });

  test('exiting before printing a URL is a failure, not a hang', async () => {
    let killed = false;
    const child = makeChildProcess({
      kill() {
        killed = true;
        return true;
      },
    });
    const promise = startTunnel({ provider: 'cloudflared', port: 8081, spawnFn: () => child });
    child.emit('exit', 1, null);
    const result = await promise;
    expect(result).toEqual({ failed: true, reason: expect.stringContaining('exited before printing') });
    expect(killed).toBe(true);
  });

  test('a provider that stays silent is bounded by urlTimeoutMs, not left running', async () => {
    const child = makeChildProcess();
    const result = await startTunnel({ provider: 'ngrok', port: 8081, spawnFn: () => child, urlTimeoutMs: 20 });
    expect(result).toEqual({ failed: true, reason: expect.stringContaining('did not print a tunnel URL') });
  });

  test('a URL that never becomes reachable fails on the INJECTED clock, not a real one', async () => {
    const c = clock();
    const child = makeChildProcess();
    const promise = startTunnel({
      provider: 'cloudflared',
      port: 8081,
      spawnFn: () => child,
      probeReachable: async () => false,
      reachableTimeoutMs: 5_000,
      now: c.now,
      sleep: c.sleep,
    });
    child.stderr?.emit('data', 'https://x.trycloudflare.com\n');
    const result = await promise;
    expect(result).toEqual({
      failed: true,
      reason: expect.stringContaining('did not become reachable'),
    });
  });

  test('a URL is proven reachable only after the probe starts succeeding', async () => {
    const c = clock();
    let calls = 0;
    const child = makeChildProcess();
    const promise = startTunnel({
      provider: 'cloudflared',
      port: 8081,
      spawnFn: () => child,
      probeReachable: async () => ++calls >= 3,
      reachableTimeoutMs: 60_000,
      now: c.now,
      sleep: c.sleep,
    });
    child.stderr?.emit('data', 'https://x.trycloudflare.com\n');
    const result = await promise;
    expect(result).toEqual({ url: 'https://x.trycloudflare.com', pid: 4242 });
    expect(calls).toBe(3);
  });

  test('a provider reporting no pid is a failure', async () => {
    const child = makeChildProcess({ pid: undefined });
    const promise = startTunnel({
      provider: 'ngrok',
      port: 8081,
      spawnFn: () => child,
      probeReachable: async () => true,
    });
    child.stdout?.emit('data', `${JSON.stringify({ url: 'https://x.ngrok-free.app' })}\n`);
    const result = await promise;
    expect(result).toEqual({ failed: true, reason: expect.stringContaining('reported no pid') });
  });
});

function fixtureRecord(overrides: Partial<TunnelRecord> = {}): TunnelRecord {
  return {
    provider: 'cloudflared',
    pid: 4242,
    url: 'https://x.trycloudflare.com',
    port: 8081,
    startedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('stopTunnel: idempotent, never throws', () => {
  test('no record at all is missing, not an error', async () => {
    await expect(stopTunnel(null)).resolves.toEqual({ status: 'missing' });
    await expect(stopTunnel(undefined)).resolves.toEqual({ status: 'missing' });
  });

  test('a pid that is already dead is missing -- calling stop twice is safe', async () => {
    const result = await stopTunnel(fixtureRecord(), { isAlive: () => false });
    expect(result).toEqual({ status: 'missing' });
  });

  test('signals the recorded pid and confirms it exits', async () => {
    let alive = true;
    const signalled: number[] = [];
    const result = await stopTunnel(fixtureRecord({ pid: 777 }), {
      isAlive: () => alive,
      kill: (pid) => {
        signalled.push(pid);
        alive = false;
      },
    });
    expect(signalled).toEqual([777]);
    expect(result).toEqual({ status: 'stopped' });
  });

  test("a kill racing the process's own exit (ESRCH) reads as missing, not failed", async () => {
    const result = await stopTunnel(fixtureRecord(), {
      isAlive: () => true,
      kill: () => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      },
    });
    expect(result).toEqual({ status: 'missing' });
  });

  test('a kill that fails for another reason is a returned failed status, not a throw', async () => {
    const result = await stopTunnel(fixtureRecord(), {
      isAlive: () => true,
      kill: () => {
        throw new Error('operation not permitted');
      },
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('not permitted');
  });

  test('a pid that never exits fails after the INJECTED timeout, not a real one', async () => {
    const c = clock();
    const result = await stopTunnel(fixtureRecord(), {
      isAlive: () => true,
      kill: () => {},
      now: c.now,
      sleep: c.sleep,
      timeoutMs: 1_000,
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('did not exit');
  });
});
