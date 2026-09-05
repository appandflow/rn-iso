import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createCleanupTracker, createHarness, verifyCleanup, workspaceLogsDir } from './native/harness.mjs';

function fixture(t, platform = 'ios', processExitTimeoutMs = 0) {
  const home = mkdtempSync(join(tmpdir(), 'stim-native-cleanup-'));
  const previousHome = process.env.STIM_HOME;
  process.env.STIM_HOME = home;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previousHome;
  });
  const cwd = join(home, 'worktree');
  const stateFile = join(workspaceLogsDir(cwd), '..', 'state.json');
  const output = {
    devices: [],
    avds: [],
    processes: '',
    status: '',
    porcelain: '',
    worktrees: '',
    gc: '',
    failure: null,
    processReads: 0,
  };
  const h = {
    env: { STIM_HOME: home },
    banner() {},
    log() {},
    sh(file, argv, options) {
      if (file === output.failure) {
        assert.equal(options.allowFail, true);
        return { code: 1, stdout: '', stderr: 'fixture inspection failed' };
      }
      let stdout;
      if (file === 'xcrun') stdout = JSON.stringify({ devices: { runtime: output.devices } });
      else if (file === 'emulator') stdout = output.avds.join('\n');
      else if (file === 'ps') {
        output.processReads++;
        stdout = output.processes;
      } else if (file === 'git' && argv.includes('status')) stdout = output.porcelain;
      else if (file === 'git' && argv.includes('worktree')) stdout = output.worktrees;
      else assert.fail(`unexpected command: ${file} ${argv.join(' ')}`);
      return { code: 0, stdout, stderr: '' };
    },
    cli(argv) {
      return { code: 0, stdout: argv[0] === 'status' ? output.status : output.gc, stderr: '' };
    },
  };
  const cleanup = createCleanupTracker({ h, platform, processExitTimeoutMs });
  return {
    cwd,
    stateFile,
    configFile: join(home, 'config.json'),
    output,
    cleanup,
    writeState(state) {
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify(state));
    },
    verify() {
      return verifyCleanup({ h, cleanup, appDir: join(home, 'app'), created: [cwd] });
    },
  };
}

for (const platform of ['ios', 'android']) {
  test(`native cleanup ignores unrelated ${platform} devices and supervisors`, async (t) => {
    const f = fixture(t, platform);
    f.cleanup.recordBuild({ udid: 'RUN-UDID', avdName: 'stim-this-run' });
    f.output.devices = [{ udid: 'OTHER-UDID', name: 'stim-this-run', state: 'Booted' }];
    f.output.avds = ['stim-this-run-unrelated', 'personal-avd'];
    f.output.processes = ' 123 Sat Sep 5 01:00:00 2026 node stim-cli supervisor --root /another/worktree';
    await f.verify();
  });

  test(`native cleanup still detects this run's leaked ${platform} device after state removal`, async (t) => {
    const f = fixture(t, platform);
    f.cleanup.recordBuild({ udid: 'RUN-UDID', avdName: 'stim-this-run' });
    f.writeState({});
    rmSync(f.stateFile);
    f.output.devices = [{ udid: 'RUN-UDID', name: 'stim-parked', state: 'Shutdown' }];
    f.output.avds = ['stim-this-run'];
    await assert.rejects(() => f.verify(), /a device from this run was left behind/);
  });

  test(`native cleanup requires ${platform} build identity`, async (t) => {
    const f = fixture(t, platform);
    assert.throws(() => f.cleanup.recordBuild({}), /build did not identify its device/);
  });

  test(`native cleanup retains a failed build's registered ${platform} device`, async (t) => {
    const f = fixture(t, platform);
    writeFileSync(
      f.configFile,
      JSON.stringify({
        projects: {
          [f.cwd]: { platforms: { [platform]: { owned: true, deviceUdid: 'RUN', avdName: 'stim-run' } } },
          '/another/worktree': {
            platforms: { [platform]: { owned: true, deviceUdid: 'OTHER', avdName: 'stim-other' } },
          },
        },
      }),
    );
    f.cleanup.recordWorkspace(f.cwd);
    rmSync(f.configFile);
    f.cleanup.recordWorkspace(f.cwd);
    f.output.devices = [{ udid: 'RUN', name: 'stim-parked' }];
    f.output.avds = ['stim-run'];
    await assert.rejects(() => f.verify(), /a device from this run was left behind/);
    f.output.devices = [{ udid: 'OTHER', name: 'stim-other' }];
    f.output.avds = ['stim-other'];
    await f.verify();
  });

  test(`native cleanup does not claim an unowned registered ${platform} device`, async (t) => {
    const f = fixture(t, platform);
    writeFileSync(
      f.configFile,
      JSON.stringify({
        projects: {
          [f.cwd]: { platforms: { [platform]: { owned: false, deviceUdid: 'OTHER', avdName: 'personal-avd' } } },
        },
      }),
    );
    f.cleanup.recordWorkspace(f.cwd);
    f.output.devices = [{ udid: 'OTHER', name: 'personal simulator' }];
    f.output.avds = ['personal-avd'];
    await f.verify();
  });
}

test('pool counts tracked UDIDs across rename, eviction and adoption', async (t) => {
  const f = fixture(t);
  f.cleanup.recordBuild({ udid: 'FIRST' });
  f.cleanup.recordBuild({ udid: 'SECOND' });
  f.output.devices = [
    { udid: 'FIRST', name: 'stim-parked' },
    { udid: 'SECOND', name: 'stim-pool-2' },
    { udid: 'UNRELATED', name: 'stim-other' },
  ];
  assert.deepEqual(f.cleanup.remainingDevices(), ['FIRST', 'SECOND']);
  f.output.devices.shift();
  f.cleanup.recordBuild({ udid: 'SECOND' });
  f.output.devices[0].name = 'stim-pool-3';
  assert.deepEqual(f.cleanup.remainingDevices(), ['SECOND']);
  f.output.devices.shift();
  await f.verify();
});

test('native cleanup ignores unrelated supervisors when this run has no live processes', async (t) => {
  const f = fixture(t);
  f.output.processes = ' 987 Sat Sep 5 01:00:00 2026 node stim-cli supervisor --root /unrelated';
  await f.verify();
});

for (const [kind, state] of [
  ['supervisor', { supervisor: { pid: 123, startedAt: '2026-09-05T01:00:00Z' } }],
  ['Metro child', { supervisor: { serverPid: 123, startedAt: '2026-09-05T01:00:00Z' } }],
  ['collector', { collectors: { ios: { pid: 123, startedAt: '2026-09-05T01:00:00Z' } } }],
]) {
  test(`native cleanup detects a leaked ${kind} after its state record disappears`, async (t) => {
    const f = fixture(t);
    f.writeState(state);
    f.output.processes = ` 123 Sat Sep 5 01:00:00 2026 node stim-cli ${kind} --root ${f.cwd}`;
    f.cleanup.recordWorkspace(f.cwd);
    rmSync(f.stateFile);
    f.cleanup.recordWorkspace(f.cwd);
    await assert.rejects(() => f.verify(), /a workspace process is still running/);
    f.output.processes = ' 987 Sat Sep 5 01:00:00 2026 node stim-cli supervisor --root /unrelated';
    await f.verify();
  });

  test(`native cleanup does not recapture a reused ${kind} PID from stale state`, async (t) => {
    const f = fixture(t);
    f.writeState(state);
    f.output.processes = ` 123 Sat Sep 5 01:00:00 2026 node stim-cli ${kind} --root ${f.cwd}`;
    f.cleanup.recordWorkspace(f.cwd);
    f.output.processes = ' 123 Sat Sep 5 02:00:00 2026 node stim-cli supervisor --root /unrelated';
    f.cleanup.recordWorkspace(f.cwd);
    await f.verify();
  });
}

test('native cleanup does not hide unreadable workspace state', async (t) => {
  const f = fixture(t);
  f.writeState({});
  writeFileSync(f.stateFile, '{');
  assert.throws(() => f.cleanup.recordWorkspace(f.cwd), SyntaxError);
});

test('native cleanup retains replaced collectors and ignores a reused PID', async (t) => {
  const f = fixture(t);
  const first = ` 123 Sat Sep 5 01:00:00 2026 node collector --root ${f.cwd}`;
  const second = ` 456 Sat Sep 5 01:01:00 2026 node collector --root ${f.cwd}`;
  f.writeState({ collectors: { android: { pid: 123 } } });
  f.output.processes = first;
  f.cleanup.recordWorkspace(f.cwd);
  f.writeState({ collectors: { android: { pid: 456 } } });
  f.output.processes = `${first}\n${second}`;
  f.cleanup.recordWorkspace(f.cwd);
  f.output.processes = first;
  await assert.rejects(() => f.verify(), /a workspace process is still running/);
  f.output.processes = first.replace('01:00:00', '02:00:00');
  await f.verify();
});

test('native cleanup tracks a new registration even when it recycles a captured PID', async (t) => {
  const f = fixture(t);
  f.writeState({ collectors: { ios: { pid: 123, startedAt: '2026-09-05T01:00:00Z' } } });
  f.output.processes = ` 123 Sat Sep 5 01:00:00 2026 node collector --root ${f.cwd}`;
  f.cleanup.recordWorkspace(f.cwd);
  f.writeState({ collectors: { ios: { pid: 123, startedAt: '2026-09-05T02:00:00Z' } } });
  f.output.processes = ` 123 Sat Sep 5 02:00:00 2026 node collector --root ${f.cwd}`;
  f.cleanup.recordWorkspace(f.cwd);
  rmSync(f.stateFile);
  await assert.rejects(() => f.verify(), /a workspace process is still running/);
});

test('native cleanup does not adopt a reused PID missing from its first snapshot', async (t) => {
  const f = fixture(t);
  f.writeState({ collectors: { ios: { pid: 123, startedAt: '2026-09-05T01:00:00Z' } } });
  f.cleanup.recordWorkspace(f.cwd);
  f.output.processes = ' 123 Sat Sep 5 02:00:00 2026 node stim-cli supervisor --root /unrelated';
  f.cleanup.recordWorkspace(f.cwd);
  await f.verify();
});

test('native cleanup waits for a signalled collector to exit', async (t) => {
  const f = fixture(t, 'ios', 200);
  f.writeState({ collectors: { ios: { pid: 123, startedAt: '2026-09-05T01:00:00Z' } } });
  f.output.processes = ` 123 Sat Sep 5 01:00:00 2026 node collector --root ${f.cwd}`;
  f.cleanup.recordWorkspace(f.cwd);
  const timer = setTimeout(() => {
    f.output.processes = '';
  }, 10);
  t.after(() => clearTimeout(timer));
  await f.verify();
  assert.ok(f.output.processReads >= 3);
});

test('native cleanup still fails a process that survives the settle window', async (t) => {
  const f = fixture(t, 'ios', 20);
  f.writeState({ supervisor: { serverPid: 123, startedAt: '2026-09-05T01:00:00Z' } });
  f.output.processes = ` 123 Sat Sep 5 01:00:00 2026 node expo --root ${f.cwd}`;
  f.cleanup.recordWorkspace(f.cwd);
  await assert.rejects(() => f.verify(), /a workspace process is still running/);
  assert.ok(f.output.processReads >= 3);
});

for (const [platform, tool] of [
  ['ios', 'xcrun'],
  ['android', 'emulator'],
  ['ios', 'ps'],
]) {
  test(`native cleanup throws when ${tool} inspection fails`, async (t) => {
    const f = fixture(t, platform);
    f.output.failure = tool;
    await assert.rejects(() => f.verify(), new RegExp(`could not inspect ${tool}: fixture inspection failed`));
  });
}

test('missing executables remain inspection failures with allowFail enabled', async () => {
  const h = createHarness({ env: { ...process.env, PATH: '' }, cliPath: '/unused', label: 'missing-inspection' });
  const result = h.sh('stim-native-cleanup-unavailable-tool', [], { allowFail: true });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ENOENT/);
  const cleanup = createCleanupTracker({ h, platform: 'android', processExitTimeoutMs: 0 });
  assert.throws(() => cleanup.remainingDevices(), /could not inspect emulator:.*ENOENT/);
  await assert.rejects(() => cleanup.verifyProcesses(), /could not inspect ps:.*ENOENT/);
});

test('native cleanup preserves registry, checkout, worktree and GC checks', async (t) => {
  const f = fixture(t);
  for (const [field, text, message] of [
    ['status', f.cwd, /status still lists a removed workspace/],
    ['porcelain', ' M tracked-file', /main checkout is dirty/],
    ['worktrees', `worktree ${f.cwd}\n`, /a worktree registration survived/],
    ['gc', f.cwd, /gc reports one of our workspaces as orphaned/],
  ]) {
    f.output[field] = text;
    await assert.rejects(() => f.verify(), message);
    f.output[field] = '';
  }
  await f.verify();
});
