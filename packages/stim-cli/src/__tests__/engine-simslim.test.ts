import { makeChildProcess, makeError } from './_factories.ts';
import { reconcileSimSlim } from '../engine/simslim.ts';

function exitingChild({ stdout = [], stderr = [], code = 0 }: { stdout?: string[]; stderr?: string[]; code?: number }) {
  const child = makeChildProcess();
  queueMicrotask(() => {
    for (const line of stdout) child.stdout?.emit('data', `${line}\n`);
    for (const line of stderr) child.stderr?.emit('data', `${line}\n`);
    child.emit('exit', code, null);
  });
  return child;
}

test('does nothing when no profile is configured and Stim did not manage the simulator', async () => {
  let spawned = false;
  await expect(
    reconcileSimSlim({
      udid: 'U1',
      spawn: () => {
        spawned = true;
        return makeChildProcess();
      },
    }),
  ).resolves.toEqual({ managed: false, profile: null });
  expect(spawned).toBe(false);
});

test('applies a profile with the exact UDID and streams progress', async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const lines: string[] = [];
  const profile = '/repo/.simslim/dev.json';
  const result = await reconcileSimSlim({
    udid: 'U1',
    profile,
    out: (line) => lines.push(line),
    spawn: (command, args) => {
      calls.push({ command, args });
      return exitingChild({
        stderr: ['Disabling 170 background services...', 'Rebooting the simulator...'],
        stdout: ['Done. Simulator reconfigured and rebooted slim.'],
      });
    },
  });

  expect(calls).toEqual([{ command: 'simslim', args: ['on', 'U1', '--profile', profile] }]);
  expect(lines).toHaveLength(3);
  expect(lines).toEqual(
    expect.arrayContaining([
      'SimSlim: Disabling 170 background services...',
      'SimSlim: Rebooting the simulator...',
      'SimSlim: Done. Simulator reconfigured and rebooted slim.',
    ]),
  );
  expect(result).toEqual({ managed: true, profile });
});

test('restores stock services after the configured profile is removed', async () => {
  const calls: string[][] = [];
  const result = await reconcileSimSlim({
    udid: 'U1',
    previouslyManaged: true,
    spawn: (_command, args) => {
      calls.push([...args]);
      return exitingChild({ stdout: ['Done. All daemons re-enabled and simulator rebooted.'] });
    },
  });

  expect(calls).toEqual([['off', 'U1']]);
  expect(result).toEqual({ managed: false, profile: null });
});

test('reports the install command when the SimSlim executable is missing', async () => {
  const child = makeChildProcess();
  queueMicrotask(() => child.emit('error', makeError('spawn simslim ENOENT', { code: 'ENOENT' })));
  await expect(reconcileSimSlim({ udid: 'U1', profile: '/repo/dev.json', spawn: () => child })).rejects.toThrow(
    'brew install mobai-app/tap/simslim',
  );
});

test('includes recent SimSlim output when the command fails', async () => {
  await expect(
    reconcileSimSlim({
      udid: 'U1',
      profile: '/repo/dev.json',
      spawn: () => exitingChild({ stderr: ['iOS 17 does not persist launchd overrides'], code: 1 }),
    }),
  ).rejects.toThrow(/exit code 1.*iOS 17/);
});
