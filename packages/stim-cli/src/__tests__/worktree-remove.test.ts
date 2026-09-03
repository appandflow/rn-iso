import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  excludePodChurn,
  matchWorktreeEntry,
  porcelainPath,
  removalBlockers,
  removalPath,
  registerRemove,
  removalRemedy,
} from '../commands/worktree.ts';
import type { Command } from 'commander';
import { withManagedRemoteWorktreeLock, withManagedTunnelLock } from '../engine/tunnel.ts';
import { registerStart } from '../commands/start.ts';
import { asProcessExit } from './_factories.ts';
import { setExecutor, resetExecutor } from '../exec.ts';
import { upsertProject, getProject } from '../config.ts';
import { ensureWorkspaceStorage, workspaceDir, workspaceStateFile } from '../paths.ts';
import { listLeaseFiles, takeLease } from '../engine/device-lease.ts';

type ActionFn = (target: string | undefined, opts: Record<string, unknown>) => void | Promise<void>;

interface CommandStub {
  command(nameAndArgs?: string): CommandStub;
  description(str?: string): CommandStub;
  option(flags?: string, description?: string): CommandStub;
  action(fn: ActionFn): CommandStub;
}

test('no blockers for a clean worktree', async () => {
  expect(removalBlockers({ dirty: false, unpushed: [] })).toEqual([]);
});

test('removalPath canonicalizes a missing path through its nearest existing parent', () => {
  expect(removalPath('/tmp/stim-missing/worktree')).toBe(join(realpathSync('/tmp'), 'stim-missing', 'worktree'));
});

test('reports uncommitted changes', async () => {
  const blockers = removalBlockers({ dirty: true, unpushed: [] });
  expect(blockers.length).toBe(1);
  expect(blockers[0]).toMatch(/uncommitted/i);
});

test('reports unpushed commits with a count', async () => {
  const blockers = removalBlockers({ dirty: false, unpushed: ['abc one', 'def two'] });
  expect(blockers.length).toBe(1);
  expect(blockers[0]).toMatch(/2 commit/);
});

test('reports both when both apply', async () => {
  expect(removalBlockers({ dirty: true, unpushed: ['abc one'] }).length).toBe(2);
});

test('reports an indeterminate-status blocker instead of treating it as clean', async () => {
  expect(removalBlockers({ dirty: null, unpushed: [] }).length).toBe(1);
  expect(removalBlockers({ dirty: false, unpushed: null }).length).toBe(1);
  expect(removalBlockers({ dirty: null, unpushed: null })[0]).toMatch(/could not determine/i);
});

test('porcelainPath reads the path out of each status form', () => {
  expect(porcelainPath(' M ios/Podfile.lock')).toBe('ios/Podfile.lock');
  expect(porcelainPath('R  old/name.js -> new/name.js')).toBe('new/name.js');
  expect(porcelainPath('?? "we\u00e4rd path"')).toBe('we\u00e4rd path');
  expect(porcelainPath('   ')).toBe(null);
});

test('the remedy names the right command for each class of dirt', () => {
  const untracked = removalRemedy(['?? scratch.txt']).join('\n');
  expect(untracked).toMatch(/clean -fd/);
  expect(untracked).not.toMatch(/checkout --/);

  const modified = removalRemedy([' M src/app.js']).join('\n');
  expect(modified).toMatch(/checkout --/);
  expect(modified).not.toMatch(/clean -fd/);

  const both = removalRemedy(['?? scratch.txt', ' M src/app.js']).join('\n');
  expect(both).toMatch(/checkout --/);
  expect(both).toMatch(/clean -fd/);

  expect(removalRemedy([])).toEqual([]);
});

test('pod-install churn keeps its exact restore command', () => {
  const lines = removalRemedy([' M ios/Podfile.lock', ' M ios/App.xcodeproj/project.pbxproj']).join('\n');
  expect(lines).toMatch(/pod install` rewrites/);
  expect(lines).toMatch(/ios\/Podfile\.lock/);
  expect(lines).not.toMatch(/clean -fd/);
});

test('pod-install churn names the paths git actually reported, not an ios/ example', () => {
  const lines = removalRemedy([' M apps/mobile/ios/Podfile.lock', ' M apps/mobile/ios/App.xcodeproj/project.pbxproj'], {
    worktree: '/tmp/wt',
  }).join('\n');
  expect(lines).toMatch(/pod install` rewrites/);
  expect(lines).toMatch(
    /git -C \/tmp\/wt checkout -- apps\/mobile\/ios\/Podfile\.lock apps\/mobile\/ios\/App\.xcodeproj\/project\.pbxproj/,
  );
  expect(!lines.includes('"ios/*.xcodeproj/project.pbxproj"')).toBeTruthy();
  expect(!/ ios\/Podfile\.lock/.test(lines)).toBeTruthy();
});

test('the remedy names the worktree when it is given one', () => {
  expect(removalRemedy(['?? x'], { worktree: '/tmp/wt' }).join('\n')).toMatch(/git -C \/tmp\/wt clean -fd/);
});

test('the remedy carries the paths themselves, capped, quoting what needs it', () => {
  expect(removalRemedy([' M src/app.js', '?? scratch.txt'], { worktree: '/tmp/wt' }).join('\n')).toMatch(
    /checkout -- src\/app\.js/,
  );
  expect(removalRemedy(['?? "we ird.txt"'], { worktree: '/tmp/wt' }).join('\n')).toMatch(/clean -fd "we ird\.txt"/);
  const many = removalRemedy([' M a', ' M b', ' M c', ' M d', ' M e', ' M f'], { worktree: '/tmp/wt' }).join('\n');
  expect(many).toMatch(/checkout -- a b c d e \.\.\./);
  expect(!many.includes('<path>')).toBeTruthy();
});

function canon(p: string) {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

function captureAction(register: (cmd: Command) => void) {
  let captured: ActionFn | undefined;
  const stub: CommandStub = {
    command() {
      return stub;
    },
    description() {
      return stub;
    },
    option() {
      return stub;
    },
    action(fn: ActionFn) {
      captured = fn;
      return stub;
    },
  };
  register(stub as Command);
  return (target: string | undefined, opts: Record<string, unknown> = {}) => {
    if (!captured) throw new Error('register did not register an action');
    return captured(target, opts);
  };
}

function captureStartAction(overrides: Parameters<typeof registerStart>[1]) {
  let captured: ((opts: Record<string, unknown>) => void | Promise<void>) | undefined;
  const stub: CommandStub = {
    command() {
      return stub;
    },
    description() {
      return stub;
    },
    option() {
      return stub;
    },
    action(fn) {
      captured = fn as unknown as (opts: Record<string, unknown>) => void | Promise<void>;
      return stub;
    },
  };
  registerStart(stub as Command, overrides);
  if (!captured) throw new Error('registerStart did not register an action');
  return captured;
}

interface PorcelainEntry {
  path: string;
  branch?: string;
}

function porcelain(entries: PorcelainEntry[]) {
  return entries
    .map(
      (e) =>
        `worktree ${e.path}\nHEAD 0000000000000000000000000000000000000000\n${e.branch ? `branch refs/heads/${e.branch}` : 'detached'}\n`,
    )
    .join('\n');
}

interface MakeExecutorOptions {
  dirty?: string | null;
  unpushed?: string | null;
  remote?: string;
  worktrees?: string | null;
  simctlList?: string;
  occupied?: Record<string, boolean>;
  diffs?: Record<string, string>;
  mainTrees?: string[];
  worktreeRemoveError?: string;
  branchDeleteError?: string;
  refSha?: string | null;
}

function makeExecutor({
  dirty = '',
  unpushed = '',
  remote = 'origin',
  worktrees = '',
  simctlList = '{"devices":{}}',
  occupied = {},
  diffs = {},
  mainTrees = [],
  worktreeRemoveError,
  branchDeleteError,
  refSha = 'abc123',
}: MakeExecutorOptions = {}) {
  const runCalls: string[] = [];
  const runQuietCalls: string[] = [];
  const exec = {
    calls: { run: runCalls, runQuiet: runQuietCalls },
    run(cmd: string) {
      runCalls.push(cmd);
      if (/simctl list devices --json/.test(cmd)) return simctlList;
      if (/simctl delete|delete avd/.test(cmd)) return '';
      throw new Error(`unexpected run: ${cmd}`);
    },
    runFile(file: string, args: string[] = []) {
      const cmd = [file, ...args].join(' ');
      runCalls.push(cmd);
      if (/worktree remove/.test(cmd)) {
        if (worktreeRemoveError) throw new Error(worktreeRemoveError);
        return '';
      }
      if (/update-ref -d/.test(cmd)) {
        if (branchDeleteError) throw new Error(branchDeleteError);
        return '';
      }
      if (/rev-parse/.test(cmd)) return refSha;
      throw new Error(`unexpected runFile: ${cmd}`);
    },
    runQuiet(cmd: string) {
      runQuietCalls.push(cmd);
      const revMatch = cmd.match(/^git -C "(.+)" rev-parse --path-format=absolute --git-dir --git-common-dir$/);
      if (revMatch) {
        const p = revMatch[1] ?? '';
        return mainTrees.includes(p) ? `${p}/.git\n${p}/.git` : null;
      }
      if (/status --porcelain/.test(cmd)) return dirty;
      const diffMatch = cmd.match(/ diff -- "(.+)"$/);
      if (diffMatch) return diffs[diffMatch[1] ?? ''] ?? '';
      if (/ checkout -- /.test(cmd)) return '';
      if (/log --oneline HEAD --not --remotes/.test(cmd)) return unpushed;
      if (/worktree list --porcelain/.test(cmd)) return worktrees;
      if (cmd.endsWith('remote')) return remote;
      const spawnMatch = cmd.match(/simctl spawn (\S+) launchctl list/);
      if (spawnMatch) {
        const udid = spawnMatch[1] ?? '';
        return occupied[udid] ? '082a\t0\tUIKitApplication:com.example.MyAppUITests.xctrunner[082a][rb-legacy]' : '';
      }
      return null;
    },
    spawn() {},
  };
  return exec;
}

function simctlJson(sims: unknown[]) {
  return JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-17-0': sims } });
}

let tmpHome: string, mainDir: string, wtDir: string;
let liveProcesses: ChildProcess[];

function liveUnrelatedProcess(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  if (!child.pid) throw new Error('test process did not start');
  liveProcesses.push(child);
  return child;
}

function writeManagedTunnel(root: string, pid: number): void {
  ensureWorkspaceStorage(root);
  writeFileSync(
    workspaceStateFile(root),
    JSON.stringify({
      metroTunnel: {
        kind: 'managed',
        provider: 'ngrok',
        pid,
        url: 'https://recorded.ngrok.app',
        port: 8081,
        startedAt: 'T',
        processToken: 'linux:100',
      },
    }),
  );
}

function writeRemoteSession(root: string, sessionId: string): void {
  ensureWorkspaceStorage(root);
  writeFileSync(
    workspaceStateFile(root),
    JSON.stringify({ remoteDevice: { platform: 'ios', sessionId, startedAt: 'T' } }),
  );
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-home-'));
  process.env.STIM_HOME = tmpHome;
  mainDir = canon(mkdtempSync(join(tmpdir(), 'stim-test-main-')));
  wtDir = canon(mkdtempSync(join(tmpdir(), 'stim-test-wt-')));
  liveProcesses = [];
});

afterEach(() => {
  for (const child of liveProcesses) child.kill('SIGKILL');
  resetExecutor();
  process.exitCode = 0;
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(mainDir, { recursive: true, force: true });
  rmSync(wtDir, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('action: on the main checkout, reclaims the environment with the owned device deleted and the tree untouched', async () => {
  upsertProject(mainDir, {
    metroPort: 8081,
    platforms: { ios: { deviceUdid: 'U9', owned: true, deviceName: 'stim-main' } },
  });
  writeFileSync(join(mainDir, 'keep.txt'), 'source file');
  mkdirSync(join(mainDir, '.stim', 'logs'), { recursive: true });
  writeFileSync(join(mainDir, '.stim', 'state.json'), '{}');
  ensureWorkspaceStorage(mainDir);
  writeFileSync(join(workspaceDir(mainDir), 'state.json'), '{}');
  const exec = makeExecutor({
    worktrees: porcelain([{ path: mainDir, branch: 'main' }]),
    simctlList: simctlJson([{ udid: 'U9', name: 'stim-main', state: 'Shutdown', isAvailable: true }]),
    mainTrees: [mainDir],
  });
  setExecutor(exec);

  const errs: string[] = [];
  const original = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    const run = captureAction(registerRemove);
    await run(mainDir, {});
  } finally {
    console.error = original;
  }

  expect(process.exitCode).not.toBe(1);
  expect(exec.calls.run.some((c) => /xcrun simctl delete U9/.test(c))).toBeTruthy();
  expect(getProject(mainDir)).toBe(null);
  expect(existsSync(join(mainDir, '.stim'))).toBe(true);
  expect(existsSync(workspaceDir(mainDir))).toBe(false);
  expect(readFileSync(join(mainDir, 'keep.txt'), 'utf-8')).toBe('source file');
  expect(![...exec.calls.run, ...exec.calls.runQuiet].some((c) => /worktree remove/.test(c))).toBeTruthy();
  expect(errs.join('\n')).toMatch(/working tree stays \(it is the main checkout\)/);
});

test('action: a dirty main checkout still reclaims, without a refusal and without mentioning the dirt', async () => {
  upsertProject(mainDir, { metroPort: 8084 });
  writeFileSync(join(mainDir, 'uncommitted.txt'), 'not yet committed');
  const exec = makeExecutor({
    dirty: ' M src/app.js\n?? uncommitted.txt\n',
    worktrees: porcelain([{ path: mainDir, branch: 'main' }]),
    mainTrees: [mainDir],
  });
  setExecutor(exec);

  const errs: string[] = [];
  const original = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    const run = captureAction(registerRemove);
    await run(mainDir, {});
  } finally {
    console.error = original;
  }

  expect(process.exitCode).not.toBe(1);
  expect(getProject(mainDir)).toBe(null);
  expect(readFileSync(join(mainDir, 'uncommitted.txt'), 'utf-8')).toBe('not yet committed');
  const text = errs.join('\n');
  expect(text).not.toMatch(/Refusing/);
  expect(text).not.toMatch(/uncommitted/);
  expect(!exec.calls.runQuiet.some((c) => /status --porcelain/.test(c))).toBeTruthy();
  expect(text).toMatch(/working tree stays/);
});

test('action: --force changes nothing on the main checkout -- reclaim only, tree stays', async () => {
  upsertProject(mainDir, { metroPort: 8085 });
  writeFileSync(join(mainDir, 'keep.txt'), 'source file');
  const exec = makeExecutor({
    worktrees: porcelain([{ path: mainDir, branch: 'main' }]),
    mainTrees: [mainDir],
  });
  setExecutor(exec);

  const errs: string[] = [];
  const original = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    const run = captureAction(registerRemove);
    await run(mainDir, { force: true });
  } finally {
    console.error = original;
  }

  expect(process.exitCode).not.toBe(1);
  expect(getProject(mainDir)).toBe(null);
  expect(readFileSync(join(mainDir, 'keep.txt'), 'utf-8')).toBe('source file');
  expect(![...exec.calls.run, ...exec.calls.runQuiet].some((c) => /worktree remove/.test(c))).toBeTruthy();
  expect(errs.join('\n')).toMatch(/working tree stays/);
});

test('action: a failed device teardown on the main checkout keeps the record and exits 1', async () => {
  upsertProject(mainDir, {
    metroPort: 8086,
    platforms: { ios: { deviceUdid: 'U7', owned: true, deviceName: 'stim-held' } },
  });
  const exec = makeExecutor({
    worktrees: porcelain([{ path: mainDir, branch: 'main' }]),
    simctlList: simctlJson([{ udid: 'U7', name: 'stim-held', state: 'Shutdown', isAvailable: true }]),
    mainTrees: [mainDir],
  });
  const originalRun = exec.run.bind(exec);
  exec.run = (cmd: string) => {
    if (/simctl delete U7/.test(cmd)) throw new Error('Unable to delete');
    return originalRun(cmd);
  };
  setExecutor(exec);

  const errs: string[] = [];
  const original = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    const run = captureAction(registerRemove);
    await run(mainDir, {});
  } finally {
    console.error = original;
  }

  expect(process.exitCode).toBe(1);
  expect(getProject(mainDir)).not.toBe(null);
  expect(errs.join('\n')).toMatch(/still tracks/);
});

test('action: a tunnel verification failure on the main checkout retains its state directory', async () => {
  const child = liveUnrelatedProcess();
  upsertProject(mainDir, { label: 'main' });
  writeManagedTunnel(mainDir, child.pid!);
  const exec = makeExecutor({
    worktrees: porcelain([{ path: mainDir, branch: 'main' }]),
    mainTrees: [mainDir],
  });
  setExecutor(exec);

  const errs: string[] = [];
  const original = console.error;
  console.error = (message) => errs.push(String(message));
  try {
    const run = captureAction(registerRemove);
    await run(mainDir, {});
  } finally {
    console.error = original;
  }

  expect(process.exitCode).toBe(1);
  expect(getProject(mainDir)).not.toBeNull();
  expect(existsSync(workspaceStateFile(mainDir))).toBe(true);
  expect(errs.join('\n')).toMatch(/could not release owned resources/i);
  expect(errs.join('\n')).toMatch(/identity could not be verified/i);
  expect(errs.join('\n')).not.toMatch(new RegExp(`kill\\s+${child.pid}`));
  expect(exec.calls.run.some((call) => /worktree remove/.test(call))).toBe(false);
  await expect(withManagedTunnelLock(mainDir, async () => true)).resolves.toBe(true);
});

test('action: main-checkout artifact deletion blocks a concurrent replacement tunnel start', async () => {
  upsertProject(mainDir, { label: 'main' });
  ensureWorkspaceStorage(mainDir);
  writeFileSync(workspaceStateFile(mainDir), '{}');
  setExecutor(
    makeExecutor({
      worktrees: porcelain([{ path: mainDir, branch: 'main' }]),
      mainTrees: [mainDir],
    }),
  );
  let competingStart: Promise<'started' | 'refused'> | null = null;
  const original = console.error;
  console.error = (message) => {
    if (/^\s*workspace\s+removed\s/.test(String(message))) {
      competingStart = withManagedRemoteWorktreeLock(mainDir, async () => {
        ensureWorkspaceStorage(mainDir);
        writeFileSync(workspaceStateFile(mainDir), JSON.stringify({ metroTunnel: { pid: 5252 } }));
      }).then(
        () => 'started',
        () => 'refused',
      );
    }
  };
  try {
    const run = captureAction(registerRemove);
    await run(mainDir, {});
  } finally {
    console.error = original;
  }

  expect(competingStart).not.toBeNull();
  await expect(competingStart).resolves.toBe('refused');
  expect(existsSync(workspaceStateFile(mainDir))).toBe(false);
});

test('action: a registered project directory that is not a git repo gets the same environment reclaim', async () => {
  upsertProject(wtDir, {
    metroPort: 8087,
    platforms: { ios: { deviceUdid: 'U8', owned: true, deviceName: 'stim-plain' } },
  });
  writeFileSync(join(wtDir, 'keep.txt'), 'source file');
  mkdirSync(join(wtDir, '.stim'), { recursive: true });
  writeFileSync(join(wtDir, '.stim', 'state.json'), '{}');
  const exec = makeExecutor({
    worktrees: null,
    simctlList: simctlJson([{ udid: 'U8', name: 'stim-plain', state: 'Shutdown', isAvailable: true }]),
  });
  setExecutor(exec);

  const errs: string[] = [];
  const original = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    const run = captureAction(registerRemove);
    await run(wtDir, {});
  } finally {
    console.error = original;
  }

  expect(process.exitCode).not.toBe(1);
  expect(exec.calls.run.some((c) => /xcrun simctl delete U8/.test(c))).toBeTruthy();
  expect(getProject(wtDir)).toBe(null);
  expect(existsSync(join(wtDir, '.stim'))).toBe(true);
  expect(readFileSync(join(wtDir, 'keep.txt'), 'utf-8')).toBe('source file');
  expect(errs.join('\n')).toMatch(/working tree stays \(it is not a git repository\)/);
});

test('action: refuses when git cannot answer the status check, leaving config untouched', async () => {
  upsertProject(wtDir, { metroPort: 8082 });
  const before = getProject(wtDir);
  const exec = makeExecutor({
    dirty: null,
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'feat-x' },
    ]),
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  expect(process.exitCode).toBe(1);
  expect(getProject(wtDir)).toEqual(before);
  expect(!exec.calls.run.some((c) => /worktree remove/.test(c))).toBeTruthy();
});

test('action: on success, ownership state stays until removeWorktree succeeds', async () => {
  upsertProject(wtDir, { metroPort: 8083 });
  const exec = makeExecutor({
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'feat-x' },
    ]),
  });
  let trackedWhenRemoved = true;
  const originalRunFile = exec.runFile.bind(exec);
  exec.runFile = (file, args = []) => {
    if (/worktree remove/.test([file, ...args].join(' '))) {
      trackedWhenRemoved = getProject(wtDir) !== null;
    }
    return originalRunFile(file, args);
  };
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  expect(process.exitCode).not.toBe(1);
  expect(trackedWhenRemoved).toBe(true);
  expect(getProject(wtDir)).toBe(null);
  expect(exec.calls.run.some((c) => /worktree remove/.test(c))).toBeTruthy();
});

test('action: removes the branch that Stim created when it has no unique commits', async () => {
  upsertProject(wtDir, {
    worktreeRoot: true,
    worktreeBranch: 'worktree-feat-x',
    worktreeBranchOwned: true,
    worktreeMainRoot: mainDir,
  });
  const exec = makeExecutor({
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'worktree-feat-x' },
    ]),
    mainTrees: [mainDir],
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  expect(process.exitCode).not.toBe(1);
  expect(exec.calls.run.some((call) => /update-ref -d refs\/heads\/worktree-feat-x abc123/.test(call))).toBe(true);
});

test('action: on success, prints only the label-column vocabulary on stderr and nothing on stdout', async () => {
  upsertProject(wtDir, {
    worktreeRoot: true,
    worktreeBranch: 'worktree-feat-x',
    worktreeBranchOwned: true,
    worktreeMainRoot: mainDir,
    platforms: { ios: { deviceUdid: 'U1', owned: true, deviceName: 'stim-x' } },
  });
  ensureWorkspaceStorage(wtDir);
  writeFileSync(join(workspaceDir(wtDir), 'state.json'), '{}');
  expect(takeLease({ root: wtDir, platform: 'android', id: 'R5CT', kind: 'run' }).status).toBe('taken');
  const exec = makeExecutor({
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'worktree-feat-x' },
    ]),
    mainTrees: [mainDir],
    simctlList: simctlJson([{ udid: 'U1', name: 'stim-x', state: 'Shutdown', isAvailable: true }]),
  });
  setExecutor(exec);

  const logs: string[] = [];
  const errs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (m) => logs.push(String(m));
  console.error = (m) => errs.push(String(m));
  try {
    const run = captureAction(registerRemove);
    await run(wtDir, {});
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  expect(process.exitCode).not.toBe(1);
  expect(logs).toEqual([]);
  expect(errs.some((line) => /^\s*device\s+deleted stim-x$/.test(line))).toBe(true);
  expect(errs.some((line) => /^\s*workspace\s+removed /.test(line))).toBe(true);
  expect(errs.some((line) => /^\s*branch\s+deleted worktree-feat-x$/.test(line))).toBe(true);
  expect(
    errs.some((line) => /^\s*lease\s+released the android lease on R5CT \(it ran until \d{2}:\d{2}:\d{2}\)/.test(line)),
  ).toBe(true);
  expect(errs.some((line) => new RegExp(`^\\s*removed\\s+${wtDir}$`).test(line))).toBe(true);
});

test('action: keeps a branch that existed before Stim attached the worktree', async () => {
  upsertProject(wtDir, {
    worktreeRoot: true,
    worktreeBranch: 'worktree-feat-x',
    worktreeBranchOwned: false,
  });
  const exec = makeExecutor({
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'worktree-feat-x' },
    ]),
    mainTrees: [mainDir],
  });
  setExecutor(exec);

  const errs: string[] = [];
  const original = console.error;
  console.error = (message) => errs.push(String(message));
  try {
    const run = captureAction(registerRemove);
    await run(wtDir, {});
  } finally {
    console.error = original;
  }

  expect(process.exitCode).not.toBe(1);
  expect(exec.calls.run.some((call) => /branch -D/.test(call))).toBe(false);
  expect(errs.some((line) => /branch\s+kept worktree-feat-x \(Stim did not create it\)/.test(line))).toBe(true);
});

test('action: force removal keeps an owned branch that has unique commits', async () => {
  upsertProject(wtDir, {
    worktreeRoot: true,
    worktreeBranch: 'worktree-feat-x',
    worktreeBranchOwned: true,
  });
  const exec = makeExecutor({
    unpushed: 'abc123 unique work',
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'worktree-feat-x' },
    ]),
    mainTrees: [mainDir],
  });
  setExecutor(exec);

  const errs: string[] = [];
  const original = console.error;
  console.error = (message) => errs.push(String(message));
  try {
    const run = captureAction(registerRemove);
    await run(wtDir, { force: true });
  } finally {
    console.error = original;
  }

  expect(process.exitCode).not.toBe(1);
  expect(exec.calls.run.some((call) => /worktree remove --force/.test(call))).toBe(true);
  expect(exec.calls.run.some((call) => /branch -D/.test(call))).toBe(false);
  expect(errs.some((line) => /branch\s+kept worktree-feat-x \(it has 1 unique commit/.test(line))).toBe(true);
});

test('action: a branch deletion failure keeps ownership state and exits unsuccessfully', async () => {
  upsertProject(wtDir, {
    worktreeRoot: true,
    worktreeBranch: 'worktree-feat-x',
    worktreeBranchOwned: true,
    worktreeMainRoot: mainDir,
  });
  const exec = makeExecutor({
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'worktree-feat-x' },
    ]),
    mainTrees: [mainDir],
    branchDeleteError: 'branch is locked',
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  expect(process.exitCode).toBe(1);
  expect(getProject(wtDir)).toMatchObject({
    worktreeBranch: 'worktree-feat-x',
    worktreeBranchOwned: true,
    worktreeRemovalComplete: true,
    worktreePendingBranchSha: 'abc123',
  });

  rmSync(wtDir, { recursive: true, force: true });
  process.exitCode = 0;
  const changedExec = makeExecutor({ refSha: 'def456' });
  const changedRunQuiet = changedExec.runQuiet.bind(changedExec);
  changedExec.runQuiet = (cmd) => {
    if (/rev-parse --verify --quiet/.test(cmd)) return 'def456';
    return changedRunQuiet(cmd);
  };
  setExecutor(changedExec);

  await run(wtDir, {});

  expect(process.exitCode).toBe(1);
  expect(changedExec.calls.run.some((call) => /branch -D/.test(call))).toBe(false);
  expect(getProject(wtDir)).not.toBe(null);

  process.exitCode = 0;
  const retryExec = makeExecutor({ refSha: 'abc123' });
  const originalRunQuiet = retryExec.runQuiet.bind(retryExec);
  retryExec.runQuiet = (cmd) => {
    if (/rev-parse --verify --quiet/.test(cmd)) return 'abc123';
    return originalRunQuiet(cmd);
  };
  setExecutor(retryExec);

  await run(wtDir, {});

  expect(process.exitCode).not.toBe(1);
  expect(retryExec.calls.run.some((call) => /update-ref -d refs\/heads\/worktree-feat-x abc123/.test(call))).toBe(true);
  expect(getProject(wtDir)).toBe(null);
});

test('action: pending cleanup keeps a branch that another worktree checks out', async () => {
  upsertProject(wtDir, {
    worktreeRoot: true,
    worktreeBranch: 'worktree-feat-x',
    worktreeBranchOwned: true,
    worktreeMainRoot: mainDir,
    worktreeRemovalComplete: true,
    worktreePendingBranchSha: 'abc123',
  });
  rmSync(wtDir, { recursive: true, force: true });
  const exec = makeExecutor({
    worktrees: porcelain([{ path: mainDir, branch: 'worktree-feat-x' }]),
    mainTrees: [mainDir],
  });
  const originalRunQuiet = exec.runQuiet.bind(exec);
  exec.runQuiet = (cmd) => {
    if (/rev-parse --verify --quiet/.test(cmd)) return 'abc123';
    return originalRunQuiet(cmd);
  };
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  expect(process.exitCode).toBe(1);
  expect(exec.calls.run.some((call) => /update-ref -d/.test(call))).toBe(false);
  expect(getProject(wtDir)).not.toBe(null);
});

test('action: a worktree deletion failure keeps ownership state', async () => {
  upsertProject(wtDir, {
    worktreeRoot: true,
    worktreeBranch: 'worktree-feat-x',
    worktreeBranchOwned: true,
  });
  const exec = makeExecutor({
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'worktree-feat-x' },
    ]),
    mainTrees: [mainDir],
    worktreeRemoveError: 'worktree is locked',
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  expect(process.exitCode).toBe(1);
  expect(getProject(wtDir)).toMatchObject({
    worktreeBranch: 'worktree-feat-x',
    worktreeBranchOwned: true,
  });
});

test('action: tunnel verification failure retains state and refuses worktree removal even with force', async () => {
  const child = liveUnrelatedProcess();
  upsertProject(wtDir, { label: 'feature' });
  writeManagedTunnel(wtDir, child.pid!);
  const exec = makeExecutor({
    dirty: '',
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'feat-x' },
    ]),
  });
  setExecutor(exec);

  const errs: string[] = [];
  const original = console.error;
  console.error = (message) => errs.push(String(message));
  try {
    const run = captureAction(registerRemove);
    await run(wtDir, { force: true });
  } finally {
    console.error = original;
  }

  expect(process.exitCode).toBe(1);
  expect(getProject(wtDir)).not.toBeNull();
  expect(existsSync(workspaceStateFile(wtDir))).toBe(true);
  expect(exec.calls.run.some((call) => /worktree remove/.test(call))).toBe(false);
  expect(errs.join('\n')).toMatch(/Refusing to remove/);
  expect(errs.join('\n')).toMatch(/identity could not be verified/i);
  expect(errs.join('\n')).not.toMatch(new RegExp(`kill\\s+${child.pid}`));
  await expect(withManagedTunnelLock(wtDir, async () => true)).resolves.toBe(true);
});

test('action: a missing recorded tunnel does not block normal worktree removal', async () => {
  upsertProject(wtDir, { label: 'feature' });
  writeManagedTunnel(wtDir, 99_999_999);
  const exec = makeExecutor({
    dirty: '',
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'feat-x' },
    ]),
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  expect(process.exitCode).not.toBe(1);
  expect(getProject(wtDir)).toBeNull();
  expect(existsSync(workspaceDir(wtDir))).toBe(false);
  expect(exec.calls.run.some((call) => /worktree remove/.test(call))).toBe(true);
});

test('action: a retained EAS session prevents generic worktree removal', async () => {
  upsertProject(wtDir, { label: 'feature' });
  writeRemoteSession(wtDir, 'drs_retained');
  const exec = makeExecutor({
    dirty: '',
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'feat-x' },
    ]),
  });
  setExecutor(exec);

  const errs: string[] = [];
  const original = console.error;
  console.error = (message) => errs.push(String(message));
  try {
    const run = captureAction(registerRemove);
    await run(wtDir, {});
  } finally {
    console.error = original;
  }

  expect(process.exitCode).toBe(1);
  expect(getProject(wtDir)).not.toBeNull();
  expect(existsSync(workspaceStateFile(wtDir))).toBe(true);
  expect(exec.calls.run.some((call) => /worktree remove/.test(call))).toBe(false);
  expect(errs.join('\n')).toContain('eas simulator:stop --id drs_retained');
});

test('action: reclaims a nested monorepo app-dir project registered under the worktree root, not just the root itself', async () => {
  const nestedDir = join(wtDir, 'apps', 'mobile');
  upsertProject(wtDir, { metroPort: null, worktreeRoot: true });
  upsertProject(nestedDir, { metroPort: 8085, platforms: { ios: { deviceUdid: 'UDID-1' } } });
  const exec = makeExecutor({
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'feat-x' },
    ]),
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  expect(process.exitCode).not.toBe(1);
  expect(getProject(wtDir)).toBe(null);
  expect(getProject(nestedDir)).toBe(null);
});

test('action: on success, deletes an owned iOS sim via simctl', async () => {
  upsertProject(wtDir, {
    metroPort: 8090,
    platforms: { ios: { deviceUdid: 'U1', owned: true, deviceName: 'stim-x' } },
  });
  const exec = makeExecutor({
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'feat-x' },
    ]),
    simctlList: simctlJson([{ udid: 'U1', name: 'stim-x', state: 'Shutdown', isAvailable: true }]),
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  expect(process.exitCode).not.toBe(1);
  expect(exec.calls.run.some((c) => /xcrun simctl delete U1/.test(c))).toBeTruthy();
  expect(getProject(wtDir)).toBe(null);
});

test('action: reaps owned sims under two nested monorepo app-dir keys, both of them', async () => {
  const nestedDir1 = join(wtDir, 'apps', 'mobile1');
  const nestedDir2 = join(wtDir, 'apps', 'mobile2');
  upsertProject(wtDir, { metroPort: null, worktreeRoot: true });
  upsertProject(nestedDir1, {
    metroPort: 8092,
    platforms: { ios: { deviceUdid: 'U3', owned: true, deviceName: 'stim-a' } },
  });
  upsertProject(nestedDir2, {
    metroPort: 8093,
    platforms: { ios: { deviceUdid: 'U4', owned: true, deviceName: 'stim-b' } },
  });
  const exec = makeExecutor({
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'feat-x' },
    ]),
    simctlList: simctlJson([
      { udid: 'U3', name: 'stim-a', state: 'Shutdown', isAvailable: true },
      { udid: 'U4', name: 'stim-b', state: 'Shutdown', isAvailable: true },
    ]),
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  expect(process.exitCode).not.toBe(1);
  expect(exec.calls.run.some((c) => /xcrun simctl delete U3/.test(c))).toBeTruthy();
  expect(exec.calls.run.some((c) => /xcrun simctl delete U4/.test(c))).toBeTruthy();
  expect(getProject(nestedDir1)).toBe(null);
  expect(getProject(nestedDir2)).toBe(null);
});

test('action: an occupied owned sim is deleted with the rest -- the environment dies whole', async () => {
  const nestedDir1 = join(wtDir, 'apps', 'mobile1');
  const nestedDir2 = join(wtDir, 'apps', 'mobile2');
  upsertProject(wtDir, { metroPort: null, worktreeRoot: true });
  upsertProject(nestedDir1, {
    metroPort: 8094,
    platforms: { ios: { deviceUdid: 'U5', owned: true, deviceName: 'stim-c' } },
  });
  upsertProject(nestedDir2, {
    metroPort: 8095,
    platforms: { ios: { deviceUdid: 'U6', owned: true, deviceName: 'stim-d' } },
  });
  const exec = makeExecutor({
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'feat-x' },
    ]),
    simctlList: simctlJson([
      { udid: 'U5', name: 'stim-c', state: 'Booted', isAvailable: true },
      { udid: 'U6', name: 'stim-d', state: 'Shutdown', isAvailable: true },
    ]),
    occupied: { U5: true },
  });
  setExecutor(exec);

  const errs: string[] = [];
  const original = console.error;
  console.error = (msg) => errs.push(String(msg));
  const run = captureAction(registerRemove);
  try {
    await run(wtDir, {});
  } finally {
    console.error = original;
  }

  expect(process.exitCode).not.toBe(1);
  expect(exec.calls.run.some((c) => /worktree remove/.test(c))).toBeTruthy();

  expect(exec.calls.run.some((c) => /xcrun simctl delete U5/.test(c))).toBeTruthy();
  expect(exec.calls.run.some((c) => /xcrun simctl delete U6/.test(c))).toBeTruthy();

  expect(getProject(nestedDir1)).toBe(null);
  expect(getProject(nestedDir2)).toBe(null);

  expect(!errs.some((l) => /kept .*device|kept .*sim/i.test(l))).toBeTruthy();
});

test('action: a project-local .stim directory is ordinary dirt and refuses removal', async () => {
  upsertProject(wtDir, { metroPort: 8090 });
  const exec = makeExecutor({
    dirty: '?? .stim/\n',
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'feat-x' },
    ]),
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  expect(process.exitCode).toBe(1);
  expect(!exec.calls.run.some((c) => /worktree remove/.test(c))).toBeTruthy();
  expect(getProject(wtDir)).not.toBe(null);
});

test('action: real work beside .stim/ refuses and names every dirty path', async () => {
  upsertProject(wtDir, { metroPort: 8091 });
  const exec = makeExecutor({
    dirty: '?? .stim/\n M src/app.js\n?? scratch.txt\n',
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'feat-x' },
    ]),
  });
  setExecutor(exec);

  const errs: string[] = [];
  const original = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    const run = captureAction(registerRemove);
    await run(wtDir, {});
  } finally {
    console.error = original;
  }

  expect(process.exitCode).toBe(1);
  expect(!exec.calls.run.some((c) => /worktree remove/.test(c))).toBeTruthy();
  const text = errs.join('\n');
  expect(text).toMatch(/checkout --/);
  expect(text).toMatch(/clean -fd/);
  expect(text.includes('.stim/')).toBeTruthy();
});

test('action: Stim never deletes a project-local .stim directory', async () => {
  upsertProject(wtDir, { metroPort: 8092 });
  mkdirSync(join(wtDir, '.stim', 'logs'), { recursive: true });
  writeFileSync(join(wtDir, '.stim', 'state.json'), '{}');
  const exec = makeExecutor({
    dirty: '?? .stim/\n',
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'feat-x' },
    ]),
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  expect(existsSync(join(wtDir, '.stim'))).toBe(true);
  expect(process.exitCode).toBe(1);
});

test('action: a concurrent tunnel start cannot publish a replacement during worktree removal', async () => {
  upsertProject(wtDir, { metroPort: 8092 });
  ensureWorkspaceStorage(wtDir);
  writeFileSync(workspaceStateFile(wtDir), '{}');
  const exec = makeExecutor({
    dirty: '',
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'feat-x' },
    ]),
  });
  let competingStart: Promise<'started' | 'refused'> | null = null;
  const originalRunFile = exec.runFile.bind(exec);
  exec.runFile = (file, args = []) => {
    if (/worktree remove/.test([file, ...args].join(' '))) {
      competingStart = withManagedRemoteWorktreeLock(wtDir, async () => {
        ensureWorkspaceStorage(wtDir);
        writeFileSync(workspaceStateFile(wtDir), JSON.stringify({ metroTunnel: { pid: 5252 } }));
      }).then(
        () => 'started',
        () => 'refused',
      );
    }
    return originalRunFile(file, args);
  };
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  expect(competingStart).not.toBeNull();
  await expect(competingStart).resolves.toBe('refused');
  expect(existsSync(workspaceStateFile(wtDir))).toBe(false);
});

test('the worktree removal lock lives outside project workspace state', async () => {
  const key = createHash('sha256').update(resolve(wtDir)).digest('hex');
  const owner = join(tmpHome, 'process-locks', 'worktrees', key, 'managed-remote.lock', 'owner.json');

  await withManagedRemoteWorktreeLock(wtDir, async () => {
    expect(existsSync(owner)).toBe(true);
  });
});

test('action: an unregistered nested remote start cannot bypass the worktree removal lock', async () => {
  const nestedDir = join(wtDir, 'apps', 'new-mobile');
  mkdirSync(nestedDir, { recursive: true });
  writeFileSync(join(nestedDir, 'package.json'), JSON.stringify({ name: 'new-mobile' }));
  upsertProject(wtDir, { metroPort: null, worktreeRoot: true });
  const exec = makeExecutor({
    dirty: '',
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'feat-x' },
    ]),
  });
  const originalRunQuiet = exec.runQuiet.bind(exec);
  exec.runQuiet = (cmd) => {
    if (cmd.includes('rev-parse --show-toplevel')) return wtDir;
    return originalRunQuiet(cmd);
  };
  let nestedStart: Promise<void> | null = null;
  const originalRunFile = exec.runFile.bind(exec);
  const originalExit = process.exit;
  exec.runFile = (file, args = []) => {
    if (/worktree remove/.test([file, ...args].join(' '))) {
      const originalCwd = process.cwd();
      process.chdir(nestedDir);
      try {
        const runStart = captureStartAction({
          providers: () => ['ngrok'],
          startTunnelSequence: async () => ({
            provider: 'ngrok',
            url: 'https://replacement.ngrok.app',
            pid: 5252,
            processToken: 'linux:200',
            cleanup: async () => ({ status: 'stopped' }),
          }),
          writeTunnelRecord: (projectRoot, patch) => {
            writeFileSync(workspaceStateFile(projectRoot), JSON.stringify(patch));
            throw new Error('stop after attempted publication');
          },
        });
        nestedStart = Promise.resolve(runStart({ remote: true, wait: '1', json: true })).catch(() => {});
      } finally {
        process.chdir(originalCwd);
      }
    }
    return originalRunFile(file, args);
  };
  process.exit = asProcessExit(() => {});
  setExecutor(exec);

  try {
    const run = captureAction(registerRemove);
    await run(wtDir, {});
    expect(nestedStart).not.toBeNull();
    await nestedStart;
  } finally {
    process.exit = originalExit;
  }

  expect(getProject(nestedDir)).toBeNull();
  expect(existsSync(workspaceStateFile(nestedDir))).toBe(false);
  await expect(withManagedRemoteWorktreeLock(wtDir, async () => 'released')).resolves.toBe('released');
});

test('action: a dirty path escaping the worktree is never removed', async () => {
  upsertProject(wtDir, { metroPort: 8093 });
  const outside = join(mainDir, '.stim');
  mkdirSync(outside, { recursive: true });
  setExecutor(
    makeExecutor({
      dirty: '?? ../stim-test-main-escape/.stim/\n',
      worktrees: porcelain([
        { path: mainDir, branch: 'main' },
        { path: wtDir, branch: 'feat-x' },
      ]),
    }),
  );

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  expect(existsSync(outside)).toBe(true);
});

test('matchWorktreeEntry walks up to the enclosing worktree root', () => {
  const entries = [{ path: '/repo' }, { path: '/repo-worktrees/feat-x' }];
  expect(matchWorktreeEntry(entries, '/repo-worktrees/feat-x')).toEqual({ index: 1, path: '/repo-worktrees/feat-x' });
  expect(matchWorktreeEntry(entries, '/repo-worktrees/feat-x/apps/mobile')).toEqual({
    index: 1,
    path: '/repo-worktrees/feat-x',
  });
  expect(matchWorktreeEntry(entries, '/repo/apps/mobile')).toEqual({ index: 0, path: '/repo' });
  expect(matchWorktreeEntry(entries, '/repo-worktrees/feat-xy')).toBe(null);
  expect(matchWorktreeEntry(entries, '/elsewhere')).toBe(null);
  expect(matchWorktreeEntry([], '/repo')).toBe(null);
});

test('matchWorktreeEntry preserves the matched branch', () => {
  expect(
    matchWorktreeEntry([{ path: '/repo-worktrees/feat-x', branch: 'worktree-feat-x' }], '/repo-worktrees/feat-x'),
  ).toEqual({ index: 0, path: '/repo-worktrees/feat-x', branch: 'worktree-feat-x' });
});

test('action: run from a monorepo app dir, it removes the enclosing worktree', async () => {
  const nestedDir = join(wtDir, 'apps', 'mobile');
  mkdirSync(nestedDir, { recursive: true });
  upsertProject(wtDir, { metroPort: null, worktreeRoot: true });
  upsertProject(nestedDir, { metroPort: 8099 });
  const exec = makeExecutor({
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'feat-x' },
    ]),
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(nestedDir, {});

  expect(process.exitCode).not.toBe(1);
  expect(exec.calls.run.some((c) => c.includes(`worktree remove -- ${wtDir}`))).toBeTruthy();
  expect(getProject(wtDir)).toBe(null);
  expect(getProject(nestedDir)).toBe(null);
});

test('action: a path inside no worktree at all is still refused, pointing at git worktree list', async () => {
  const exec = makeExecutor({ worktrees: porcelain([{ path: mainDir, branch: 'main' }]) });
  setExecutor(exec);

  const errs: string[] = [];
  const original = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    const run = captureAction(registerRemove);
    await run(wtDir, {});
  } finally {
    console.error = original;
  }

  expect(process.exitCode).toBe(1);
  expect(!exec.calls.run.some((c) => /worktree remove/.test(c))).toBeTruthy();
  const text = errs.join('\n');
  expect(text).toMatch(/git worktree list/);
  expect(!/stim worktree list/.test(text)).toBeTruthy();
});

test('action: the dirty-tree remedy names the real worktree, not a placeholder', async () => {
  upsertProject(wtDir, { metroPort: 8100 });
  setExecutor(
    makeExecutor({
      dirty: ' M src/app.js\n?? scratch.txt\n',
      worktrees: porcelain([
        { path: mainDir, branch: 'main' },
        { path: wtDir, branch: 'feat-x' },
      ]),
    }),
  );

  const errs: string[] = [];
  const original = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    const run = captureAction(registerRemove);
    await run(wtDir, {});
  } finally {
    console.error = original;
  }

  expect(process.exitCode).toBe(1);
  const text = errs.join('\n');
  expect(!text.includes('<worktree>')).toBeTruthy();
  expect(!text.includes('git -C <path>')).toBeTruthy();
  expect(text).toMatch(new RegExp(`git -C ${wtDir} checkout --`));
  expect(text).toMatch(new RegExp(`git -C ${wtDir} clean -fd`));
});

test('against a real repo: remove on the main checkout reclaims the environment and leaves the repo intact', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-remove-main-')));
  const repo = join(base, 'repo');
  const errs: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  try {
    mkdirSync(repo, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: repo, encoding: 'utf-8' });
    git('git init -q');
    git('git config user.email test@example.com');
    git('git config user.name test');
    writeFileSync(join(repo, 'package.json'), '{}');
    git('git add -A');
    git('git commit -q -m init');
    writeFileSync(join(repo, 'marker.txt'), 'still here');

    upsertProject(repo, { metroPort: null });
    mkdirSync(join(repo, '.stim', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.stim', 'state.json'), '{}');

    console.error = (m) => errs.push(String(m));
    console.log = () => {};
    const run = captureAction(registerRemove);
    await run(repo, {});
    console.error = originalError;
    console.log = originalLog;

    expect(process.exitCode).not.toBe(1);
    expect(readFileSync(join(repo, 'package.json'), 'utf-8')).toBe('{}');
    expect(readFileSync(join(repo, 'marker.txt'), 'utf-8')).toBe('still here');
    expect(execSync('git rev-parse --is-inside-work-tree', { cwd: repo, encoding: 'utf-8' }).trim()).toBe('true');
    expect(existsSync(join(repo, '.stim'))).toBe(true);
    expect(getProject(repo)).toBe(null);
    expect(errs.join('\n')).toMatch(/working tree stays \(it is the main checkout\)/);
  } finally {
    console.error = originalError;
    console.log = originalLog;
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('excludePodChurn takes the whole set when every dirty path is pod churn', () => {
  const { lines, restore } = excludePodChurn([
    ' M apps/app/ios/Podfile.lock',
    ' M apps/app/ios/Tlon.xcodeproj/project.pbxproj',
  ]);
  expect(lines).toEqual([]);
  expect(restore).toEqual(['apps/app/ios/Podfile.lock', 'apps/app/ios/Tlon.xcodeproj/project.pbxproj']);
});

test('excludePodChurn handles a bare project whose ios/ is at the repo root', () => {
  const { restore } = excludePodChurn([' M ios/Podfile.lock']);
  expect(restore).toEqual(['ios/Podfile.lock']);
});

test('excludePodChurn restores nothing when anything else is dirty alongside', () => {
  const dirty = [' M apps/app/ios/Podfile.lock', ' M apps/app/src/App.tsx'];
  const { lines, restore } = excludePodChurn(dirty);
  expect(lines).toEqual(dirty);
  expect(restore).toEqual([]);
});

test('excludePodChurn refuses an untracked Podfile.lock: checkout cannot restore one', () => {
  const dirty = ['?? apps/app/ios/Podfile.lock'];
  expect(excludePodChurn(dirty)).toEqual({ lines: dirty, restore: [] });
});

test('excludePodChurn refuses a staged change, which checkout would not undo', () => {
  for (const line of ['M  apps/app/ios/Podfile.lock', 'MM apps/app/ios/Podfile.lock', 'A  apps/app/ios/Podfile.lock']) {
    expect(excludePodChurn([line])).toEqual({ lines: [line], restore: [] });
  }
});

test('excludePodChurn does not reach beyond the two files pod install rewrites', () => {
  for (const line of [
    ' M apps/app/android/Podfile.lock',
    ' M apps/app/package-lock.json',
    ' M apps/app/ios.lock/Podfile.lock',
    ' M apps/app/ios/Podfile',
    ' M Podfile.lock',
  ]) {
    expect(excludePodChurn([line]).restore).toEqual([]);
  }
});

test('excludePodChurn leaves a path it could not safely name to the refusal', () => {
  const line = ' M apps/my app/ios/Podfile.lock';
  expect(excludePodChurn([line])).toEqual({ lines: [line], restore: [] });
});

test('excludePodChurn on a clean listing restores nothing', () => {
  expect(excludePodChurn([])).toEqual({ lines: [], restore: [] });
});

function podChurnRepo(base: string, { extraDirt = false }: { extraDirt?: boolean } = {}) {
  const repo = join(base, 'repo');
  const bareRemote = join(base, 'remote.git');
  mkdirSync(bareRemote, { recursive: true });
  execSync(`git init -q --bare "${bareRemote}"`);
  mkdirSync(join(repo, 'apps', 'app', 'ios', 'Tlon.xcodeproj'), { recursive: true });
  const git = (cmd: string) => execSync(cmd, { cwd: repo, encoding: 'utf-8' });
  git('git init -q');
  git('git config user.email test@example.com');
  git('git config user.name test');
  git(`git remote add origin "${bareRemote}"`);
  writeFileSync(join(repo, '.gitignore'), '.stim/\n');
  writeFileSync(join(repo, 'apps', 'app', 'ios', 'Podfile.lock'), 'PODS:\n  - hermes-engine\n');
  writeFileSync(join(repo, 'apps', 'app', 'ios', 'Tlon.xcodeproj', 'project.pbxproj'), '// !$*UTF8*$!\n');
  writeFileSync(join(repo, 'apps', 'app', 'App.tsx'), 'export default 1;\n');
  git('git add -A');
  git('git commit -q -m init');
  git('git push -q -u origin HEAD');
  const wt = join(base, 'wt');
  git(`git worktree add -q "${wt}" -b feat-pods`);

  writeFileSync(
    join(wt, 'apps', 'app', 'ios', 'Podfile.lock'),
    `PODS:\n  - hermes-engine (from \`${wt}/node_modules\`)\n`,
  );
  writeFileSync(join(wt, 'apps', 'app', 'ios', 'Tlon.xcodeproj', 'project.pbxproj'), '// !$*UTF8*$!\n// regenerated\n');
  if (extraDirt) writeFileSync(join(wt, 'apps', 'app', 'App.tsx'), 'export default 2;\n');
  return wt;
}

test('against a real repo: a worktree dirty only with pod-install churn is restored and removed', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-remove-pods-')));
  const originalCwd = process.cwd();
  const errs: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  try {
    const wt = podChurnRepo(base);
    expect(execSync('git status --porcelain', { cwd: wt, encoding: 'utf-8' }).trim()).toBe(
      'M apps/app/ios/Podfile.lock\n M apps/app/ios/Tlon.xcodeproj/project.pbxproj',
    );

    console.error = (m) => errs.push(String(m));
    console.log = () => {};
    const run = captureAction(registerRemove);
    await run(wt, {});
    console.error = originalError;
    console.log = originalLog;

    const text = errs.join('\n');
    expect(process.exitCode).not.toBe(1);
    expect(existsSync(wt)).toBe(false);
    expect(text).toMatch(/restored apps\/app\/ios\/Podfile\.lock \(pod install churn; the worktree is being removed\)/);
    expect(text).toMatch(/restored apps\/app\/ios\/Tlon\.xcodeproj\/project\.pbxproj \(pod install churn/);
  } finally {
    console.error = originalError;
    console.log = originalLog;
    process.chdir(originalCwd);
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('against a real repo: pod churn PLUS a modified source file is refused exactly as before', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-remove-pods-dirty-')));
  const originalCwd = process.cwd();
  const errs: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  try {
    const wt = podChurnRepo(base, { extraDirt: true });
    console.error = (m) => errs.push(String(m));
    console.log = () => {};
    const run = captureAction(registerRemove);
    await run(wt, {});
    console.error = originalError;
    console.log = originalLog;

    const text = errs.join('\n');
    expect(process.exitCode).toBe(1);
    expect(existsSync(wt)).toBe(true);
    expect(text).toMatch(/Refusing to remove/);
    expect(text).toMatch(/App\.tsx/);
    expect(text).not.toMatch(/restored/);
    expect(readFileSync(join(wt, 'apps', 'app', 'ios', 'Podfile.lock'), 'utf-8')).toMatch(/node_modules/);
  } finally {
    console.error = originalError;
    console.log = originalLog;
    process.chdir(originalCwd);
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('action: removal releases this workspace lease and leaves another workspace lease alone', async () => {
  upsertProject(mainDir, { metroPort: 8086 });
  ensureWorkspaceStorage(mainDir);
  expect(takeLease({ root: mainDir, platform: 'ios', id: 'UDID-MINE', kind: 'declared' }).status).toBe('taken');
  expect(takeLease({ root: wtDir, platform: 'android', id: 'R5CT', kind: 'run' }).status).toBe('taken');
  const exec = makeExecutor({
    worktrees: porcelain([{ path: mainDir, branch: 'main' }]),
    mainTrees: [mainDir],
  });
  setExecutor(exec);

  const errs: string[] = [];
  const original = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    const run = captureAction(registerRemove);
    await run(mainDir, {});
  } finally {
    console.error = original;
  }

  expect(process.exitCode).not.toBe(1);
  expect(listLeaseFiles().map((entry) => entry.id)).toEqual(['R5CT']);
  expect(
    errs.some((line) =>
      /^\s*lease\s+released the ios lease on UDID-MINE \(it ran until \d{2}:\d{2}:\d{2}\)/.test(line),
    ),
  ).toBe(true);
});
