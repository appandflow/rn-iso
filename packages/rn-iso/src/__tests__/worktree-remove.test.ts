import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  addsOnlyWorkspaceIgnoreBlock,
  excludePodChurn,
  excludeSelfHealedIgnores,
  excludeWorkspaceArtifacts,
  matchWorktreeEntry,
  porcelainPath,
  removalBlockers,
  registerRemove,
  isOnlyWorkspaceIgnoreBlock,
  removalRemedy,
  workspaceArtifactPaths,
} from '../commands/worktree.ts';
import type { Command } from 'commander';
import { ensureWorkspaceIgnored, renderWorkspaceIgnoreBlock } from '../engine/workspace.ts';
import { setExecutor, resetExecutor } from '../exec.ts';
import { upsertProject, getProject } from '../config.ts';

// The action callback commander invokes: `(target, opts)`. `target` is
// undefined when `worktree remove` is run without its positional argument.
type ActionFn = (target: string | undefined, opts: Record<string, unknown>) => void | Promise<void>;

// The subset of commander's Command that registerRemove chains off of. A real
// Command is assignable to this, so `stub as Command` is a plain widening cast
// (no `as unknown` needed) that lets the stub stand in for the real object.
interface CommandStub {
  command(nameAndArgs?: string): CommandStub;
  description(str?: string): CommandStub;
  option(flags?: string, description?: string): CommandStub;
  action(fn: ActionFn): CommandStub;
}

test('no blockers for a clean worktree', async () => {
  expect(removalBlockers({ dirty: false, unpushed: [] })).toEqual([]);
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

// dirty/unpushed are null (not false/[]) when the underlying git call itself
// failed -- see hasUncommittedWork/unpushedCommits in src/worktree.js. A
// destructive command must fail CLOSED on that: treat "could not determine"
// as its own blocker rather than let it fall through to "clean".
test('reports an indeterminate-status blocker instead of treating it as clean', async () => {
  expect(removalBlockers({ dirty: null, unpushed: [] }).length).toBe(1);
  expect(removalBlockers({ dirty: false, unpushed: null }).length).toBe(1);
  expect(removalBlockers({ dirty: null, unpushed: null })[0]).toMatch(/could not determine/i);
});

// --- the dirty listing: what counts, and what to do about it ----------

test('porcelainPath reads the path out of each status form', () => {
  expect(porcelainPath('?? .rn-iso/')).toBe('.rn-iso/');
  expect(porcelainPath(' M ios/Podfile.lock')).toBe('ios/Podfile.lock');
  expect(porcelainPath('R  old/name.js -> new/name.js')).toBe('new/name.js');
  expect(porcelainPath('?? "we\u00e4rd path"')).toBe('we\u00e4rd path');
  expect(porcelainPath('   ')).toBe(null);
});

// Two real e2e runs dead-ended on `?? .rn-iso/`, with `--force` -- which also
// discards real work -- as the only documented escape. The directory dies with
// the worktree by design, so it never counts.
test('the workspace directory never counts as dirty work, at any depth', () => {
  expect(excludeWorkspaceArtifacts(['?? .rn-iso/'])).toEqual([]);
  expect(excludeWorkspaceArtifacts(['?? apps/mobile/.rn-iso/'])).toEqual([]);
  expect(excludeWorkspaceArtifacts([' M .rn-iso/state.json'])).toEqual([]);
  expect(excludeWorkspaceArtifacts(['?? .rn-iso/', ' M src/app.js'])).toEqual([' M src/app.js']);
  expect(excludeWorkspaceArtifacts(['?? .rn-isolation/'])).toEqual(['?? .rn-isolation/']);
});

// `git worktree remove` runs its OWN cleanliness check, so filtering .rn-iso/
// out of rn-iso's verdict only moved the dead end one step: git then refused
// over the same untracked directory, with --force as its only answer.
test('workspaceArtifactPaths is the complement of the filter, so the two cover every line', () => {
  const lines = ['?? .rn-iso/', ' M src/app.js', '?? apps/mobile/.rn-iso/'];
  expect(workspaceArtifactPaths(lines)).toEqual(['.rn-iso/', 'apps/mobile/.rn-iso/']);
  expect(excludeWorkspaceArtifacts(lines)).toEqual([' M src/app.js']);
  expect(workspaceArtifactPaths(lines).length + excludeWorkspaceArtifacts(lines).length).toBe(lines.length);
});

// The refusal used to offer `git checkout -- <path>` whatever the dirt was.
// That does nothing to an untracked file, so following it produced the identical
// refusal and taught the reader that --force was the only way out.
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

// The one case where "restore and retry" is a complete instruction keeps its
// own lead-in -- but the command under it is built from the paths git named,
// like every other class of dirt.
test('pod-install churn keeps its exact restore command', () => {
  const lines = removalRemedy([' M ios/Podfile.lock', ' M ios/App.xcodeproj/project.pbxproj']).join('\n');
  expect(lines).toMatch(/pod install` rewrites/);
  expect(lines).toMatch(/ios\/Podfile\.lock/);
  expect(lines).not.toMatch(/clean -fd/);
});

// A monorepo's pods do not live at `ios/`. The remedy used to print a
// hardcoded `ios/Podfile.lock ios/*.xcodeproj/project.pbxproj` whatever the
// paths actually were, so in a monorepo it printed a command that fails --
// `error: pathspec 'ios/Podfile.lock' did not match any file(s) known to git` --
// which reads like rn-iso being broken and sends the reader to --force. The
// paths are already in hand and already repo-relative; print those.
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

// A remedy is a command to run, so it carries the paths it is about rather than
// a `<path>...` the reader has to fill in from the listing above it.
test('the remedy carries the paths themselves, capped, quoting what needs it', () => {
  expect(removalRemedy([' M src/app.js', '?? scratch.txt'], { worktree: '/tmp/wt' }).join('\n')).toMatch(
    /checkout -- src\/app\.js/,
  );
  expect(removalRemedy(['?? "we ird.txt"'], { worktree: '/tmp/wt' }).join('\n')).toMatch(/clean -fd "we ird\.txt"/);
  const many = removalRemedy([' M a', ' M b', ' M c', ' M d', ' M e', ' M f'], { worktree: '/tmp/wt' }).join('\n');
  expect(many).toMatch(/checkout -- a b c d e \.\.\./);
  expect(!many.includes('<path>')).toBeTruthy();
});

// --- action-level tests -----------------------------------------------
//
// The pure removalBlockers tests above cover the refusal *decision*, but not
// the wiring: that the action refuses BEFORE reclaimProject runs, and that
// reclaimProject runs BEFORE removeWorktree. Those two orderings are the
// entire point of this task, and nothing above would catch a future
// reordering that broke them -- both tests would still pass unchanged. The
// harness mirrors test/worktree.test.js:53-90 (setExecutor + RN_ISO_HOME);
// registerRemove is driven directly with a stub commander object rather
// than going through bin/cli.js.

function canon(p: string) {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

// Stub of the commander `Command` API: registerRemove chains
// .command().description().option().action(fn) off of whatever it is
// handed, exactly like the real `worktree` subcommand does in
// bin/cli.js. Capturing `fn` is the only way to invoke the action in
// isolation from commander's own arg-parsing.
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

// `dirty`/`unpushed`/`worktrees` are the raw runQuiet return values (a
// string, or null to simulate the underlying git call failing outright).
// `simctlList` backs `xcrun simctl list devices --json` -- deleteIosSim
// looks a udid up there before it will delete it (the rn-iso- name-prefix
// guard), so any test that expects an owned iOS device to actually be
// deleted must list it here.
// `occupied` maps udid -> true to simulate a foreign .xctrunner UI-test
// runner still attached (isSimOccupied's `xcrun simctl spawn <udid>
// launchctl list` probe -- see parseOccupyingApps in src/sim/ios.js).
interface MakeExecutorOptions {
  // dirty/unpushed/worktrees are raw runQuiet returns: a string, or null when
  // the underlying git call itself failed outright.
  dirty?: string | null;
  unpushed?: string | null;
  remote?: string;
  worktrees?: string | null;
  simctlList?: string;
  occupied?: Record<string, boolean>;
  diffs?: Record<string, string>;
  // Paths isMainWorkingTree should report as the MAIN working tree: the
  // `rev-parse --git-dir --git-common-dir` probe answers with two equal lines
  // for them, and fails (null) for everything else -- which is also what real
  // git does for a directory that is not a repo at all.
  mainTrees?: string[];
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
}: MakeExecutorOptions = {}) {
  const runCalls: string[] = [];
  const runQuietCalls: string[] = [];
  const exec = {
    calls: { run: runCalls, runQuiet: runQuietCalls },
    run(cmd: string) {
      runCalls.push(cmd);
      if (/simctl list devices --json/.test(cmd)) return simctlList;
      // deleteIosSim/deleteAvd go through the throwing run() so a failed
      // delete surfaces as { status: 'failed' } instead of a false success.
      if (/simctl delete|delete avd/.test(cmd)) return '';
      throw new Error(`unexpected run: ${cmd}`);
    },
    // `git worktree remove` now goes through runFile (no shell) since it is a
    // destructive command with an interpolated path. Reconstruct the command
    // into the same runCalls log so the assertions below match either form.
    runFile(file: string, args: string[] = []) {
      const cmd = [file, ...args].join(' ');
      runCalls.push(cmd);
      if (/worktree remove/.test(cmd)) return '';
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

// One iOS runtime bucket with the given sims, matching parseSimctlList's
// expected shape (src/sim/ios.js).
function simctlJson(sims: unknown[]) {
  return JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-17-0': sims } });
}

let tmpHome: string, mainDir: string, wtDir: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-home-'));
  process.env.RN_ISO_HOME = tmpHome;
  mainDir = canon(mkdtempSync(join(tmpdir(), 'rn-iso-test-main-')));
  wtDir = canon(mkdtempSync(join(tmpdir(), 'rn-iso-test-wt-')));
});

afterEach(() => {
  resetExecutor();
  process.exitCode = 0;
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(mainDir, { recursive: true, force: true });
  rmSync(wtDir, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

// --- the main checkout: reclaim the environment, never touch the tree -------
//
// `git worktree remove` cannot remove the main working tree, and deleting the
// source tree is not what anyone meant. So on the main checkout (detected by
// `rev-parse --git-dir --git-common-dir` resolving to the same place) `remove`
// does everything the normal removal does to rn-iso's own state -- devices
// deleted, port freed, registry entries dropped, `.rn-iso/` deleted -- and
// leaves every file in the tree alone. This replaced a flat refusal.

test('action: on the main checkout, reclaims the environment with the owned device deleted and the tree untouched', async () => {
  upsertProject(mainDir, {
    metroPort: 8081,
    platforms: { ios: { deviceUdid: 'U9', owned: true, deviceName: 'rn-iso-main' } },
  });
  writeFileSync(join(mainDir, 'keep.txt'), 'source file');
  mkdirSync(join(mainDir, '.rn-iso', 'logs'), { recursive: true });
  writeFileSync(join(mainDir, '.rn-iso', 'state.json'), '{}');
  const exec = makeExecutor({
    worktrees: porcelain([{ path: mainDir, branch: 'main' }]),
    simctlList: simctlJson([{ udid: 'U9', name: 'rn-iso-main', state: 'Shutdown', isAvailable: true }]),
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
  // The reclaim ran with deleteOwnedDevices: the owned sim is actually gone.
  expect(exec.calls.run.some((c) => /xcrun simctl delete U9/.test(c))).toBeTruthy();
  // The registry entry is dropped and the state dir deleted...
  expect(getProject(mainDir)).toBe(null);
  expect(existsSync(join(mainDir, '.rn-iso'))).toBe(false);
  // ...while the tree itself is untouched: the marker survives and no
  // `git worktree remove` was ever issued.
  expect(readFileSync(join(mainDir, 'keep.txt'), 'utf-8')).toBe('source file');
  expect(![...exec.calls.run, ...exec.calls.runQuiet].some((c) => /worktree remove/.test(c))).toBeTruthy();
  expect(errs.join('\n')).toMatch(/working tree stays \(it is the main checkout\)/);
});

// The dirty-tree/unpushed guards protect work in a tree about to be deleted.
// Nothing is deleted here, so they do not apply -- and dirt is not mentioned.
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
  // The guards were never even consulted: nothing asked git for status.
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

// The exit-code rule is the normal removal's: a failed device teardown keeps
// the record (dropping it is what turns a failed teardown into a simulator
// nothing references) and exits 1.
test('action: a failed device teardown on the main checkout keeps the record and exits 1', async () => {
  upsertProject(mainDir, {
    metroPort: 8086,
    platforms: { ios: { deviceUdid: 'U7', owned: true, deviceName: 'rn-iso-held' } },
  });
  const exec = makeExecutor({
    worktrees: porcelain([{ path: mainDir, branch: 'main' }]),
    simctlList: simctlJson([{ udid: 'U7', name: 'rn-iso-held', state: 'Shutdown', isAvailable: true }]),
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

// A registered directory that is not a git repo at all: there is no worktree
// to hand to git and no git status to guard, so environment reclaim is the
// only thing `remove` can mean there -- and it gets exactly that.
test('action: a registered project directory that is not a git repo gets the same environment reclaim', async () => {
  upsertProject(wtDir, {
    metroPort: 8087,
    platforms: { ios: { deviceUdid: 'U8', owned: true, deviceName: 'rn-iso-plain' } },
  });
  writeFileSync(join(wtDir, 'keep.txt'), 'source file');
  mkdirSync(join(wtDir, '.rn-iso'), { recursive: true });
  writeFileSync(join(wtDir, '.rn-iso', 'state.json'), '{}');
  // Every git probe fails: `worktrees: null` is `git worktree list` failing
  // outright, and the mock answers no rev-parse for wtDir.
  const exec = makeExecutor({
    worktrees: null,
    simctlList: simctlJson([{ udid: 'U8', name: 'rn-iso-plain', state: 'Shutdown', isAvailable: true }]),
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
  expect(existsSync(join(wtDir, '.rn-iso'))).toBe(false);
  expect(readFileSync(join(wtDir, 'keep.txt'), 'utf-8')).toBe('source file');
  expect(errs.join('\n')).toMatch(/working tree stays \(it is not a git repository\)/);
});

test('action: refuses when git cannot answer the status check, leaving config untouched', async () => {
  upsertProject(wtDir, { metroPort: 8082 });
  const before = getProject(wtDir);
  const exec = makeExecutor({
    dirty: null, // simulates hasUncommittedWork's runQuiet failing outright
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

test('action: on success, reclaimProject clears rn-iso tracking before removeWorktree runs', async () => {
  upsertProject(wtDir, { metroPort: 8083 });
  const exec = makeExecutor({
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'feat-x' },
    ]),
  });
  // The property this whole task exists to guarantee: by the time `git
  // worktree remove` runs, reclaimProject must already have dropped the
  // config entry. A future reorder (removeWorktree before reclaimProject)
  // would leave the entry present here and fail this assertion, even though
  // every pure removalBlockers test above would still pass unchanged.
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
  expect(trackedWhenRemoved).toBe(false);
  expect(getProject(wtDir)).toBe(null);
  expect(exec.calls.run.some((c) => /worktree remove/.test(c))).toBeTruthy();
});

// Regression: in a monorepo, `rn-iso ios` registers a nested app dir (e.g.
// `<worktree>/apps/mobile`) as its own config key -- a different key from
// the worktree root that `worktree create` registers. That nested key is
// where metroPort and the device claim actually live. Reclaiming only the
// exact `path` argument (the old behaviour) leaves the nested entry, its
// Metro process, and its port claim to leak until `gc --delete` runs.
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

// The environment dies whole: `worktree remove` must reap the owned devices
// registered under it, not just clear rn-iso's tracking for them.
test('action: on success, deletes an owned iOS sim via simctl', async () => {
  upsertProject(wtDir, {
    metroPort: 8090,
    platforms: { ios: { deviceUdid: 'U1', owned: true, deviceName: 'rn-iso-x' } },
  });
  const exec = makeExecutor({
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'feat-x' },
    ]),
    simctlList: simctlJson([{ udid: 'U1', name: 'rn-iso-x', state: 'Shutdown', isAvailable: true }]),
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  expect(process.exitCode).not.toBe(1);
  expect(exec.calls.run.some((c) => /xcrun simctl delete U1/.test(c))).toBeTruthy();
  expect(getProject(wtDir)).toBe(null);
});

// A legacy assignment (`owned` absent) is a device rn-iso did not create --
// its claim is cleared like any other, but the device itself must never be
// shut down or deleted.
test('action: does not delete a legacy (non-owned) iOS device', async () => {
  upsertProject(wtDir, {
    metroPort: 8091,
    platforms: { ios: { deviceUdid: 'U2' } },
  });
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
  // Stronger than checking for the absence of a delete: U2 must never be
  // named in ANY issued command (no shutdown, no occupancy probe, no
  // delete) -- a legacy record is not rn-iso's to touch at all.
  expect(![...exec.calls.run, ...exec.calls.runQuiet].some((c) => c.includes('U2'))).toBeTruthy();
  expect(getProject(wtDir)).toBe(null);
});

// The environment dies whole even in a monorepo: two nested app-dir keys
// under one worktree root, each with their own owned sim, must both be
// reaped by a single `worktree remove` -- not just the first one found.
test('action: reaps owned sims under two nested monorepo app-dir keys, both of them', async () => {
  const nestedDir1 = join(wtDir, 'apps', 'mobile1');
  const nestedDir2 = join(wtDir, 'apps', 'mobile2');
  upsertProject(wtDir, { metroPort: null, worktreeRoot: true });
  upsertProject(nestedDir1, {
    metroPort: 8092,
    platforms: { ios: { deviceUdid: 'U3', owned: true, deviceName: 'rn-iso-a' } },
  });
  upsertProject(nestedDir2, {
    metroPort: 8093,
    platforms: { ios: { deviceUdid: 'U4', owned: true, deviceName: 'rn-iso-b' } },
  });
  const exec = makeExecutor({
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'feat-x' },
    ]),
    simctlList: simctlJson([
      { udid: 'U3', name: 'rn-iso-a', state: 'Shutdown', isAvailable: true },
      { udid: 'U4', name: 'rn-iso-b', state: 'Shutdown', isAvailable: true },
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

// An occupied owned sim (a foreign UI-test runner still attached) must not
// block anything else: the worktree removal still proceeds, the OTHER
// nested project's owned sim is still reaped, and the occupied one comes
// back as a skip rather than aborting the whole command.
test('action: an occupied owned sim is deleted with the rest -- the environment dies whole', async () => {
  const nestedDir1 = join(wtDir, 'apps', 'mobile1');
  const nestedDir2 = join(wtDir, 'apps', 'mobile2');
  upsertProject(wtDir, { metroPort: null, worktreeRoot: true });
  upsertProject(nestedDir1, {
    metroPort: 8094,
    platforms: { ios: { deviceUdid: 'U5', owned: true, deviceName: 'rn-iso-c' } },
  });
  upsertProject(nestedDir2, {
    metroPort: 8095,
    platforms: { ios: { deviceUdid: 'U6', owned: true, deviceName: 'rn-iso-d' } },
  });
  const exec = makeExecutor({
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'feat-x' },
    ]),
    simctlList: simctlJson([
      { udid: 'U5', name: 'rn-iso-c', state: 'Booted', isAvailable: true },
      { udid: 'U6', name: 'rn-iso-d', state: 'Shutdown', isAvailable: true },
    ]),
    occupied: { U5: true },
  });
  setExecutor(exec);

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);
  const run = captureAction(registerRemove);
  try {
    await run(wtDir, {});
  } finally {
    console.log = originalLog;
  }

  // The worktree itself was still removed.
  expect(process.exitCode).not.toBe(1);
  expect(exec.calls.run.some((c) => /worktree remove/.test(c))).toBeTruthy();

  // Both sims go, occupied or not: they are rn-iso's own, created for a project
  // that is being removed, and the holder is almost always the caller's own
  // UI-test runner. Sparing U5 here is what used to leak a booted sim and a
  // live runner out of `worktree remove`.
  expect(exec.calls.run.some((c) => /xcrun simctl delete U5/.test(c))).toBeTruthy();
  expect(exec.calls.run.some((c) => /xcrun simctl delete U6/.test(c))).toBeTruthy();

  // Both config entries are cleared either way -- reclaiming rn-iso's own
  // tracking does not depend on whether the device itself could be torn
  // down.
  expect(getProject(nestedDir1)).toBe(null);
  expect(getProject(nestedDir2)).toBe(null);

  // Nothing is reported as kept: there is no occupied-skip path left for a
  // device being deleted, so no "kept ..." line should appear at all.
  expect(!logs.some((l) => /kept/i.test(l))).toBeTruthy();
});

// The whole field-test failure, end to end: a workspace whose ONLY dirty path is
// its own `.rn-iso/` must remove without --force. Before this it refused, and
// the printed remedy (`git checkout -- <path>`) could not clear an untracked
// directory, so there was no non-destructive way forward at all.
test('action: a tree dirty only with .rn-iso/ removes without --force', async () => {
  upsertProject(wtDir, { metroPort: 8090 });
  const exec = makeExecutor({
    dirty: '?? .rn-iso/\n',
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'feat-x' },
    ]),
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  expect(process.exitCode).not.toBe(1);
  expect(exec.calls.run.some((c) => /worktree remove/.test(c))).toBeTruthy();
  expect(!exec.calls.run.some((c) => /worktree remove --force/.test(c))).toBeTruthy();
  expect(getProject(wtDir)).toBe(null);
});

test('action: real work beside .rn-iso/ still refuses, and names both remedies', async () => {
  upsertProject(wtDir, { metroPort: 8091 });
  const exec = makeExecutor({
    dirty: '?? .rn-iso/\n M src/app.js\n?? scratch.txt\n',
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
  expect(!text.includes('.rn-iso/')).toBeTruthy();
});

// Filtering `.rn-iso/` out of rn-iso's own verdict was only half the fix: `git
// worktree remove` refuses on "modified or untracked files" too, so the
// directory has to be gone before git looks. Verified against real git in the
// live smoke run recorded with this change (CLAUDE.md item 9); this pins the
// wiring.
test('action: the workspace directory is deleted before git worktree remove is called', async () => {
  upsertProject(wtDir, { metroPort: 8092 });
  mkdirSync(join(wtDir, '.rn-iso', 'logs'), { recursive: true });
  writeFileSync(join(wtDir, '.rn-iso', 'state.json'), '{}');
  const exec = makeExecutor({
    dirty: '?? .rn-iso/\n',
    worktrees: porcelain([
      { path: mainDir, branch: 'main' },
      { path: wtDir, branch: 'feat-x' },
    ]),
  });
  // Fail the removal the way real git does when the directory is still there,
  // so the assertion is about ORDER rather than about our own rmSync.
  const originalRunFile = exec.runFile;
  exec.runFile = function (file, args = []) {
    if (/worktree remove/.test([file, ...args].join(' ')) && existsSync(join(wtDir, '.rn-iso'))) {
      throw new Error('fatal: contains modified or untracked files, use --force to delete it');
    }
    return originalRunFile.call(this, file, args);
  };
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  expect(existsSync(join(wtDir, '.rn-iso'))).toBe(false);
  expect(process.exitCode).not.toBe(1);
});

// Containment: a path out of `git status` is relative to the worktree, and
// anything that resolves outside it is left alone whatever it says.
test('action: a dirty path escaping the worktree is never removed', async () => {
  upsertProject(wtDir, { metroPort: 8093 });
  const outside = join(mainDir, '.rn-iso');
  mkdirSync(outside, { recursive: true });
  setExecutor(
    makeExecutor({
      dirty: '?? ../rn-iso-test-main-escape/.rn-iso/\n',
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

// --- item 1: rn-iso's own gitignore self-heal must not dead-end teardown ----
//
// `start` appends the `.rn-iso/` block to a TRACKED .gitignore (that is the
// self-heal that replaced `init`), which shows up as ` M apps/x/.gitignore` and
// refused the teardown -- the same class of dead end as `?? .rn-iso/`, one file
// over: the loop's own write blocking the loop's own exit. It is only ignorable
// when the diff is EXACTLY that block and nothing else, so the fixtures below
// are built from renderWorkspaceIgnoreBlock rather than retyped.

interface IgnoreDiffOptions {
  file?: string;
  added?: string[];
  removed?: string[];
  context?: string[];
}

function ignoreDiff({
  file = 'apps/x/.gitignore',
  added = [],
  removed = [],
  context = ['node_modules/'],
}: IgnoreDiffOptions = {}) {
  return [
    `diff --git a/${file} b/${file}`,
    'index c2658d7..2986a0a 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1,6 @@',
    ...context.map((l) => ` ${l}`),
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    '',
  ].join('\n');
}

// The exact lines ensureWorkspaceIgnored appends, blank separator included.
function ourBlockLines() {
  return [
    '',
    ...renderWorkspaceIgnoreBlock()
      .split('\n')
      .filter((l) => l !== ''),
  ];
}

test('a .gitignore diff that adds only rn-iso own block is recognized as ours', () => {
  expect(addsOnlyWorkspaceIgnoreBlock(ignoreDiff({ added: ourBlockLines() }))).toBe(true);
});

test('one user line beside our block is not ours', () => {
  const added = [...ourBlockLines(), '.env.local'];
  expect(addsOnlyWorkspaceIgnoreBlock(ignoreDiff({ added }))).toBe(false);
});

test('a removed line is never ours, whatever was added', () => {
  const diff = ignoreDiff({ added: ourBlockLines(), removed: ['node_modules/'], context: [] });
  expect(addsOnlyWorkspaceIgnoreBlock(diff)).toBe(false);
});

test('an empty, missing or entry-less diff is not ours', () => {
  expect(addsOnlyWorkspaceIgnoreBlock('')).toBe(false);
  expect(addsOnlyWorkspaceIgnoreBlock(null)).toBe(false);
  expect(
    addsOnlyWorkspaceIgnoreBlock(
      ignoreDiff({ added: ["# rn-iso: this workspace's build output, logs and supervisor pidfile."] }),
    ),
  ).toBe(false);
});

// The other half of the same dead end, and the one a repo with NO .gitignore
// hits: `start` does not MODIFY a file there, it CREATES one, so git reports
// `?? .gitignore` and `worktree remove` refused over an untracked file it had
// written itself. A diff cannot answer this one -- an untracked file has no
// index side -- so the whole content is checked against the block instead, and
// on the same fail-closed rule: one line that is not ours and it stays dirty.
test('a .gitignore that is nothing but rn-iso own block is recognized as ours', () => {
  expect(isOnlyWorkspaceIgnoreBlock(renderWorkspaceIgnoreBlock())).toBe(true);
  expect(isOnlyWorkspaceIgnoreBlock(`\n${renderWorkspaceIgnoreBlock()}\n\n`)).toBe(true);
});

test('anything else in the file is the repo own, and refuses', () => {
  expect(isOnlyWorkspaceIgnoreBlock(`${renderWorkspaceIgnoreBlock()}.env.local\n`)).toBe(false);
  expect(isOnlyWorkspaceIgnoreBlock(`node_modules/\n${renderWorkspaceIgnoreBlock()}`)).toBe(false);
  expect(isOnlyWorkspaceIgnoreBlock('')).toBe(false);
  expect(isOnlyWorkspaceIgnoreBlock(null)).toBe(false);
  expect(isOnlyWorkspaceIgnoreBlock("# rn-iso: this workspace's build output, logs and supervisor pidfile.\n")).toBe(
    false,
  );
});

test('excludeSelfHealedIgnores drops an untracked .gitignore rn-iso wrote whole', () => {
  const read = () => renderWorkspaceIgnoreBlock();
  const result = excludeSelfHealedIgnores(['?? apps/x/.gitignore'], { diff: () => '', read });
  expect(result.lines).toEqual([]);
  expect(result.created).toEqual(['apps/x/.gitignore']);
  expect(result.healed).toEqual([]);

  expect(
    excludeSelfHealedIgnores(['?? apps/x/.gitignore'], {
      diff: () => '',
      read: () => `${renderWorkspaceIgnoreBlock()}.env\n`,
    }).lines,
  ).toEqual(['?? apps/x/.gitignore']);
  expect(excludeSelfHealedIgnores(['?? scratch.txt'], { diff: () => '', read }).lines).toEqual(['?? scratch.txt']);
});

test('excludeSelfHealedIgnores drops only an unstaged .gitignore whose diff is ours', () => {
  const ours = ignoreDiff({ added: ourBlockLines() });
  const seen: string[] = [];
  const diff = (file: string) => {
    seen.push(file);
    return ours;
  };

  const clean = excludeSelfHealedIgnores([' M apps/x/.gitignore'], { diff, read: () => '' });
  expect(clean.lines).toEqual([]);
  expect(clean.healed).toEqual(['apps/x/.gitignore']);
  expect(clean.created).toEqual([]);
  expect(seen).toEqual(['apps/x/.gitignore']);

  // A STAGED change to the same file is a different thing: `git checkout --`
  // would not clear it and git would refuse anyway. Fail closed.
  expect(excludeSelfHealedIgnores(['M  apps/x/.gitignore'], { diff, read: () => '' }).lines).toEqual([
    'M  apps/x/.gitignore',
  ]);
  expect(excludeSelfHealedIgnores([' M src/app.js'], { diff, read: () => '' }).lines).toEqual([' M src/app.js']);
});

test('action: a worktree dirty only with a .gitignore rn-iso created removes, deleting it first', async () => {
  upsertProject(wtDir, { metroPort: 8097 });
  // The real file, because this is the one case decided by CONTENT on disk
  // rather than by a diff git can be asked for.
  writeFileSync(join(wtDir, '.gitignore'), renderWorkspaceIgnoreBlock());
  mkdirSync(join(wtDir, '.rn-iso'), { recursive: true });
  writeFileSync(join(wtDir, '.rn-iso', 'state.json'), '{}');
  setExecutor(
    makeExecutor({
      dirty: '?? .gitignore\n',
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

  expect(process.exitCode).not.toBe(1);
  expect(existsSync(join(wtDir, '.gitignore'))).toBe(false);
  expect(errs.join('\n')).toMatch(/removed \.gitignore \(rn-iso wrote all of it\)/);
});

test('action: a .gitignore with the repo own lines in it still refuses', async () => {
  writeFileSync(join(wtDir, '.gitignore'), `${renderWorkspaceIgnoreBlock()}.env.local\n`);
  setExecutor(
    makeExecutor({
      dirty: '?? .gitignore\n',
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
  expect(existsSync(join(wtDir, '.gitignore'))).toBe(true);
  expect(errs.join('\n')).toMatch(/clean -fd/);
});

test('action: a worktree dirty only with rn-iso own gitignore append removes, restoring the file first', async () => {
  upsertProject(wtDir, { metroPort: 8096 });
  const exec = makeExecutor({
    dirty: ' M apps/x/.gitignore\n',
    diffs: { 'apps/x/.gitignore': ignoreDiff({ added: ourBlockLines() }) },
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

  expect(process.exitCode).not.toBe(1);
  expect(exec.calls.run.some((c) => /worktree remove/.test(c))).toBeTruthy();
  expect(!exec.calls.run.some((c) => /worktree remove --force/.test(c))).toBeTruthy();
  // git runs its OWN cleanliness check, so the file has to be back before it
  // looks -- proven against real git in the integration test below.
  const restore = exec.calls.runQuiet.findIndex((c) => /checkout -- "apps\/x\/\.gitignore"/.test(c));
  expect(restore >= 0).toBeTruthy();
  expect(errs.join('\n')).toMatch(/restoring apps\/x\/\.gitignore \(only rn-iso's own entry was added\)/);
});

test('action: our block plus a user line still refuses', async () => {
  upsertProject(wtDir, { metroPort: 8097 });
  const exec = makeExecutor({
    dirty: ' M apps/x/.gitignore\n',
    diffs: { 'apps/x/.gitignore': ignoreDiff({ added: [...ourBlockLines(), '.env.local'] }) },
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
  expect(errs.join('\n')).toMatch(/apps\/x\/\.gitignore/);
});

test('action: a removed line in the .gitignore still refuses', async () => {
  upsertProject(wtDir, { metroPort: 8098 });
  const exec = makeExecutor({
    dirty: ' M apps/x/.gitignore\n',
    diffs: {
      'apps/x/.gitignore': ignoreDiff({ added: ourBlockLines(), removed: ['node_modules/'], context: [] }),
    },
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
});

// --- item 2: the default path, the remedy placeholders, the dead reference --

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
  expect(!/rn-iso worktree list/.test(text)).toBeTruthy();
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

// --- against real git (CLAUDE.md item 9) -------------------------------------
//
// Everything above runs on a mocked executor, which can prove we composed a
// git-shaped command but not that git accepts it -- and this change turns on
// two things only real git can settle: the exact shape of `git diff` for an
// appended block, and that `git worktree remove` still refuses over the
// modified .gitignore unless it is restored first (it does; that is why the
// verdict is paired with a restore rather than left to die with the directory).
// The gate-run dead end, end to end: a repo with NO .gitignore at all, the real
// `ensureWorkspaceIgnored` writing one, and real git refusing to remove the
// worktree over the untracked file rn-iso itself created. Only real git settles
// whether deleting the file is enough (it is; the .rn-iso/ the entry was hiding
// becomes untracked again the moment it goes, which is why the purge runs a
// second time).
test('against a real repo: a worktree whose only dirt is the .gitignore rn-iso created', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'rn-iso-test-remove-created-')));
  const repo = join(base, 'repo');
  const originalCwd = process.cwd();
  const errs: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  try {
    const bareRemote = join(base, 'remote.git');
    mkdirSync(bareRemote, { recursive: true });
    execSync(`git init -q --bare "${bareRemote}"`);
    mkdirSync(repo, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: repo, encoding: 'utf-8' });
    git('git init -q');
    git('git config user.email test@example.com');
    git('git config user.name test');
    git(`git remote add origin "${bareRemote}"`);
    writeFileSync(join(repo, 'package.json'), '{}');
    git('git add -A');
    git('git commit -q -m init');
    git('git push -q -u origin HEAD');
    const wt = join(base, 'wt');
    git(`git worktree add -q "${wt}" -b feat-created`);

    // Exactly what `start` does, through the real function: the repo has no
    // .gitignore, so one is created -- and it is untracked.
    expect(ensureWorkspaceIgnored(wt).added).toBe(true);
    mkdirSync(join(wt, '.rn-iso', 'logs'), { recursive: true });
    writeFileSync(join(wt, '.rn-iso', 'state.json'), '{}');
    expect(execSync('git status --porcelain', { cwd: wt, encoding: 'utf-8' }).trim()).toBe('?? .gitignore');

    console.error = (m) => errs.push(String(m));
    console.log = () => {};
    const run = captureAction(registerRemove);
    await run(wt, {});
    console.error = originalError;
    console.log = originalLog;

    expect(process.exitCode).not.toBe(1);
    expect(existsSync(wt)).toBe(false);
    expect(errs.join('\n')).toMatch(/removed \.gitignore \(rn-iso wrote all of it\)/);
  } finally {
    console.error = originalError;
    console.log = originalLog;
    process.chdir(originalCwd);
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('against a real repo: removal from a monorepo app dir, dirty only with rn-iso own gitignore append', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'rn-iso-test-remove-live-')));
  const repo = join(base, 'repo');
  const originalCwd = process.cwd();
  const errs: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  try {
    const bareRemote = join(base, 'remote.git');
    mkdirSync(bareRemote, { recursive: true });
    execSync(`git init -q --bare "${bareRemote}"`);
    mkdirSync(join(repo, 'apps', 'x'), { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: repo, encoding: 'utf-8' });
    git('git init -q');
    git('git config user.email test@example.com');
    git('git config user.name test');
    git(`git remote add origin "${bareRemote}"`);
    writeFileSync(join(repo, 'apps', 'x', '.gitignore'), 'node_modules/\n');
    git('git add -A');
    git('git commit -q -m init');
    // Without a remote every commit counts as unpushed and the removal is
    // refused for a reason that has nothing to do with this test.
    git('git push -q -u origin HEAD');
    const wt = join(base, 'wt');
    git(`git worktree add -q "${wt}" -b feat-live`);

    // Exactly what `start` does, through the real writer: the workspace
    // directory, and the gitignore entry that hides it.
    const gitignore = join(wt, 'apps', 'x', '.gitignore');
    writeFileSync(gitignore, `${readFileSync(gitignore, 'utf-8')}\n${renderWorkspaceIgnoreBlock()}`);
    mkdirSync(join(wt, 'apps', 'x', '.rn-iso', 'logs'), { recursive: true });
    writeFileSync(join(wt, 'apps', 'x', '.rn-iso', 'state.json'), '{}');
    expect(execSync('git status --porcelain', { cwd: wt, encoding: 'utf-8' }).trim()).toBe('M apps/x/.gitignore');

    // ...and the removal is run from the app dir, the way an agent does.
    process.chdir(join(wt, 'apps', 'x'));
    console.error = (m) => errs.push(String(m));
    console.log = () => {};
    const run = captureAction(registerRemove);
    await run(undefined, {});
    console.error = originalError;
    console.log = originalLog;
    process.chdir(originalCwd);

    expect(process.exitCode).not.toBe(1);
    expect(existsSync(wt)).toBe(false);
    expect(errs.join('\n')).toMatch(/restoring apps\/x\/\.gitignore/);
  } finally {
    console.error = originalError;
    console.log = originalLog;
    process.chdir(originalCwd);
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

// The main-checkout branch turns on a rev-parse comparison only real git can
// settle (`--git-dir` == `--git-common-dir` in the main tree, and only there).
// A real repo, registered, with uncommitted work: remove must reclaim the
// environment and leave every file -- committed or not -- exactly where it was.
test('against a real repo: remove on the main checkout reclaims the environment and leaves the repo intact', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'rn-iso-test-remove-main-')));
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
    // Uncommitted work on purpose: the dirty guard must not apply here.
    writeFileSync(join(repo, 'marker.txt'), 'still here');

    upsertProject(repo, { metroPort: null });
    mkdirSync(join(repo, '.rn-iso', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.rn-iso', 'state.json'), '{}');

    console.error = (m) => errs.push(String(m));
    console.log = () => {};
    const run = captureAction(registerRemove);
    await run(repo, {});
    console.error = originalError;
    console.log = originalLog;

    expect(process.exitCode).not.toBe(1);
    // The repo survives, files and git registration both...
    expect(readFileSync(join(repo, 'package.json'), 'utf-8')).toBe('{}');
    expect(readFileSync(join(repo, 'marker.txt'), 'utf-8')).toBe('still here');
    expect(execSync('git rev-parse --is-inside-work-tree', { cwd: repo, encoding: 'utf-8' }).trim()).toBe('true');
    // ...while the rn-iso state is gone whole.
    expect(existsSync(join(repo, '.rn-iso'))).toBe(false);
    expect(getProject(repo)).toBe(null);
    expect(errs.join('\n')).toMatch(/working tree stays \(it is the main checkout\)/);
  } finally {
    console.error = originalError;
    console.log = originalLog;
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

// --- pod-install churn is restored, not refused over ------------------------
//
// GATE PROVENANCE (2026-08-24): every `worktree remove` in the release gate
// needed a hand-run `git checkout -- apps/app/ios/Podfile.lock` first. The
// repo's own postinstall runs `pod install`, and th3rdwave's hermes-engine
// podspec bakes the absolute worktree path into Podfile.lock, so the file is
// modified in every worktree the moment dependencies are installed -- before
// any rn-iso command runs. The refusal already NAMED this class (removalRemedy
// prints the checkout command for it); it just made a human paste it.
//
// The refusal exists to protect uncommitted WORK. These files are not work:
// they are about to be destroyed with the worktree either way, and lockfile
// changes anyone intended would have been committed. So the same reasoning
// that restores rn-iso's own .gitignore append applies one file over.

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

// FAIL CLOSED. One file that is not churn and the whole set stays dirty: this
// is the guard against discarding real uncommitted work, and it only holds if
// "mostly churn" is refused exactly like "not churn at all".
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

// `git checkout -- <file>` restores from the INDEX, so a staged change would
// survive it and the tree would still be dirty. Same rule excludeSelfHealedIgnores
// applies to a modified .gitignore.
test('excludePodChurn refuses a staged change, which checkout would not undo', () => {
  for (const line of ['M  apps/app/ios/Podfile.lock', 'MM apps/app/ios/Podfile.lock', 'A  apps/app/ios/Podfile.lock']) {
    expect(excludePodChurn([line])).toEqual({ lines: [line], restore: [] });
  }
});

// The class is named by the two files `pod install` rewrites, under an `ios/`
// directory. A Podfile.lock somewhere else, or any other lockfile, is not this
// class and is not restored.
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

// --- pod churn against real git (CLAUDE.md item 9) --------------------------
//
// The mocked cases above prove the CLASSIFICATION. Only real git settles the
// two things that actually decide whether the gate's hand-run checkout goes
// away: that `git checkout -- <path>` restores the file rn-iso named, and that
// `git worktree remove` -- which runs its OWN cleanliness check and refuses
// over "modified or untracked files" -- is satisfied afterwards.
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
  writeFileSync(join(repo, '.gitignore'), '.rn-iso/\n');
  writeFileSync(join(repo, 'apps', 'app', 'ios', 'Podfile.lock'), 'PODS:\n  - hermes-engine\n');
  writeFileSync(join(repo, 'apps', 'app', 'ios', 'Tlon.xcodeproj', 'project.pbxproj'), '// !$*UTF8*$!\n');
  writeFileSync(join(repo, 'apps', 'app', 'App.tsx'), 'export default 1;\n');
  git('git add -A');
  git('git commit -q -m init');
  git('git push -q -u origin HEAD');
  const wt = join(base, 'wt');
  git(`git worktree add -q "${wt}" -b feat-pods`);

  // What the repo's own postinstall `pod install` does to a fresh worktree:
  // the hermes-engine podspec bakes the absolute path in, so the lockfile is
  // modified before any rn-iso command has run.
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
  const base = canon(mkdtempSync(join(tmpdir(), 'rn-iso-test-remove-pods-')));
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
  const base = canon(mkdtempSync(join(tmpdir(), 'rn-iso-test-remove-pods-dirty-')));
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
    // ...and the churn is still on disk, unrestored: the refusal is the same
    // fail-closed one it has always been.
    expect(readFileSync(join(wt, 'apps', 'app', 'ios', 'Podfile.lock'), 'utf-8')).toMatch(/node_modules/);
  } finally {
    console.error = originalError;
    console.log = originalLog;
    process.chdir(originalCwd);
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});
