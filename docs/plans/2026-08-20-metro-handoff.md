# Metro Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop rn-iso from spawning Metro; keep it allocating the port, and make teardown kill Metro only after positively identifying it as this project's.

**Architecture:** `src/metro.js` is gutted of spawn machinery and re-purposed into a port-to-process identity module. A new `resolveProjectMetro(port, projectPath)` returns a three-outcome result mirroring `resolveOwnedIosSim`, requiring *both* a live `/status` answer and a working directory inside the project before anything is killed. All five kill sites (`stop`, `release`, `shutdown`, `reclaim`, `gc`) route through it. `up` allocates and records the port but never spawns.

**Tech Stack:** Node 20+ ESM, `node --test`, commander, chalk. No new dependencies.

## Global Constraints

- **ESM only.** `"type": "module"`, no transpiler, no `require()`.
- **All `child_process` goes through `src/exec.js`** (`getExecutor()`). Importing `child_process` anywhere outside `exec.js` is a bug. Tests inject via `setExecutor()`.
- **ASCII only in `src/`, `bin/`, `test/`.** No em dashes, smart quotes, or check marks. Markdown files may use them.
- **`RN_ISO_HOME` is the test redirect** for all config/state paths. Every config-touching test sets it in `beforeEach` and deletes it in `afterEach`.
- **Pure logic separate from invocation.** Parsers and decision functions are pure and unit-tested; the I/O wrappers around them are thin.
- **Live-verify anything that shells out.** Mocked-executor tests cannot prove a shell command is correct. Anything touching real `lsof`/`ps`/`kill` needs a real-tool test or a recorded manual verification.
- **Fail closed.** Any guard that cannot get a definite answer must skip, never destroy.
- **Commits:** conventional prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`), titles under ~70 chars. GPG signing is NOT configured; use a plain `git commit` with no `-S` and no `--no-gpg-sign`.
- **Baseline:** 236 tests passing at `34800a5` on `main`. Target version: **0.8.0**.
- Spec: `docs/specs/2026-08-20-metro-handoff-design.md`.

## File Structure

| File | Responsibility after this plan |
|---|---|
| `src/metro.js` | Port-to-process identity and killing. No spawning, no logs. |
| `src/ports.js` | Unchanged. Allocation, reclamation, `isMetroRunning`. |
| `src/commands/stop.js` | Manual entry point for the identity guard, plus `--force`. |
| `src/commands/up.js` | Allocates/records port, does not spawn. |
| `src/commands/start.js` | **Deleted.** |
| `src/commands/logs.js` | **Deleted.** |
| `src/reclaim.js`, `src/commands/{release,shutdown,gc}.js` | Route Metro teardown through the guard. |
| `src/commands/{device,status}.js` | Drop `metroPid` / `metroLog` reporting. |
| `test/metro.test.js` | Rewritten: parsers, guard outcomes, real-tool test. |

---

### Task 1: Identity primitives and `resolveProjectMetro`

**Files:**
- Modify: `src/metro.js` (add; delete nothing yet)
- Test: `test/metro.test.js`

**Interfaces:**
- Consumes: `findPidListeningOnPort(port)` and `isPidAlive(pid)` (already in `src/metro.js`), `isMetroRunning(port)` from `src/ports.js`.
- Produces:
  - `parseLsofPids(out) -> number[]`
  - `parseLsofCwd(out) -> string | null`
  - `parsePsPgid(out) -> number | null`
  - `processCwd(pid) -> string | null`
  - `processGroupLeader(pid) -> number | null`
  - `isInsideProject(cwd, projectPath) -> boolean`
  - `async resolveProjectMetro(port, projectPath, { probe } = {}) -> { metro: {pid, leader, cwd} } | { missing: true } | { notOurs: string }`

- [ ] **Step 1: Write the failing tests**

Append to `test/metro.test.js`:

```js
import { parseLsofPids, parseLsofCwd, parsePsPgid, isInsideProject, resolveProjectMetro } from '../src/metro.js';
import { setExecutor, resetExecutor } from '../src/exec.js';

test('parseLsofPids parses newline separated pids and ignores junk', () => {
  assert.deepEqual(parseLsofPids('59914\n59806\n'), [59914, 59806]);
  assert.deepEqual(parseLsofPids(''), []);
  assert.deepEqual(parseLsofPids(null), []);
  assert.deepEqual(parseLsofPids('not-a-pid\n42'), [42]);
});

test('parseLsofCwd extracts the cwd path from -Fn field output', () => {
  const out = 'p59914\nfcwd\nn/Volumes/SSD/Developer/member-app\n';
  assert.equal(parseLsofCwd(out), '/Volumes/SSD/Developer/member-app');
  assert.equal(parseLsofCwd(''), null);
  assert.equal(parseLsofCwd('p59914\nfcwd\n'), null);
});

test('parsePsPgid reads the process group id', () => {
  assert.equal(parsePsPgid(' 59806\n'), 59806);
  assert.equal(parsePsPgid(''), null);
  assert.equal(parsePsPgid('nonsense'), null);
});

test('isInsideProject accepts the root and descendants, rejects siblings', () => {
  assert.equal(isInsideProject('/a/b', '/a/b'), true);
  assert.equal(isInsideProject('/a/b/apps/x', '/a/b'), true);
  assert.equal(isInsideProject('/a/bc', '/a/b'), false);
  assert.equal(isInsideProject('/a', '/a/b'), false);
  assert.equal(isInsideProject(null, '/a/b'), false);
});

test('resolveProjectMetro returns missing when nothing listens', async () => {
  setExecutor({ run: () => '', runQuiet: () => '', spawn: () => {} });
  const r = await resolveProjectMetro(8082, '/a/b', { probe: async () => true });
  assert.equal(r.missing, true);
  resetExecutor();
});

test('resolveProjectMetro refuses a listener that does not answer /status', async () => {
  setExecutor({ run: () => '', runQuiet: () => '4242', spawn: () => {} });
  const r = await resolveProjectMetro(8082, '/a/b', { probe: async () => false });
  assert.match(r.notOurs, /does not answer/);
  assert.equal(r.metro, undefined);
  resetExecutor();
});

test('resolveProjectMetro refuses a Metro running from another directory', async () => {
  setExecutor({
    run: () => '',
    runQuiet: (cmd) => {
      if (cmd.includes('-sTCP:LISTEN')) return '4242';
      if (cmd.includes('-d cwd')) return 'p4242\nfcwd\nn/somewhere/else\n';
      return '';
    },
    spawn: () => {},
  });
  const r = await resolveProjectMetro(8082, '/a/b', { probe: async () => true });
  assert.match(r.notOurs, /outside/);
  resetExecutor();
});

test('resolveProjectMetro identifies our Metro and reports its group leader', async () => {
  setExecutor({
    run: () => '',
    runQuiet: (cmd) => {
      if (cmd.includes('-sTCP:LISTEN')) return '59914';
      if (cmd.includes('-d cwd')) return 'p59914\nfcwd\nn/a/b\n';
      if (cmd.includes('ps -o pgid=')) return ' 59806\n';
      return '';
    },
    spawn: () => {},
  });
  const r = await resolveProjectMetro(8082, '/a/b', { probe: async () => true });
  assert.equal(r.metro.pid, 59914);
  assert.equal(r.metro.leader, 59806);
  resetExecutor();
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --test test/metro.test.js`
Expected: FAIL, `SyntaxError` or "does not provide an export named 'parseLsofPids'".

- [ ] **Step 3: Implement the primitives**

Add to `src/metro.js` (keep the existing exports for now):

```js
import { realpathSync } from 'fs';
import { sep } from 'path';

// lsof -t prints one pid per line. Several processes can hold the same
// listening socket (an npm wrapper and the node child it spawned), so this
// returns all of them and the caller decides which one matters.
export function parseLsofPids(out) {
  if (!out) return [];
  return String(out)
    .split('\n')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

// lsof -Fn field output looks like "p<pid>\nfcwd\nn<path>". Only the n-line
// following fcwd carries the directory.
export function parseLsofCwd(out) {
  if (!out) return null;
  const lines = String(out).split('\n');
  const idx = lines.findIndex((l) => l === 'fcwd');
  if (idx === -1) return null;
  const nLine = lines.slice(idx + 1).find((l) => l.startsWith('n'));
  return nLine ? nLine.slice(1) : null;
}

export function parsePsPgid(out) {
  if (!out) return null;
  const n = parseInt(String(out).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

export function processCwd(pid) {
  return parseLsofCwd(getExecutor().runQuiet(`lsof -a -p ${pid} -d cwd -Fn`));
}

export function processGroupLeader(pid) {
  return parsePsPgid(getExecutor().runQuiet(`ps -o pgid= -p ${pid}`));
}

// Canonicalize both sides before comparing: worktrees and this machine's
// /Users -> /Volumes symlink both make a textual prefix check wrong.
export function isInsideProject(cwd, projectPath) {
  if (!cwd || !projectPath) return false;
  const canon = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const a = canon(cwd);
  const b = canon(projectPath);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

// Three outcomes, mirroring resolveOwnedIosSim. A port is NOT identity: the
// final 0.7.0 review's one Critical finding was Android teardown trusting a
// console port that a foreign emulator could occupy. Killing by port alone
// repeats that mistake, so identity must be proven before anything dies.
//   { metro: {pid, leader, cwd} }  proven to be this project's Metro
//   { missing: true }              nothing listening; already gone
//   { notOurs: <reason> }          listening but unproven; report, never kill
export async function resolveProjectMetro(port, projectPath, { probe = isMetroRunning } = {}) {
  const pids = parseLsofPids(getExecutor().runQuiet(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`));
  if (pids.length === 0) return { missing: true };
  const pid = pids[0];

  if (!(await probe(port))) {
    return { notOurs: `pid ${pid} on port ${port} does not answer Metro's /status` };
  }
  const cwd = processCwd(pid);
  if (!cwd) {
    return { notOurs: `pid ${pid} on port ${port}: working directory could not be read` };
  }
  if (!isInsideProject(cwd, projectPath)) {
    return { notOurs: `pid ${pid} on port ${port} runs from ${cwd}, outside ${projectPath}` };
  }
  const leader = processGroupLeader(pid) ?? pid;
  return { metro: { pid, leader, cwd } };
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `node --test test/metro.test.js`
Expected: PASS, all new tests green.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: 236 existing + 7 new = 243 passing, 0 failing.

- [ ] **Step 6: Commit**

```bash
git add src/metro.js test/metro.test.js
git commit -m "feat(metro): port-to-process identity guard, ownership before killing"
```

---

### Task 2: `killMetroTree` and the real-tool verification

**Files:**
- Modify: `src/metro.js`
- Test: `test/metro.test.js`

**Interfaces:**
- Consumes: `resolveProjectMetro` from Task 1.
- Produces: `killMetroTree(leader) -> boolean`

- [ ] **Step 1: Write the failing tests**

Append to `test/metro.test.js`:

```js
import { killMetroTree } from '../src/metro.js';
import { spawn as realSpawn } from 'node:child_process';

test('killMetroTree signals the process group, not just the pid', () => {
  const signalled = [];
  const origKill = process.kill;
  process.kill = (pid, sig) => { signalled.push([pid, sig]); };
  try {
    assert.equal(killMetroTree(59806), true);
    assert.deepEqual(signalled[0], [-59806, 'SIGTERM']);
  } finally {
    process.kill = origKill;
  }
});

test('killMetroTree falls back to the bare pid when the group is gone', () => {
  const signalled = [];
  const origKill = process.kill;
  process.kill = (pid, sig) => {
    if (pid < 0) throw new Error('ESRCH');
    signalled.push([pid, sig]);
  };
  try {
    assert.equal(killMetroTree(59806), true);
    assert.deepEqual(signalled[0], [59806, 'SIGTERM']);
  } finally {
    process.kill = origKill;
  }
});

test('killMetroTree reports false when nothing could be signalled', () => {
  const origKill = process.kill;
  process.kill = () => { throw new Error('ESRCH'); };
  try {
    assert.equal(killMetroTree(1234567), false);
  } finally {
    process.kill = origKill;
  }
});
```

Now the real-tool test. This one uses genuine `lsof`/`ps`/`kill` against a real
listening process, because mocked output cannot prove the shell commands are
right. It does NOT start Metro (too slow); it starts a bare node HTTP server
that answers `/status` exactly like Metro does, from a real directory.

```js
test('resolveProjectMetro identifies and kills a REAL listening process from the project dir', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-metro-'));
  const port = 8099;
  const script = join(dir, 'fake-metro.js');
  writeFileSync(script, `
    const http = require('http');
    http.createServer((req, res) => res.end('packager-status:running'))
        .listen(${port}, '127.0.0.1');
  `);
  const child = realSpawn(process.execPath, [script], { cwd: dir, detached: true, stdio: 'ignore' });
  child.unref();
  try {
    // Give the listener a moment to bind.
    for (let i = 0; i < 40; i++) {
      if (await isMetroRunning(port)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const ours = await resolveProjectMetro(port, dir);
    assert.ok(ours.metro, `expected identification, got ${JSON.stringify(ours)}`);
    assert.equal(typeof ours.metro.pid, 'number');

    // The same live process must be REFUSED for a different project.
    const foreign = await resolveProjectMetro(port, join(tmpdir(), 'some-other-project'));
    assert.ok(foreign.notOurs, 'a process outside the project must not be claimed');

    assert.equal(killMetroTree(ours.metro.leader), true);
    for (let i = 0; i < 40; i++) {
      if (!(await isMetroRunning(port))) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(await isMetroRunning(port), false, 'real process should be dead');
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
```

Add `import { isMetroRunning } from '../src/ports.js';` at the top of the test file if not already present.

- [ ] **Step 2: Run and verify failure**

Run: `node --test test/metro.test.js`
Expected: FAIL, "does not provide an export named 'killMetroTree'".

- [ ] **Step 3: Implement**

Add to `src/metro.js`:

```js
// Kills the process GROUP. lsof reports whoever holds the socket, which for a
// bundler started through a package manager is the node child, not the wrapper
// (observed: `npm exec react-native start` 59806 with node child 59914 holding
// the port). Killing only the listener orphans the wrapper.
export function killMetroTree(leader) {
  if (!leader) return false;
  try {
    process.kill(-leader, 'SIGTERM');
    return true;
  } catch {
    try {
      process.kill(leader, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/metro.test.js`
Expected: PASS including the real-process test.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: 247 passing, 0 failing.

- [ ] **Step 6: Commit**

```bash
git add src/metro.js test/metro.test.js
git commit -m "feat(metro): kill the process group, verified against a real listener"
```

---

### Task 3: `stop` uses the guard, gains `--force`

**Files:**
- Modify: `src/commands/stop.js` (full rewrite of the kill paths)
- Test: `test/stop.test.js` (create)

**Interfaces:**
- Consumes: `resolveProjectMetro`, `killMetroTree` from Tasks 1-2.
- Produces: `stopAction({ resolution, force }) -> { action: 'killed'|'missing'|'refused'|'forced', reason?, pid? }` (pure, exported for tests)

- [ ] **Step 1: Write the failing test**

Create `test/stop.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopAction } from '../src/commands/stop.js';

test('stopAction kills an identified Metro', () => {
  const r = stopAction({ resolution: { metro: { pid: 1, leader: 2 } }, force: false });
  assert.equal(r.action, 'killed');
  assert.equal(r.leader, 2);
});

test('stopAction treats nothing-listening as a no-op, not an error', () => {
  const r = stopAction({ resolution: { missing: true }, force: false });
  assert.equal(r.action, 'missing');
});

test('stopAction refuses an unidentified listener and surfaces the reason', () => {
  const r = stopAction({ resolution: { notOurs: 'pid 9 runs from /elsewhere' }, force: false });
  assert.equal(r.action, 'refused');
  assert.match(r.reason, /elsewhere/);
});

test('stopAction with --force kills an unidentified listener', () => {
  const r = stopAction({ resolution: { notOurs: 'unknown', pid: 9 }, force: true });
  assert.equal(r.action, 'forced');
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test test/stop.test.js`
Expected: FAIL, "does not provide an export named 'stopAction'".

- [ ] **Step 3: Rewrite `src/commands/stop.js`**

Replace the file contents with:

```js
// src/commands/stop.js
import chalk from 'chalk';
import { resolveRegisteredProject } from '../project.js';
import { getProject } from '../config.js';
import { resolveProjectMetro, killMetroTree, findPidListeningOnPort } from '../metro.js';

// Pure: decides what to do with a resolution. Kept separate so the decision is
// testable without a live process.
export function stopAction({ resolution, force }) {
  if (resolution.metro) {
    return { action: 'killed', pid: resolution.metro.pid, leader: resolution.metro.leader };
  }
  if (resolution.missing) return { action: 'missing' };
  if (force) return { action: 'forced', pid: resolution.pid ?? null };
  return { action: 'refused', reason: resolution.notOurs };
}

export default function stopCommand(program) {
  program
    .command('stop [target]')
    .description('Kill this project\'s Metro. rn-iso no longer starts Metro, so it verifies the process on the assigned port belongs to this project before killing it. Pass a project shortcut or absolute path to target another project.')
    .option('--force', 'Kill whatever listens on the port even if it cannot be identified as this project\'s Metro (destructive: ask the user first)')
    .action(async (target, opts) => {
      const { found, error } = resolveRegisteredProject(target);
      if (!found) {
        console.error(chalk.red(error));
        process.exit(1);
      }
      const proj = getProject(found);
      if (!proj?.metroPort) {
        console.log(chalk.dim(`No Metro port assigned to ${found}.`));
        return;
      }
      const port = proj.metroPort;
      const resolution = await resolveProjectMetro(port, found);
      if (resolution.notOurs && opts.force) resolution.pid = findPidListeningOnPort(port);

      const result = stopAction({ resolution, force: Boolean(opts.force) });
      if (result.action === 'missing') {
        console.log(chalk.dim(`No Metro running on port ${port}.`));
        return;
      }
      if (result.action === 'refused') {
        console.error(chalk.yellow(`Refusing to kill port ${port}: ${result.reason}.`));
        console.error(chalk.dim('Pass --force to kill it anyway.'));
        process.exit(1);
      }
      const leader = result.leader ?? result.pid;
      if (!leader || !killMetroTree(leader)) {
        console.error(chalk.red(`Could not kill the process on port ${port}.`));
        process.exit(1);
      }
      const how = result.action === 'forced' ? ' (forced, identity unverified)' : '';
      console.log(chalk.green(`Killed Metro on port ${port}${how} (${found})`));
    });
}
```

Note the removals: no `killByPort` numeric-target path (the port is now looked up from the project record), and no `setMetro(root, port, null)` calls, because `metroPid` ceases to exist in Task 5.

- [ ] **Step 4: Run tests**

Run: `node --test test/stop.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. If `test/shutdown.test.js` or others fail on `setMetro` arity, leave them; Task 5 fixes the field removal. If they fail here, the change was too broad, revert and re-scope.

- [ ] **Step 6: Commit**

```bash
git add src/commands/stop.js test/stop.test.js
git commit -m "feat(stop): verify identity before killing, add --force"
```

---

### Task 4: Route the four teardown sites through the guard

**Files:**
- Modify: `src/reclaim.js:124-136`
- Modify: `src/commands/shutdown.js:53-58, 134-149`
- Modify: `src/commands/release.js:131-140`
- Test: `test/reclaim.test.js`, `test/shutdown.test.js`

**Interfaces:**
- Consumes: `resolveProjectMetro`, `killMetroTree`.
- Produces: `reclaimProject` gains `skippedMetro: string | null` alongside `killedPid`.

- [ ] **Step 1: Write the failing test**

Append to `test/reclaim.test.js`:

```js
test('reclaimProject refuses to kill an unidentified process on the port', async () => {
  // A stale record plus a foreign listener must NOT be killed: this is the
  // Metro analogue of the Android console-port Critical from the 0.7.0 review.
  setExecutor({
    run: () => '',
    runQuiet: (cmd) => (cmd.includes('-sTCP:LISTEN') ? '4242' : ''),
    spawn: () => {},
  });
  const result = await reclaimProject('/nonexistent/project', { deleteArtifacts: false });
  assert.equal(result.killedPid, null);
  assert.ok(result.skippedMetro, 'must report why it declined');
  resetExecutor();
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test test/reclaim.test.js`
Expected: FAIL, `skippedMetro` undefined (today it kills unconditionally).

- [ ] **Step 3: Update `src/reclaim.js`**

Replace the Metro block (currently lines 124-136) with:

```js
  // A Metro started from a deleted directory can outlive it and squat on the
  // port, so the port is not genuinely free until the process is gone. Killing
  // by port alone would repeat the Android console-port mistake, so identity is
  // proven first and an unidentified listener is reported, never killed.
  let killedPid = null;
  let skippedMetro = null;
  if (typeof project?.metroPort === 'number') {
    const resolution = await resolveProjectMetro(project.metroPort, path);
    if (resolution.metro) {
      killedPid = killMetroTree(resolution.metro.leader) ? resolution.metro.pid : null;
      if (killedPid === null) skippedMetro = `could not kill pid ${resolution.metro.pid}`;
    } else if (resolution.notOurs) {
      skippedMetro = resolution.notOurs;
    }
  }
```

Update the import on line 3 to `import { resolveProjectMetro, killMetroTree } from './metro.js';` and add `skippedMetro` to the returned object.

- [ ] **Step 3b: Make `reclaimProject` async and propagate it**

`resolveProjectMetro` awaits an HTTP probe, so `reclaimProject` (currently
`export function` at `src/reclaim.js:104`) must become `export async function`.
It has three production callers and one test, and none of them are currently
async. Convert all of them, in this order:

| Site | Change |
|---|---|
| `src/reclaim.js:104` | `export function` -> `export async function` |
| `src/commands/gc.js:297` | `const result = await reclaimProject(...)` |
| `src/commands/gc.js:188` | `.action(opts => {` -> `.action(async opts => {` |
| `src/commands/prune.js:44` | `const result = await reclaimProject(...)` |
| `src/commands/prune.js:12` | `.action(() => {` -> `.action(async () => {` |
| `src/commands/worktree.js:283` | `const r = await reclaimProject(...)` |
| `src/commands/worktree.js:269` | `function reclaimAll(rootPath)` -> `async function reclaimAll(rootPath)` |
| `src/commands/worktree.js:367` | `const result = await reclaimAll(path);` |
| `test/reclaim.test.js:47` | `const result = await reclaimProject(...)`; make the test callback `async` |

`bin/cli.js` already uses `parseAsync` (commit 96152aa), so async command
actions propagate their rejections correctly. Do not switch it back to
`parse()`.

Verify nothing calls it without awaiting:

```bash
grep -rn "reclaimProject(\|reclaimAll(" src/ test/ | grep -v "await" | grep -v "function"
```
Expected: no output.

- [ ] **Step 4: Update `shutdown.js`**

At line 56, stop reading `proj.metroPid`:

```js
          metros.push({ path, port: proj.metroPort });
```

Replace the Phase 1 loop (lines 134-149) with:

```js
      // Phase 1: kill Metro instances, identity-verified. rn-iso no longer
      // starts Metro, so a recorded port proves nothing about who holds it.
      for (const m of metros) {
        const resolution = await resolveProjectMetro(m.port, m.path);
        if (resolution.metro && killMetroTree(resolution.metro.leader)) {
          console.log(chalk.green(`Killed Metro pid ${resolution.metro.pid} on port ${m.port} ${chalk.dim(`(${m.path})`)}`));
        } else if (resolution.notOurs) {
          console.log(chalk.yellow(`Skipped port ${m.port}: ${resolution.notOurs} (${m.path})`));
        } else {
          console.log(chalk.dim(`No Metro running on port ${m.port} (${m.path})`));
        }
      }
```

Update the import on line 6 to `import { resolveProjectMetro, killMetroTree } from '../metro.js';` and drop `setMetro` from the config import if it becomes unused.

- [ ] **Step 5: Update `release.js`**

`handleUnmatchedPort` (line 131) already prompts before killing an unmatched port; keep the prompt but route the kill through `killMetroTree` so it takes the group:

```js
  const pid = findPidListeningOnPort(port);
```
stays, and the kill inside the confirm branch becomes:
```js
    const leader = processGroupLeader(pid) ?? pid;
    if (!killMetroTree(leader)) {
      console.error(chalk.red(`Could not kill pid ${pid} on port ${port}.`));
      return;
    }
```
Import `killMetroTree` and `processGroupLeader` from `../metro.js`.

- [ ] **Step 6: `gc.js` needs no change**

`gc` reaches Metro only through `reclaimProject`, so Task 4's Step 3 covers it. Confirm with:

Run: `grep -n "metro\|Metro" src/commands/gc.js`
Expected: only the two comment/log lines at ~200 and ~300; no direct kill.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS. Existing `shutdown.test.js` mocks that assert on `metroPid` will need updating to the new shape; update them rather than deleting coverage.

- [ ] **Step 8: Commit**

```bash
git add src/reclaim.js src/commands/shutdown.js src/commands/release.js test/reclaim.test.js test/shutdown.test.js
git commit -m "fix(teardown): verify Metro identity before killing at every site"
```

---

### Task 5: `up` stops spawning; drop `metroPid` and `metroLog`

**Files:**
- Modify: `src/commands/up.js:110-150, 363-375`
- Modify: `src/config.js:62, 80-88, 211`
- Modify: `src/commands/device.js:33-38`
- Modify: `src/commands/status.js:38-47`
- Test: `test/up.test.js`, `test/config.test.js`, `test/status.test.js`

**Interfaces:**
- Produces: `buildFacts` payload without `metroPid` / `metroLog`; `setMetro(projectPath, metroPort)` (two args).

- [ ] **Step 1: Write the failing test**

Append to `test/up.test.js`:

```js
test('buildFacts no longer reports metroPid or metroLog', () => {
  const facts = buildFacts({
    platform: 'ios',
    device: { owned: true, deviceUdid: 'ABC', deviceName: 'rn-iso-x' },
    port: 8082,
    metro: { healthy: false },
    bundleId: 'io.example.app',
    setup: null,
  });
  assert.equal(facts.metroPort, 8082);
  assert.equal(facts.metroHealthy, false);
  assert.equal('metroPid' in facts, false);
  assert.equal('metroLog' in facts, false);
});

test('buildFacts reports metroHealthy true when the probe found Metro', () => {
  const facts = buildFacts({
    platform: 'ios',
    device: { owned: true, deviceUdid: 'ABC' },
    port: 8082,
    metro: { healthy: true },
    bundleId: null,
    setup: null,
  });
  assert.equal(facts.metroHealthy, true);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test test/up.test.js`
Expected: FAIL, `'metroPid' in facts` is true.

- [ ] **Step 3: Update `buildFacts` in `src/commands/up.js`**

```js
export function buildFacts({ platform, device, port, metro, bundleId, setup }) {
  const base = {
    platform,
    owned: Boolean(device.owned),
    metroPort: port,
    metroHealthy: Boolean(metro.healthy),
    bundleId: bundleId ?? null,
    setup: setup ?? null,
  };
```

- [ ] **Step 4: Replace the spawn block in `up.js`**

Replace lines 116-124 (the `ensureMetro` call and its reporting) with:

```js
      // rn-iso allocates and records the port but does not start Metro: how to
      // invoke a project's bundler is project-specific judgment, the same
      // reason the build wrappers were removed. Report what is actually there.
      const metroHealthy = await isMetroRunning(port);
      if (metroHealthy) {
        out(chalk.dim(`Metro already running on port ${port}`));
      } else {
        out(chalk.dim(`Metro port reserved: ${port} (not running -- start it yourself)`));
      }
```

Replace lines 141-146 (the `metroPid` / `log` assembly) with:

```js
      const metro = { healthy: metroHealthy };
```

Update the import on line 21 to drop `ensureMetro`, `logFileFor`, and `findPidListeningOnPort` if unused, and import `isMetroRunning` from `../ports.js`. Change `setMetro(root, port, null)` on line 113 to `setMetro(root, port)`.

- [ ] **Step 5: Update `config.js`**

- Line 62: delete `metroPid: null,` from the new-project template.
- Lines 80-88: `export function setMetro(projectPath, metroPort) { ... }` — delete the `metroPid` assignment.
- Line 211: `cfg.projects[projectPath] = { metroPort: null, platforms: {} };`

- [ ] **Step 6: Update `device.js` and `status.js`**

`device.js` lines 33-38:
```js
        const metro = {
          metroPort: proj.metroPort,
          metroHealthy: proj.metroPort ? await isMetroRunning(proj.metroPort) : false,
        };
```
Drop the `logFileFor` import.

`status.js` lines 38-47:
```js
        if (proj.metroPort) {
          const running = await isMetroRunning(proj.metroPort);
          const label = running ? chalk.green('running') : chalk.dim('not running');
          console.log(`  metro: port ${proj.metroPort} (${label})`);
        } else {
          console.log(chalk.dim('  metro: unassigned'));
        }
```
Drop the `isPidAlive` / `logFileExists` import.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS. Update any test asserting `metroPid` in a payload or a 3-arg `setMetro`.

- [ ] **Step 8: Commit**

```bash
git add src/commands/up.js src/commands/device.js src/commands/status.js src/config.js test/
git commit -m "feat(up): reserve the port, stop spawning Metro"
```

---

### Task 6: Delete the spawn machinery, `start`, and `logs`

**Files:**
- Delete: `src/commands/start.js`, `src/commands/logs.js`
- Modify: `src/metro.js`, `bin/cli.js:5,7,27,29`
- Modify: `test/metro.test.js`

- [ ] **Step 1: Delete the dead exports from `src/metro.js`**

Remove `projectHash`, `logFileFor`, `buildMetroSpawnArgs`, `ensureMetro`, `waitForMetroReady`, `killMetroByPid`, `logFileExists`, and the now-unused `createHash` / `mkdirSync` / `existsSync` / `openSync` / `statSync` / `join` / `getConfigDir` imports.

Keep: `findPidListeningOnPort`, `isPidAlive`, and everything added in Tasks 1-2.

- [ ] **Step 2: Delete the commands and deregister them**

```bash
git rm src/commands/start.js src/commands/logs.js
```

In `bin/cli.js` remove lines 5 and 7 (the imports) and lines 27 and 29 (`startCommand(program);`, `logsCommand(program);`).

- [ ] **Step 3: Delete the stale tests**

From `test/metro.test.js`, delete `projectHash is deterministic and short`, `logFileFor uses RN_ISO_HOME and project hash`, and the three `buildMetroSpawnArgs` tests. Keep everything from Tasks 1-2.

- [ ] **Step 4: Verify nothing still references the deleted symbols**

Run:
```bash
grep -rn "ensureMetro\|logFileFor\|logFileExists\|buildMetroSpawnArgs\|killMetroByPid\|projectHash\|waitForMetroReady" src/ bin/ test/
```
Expected: no output.

- [ ] **Step 5: Verify the CLI loads and the commands are gone**

Run: `node bin/cli.js --help`
Expected: exits 0; no `start` or `logs` in the command list; `stop` present.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, count reduced by the 5 deleted tests.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: delete Metro spawn machinery, start and logs commands"
```

---

### Task 7: Documentation

**Files:**
- Modify: `skill/SKILL.md` (lines 3, 9, 21-25, 38, 45, 62, 64-68, 90-91, 126, 128-129, 131)
- Modify: `README.md`
- Modify: `CLAUDE.md` (the "up is a broker" section and the file-layout table)

- [ ] **Step 1: Rewrite SKILL.md's Metro guidance**

Replace the "Metro rules" section with a "Starting Metro" section:

````markdown
## Starting Metro

rn-iso reserves a **port** for your project and never starts Metro itself --
which bundler command a project needs is judgment you have from reading the
repo, the same reason rn-iso does not run your build. Start it yourself on the
assigned port, in the background, before you build:

| Project shape | Metro invocation |
|---|---|
| Expo | `npx expo start --port <port>` |
| Bare RN | `npx react-native start --port <port>` |
| Has its own `start` script | run it and append `--port <port>` -- it may carry flags that matter |
| Monorepo | run from the app directory, not the repo root |

Two rules that make teardown work:

- **Background it as its own process group**, and keep the working directory
  inside the project. `rn-iso stop` (and `release` / `worktree remove` / `gc`)
  identify your Metro by checking that the process on the port answers
  `/status` AND runs from inside the project. A Metro started from elsewhere
  cannot be identified, and rn-iso will refuse to kill it rather than risk
  killing something of yours.
- **Send its output to a file you can find again** -- rn-iso no longer captures
  Metro's log, so a later session can only read it if the path is predictable.

`metroHealthy` in `up --json` is a live `/status` ping. It is normally `false`
on a fresh `up`, because nothing has started Metro yet -- that is expected, not
an error. Start Metro, then poll until it reports `true` before building.
````

Update the lifecycle example (lines 21-25) to insert the Metro step between
`up` and the build, and drop `metroPid` / `metroLog` from the sample payload.
Delete the `logs` and `start` bullets (lines 126, 128). Update the `stop`
bullet (line 129) to describe identity verification and `--force`, and add
`--force` to the destructive-command rules. Fix line 38 ("always ensures Metro
is running") and line 62 (which claims managed-only Metro is what makes the
build safe -- the CLI's own port probe is what does that, and it still works).

- [ ] **Step 2: Update README.md**

Update the command table to drop `start` / `logs`, add `--force` to `stop`, and
revise the "Owned device creation" bullet to say rn-iso reserves the port but
does not start Metro.

- [ ] **Step 3: Update CLAUDE.md**

In "3. `up` is a broker, never a build wrapper", extend the principle to Metro
explicitly. In the file-layout table, change `metro.js`'s description to
"port-to-process identity and group killing" and delete the `start.js` /
`logs.js` rows.

- [ ] **Step 4: Verify no doc still promises deleted behavior**

Run:
```bash
grep -rn "rn-iso logs\|rn-iso start\|managed Metro\|PID-tracked\|metroPid\|metroLog" README.md skill/SKILL.md CLAUDE.md
```
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add README.md skill/SKILL.md CLAUDE.md
git commit -m "docs: agents start Metro on the reserved port"
```

---

### Task 8: Live verification and the 0.8.0 release

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Live-verify the whole flow on a real project**

Metro identity is entirely real `lsof`/`ps`/`kill` behavior, so this must run
against a real bundler, not a stub. Use a temp config so real state is not
touched:

```bash
export RN_ISO_HOME=$(mktemp -d)
cd /Volumes/ExternalSSD/Developer/member-app
node /Volumes/ExternalSSD/Developer/rn-iso/bin/cli.js up ios --json
```
Expected: one JSON line, `metroHealthy:false`, a `metroPort`, an owned sim
created and booted. All status text on stderr.

```bash
npx react-native start --port <port> &
```
Wait for it to bind, then:
```bash
node /Volumes/ExternalSSD/Developer/rn-iso/bin/cli.js up ios --json
```
Expected: `metroHealthy:true`.

- [ ] **Step 2: Live-verify the refusal path**

From a directory OUTSIDE the project, start a listener on the project's port
and confirm `stop` refuses it:

Expected: exit 1, "Refusing to kill port N: ... outside ...". Then confirm
`stop --force` does kill it.

- [ ] **Step 3: Live-verify teardown**

```bash
node .../bin/cli.js stop      # kills the real Metro, group and all
node .../bin/cli.js release   # deletes the owned sim
```
Expected: no leaked process, no bound port, no sim. Verify with
`lsof -nP -iTCP:<port> -sTCP:LISTEN` (empty) and `xcrun simctl list devices | grep rn-iso` (empty).

Then clean up: `rm -rf "$RN_ISO_HOME"` and confirm `~/.rn-iso/config.json` mtime is unchanged.

- [ ] **Step 4: Bump to 0.8.0**

```bash
npm version 0.8.0 --no-git-tag-version
npm install --package-lock-only
npm test
node bin/cli.js --version   # 0.8.0
npm pack --dry-run          # no test/, docs/, .superpowers/
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: 0.8.0 -- agents own Metro, rn-iso owns the port"
```

- [ ] **Step 6: Release**

Follow `RELEASE.md` exactly: merge to `main`, tag `v0.8.0`, push, write GitHub
release notes with a **Removed (breaking)** section covering `start`, `logs`,
`metroPid`, `metroLog`, and managed Metro, plus **Migration notes** telling
users to start Metro themselves on the reserved port. Then `npm publish`
(2FA prompts for an OTP).
