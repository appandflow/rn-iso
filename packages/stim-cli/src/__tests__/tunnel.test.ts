import {
  readTunnelProcessArgs,
  readTunnelProcessToken,
  startTunnel,
  startTunnelSequence,
  stopTunnel,
  parseCloudflaredLine,
  parseNgrokLine,
  tunnelArgv,
  type TunnelRecord,
} from '../engine/tunnel.ts';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetExecutor, setExecutor } from '../exec.ts';
import { makeChildProcess } from './_factories.ts';

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

const successfulTunnelCleanup = async () => ({ status: 'stopped' as const });

function startVerified(options: Parameters<typeof startTunnel>[0]) {
  return startTunnel({ isChildAlive: () => false, ...options, readProcessToken: () => 'linux:100' });
}

describe('tunnelArgv', () => {
  test('cloudflared: a quick tunnel at the local port', () => {
    expect(tunnelArgv('cloudflared', 8081)).toEqual({
      bin: 'cloudflared',
      args: ['tunnel', '--url', 'http://127.0.0.1:8081'],
    });
  });

  test('cloudflared: writes logs to an owned file when one is provided', () => {
    expect(tunnelArgv('cloudflared', 8081, null, '/tmp/tunnel.log')).toEqual({
      bin: 'cloudflared',
      args: ['tunnel', '--url', 'http://127.0.0.1:8081', '--logfile', '/tmp/tunnel.log'],
    });
  });

  test('ngrok: JSON-formatted logs on stdout, so the URL can be parsed', () => {
    expect(tunnelArgv('ngrok', 8081)).toEqual({
      bin: 'ngrok',
      args: ['http', '8081', '--log=stdout', '--log-format=json'],
    });
  });

  test('ngrok: appends the configured stable URL', () => {
    expect(tunnelArgv('ngrok', 8081, 'https://stable.ngrok.app')).toEqual({
      bin: 'ngrok',
      args: ['http', '8081', '--log=stdout', '--log-format=json', '--url', 'https://stable.ngrok.app'],
    });
  });

  test('ngrok: does not add --url without a configured stable URL', () => {
    expect(tunnelArgv('ngrok', 8081).args).not.toContain('--url');
  });

  test('ngrok: writes JSON logs to an owned file when one is provided', () => {
    expect(tunnelArgv('ngrok', 8081, null, '/tmp/tunnel.log')).toEqual({
      bin: 'ngrok',
      args: ['http', '8081', '--log=/tmp/tunnel.log', '--log-format=json'],
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
    const promise = startVerified({
      provider: 'cloudflared',
      port: 8081,
      spawnFn: () => child,
      probeReachable: async () => true,
    });
    child.stderr?.emit('data', 'banner |  https://random-words.trycloudflare.com  |\n');
    await expect(promise).resolves.toMatchObject({
      url: 'https://random-words.trycloudflare.com',
      pid: 4242,
      processToken: 'linux:100',
      cleanup: expect.any(Function),
    });
  });

  test('ngrok: the URL from a JSON stdout line, confirmed reachable', async () => {
    const child = makeChildProcess();
    const promise = startVerified({
      provider: 'ngrok',
      port: 8081,
      spawnFn: () => child,
      probeReachable: async () => true,
    });
    child.stdout?.emit('data', `${JSON.stringify({ msg: 'started tunnel', url: 'https://abcd.ngrok-free.app' })}\n`);
    await expect(promise).resolves.toMatchObject({
      url: 'https://abcd.ngrok-free.app',
      pid: 4242,
      cleanup: expect.any(Function),
    });
  });

  test("the child is unref'd on success so it can outlive the caller", async () => {
    let unrefed = false;
    const child = makeChildProcess({
      unref() {
        unrefed = true;
        return child;
      },
    });
    const promise = startVerified({
      provider: 'ngrok',
      port: 8081,
      spawnFn: () => child,
      probeReachable: async () => true,
    });
    child.stdout?.emit('data', `${JSON.stringify({ url: 'https://abcd.ngrok-free.app' })}\n`);
    await promise;
    expect(unrefed).toBe(true);
  });

  test('routes provider output to an owned file so the child is not attached to caller pipes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stim-cli-tunnel-log-test-'));
    const logFile = join(dir, 'cloudflared.log');
    const line = 'banner |  https://detached.trycloudflare.com  |\n';
    const child = makeChildProcess();
    let args: string[] = [];
    let stdio: unknown;
    const options = {
      provider: 'cloudflared' as const,
      port: 8081,
      logFile,
      spawnFn: (_cmd: string, childArgs: string[], spawnOptions: Record<string, unknown>) => {
        args = childArgs;
        stdio = spawnOptions.stdio;
        queueMicrotask(() => {
          writeFileSync(logFile, line);
          child.stderr?.emit('data', line);
        });
        return child;
      },
      probeReachable: async () => true,
    };

    try {
      const result = await startVerified(options);
      expect(result).toMatchObject({ url: 'https://detached.trycloudflare.com', logFile });
      expect(args).toEqual(['tunnel', '--url', 'http://127.0.0.1:8081', '--logfile', logFile]);
      expect(stdio).toEqual(['ignore', 'ignore', 'ignore']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not record a PID reused after spawn with a different process token', async () => {
    let token = 'linux:100';
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const child = makeChildProcess({
      kill(signal) {
        signals.push(signal);
        return true;
      },
    });
    const promise = startTunnel({
      provider: 'ngrok',
      port: 8081,
      spawnFn: () => child,
      probeReachable: async () => true,
      readProcessToken: () => token,
      isChildAlive: () => true,
      cleanupTimeoutMs: 1,
    });
    child.stdout?.emit('data', `${JSON.stringify({ url: 'https://replacement.ngrok.app' })}\n`);
    token = 'linux:200';
    child.emit('exit', 0, null);

    await expect(promise).resolves.toEqual({
      failed: true,
      reason: expect.stringContaining('process identity changed'),
    });
    expect(signals).toEqual([]);
  });

  test('does not record a replacement after the retained child exits with the same process token', async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const child = makeChildProcess({
      kill(signal) {
        signals.push(signal);
        return true;
      },
    });
    const promise = startTunnel({
      provider: 'ngrok',
      port: 8081,
      spawnFn: () => child,
      probeReachable: async () => true,
      readProcessToken: () => 'ps-lstart:Fri Aug 28 06:00:00 2026',
      isChildAlive: () => true,
      cleanupTimeoutMs: 1,
    });
    child.stdout?.emit('data', `${JSON.stringify({ url: 'https://replacement.ngrok.app' })}\n`);
    child.emit('exit', 0, null);

    await expect(promise).resolves.toEqual({
      failed: true,
      reason: expect.stringContaining('exited before its tunnel could be recorded'),
    });
    expect(signals).toEqual([]);
  });
});

describe('startTunnel: nothing here throws -- every failure is a returned value', () => {
  test('a binary that will not even start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stim-cli-tunnel-spawn-test-'));
    const logFile = join(dir, 'ngrok.log');
    writeFileSync(logFile, '');
    const result = await startVerified({
      provider: 'ngrok',
      port: 8081,
      logFile,
      spawnFn: () => {
        throw Object.assign(new Error('spawn ngrok ENOENT'), { code: 'ENOENT' });
      },
    });
    expect(result).toEqual({ failed: true, reason: expect.stringContaining('Could not start ngrok') });
    expect(existsSync(logFile)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('exiting before printing a URL is a failure, not a hang', async () => {
    let killed = false;
    const child = makeChildProcess({
      kill() {
        killed = true;
        return true;
      },
    });
    const promise = startVerified({ provider: 'cloudflared', port: 8081, spawnFn: () => child });
    child.emit('exit', 1, null);
    const result = await promise;
    expect(result).toEqual({ failed: true, reason: expect.stringContaining('exited before printing') });
    expect(killed).toBe(false);
  });

  test('a provider that stays silent is bounded by urlTimeoutMs, not left running', async () => {
    const child = makeChildProcess();
    const result = await startVerified({ provider: 'ngrok', port: 8081, spawnFn: () => child, urlTimeoutMs: 20 });
    expect(result).toEqual({ failed: true, reason: expect.stringContaining('did not print a tunnel URL') });
  });

  test('waits for a child that exits after SIGTERM before returning failure', async () => {
    let exited = false;
    let streamsDestroyed = 0;
    const child = makeChildProcess({
      kill(signal) {
        expect(signal).toBe('SIGTERM');
        setTimeout(() => {
          exited = true;
          child.emit('exit', null, 'SIGTERM');
        }, 5);
        return true;
      },
    });
    Object.assign(child.stdout as object, { destroy: () => void (streamsDestroyed += 1) });
    Object.assign(child.stderr as object, { destroy: () => void (streamsDestroyed += 1) });

    await startVerified({ provider: 'ngrok', port: 8081, spawnFn: () => child, urlTimeoutMs: 1 });

    expect(exited).toBe(true);
    expect(streamsDestroyed).toBe(2);
  });

  test('escalates to SIGKILL and confirms exit when a child ignores SIGTERM', async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const child = makeChildProcess({
      kill(signal) {
        signals.push(signal);
        if (signal === 'SIGKILL') child.emit('exit', null, 'SIGKILL');
        return true;
      },
    });

    await startVerified({
      provider: 'ngrok',
      port: 8081,
      spawnFn: () => child,
      urlTimeoutMs: 1,
      cleanupTimeoutMs: 5,
      isChildAlive: () => true,
    } as Parameters<typeof startTunnel>[0]);

    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  test('does not fall back when SIGKILL cannot confirm child exit', async () => {
    const providers: string[] = [];
    const child = makeChildProcess({ kill: () => true });

    const result = await startTunnelSequence({
      providers: ['ngrok', 'cloudflared'],
      port: 8081,
      start: async ({ provider }) => {
        providers.push(provider);
        if (provider === 'cloudflared') {
          return {
            url: 'https://fallback.trycloudflare.com',
            pid: 4243,
            processToken: 'linux:100',
            cleanup: successfulTunnelCleanup,
          };
        }
        return startVerified({
          provider,
          port: 8081,
          spawnFn: () => child,
          urlTimeoutMs: 1,
          cleanupTimeoutMs: 1,
          isChildAlive: () => true,
        } as Parameters<typeof startTunnel>[0]);
      },
    });

    expect(providers).toEqual(['ngrok']);
    expect(result).toEqual({ failed: true, reason: expect.stringContaining('could not confirm') });
  });

  test('auto fallback starts only after the failed child exits', async () => {
    const order: string[] = [];
    const child = makeChildProcess({
      kill() {
        setTimeout(() => {
          order.push('ngrok-exit');
          child.emit('exit', null, 'SIGTERM');
        }, 5);
        return true;
      },
    });

    await startTunnelSequence({
      providers: ['ngrok', 'cloudflared'],
      port: 8081,
      start: async ({ provider }) => {
        if (provider === 'cloudflared') {
          order.push('cloudflared-start');
          return {
            url: 'https://fallback.trycloudflare.com',
            pid: 4243,
            processToken: 'linux:100',
            cleanup: successfulTunnelCleanup,
          };
        }
        return startVerified({ provider, port: 8081, spawnFn: () => child, urlTimeoutMs: 1 });
      },
    });

    expect(order).toEqual(['ngrok-exit', 'cloudflared-start']);
  });

  test('a URL that never becomes reachable fails on the INJECTED clock, not a real one', async () => {
    const c = clock();
    const child = makeChildProcess();
    const promise = startVerified({
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
    const promise = startVerified({
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
    expect(result).toMatchObject({ url: 'https://x.trycloudflare.com', pid: 4242, cleanup: expect.any(Function) });
    expect(calls).toBe(3);
  });

  test('a provider reporting no pid is a failure', async () => {
    const child = makeChildProcess({ pid: undefined });
    const promise = startVerified({
      provider: 'ngrok',
      port: 8081,
      spawnFn: () => child,
      probeReachable: async () => true,
      cleanupTimeoutMs: 1,
    });
    child.stdout?.emit('data', `${JSON.stringify({ url: 'https://x.ngrok-free.app' })}\n`);
    const result = await promise;
    expect(result).toEqual({
      failed: true,
      reason: expect.stringMatching(/reported no pid.*could not confirm/),
      cleanupFailed: true,
    });
  });

  test('a process whose start token cannot be captured is cleaned up and not returned as owned', async () => {
    const child = makeChildProcess();
    const promise = startTunnel({
      provider: 'ngrok',
      port: 8081,
      spawnFn: () => child,
      probeReachable: async () => true,
      readProcessToken: () => null,
    });
    child.stdout?.emit('data', `${JSON.stringify({ url: 'https://x.ngrok-free.app' })}\n`);
    const result = await promise;
    expect(result).toEqual({ failed: true, reason: expect.stringContaining('process identity token') });
  });
});

describe('startTunnelSequence', () => {
  test('auto falls back to cloudflared after ngrok exits before returning a URL', async () => {
    const calls: string[] = [];
    const result = await startTunnelSequence({
      providers: ['ngrok', 'cloudflared'],
      port: 8081,
      start: async ({ provider }) => {
        calls.push(provider);
        return provider === 'ngrok'
          ? { failed: true as const, reason: 'authentication failed before printing a tunnel URL' }
          : {
              url: 'https://fallback.trycloudflare.com',
              pid: 4243,
              processToken: 'linux:100',
              cleanup: successfulTunnelCleanup,
            };
      },
    });

    expect(calls).toEqual(['ngrok', 'cloudflared']);
    expect(result).toEqual({
      provider: 'cloudflared',
      url: 'https://fallback.trycloudflare.com',
      pid: 4243,
      processToken: 'linux:100',
      cleanup: successfulTunnelCleanup,
    });
  });

  test('a successful ngrok URL wins without starting cloudflared', async () => {
    const calls: string[] = [];
    const result = await startTunnelSequence({
      providers: ['ngrok', 'cloudflared'],
      port: 8081,
      start: async ({ provider }) => {
        calls.push(provider);
        return {
          url: 'https://ready.ngrok.app',
          pid: 4242,
          processToken: 'linux:100',
          cleanup: successfulTunnelCleanup,
        };
      },
    });

    expect(calls).toEqual(['ngrok']);
    expect(result).toEqual({
      provider: 'ngrok',
      url: 'https://ready.ngrok.app',
      pid: 4242,
      processToken: 'linux:100',
      cleanup: successfulTunnelCleanup,
    });
  });

  test('explicit ngrok is fail-closed when it is the only candidate', async () => {
    const calls: string[] = [];
    const result = await startTunnelSequence({
      providers: ['ngrok'],
      port: 8081,
      start: async ({ provider }) => {
        calls.push(provider);
        return { failed: true as const, reason: 'authentication failed' };
      },
    });

    expect(calls).toEqual(['ngrok']);
    expect(result).toEqual({ failed: true, reason: expect.stringContaining('ngrok: authentication failed') });
  });

  test('explicit cloudflared is fail-closed when it is the only candidate', async () => {
    const calls: string[] = [];
    const result = await startTunnelSequence({
      providers: ['cloudflared'],
      port: 8081,
      start: async ({ provider }) => {
        calls.push(provider);
        return { failed: true as const, reason: 'quick tunnel refused' };
      },
    });

    expect(calls).toEqual(['cloudflared']);
    expect(result).toEqual({ failed: true, reason: expect.stringContaining('cloudflared: quick tunnel refused') });
  });

  test('reports evidence from every failed auto provider', async () => {
    const result = await startTunnelSequence({
      providers: ['ngrok', 'cloudflared'],
      port: 8081,
      start: async ({ provider }) => ({ failed: true as const, reason: `${provider} evidence` }),
    });

    expect(result).toEqual({
      failed: true,
      reason: expect.stringMatching(/ngrok: ngrok evidence.*cloudflared: cloudflared evidence/),
    });
  });
});

function fixtureRecord(overrides: Partial<TunnelRecord> = {}): TunnelRecord {
  return {
    provider: 'cloudflared',
    pid: 4242,
    url: 'https://x.trycloudflare.com',
    port: 8081,
    startedAt: new Date(0).toISOString(),
    processToken: 'linux:100',
    ...overrides,
  };
}

function stopVerified(record: TunnelRecord, options: Parameters<typeof stopTunnel>[1] = {}) {
  return stopTunnel(record, { readProcessToken: () => 'linux:100', ...options });
}

describe('stopTunnel: idempotent, never throws', () => {
  test('no record at all is missing, not an error', async () => {
    await expect(stopTunnel(null)).resolves.toEqual({ status: 'missing' });
    await expect(stopTunnel(undefined)).resolves.toEqual({ status: 'missing' });
  });

  test('a pid that is already dead is missing -- calling stop twice is safe', async () => {
    const result = await stopVerified(fixtureRecord(), { isAlive: () => false });
    expect(result).toEqual({ status: 'missing' });
  });

  test('a legacy record without a process token fails closed and is not signalled', async () => {
    const signalled: number[] = [];
    const record = fixtureRecord();
    delete (record as Partial<TunnelRecord>).processToken;
    const result = await stopTunnel(record, {
      isAlive: () => true,
      readProcessArgs: () => ['cloudflared', 'tunnel', '--url', 'http://127.0.0.1:8081'],
      kill: (pid) => signalled.push(pid),
    });
    expect(signalled).toEqual([]);
    expect(result).toEqual({ status: 'failed', reason: expect.stringMatching(/process identity token.*retry/i) });
  });

  test('the same pid and argv with a different process token is not signalled', async () => {
    const signalled: number[] = [];
    const result = await stopVerified(fixtureRecord(), {
      isAlive: () => true,
      readProcessArgs: () => ['cloudflared', 'tunnel', '--url', 'http://127.0.0.1:8081'],
      readProcessToken: () => 'linux:200',
      kill: (pid) => signalled.push(pid),
    } as Parameters<typeof stopTunnel>[1]);
    expect(signalled).toEqual([]);
    expect(result).toEqual({ status: 'failed', reason: expect.stringContaining('process instance') });
  });

  test('signals an alive pid only when its ngrok command and port match', async () => {
    let alive = true;
    const signalled: number[] = [];
    const result = await stopVerified(fixtureRecord({ provider: 'ngrok', pid: 777 }), {
      isAlive: () => alive,
      readProcessArgs: () => ['/opt/homebrew/bin/ngrok', 'http', '8081', '--log=stdout', '--log-format=json'],
      kill: (pid) => {
        signalled.push(pid);
        alive = false;
      },
    });
    expect(signalled).toEqual([777]);
    expect(result).toEqual({ status: 'stopped' });
  });

  test('signals the exact ngrok command with the recorded stable URL', async () => {
    let alive = true;
    const signalled: number[] = [];
    const stableUrl = `https://${'stable-'.repeat(500)}endpoint.ngrok.app`;
    const result = await stopVerified(fixtureRecord({ provider: 'ngrok', pid: 779, url: stableUrl }), {
      isAlive: () => alive,
      readProcessArgs: () => ['ngrok', 'http', '8081', '--log=stdout', '--log-format=json', '--url', stableUrl],
      kill: (pid) => {
        signalled.push(pid);
        alive = false;
      },
    });
    expect(signalled).toEqual([779]);
    expect(result.status).toBe('stopped');
  });

  test.each([
    ['an unrelated flag', ['ngrok', 'http', '8081', '--log=stdout', '--log-format=json', '--inspect=false']],
    ['an extra positional argument', ['ngrok', 'http', '8081', '--log=stdout', '--log-format=json', 'other']],
    ['a different subcommand', ['ngrok', 'tcp', '8081', '--log=stdout', '--log-format=json']],
    [
      'a duplicate endpoint flag',
      [
        'ngrok',
        'http',
        '8081',
        '--log=stdout',
        '--log-format=json',
        '--url',
        'https://x.ngrok.app',
        '--url',
        'https://x.ngrok.app',
      ],
    ],
    [
      'a stable endpoint different from the record',
      ['ngrok', 'http', '8081', '--log=stdout', '--log-format=json', '--url', 'https://other.ngrok.app'],
    ],
  ])('does not signal an ngrok command with %s', async (_name, args) => {
    let alive = true;
    const signalled: number[] = [];
    const result = await stopVerified(fixtureRecord({ provider: 'ngrok', url: 'https://x.ngrok.app' }), {
      isAlive: () => alive,
      readProcessArgs: () => args,
      kill: (pid) => {
        signalled.push(pid);
        alive = false;
      },
    });
    expect(signalled).toEqual([]);
    expect(result.status).toBe('failed');
  });

  test('signals an alive pid only when its cloudflared command and local URL match', async () => {
    let alive = true;
    const signalled: number[] = [];
    const result = await stopVerified(fixtureRecord({ provider: 'cloudflared', pid: 778 }), {
      isAlive: () => alive,
      readProcessArgs: () => ['/opt/homebrew/bin/cloudflared', 'tunnel', '--url', 'http://127.0.0.1:8081'],
      kill: (pid) => {
        signalled.push(pid);
        alive = false;
      },
    });
    expect(signalled).toEqual([778]);
    expect(result).toEqual({ status: 'stopped' });
  });

  test('does not signal an alive pid owned by the wrong provider', async () => {
    const signalled: number[] = [];
    const result = await stopVerified(fixtureRecord({ provider: 'ngrok' }), {
      isAlive: () => true,
      readProcessArgs: () => ['/usr/local/bin/cloudflared', 'tunnel', '--url', 'http://127.0.0.1:8081'],
      kill: (pid) => signalled.push(pid),
    });
    expect(signalled).toEqual([]);
    expect(result).toEqual({ status: 'failed', reason: expect.stringContaining('could not verify') });
  });

  test('does not accept a provider word in an unrelated path or argument', async () => {
    const signalled: number[] = [];
    for (const args of [
      ['/tmp/ngrok-helper', 'http', '8081'],
      ['/usr/bin/node', '/tmp/ngrok/server.js', 'http', '8081'],
      ['/usr/bin/sleep', 'ngrok', 'http', '8081'],
    ]) {
      const result = await stopVerified(fixtureRecord({ provider: 'ngrok' }), {
        isAlive: () => true,
        readProcessArgs: () => args,
        kill: (pid) => signalled.push(pid),
      });
      expect(result.status).toBe('failed');
    }
    expect(signalled).toEqual([]);
  });

  test('does not signal a matching provider command for a different local port', async () => {
    const signalled: number[] = [];
    const result = await stopVerified(fixtureRecord({ provider: 'cloudflared', port: 8081 }), {
      isAlive: () => true,
      readProcessArgs: () => ['cloudflared', 'tunnel', '--url', 'http://127.0.0.1:9090'],
      kill: (pid) => signalled.push(pid),
    });
    expect(signalled).toEqual([]);
    expect(result.status).toBe('failed');
  });

  test.each([
    ['a run subcommand', ['cloudflared', 'tunnel', 'run', 'other', '--url', 'http://127.0.0.1:8081']],
    ['an unrelated flag', ['cloudflared', 'tunnel', '--url', 'http://127.0.0.1:8081', '--no-autoupdate']],
    [
      'a duplicate endpoint flag',
      ['cloudflared', 'tunnel', '--url', 'http://127.0.0.1:8081', '--url', 'http://127.0.0.1:8081'],
    ],
    ['an alternate endpoint', ['cloudflared', 'tunnel', '--url', 'http://localhost:8081']],
  ])('does not signal a cloudflared command with %s', async (_name, args) => {
    let alive = true;
    const signalled: number[] = [];
    const result = await stopVerified(fixtureRecord({ provider: 'cloudflared' }), {
      isAlive: () => alive,
      readProcessArgs: () => args,
      kill: (pid) => {
        signalled.push(pid);
        alive = false;
      },
    });
    expect(signalled).toEqual([]);
    expect(result.status).toBe('failed');
  });

  test('an unreadable live command fails closed without a signal', async () => {
    const signalled: number[] = [];
    const result = await stopVerified(fixtureRecord(), {
      isAlive: () => true,
      readProcessArgs: () => null,
      kill: (pid) => signalled.push(pid),
    });
    expect(signalled).toEqual([]);
    expect(result).toEqual({ status: 'failed', reason: expect.stringContaining('could not read') });
  });

  test("a kill racing the process's own exit (ESRCH) reads as missing, not failed", async () => {
    const previousHome = process.env.STIM_CLI_HOME;
    const home = mkdtempSync(join(tmpdir(), 'stim-cli-tunnel-stop-test-'));
    const logFile = join(home, 'tunnel-logs', 'cloudflared.log');
    mkdirSync(join(home, 'tunnel-logs'));
    writeFileSync(logFile, '');
    process.env.STIM_CLI_HOME = home;
    try {
      const result = await stopVerified(fixtureRecord({ logFile }), {
        isAlive: () => true,
        readProcessArgs: () => ['cloudflared', 'tunnel', '--url', 'http://127.0.0.1:8081', '--logfile', logFile],
        kill: () => {
          throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
        },
      });
      expect(result).toEqual({ status: 'missing' });
      expect(existsSync(logFile)).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.STIM_CLI_HOME;
      else process.env.STIM_CLI_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a kill that fails for another reason is a returned failed status, not a throw', async () => {
    const result = await stopVerified(fixtureRecord(), {
      isAlive: () => true,
      readProcessArgs: () => ['cloudflared', 'tunnel', '--url', 'http://127.0.0.1:8081'],
      kill: () => {
        throw new Error('operation not permitted');
      },
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('not permitted');
  });

  test('a pid that never exits fails after the INJECTED timeout, not a real one', async () => {
    const c = clock();
    const result = await stopVerified(fixtureRecord(), {
      isAlive: () => true,
      readProcessArgs: () => ['cloudflared', 'tunnel', '--url', 'http://127.0.0.1:8081'],
      kill: () => {},
      now: c.now,
      sleep: c.sleep,
      timeoutMs: 1_000,
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('did not exit');
  });
});

describe('readTunnelProcessArgs', () => {
  test('reads a bounded NUL-delimited command from Linux procfs', () => {
    const reads: Array<{ path: string; maxBytes: number }> = [];
    const result = readTunnelProcessArgs(4242, {
      platform: 'linux',
      readProcCommand: (path, maxBytes) => {
        reads.push({ path, maxBytes });
        return Buffer.from(['/usr/bin/ngrok', 'http', '8081', ''].join('\0'));
      },
    });
    expect(result).toEqual(['/usr/bin/ngrok', 'http', '8081']);
    expect(reads).toEqual([{ path: '/proc/4242/cmdline', maxBytes: expect.any(Number) }]);
    expect(reads[0]?.maxBytes).toBeLessThanOrEqual(64 * 1024);
  });

  test('an unreadable Linux procfs command fails closed', () => {
    expect(
      readTunnelProcessArgs(4242, {
        platform: 'linux',
        readProcCommand: () => {
          throw new Error('EACCES');
        },
      }),
    ).toBeNull();
  });

  test('runs ps with a timeout on macOS and parses quoted arguments', () => {
    const calls: Array<{ pid: number; timeoutMs: number }> = [];
    const result = readTunnelProcessArgs(4242, {
      platform: 'darwin',
      runPsCommand: (pid, timeoutMs) => {
        calls.push({ pid, timeoutMs });
        return "'/opt/local/bin/ngrok' http 8081 --url 'https://stable.ngrok.app'";
      },
    });
    expect(result).toEqual(['/opt/local/bin/ngrok', 'http', '8081', '--url', 'https://stable.ngrok.app']);
    expect(calls).toEqual([{ pid: 4242, timeoutMs: expect.any(Number) }]);
    expect(calls[0]?.timeoutMs).toBeLessThanOrEqual(5_000);
  });

  test('uses full-width BSD ps argv and preserves a long stable ngrok URL', () => {
    const stableUrl = `https://${'a'.repeat(4_000)}.ngrok.app`;
    const calls: Array<{ file: string; args: string[]; timeoutMs: number | undefined }> = [];
    setExecutor({
      runFile(file, args, options) {
        calls.push({ file, args, timeoutMs: options?.timeoutMs });
        return `ngrok http 8081 --log=stdout --log-format=json --url ${stableUrl}`;
      },
    });
    try {
      expect(readTunnelProcessArgs(4242, { platform: 'darwin' })).toEqual([
        'ngrok',
        'http',
        '8081',
        '--log=stdout',
        '--log-format=json',
        '--url',
        stableUrl,
      ]);
    } finally {
      resetExecutor();
    }
    expect(calls).toEqual([
      { file: 'ps', args: ['-ww', '-o', 'command=', '-p', '4242'], timeoutMs: expect.any(Number) },
    ]);
  });

  test.each([
    [
      'ps failure',
      () => {
        throw new Error('ps failed');
      },
    ],
    [
      'ps timeout',
      () => {
        throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
      },
    ],
    ['empty output', () => ''],
    ['malformed output', () => "'/usr/bin/ngrok http 8081"],
  ])('%s fails closed', (_name, runPsCommand) => {
    expect(readTunnelProcessArgs(4242, { platform: 'darwin', runPsCommand })).toBeNull();
  });
});

describe('readTunnelProcessToken', () => {
  test('reads Linux procfs starttime as a boot-relative process token', () => {
    const stat = `4242 (ngrok helper) S ${Array.from({ length: 18 }, (_, index) => index + 1).join(' ')} 98765 0`;
    expect(
      readTunnelProcessToken(4242, {
        platform: 'linux',
        readProcStat: (path, maxBytes) => {
          expect(path).toBe('/proc/4242/stat');
          expect(maxBytes).toBeLessThanOrEqual(64 * 1024);
          return Buffer.from(stat);
        },
      }),
    ).toBe('linux:98765');
  });

  test('normalizes a bounded BSD lstart value', () => {
    const calls: Array<{ pid: number; timeoutMs: number }> = [];
    const token = readTunnelProcessToken(4242, {
      platform: 'darwin',
      runPsStartCommand: (pid, timeoutMs) => {
        calls.push({ pid, timeoutMs });
        return 'Fri Aug 28 06:10:11 2026\n';
      },
    });
    expect(token).toBe('ps-lstart:Fri Aug 28 06:10:11 2026');
    expect(calls).toEqual([{ pid: 4242, timeoutMs: expect.any(Number) }]);
  });

  test('uses full-width BSD ps argv for the process start token', () => {
    const calls: Array<{ file: string; args: string[]; timeoutMs: number | undefined }> = [];
    setExecutor({
      runFile(file, args, options) {
        calls.push({ file, args, timeoutMs: options?.timeoutMs });
        return 'Fri Aug 28 06:10:11 2026';
      },
    });
    try {
      expect(readTunnelProcessToken(4242, { platform: 'darwin' })).toBe('ps-lstart:Fri Aug 28 06:10:11 2026');
    } finally {
      resetExecutor();
    }
    expect(calls).toEqual([
      { file: 'ps', args: ['-ww', '-o', 'lstart=', '-p', '4242'], timeoutMs: expect.any(Number) },
    ]);
  });
});

describe('against output cloudflared really printed', () => {
  // Captured from cloudflared 2026.8.2; keep these raw lines as parser fixtures.
  const BANNER =
    '2026-08-26T19:50:27Z INF |  https://priest-contribute-mysql-leslie.trycloudflare.com                                  |';
  const REQUEST_ERROR =
    '2026-08-26T20:26:19Z ERR Request failed error="Unable to reach the origin service." connIndex=0 ' +
    'dest=https://priest-contribute-mysql-leslie.trycloudflare.com/status event=0 ip=198.41.192.37 type=http';
  const PRECHECK = '2026-08-26T19:50:22Z INF Requesting new quick Tunnel on trycloudflare.com...';

  test('the banner line yields the bare origin, boxed in pipes and padding', () => {
    expect(parseCloudflaredLine(BANNER)).toBe('https://priest-contribute-mysql-leslie.trycloudflare.com');
  });

  test('a url carrying a PATH still yields only the origin', () => {
    expect(parseCloudflaredLine(REQUEST_ERROR)).toBe('https://priest-contribute-mysql-leslie.trycloudflare.com');
  });

  test('the pre-banner line naming the domain is NOT a url', () => {
    expect(parseCloudflaredLine(PRECHECK)).toBeNull();
  });
});
