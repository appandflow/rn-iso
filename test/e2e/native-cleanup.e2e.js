import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createCleanupTracker, verifyCleanup, workspaceLogsDir } from './native/harness.mjs';

function fixture(t, platform = 'ios') {
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
  const output = { devices: [], avds: [], processes: '', status: '', porcelain: '', worktrees: '', gc: '' };
  const h = {
    banner() {},
    log() {},
    sh(file, argv) {
      let stdout;
      if (file === 'xcrun') stdout = JSON.stringify({ devices: { runtime: output.devices } });
      else if (file === 'emulator') stdout = output.avds.join('\n');
      else if (file === 'ps') stdout = output.processes;
      else if (file === 'git' && argv.includes('status')) stdout = output.porcelain;
      else if (file === 'git' && argv.includes('worktree')) stdout = output.worktrees;
      else assert.fail(`unexpected command: ${file} ${argv.join(' ')}`);
      return { code: 0, stdout, stderr: '' };
    },
    cli(argv) {
      return { code: 0, stdout: argv[0] === 'status' ? output.status : output.gc, stderr: '' };
    },
  };
  const cleanup = createCleanupTracker({ h, platform });
  return {
    cwd,
    stateFile,
    output,
    cleanup,
    writeState(state) {
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify(state));
    },
    verify() {
      verifyCleanup({ h, cleanup, appDir: join(home, 'app'), created: [cwd] });
    },
  };
}

for (const platform of ['ios', 'android']) {
  test(`native cleanup ignores unrelated ${platform} devices and supervisors`, (t) => {
    const f = fixture(t, platform);
    f.cleanup.recordBuild({ udid: 'RUN-UDID', avdName: 'stim-this-run' });
    f.output.devices = [{ udid: 'OTHER-UDID', name: 'stim-this-run', state: 'Booted' }];
    f.output.avds = ['stim-this-run-unrelated', 'personal-avd'];
    f.output.processes = ' 123 Sat Sep 5 01:00:00 2026 node stim-cli supervisor --root /another/worktree';
    f.verify();
  });

  test(`native cleanup still detects this run's leaked ${platform} device after state removal`, (t) => {
    const f = fixture(t, platform);
    f.cleanup.recordBuild({ udid: 'RUN-UDID', avdName: 'stim-this-run' });
    f.writeState({});
    rmSync(f.stateFile);
    f.output.devices = [{ udid: 'RUN-UDID', name: 'stim-parked', state: 'Shutdown' }];
    f.output.avds = ['stim-this-run'];
    assert.throws(() => f.verify(), /a device from this run was left behind/);
  });

  test(`native cleanup requires ${platform} build identity`, (t) => {
    const f = fixture(t, platform);
    assert.throws(() => f.cleanup.recordBuild({}), /build did not identify its device/);
  });
}

test('pool counts tracked UDIDs across rename, eviction and adoption', (t) => {
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
  f.verify();
});

test('native cleanup ignores unrelated supervisors when this run has no live processes', (t) => {
  const f = fixture(t);
  f.output.processes = ' 987 Sat Sep 5 01:00:00 2026 node stim-cli supervisor --root /unrelated';
  f.verify();
});

for (const [kind, state] of [
  ['supervisor', { supervisor: { pid: 123 } }],
  ['Metro child', { supervisor: { serverPid: 123 } }],
  ['collector', { collectors: { ios: { pid: 123 } } }],
]) {
  test(`native cleanup detects a leaked ${kind} after its state record disappears`, (t) => {
    const f = fixture(t);
    f.writeState(state);
    f.output.processes = ` 123 Sat Sep 5 01:00:00 2026 node stim-cli ${kind} --root ${f.cwd}`;
    f.cleanup.recordProcesses(f.cwd);
    rmSync(f.stateFile);
    f.cleanup.recordProcesses(f.cwd);
    assert.throws(() => f.verify(), /a workspace process is still running/);
    f.output.processes = ' 987 Sat Sep 5 01:00:00 2026 node stim-cli supervisor --root /unrelated';
    f.verify();
  });
}

test('native cleanup does not hide unreadable workspace state', (t) => {
  const f = fixture(t);
  f.writeState({});
  writeFileSync(f.stateFile, '{');
  assert.throws(() => f.cleanup.recordProcesses(f.cwd), SyntaxError);
});

test('native cleanup retains replaced collectors and ignores a reused PID', (t) => {
  const f = fixture(t);
  const first = ` 123 Sat Sep 5 01:00:00 2026 node collector --root ${f.cwd}`;
  const second = ` 456 Sat Sep 5 01:01:00 2026 node collector --root ${f.cwd}`;
  f.writeState({ collectors: { android: { pid: 123 } } });
  f.output.processes = first;
  f.cleanup.recordProcesses(f.cwd);
  f.writeState({ collectors: { android: { pid: 456 } } });
  f.output.processes = `${first}\n${second}`;
  f.cleanup.recordProcesses(f.cwd);
  f.output.processes = first;
  assert.throws(() => f.verify(), /a workspace process is still running/);
  f.output.processes = first.replace('01:00:00', '02:00:00');
  f.verify();
});

test('native cleanup preserves registry, checkout, worktree and GC checks', (t) => {
  const f = fixture(t);
  for (const [field, text, message] of [
    ['status', f.cwd, /status still lists a removed workspace/],
    ['porcelain', ' M tracked-file', /main checkout is dirty/],
    ['worktrees', `worktree ${f.cwd}\n`, /a worktree registration survived/],
    ['gc', f.cwd, /gc reports one of our workspaces as orphaned/],
  ]) {
    f.output[field] = text;
    assert.throws(() => f.verify(), message);
    f.output[field] = '';
  }
  f.verify();
});
