// `rn-iso start`.
//
// The behaviours pinned here are the ones an agent loop depends on:
//   - idempotence: a healthy dev server on the reserved port is a no-op exit 0,
//     never a second bundler;
//   - honesty about who is serving: a dev server the agent started itself is
//     reported with supervisor null rather than fought;
//   - identity: health is resolveProjectMetro, so a FOREIGN listener on the
//     reserved port moves the reservation instead of counting as success;
//   - a failure prints the supervisor log's tail and its path, not a stack.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProject, upsertProject } from '../config.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { supervisorLogFile, workspaceLogsDir } from '../paths.ts';
import { writeWorkspaceState } from '../supervisor/run.ts';
import {
  liveSupervisor,
  parseWait,
  readLogTail,
  registerStart,
  startFacts,
  supervisorEntry,
  tailLines,
} from '../commands/start.ts';

let tmpHome;
let root;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
  // realpath: findProjectRoot canonicalizes, and on macOS /var is a symlink
  // to /private/var, so an uncanonicalized root registers under a different key
  // than the command computes.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'rn-iso-ws-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws' }));
});

afterEach(() => {
  for (const server of openServers.splice(0)) server.close();
  resetExecutor();
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

// The same commander stub the other command tests use.
function captureAction(register) {
  let captured;
  const stub = {
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
      captured = fn;
      return stub;
    },
  };
  register(stub);
  return (opts = {}) => captured(opts);
}

// resolveProjectMetro asks lsof who listens, probes /status for real, then
// reads that pid's cwd and process group. This mock answers the three shell
// calls; the /status half is a real listener started by the test.
function metroExecutor({ listeners = {}, cwd = root, spawnResult = null } = {}) {
  const calls = { run: [], spawn: [] };
  return {
    calls,
    run() {
      return '';
    },
    runFile() {
      return '';
    },
    runQuiet(cmd) {
      calls.run.push(cmd);
      const listening = /lsof -nP -iTCP:(\d+)/.exec(cmd);
      if (listening) return listeners[listening[1]] ? String(listeners[listening[1]]) : '';
      if (/lsof -a -p \d+ -d cwd/.test(cmd)) return `p1\nfcwd\nn${cwd}`;
      if (/ps -o pgid=/.test(cmd)) return '777';
      return '';
    },
    spawn(cmd, args, opts) {
      calls.spawn.push({ cmd, args, opts });
      return spawnResult || { pid: 4242, unref() {}, on() {} };
    },
  };
}

// Every listener is registered for teardown: one left open by a test whose
// assertion failed first would keep the test runner's process alive.
const openServers = [];

function metroListener(port) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('packager-status:running');
  });
  openServers.push(server);
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function runAction(opts) {
  const run = captureAction(registerStart);
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  const cwd = process.cwd();
  let exitCode = null;
  console.log = (l) => logs.push(String(l));
  console.error = (l) => errs.push(String(l));
  process.exit = (c) => {
    exitCode = c;
  };
  process.chdir(root);
  try {
    await run(opts);
  } finally {
    process.chdir(cwd);
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  }
  return { logs, errs, exitCode };
}

describe('option parsing', () => {
  test('--wait defaults to 60 seconds', () => {
    expect(parseWait(undefined)).toEqual({ seconds: 60 });
  });

  test('--wait takes a number of seconds', () => {
    expect(parseWait('90')).toEqual({ seconds: 90 });
  });

  test('a --wait that is not a positive number is refused, not silently defaulted', () => {
    expect(parseWait('soon').error).toMatch(/--wait/);
    expect(parseWait('0').error).toMatch(/--wait/);
    expect(parseWait('-5').error).toMatch(/--wait/);
  });
});

describe('the supervisor entry point', () => {
  test('resolves to the run.js that is actually shipped', () => {
    expect(existsSync(supervisorEntry())).toBeTruthy();
    expect(supervisorEntry()).toMatch(/src\/supervisor\/run\.ts$/);
  });
});

describe('liveSupervisor', () => {
  const alive = () => true;
  const dead = () => false;

  test('takes the workspace state first, because only it carries the mode', () => {
    const found = liveSupervisor({
      state: { supervisor: { pid: 10, port: 8082, mode: 'bare-inproc', startedAt: 'T' } },
      project: { supervisor: { pid: 10, port: 8082 } },
      port: 8082,
      isAlive: alive,
    });
    expect(found).toEqual({ pid: 10, port: 8082, mode: 'bare-inproc', startedAt: 'T' });
  });

  test('falls back to the global registration when the workspace file is gone', () => {
    const found = liveSupervisor({
      state: null,
      project: { supervisor: { pid: 11, port: 8082, startedAt: 'T' } },
      port: 8082,
      isAlive: alive,
    });
    expect(found.pid).toBe(11);
    expect(found.mode).toBe(null);
  });

  test('a dead pid is not a supervisor: a stale record outlives its process', () => {
    expect(
      liveSupervisor({
        state: { supervisor: { pid: 12, port: 8082 } },
        project: null,
        port: 8082,
        isAlive: dead,
      }),
    ).toBe(null);
  });

  test('a supervisor recorded on another port is not the one that would answer here', () => {
    expect(
      liveSupervisor({
        state: { supervisor: { pid: 13, port: 8099 } },
        project: null,
        port: 8082,
        isAlive: alive,
      }),
    ).toBe(null);
  });

  test('no record at all is null, not a throw', () => {
    expect(liveSupervisor({ port: 8082 })).toBe(null);
    expect(liveSupervisor()).toBe(null);
  });
});

describe('startFacts', () => {
  test('shapes the facts an agent reads', () => {
    expect(
      startFacts({
        port: 8082,
        supervisor: { pid: 91, mode: 'expo-child' },
        logsDir: '/w/.rn-iso/logs',
        alreadyRunning: false,
      }),
    ).toEqual({ port: 8082, supervisorPid: 91, mode: 'expo-child', logsDir: '/w/.rn-iso/logs', alreadyRunning: false });
  });

  test('a dev server rn-iso did not start reports a null supervisor rather than a lie', () => {
    const facts = startFacts({ port: 8082, supervisor: null, logsDir: '/l', alreadyRunning: true });
    expect(facts.supervisorPid).toBe(null);
    expect(facts.mode).toBe(null);
    expect(facts.alreadyRunning).toBe(true);
  });
});

describe('the supervisor log tail', () => {
  test('takes the last lines and drops the blank ones', () => {
    expect(tailLines('a\nb\n\nc\nd\ne\nf\n', 3)).toEqual(['d', 'e', 'f']);
  });

  test('a log that does not exist yet is an empty tail, not a throw', () => {
    expect(readLogTail(join(root, 'nope.log'))).toEqual([]);
  });
});

describe('action: already running', () => {
  test('a healthy dev server with a live supervisor record is a no-op exit 0', async () => {
    const port = 8151;
    const server = await metroListener(port);
    setExecutor(metroExecutor({ listeners: { [port]: 4242 } }));
    upsertProject(root, { metroPort: port });
    // A pid that is definitely alive: this test process.
    writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'bare-inproc', startedAt: 'T' } });

    let result;
    try {
      result = await runAction({ json: true });
    } finally {
      server.close();
    }

    expect(result.exitCode).toBe(null);
    expect(result.logs.length).toBe(1);
    const facts = JSON.parse(result.logs[0]);
    expect(facts).toEqual({
      port,
      supervisorPid: process.pid,
      mode: 'bare-inproc',
      logsDir: workspaceLogsDir(root),
      alreadyRunning: true,
    });
  });

  test('a healthy dev server the agent started itself is reported, not fought', async () => {
    const port = 8152;
    const server = await metroListener(port);
    const exec = metroExecutor({ listeners: { [port]: 4242 } });
    setExecutor(exec);
    upsertProject(root, { metroPort: port });

    let result;
    try {
      result = await runAction({ json: true });
    } finally {
      server.close();
    }

    const facts = JSON.parse(result.logs[0]);
    expect(facts.supervisorPid).toBe(null);
    expect(facts.alreadyRunning).toBe(true);
    expect(result.exitCode).toBe(null);
    expect(exec.calls.spawn).toEqual([]);
    expect(result.errs.join('\n')).toMatch(/started outside rn-iso/);
  });

  test('two starts in a row leave one supervisor', async () => {
    const port = 8153;
    const server = await metroListener(port);
    const exec = metroExecutor({ listeners: { [port]: 4242 } });
    setExecutor(exec);
    upsertProject(root, { metroPort: port });
    writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'bare-inproc', startedAt: 'T' } });

    try {
      await runAction({ json: true });
      await runAction({ json: true });
    } finally {
      server.close();
    }
    expect(exec.calls.spawn).toEqual([]);
  });
});

describe('action: spawning the supervisor', () => {
  test('spawns node run.js --root --port detached, with stdio into supervisor.log, and waits for health', async () => {
    const port = 8154;
    const exec = metroExecutor({ listeners: {} });
    let server = null;
    // The fake supervisor: spawning it is what makes the port answer, exactly
    // as the real one does.
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      // The real supervisor records itself and then serves; both are faked
      // here, and the pid has to be a live one or `start` correctly concludes
      // the supervisor is already gone.
      writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'bare-inproc', startedAt: 'T' } });
      metroListener(port).then((s) => {
        server = s;
        exec.listening = true;
      });
      return { pid: process.pid, unref() {}, on() {} };
    };
    const base = exec.runQuiet.bind(exec);
    exec.runQuiet = (cmd) => {
      if (new RegExp(`lsof -nP -iTCP:${port}`).test(cmd)) return exec.listening ? '5150' : '';
      return base(cmd);
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port });

    let result;
    try {
      result = await runAction({ json: true, wait: '10' });
    } finally {
      server?.close();
    }

    expect(result.exitCode).toBe(null);
    const spawned = exec.calls.spawn[0];
    expect(spawned.cmd).toBe(process.execPath);
    expect(spawned.args).toEqual([supervisorEntry(), '--root', root, '--port', String(port)]);
    expect(spawned.opts.cwd).toBe(root);
    expect(spawned.opts.detached).toBe(true);
    expect(spawned.opts.stdio[0]).toBe('ignore');
    expect(typeof spawned.opts.stdio[1]).toBe('number');
    expect(spawned.opts.stdio[1]).toBe(spawned.opts.stdio[2]);
    expect(existsSync(supervisorLogFile(root))).toBeTruthy();

    const facts = JSON.parse(result.logs[0]);
    expect(facts.port).toBe(port);
    expect(facts.alreadyRunning).toBe(false);
    expect(facts.supervisorPid).toBe(process.pid);
    expect(facts.mode).toBe('bare-inproc');
  });

  test('a supervisor that never answers exits 1 with the log tail and the log path', async () => {
    const port = 8155;
    const exec = metroExecutor({ listeners: {} });
    // A live pid, so this is the genuine "still running, not serving" timeout
    // rather than the "already dead" path tested below.
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      return { pid: process.pid, unref() {}, on() {} };
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port });
    mkdirSync(workspaceLogsDir(root), { recursive: true });
    writeFileSync(
      supervisorLogFile(root),
      [
        'noise 1',
        'noise 2',
        'noise 3',
        'noise 4',
        'noise 5',
        'noise 6',
        'rn-iso supervisor: failed to start the bare-inproc dev server: RN_ISO_BARE_DEPS: metro is not resolvable',
      ].join('\n'),
    );

    const result = await runAction({ json: true, wait: '1' });

    expect(result.exitCode).toBe(1);
    // The error contract, not an empty stdout. A caller doing
    // `facts=$(rn-iso start --json)` got an empty string on every failure and
    // had to scrape stderr prose, which `guide facts` promises it never has to.
    expect(result.logs.length).toBe(1);
    expect(JSON.parse(result.logs[0])).toEqual({
      code: 'RN_ISO_METRO_TIMEOUT',
      message: 'The dev server did not answer on port 8155 within 1s.',
      remedy: 'It may still be starting. Run `rn-iso stop` to halt it, or `rn-iso logs` to follow along.',
    });
    const stderr = result.errs.join('\n');
    expect(stderr).toMatch(/did not answer on port 8155 within 1s/);
    expect(stderr).toMatch(/RN_ISO_BARE_DEPS/);
    expect(stderr).toMatch(new RegExp(supervisorLogFile(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(!stderr.includes('noise 1')).toBeTruthy();
    expect(stderr.includes('noise 4')).toBeTruthy();
  });

  test('a supervisor that exits during startup ends the wait immediately', async () => {
    const port = 8156;
    const exec = metroExecutor({ listeners: {} });
    const handlers = {};
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      const child = {
        pid: process.pid,
        unref() {},
        on(event, cb) {
          handlers[event] = cb;
        },
      };
      // Dead before the first poll.
      setTimeout(() => handlers.exit?.(1, null), 5);
      return child;
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port });

    const started = Date.now();
    const result = await runAction({ json: true, wait: '30' });
    const elapsed = Date.now() - started;

    expect(result.exitCode).toBe(1);
    expect(elapsed < 5000).toBeTruthy();
    expect(result.errs.join('\n')).toMatch(/supervisor exited \(code 1\) before the dev server came up/);
    // A supervisor that DIED and one that is merely slow need different next
    // steps, so they carry different codes rather than one generic failure.
    const facts = JSON.parse(result.logs.at(-1));
    expect(facts.code).toBe('RN_ISO_SUPERVISOR_EXITED');
    expect(facts.remedy).toMatch(/start` again/);
  });
});

describe('the error contract', () => {
  test('a refusal before anything runs still puts one JSON line on stdout', async () => {
    setExecutor(metroExecutor({ listeners: {} }));
    const result = await runAction({ json: true, wait: 'soon' });
    expect(result.exitCode).toBe(1);
    expect(result.logs.length).toBe(1);
    const facts = JSON.parse(result.logs[0]);
    expect(facts.code).toBe('RN_ISO_BAD_ARG');
    expect(facts.message).toMatch(/Invalid --wait/);
    expect(facts.remedy).toBeTruthy();
  });

  test('without --json a failure keeps stdout free of JSON and names the code', async () => {
    setExecutor(metroExecutor({ listeners: {} }));
    const result = await runAction({ wait: 'soon' });
    expect(result.exitCode).toBe(1);
    for (const line of result.logs) expect(() => JSON.parse(line)).toThrow();
    expect(result.errs.join('\n')).toMatch(/RN_ISO_BAD_ARG/);
  });
});

// `.rn-iso/` used to be gitignored by `rn-iso init`, which made it a step a
// repo had to remember before its first build -- and forgetting it dead-ended
// `worktree remove` on `?? .rn-iso/`. `start` is the first command of the loop,
// so it ensures the entry itself.
describe('the workspace gitignore', () => {
  test('adds the entry on a repo that has none, and says so once on stderr', async () => {
    const port = 8161;
    const server = await metroListener(port);
    setExecutor(metroExecutor({ listeners: { [port]: 4242 } }));
    upsertProject(root, { metroPort: port });
    try {
      const result = await runAction({ json: true, wait: '5' });
      expect(result.exitCode).toBe(null);
      const gitignore = readFileSync(join(root, '.gitignore'), 'utf-8');
      expect(gitignore).toMatch(/^\.rn-iso\/$/m);
      const notes = result.errs.filter((l) => /added \.rn-iso\/ to \.gitignore/.test(l));
      expect(notes.length).toBe(1);
      expect(notes[0]).toMatch(/note {3}added/);
      // The note is stderr, never the --json payload's line.
      expect(result.logs.length).toBe(1);
      expect(JSON.parse(result.logs[0]).port).toBeTruthy();
    } finally {
      server.close();
    }
  });

  test('a repo that already ignores it is left alone and says nothing', async () => {
    const port = 8162;
    const server = await metroListener(port);
    setExecutor(metroExecutor({ listeners: { [port]: 4242 } }));
    upsertProject(root, { metroPort: port });
    writeFileSync(join(root, '.gitignore'), 'node_modules\n/.rn-iso\n');
    try {
      const result = await runAction({ json: true, wait: '5' });
      expect(result.exitCode).toBe(null);
      expect(readFileSync(join(root, '.gitignore'), 'utf-8')).toBe('node_modules\n/.rn-iso\n');
      expect(result.errs.filter((l) => /gitignore/.test(l))).toEqual([]);
    } finally {
      server.close();
    }
  });
});

describe('action: the reserved port', () => {
  test('a FOREIGN holder of the reserved port moves the reservation instead of counting as healthy', async () => {
    const port = 8157;
    const server = await metroListener(port);
    // Answers /status, but runs from somewhere else: not this project's.
    const exec = metroExecutor({ listeners: { [port]: 4242 }, cwd: '/somewhere/else' });
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      return { pid: 1, unref() {}, on() {} };
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port });

    let result;
    try {
      result = await runAction({ json: true, wait: '1' });
    } finally {
      server.close();
    }

    const reserved = getProject(root).metroPort;
    expect(reserved).not.toBe(port);
    expect(result.errs.join('\n')).toMatch(/is held by something else/);
    // It then tries to start on the new port, and fails to come up within 1s.
    expect(result.exitCode).toBe(1);
    expect(exec.calls.spawn[0].args[4]).toBe(String(reserved));
  });

  test('a project with no reservation gets one', async () => {
    const exec = metroExecutor({ listeners: {} });
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      return { pid: 1, unref() {}, on() {} };
    };
    setExecutor(exec);

    const result = await runAction({ json: true, wait: '1' });

    const reserved = getProject(root).metroPort;
    expect(typeof reserved).toBe('number');
    expect(exec.calls.spawn[0].args[4]).toBe(String(reserved));
    expect(result.exitCode).toBe(1);
  });

  test('an invalid --wait fails before anything is spawned', async () => {
    const exec = metroExecutor({ listeners: {} });
    setExecutor(exec);
    const result = await runAction({ json: true, wait: 'soon' });
    expect(result.exitCode).toBe(1);
    expect(exec.calls.spawn).toEqual([]);
    expect(result.errs.join('\n')).toMatch(/Invalid --wait/);
  });
});

describe('action: an existing supervisor that is not answering', () => {
  test('waits on the one that exists rather than spawning a second', async () => {
    const port = 8158;
    const exec = metroExecutor({ listeners: {} });
    setExecutor(exec);
    upsertProject(root, { metroPort: port });
    writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'bare-inproc', startedAt: 'T' } });
    mkdirSync(workspaceLogsDir(root), { recursive: true });
    writeFileSync(supervisorLogFile(root), 'still starting\n');

    const result = await runAction({ json: true, wait: '1' });

    expect(exec.calls.spawn).toEqual([]);
    expect(result.exitCode).toBe(1);
    expect(result.errs.join('\n')).toMatch(/did not serve port 8158/);
    expect(result.errs.join('\n')).toMatch(/rn-iso stop/);
  });

  test('and reports success once that supervisor answers', async () => {
    const port = 8159;
    const exec = metroExecutor({ listeners: {} });
    let server = null;
    const base = exec.runQuiet.bind(exec);
    exec.runQuiet = (cmd) => {
      if (new RegExp(`lsof -nP -iTCP:${port}`).test(cmd)) return exec.listening ? '5152' : '';
      return base(cmd);
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port });
    writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'bare-inproc', startedAt: 'T' } });
    metroListener(port).then((s) => {
      server = s;
      exec.listening = true;
    });

    let result;
    try {
      result = await runAction({ json: true, wait: '10' });
    } finally {
      server?.close();
    }

    expect(result.exitCode).toBe(null);
    const facts = JSON.parse(result.logs[0]);
    expect(facts.supervisorPid).toBe(process.pid);
    expect(facts.alreadyRunning).toBe(true);
    expect(exec.calls.spawn).toEqual([]);
  });
});

describe('output contract', () => {
  test('without --json every line is human and nothing is JSON', async () => {
    const port = 8160;
    const server = await metroListener(port);
    setExecutor(metroExecutor({ listeners: { [port]: 4242 } }));
    upsertProject(root, { metroPort: port });
    writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'expo-child', startedAt: 'T' } });

    let result;
    try {
      result = await runAction({});
    } finally {
      server.close();
    }

    expect(result.exitCode).toBe(null);
    expect(result.logs.join('\n')).toMatch(/OK: dev server on port 8160/);
    expect(result.logs.join('\n')).toMatch(/expo-child/);
    expect(result.logs.join('\n')).toMatch(new RegExp(workspaceLogsDir(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    for (const line of result.logs) {
      expect(() => JSON.parse(line)).toThrow();
    }
  });
});
