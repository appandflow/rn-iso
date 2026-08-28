import assert from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { parseNdjsonLine } from '../ndjson.ts';
import { workspaceDir, workspaceLogsDir } from '../paths.ts';
import logsCommand, {
  ERRORS_PRINT_CAP,
  formatRecord,
  formatTime,
  formatStackFrame,
  parseTail,
  validateLevel,
  validateSources,
} from '../commands/logs.ts';

type ActionFn = (opts: Record<string, unknown>) => void | Promise<void>;

interface CommandStub {
  command(nameAndArgs?: string): CommandStub;
  description(str?: string): CommandStub;
  option(flags?: string, description?: string): CommandStub;
  action(fn: ActionFn): CommandStub;
}

function parsedMsgs(lines: string[]): unknown[] {
  return lines.map((l) => {
    const record = parseNdjsonLine(l);
    assert(record);
    return record.msg;
  });
}

function captureAction(register: (program: Command) => void) {
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
  return (opts: Record<string, unknown> = {}) => {
    if (!captured) throw new Error('register did not register an action');
    return captured(opts);
  };
}

describe('formatting', () => {
  test('formatTime renders local wall clock to the millisecond', () => {
    const ts = Date.UTC(2026, 7, 25, 12, 34, 56, 789);
    const d = new Date(ts);
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    const expected = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    expect(formatTime(ts)).toBe(expected);
    expect(formatTime(ts)).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  test('formatTime renders a record with no usable ts without crashing', () => {
    expect(formatTime(undefined)).toBe('--:--:--.---');
    expect(formatTime('nope')).toBe('--:--:--.---');
  });

  test('formatRecord is "HH:MM:SS.mmm level src msg" with aligned columns', () => {
    const line = formatRecord({ ts: 0, src: 'metro', level: 'error', msg: 'Unable to resolve module' });
    expect(line).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} error metro  Unable to resolve module$/);
  });

  test('the level and src columns are padded so messages line up', () => {
    const a = formatRecord({ ts: 0, src: 'metro', level: 'info', msg: 'x' });
    const b = formatRecord({ ts: 0, src: 'client', level: 'error', msg: 'x' });
    expect(a.indexOf('x')).toBe(b.indexOf('x'));
  });

  test('formatStackFrame renders fn, file, line and column', () => {
    expect(formatStackFrame({ file: 'src/App.js', line: 12, column: 3, fn: 'render' })).toBe(
      'at render (src/App.js:12:3)',
    );
  });

  test('formatStackFrame degrades when fields are missing', () => {
    expect(formatStackFrame({ file: 'src/App.js', line: 12 })).toBe('at src/App.js:12');
    expect(formatStackFrame({ fn: 'render' })).toBe('at render');
    expect(formatStackFrame({})).toBe(null);
  });

  test('stack frames follow the message, indented', () => {
    const line = formatRecord({
      ts: 0,
      src: 'client',
      level: 'error',
      msg: 'redbox',
      stack: [
        { file: 'src/App.js', line: 12, column: 3, fn: 'render' },
        { file: 'src/index.js', line: 1, column: 1 },
      ],
    });
    const lines = line.split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toMatch(/redbox$/);
    expect(lines[1]).toBe('    at render (src/App.js:12:3)');
    expect(lines[2]).toBe('    at src/index.js:1:1');
  });

  test('a multi-line message keeps its own lines, indented under the first', () => {
    const line = formatRecord({ ts: 0, src: 'metro', level: 'error', msg: 'first\nsecond' });
    const lines = line.split('\n');
    expect(lines[0]).toMatch(/first$/);
    expect(lines[1]).toBe('    second');
  });

  test('a record missing src or msg still renders', () => {
    const line = formatRecord({ ts: 0, level: 'info' });
    expect(line).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} info /);
  });

  test('formatRecord paints only the level, and defaults to no colour', () => {
    const line = formatRecord({ ts: 0, src: 'metro', level: 'warn', msg: 'hm' }, { paint: (t) => `<${t}>` });
    expect(line).toMatch(/<warn >/);
    expect(formatRecord({ ts: 0, src: 'metro', level: 'warn', msg: 'hm' }).includes('<')).toBe(false);
  });
});

describe('option validation', () => {
  test('parseTail accepts a non-negative integer', () => {
    expect(parseTail('50')).toEqual({ n: 50 });
    expect(parseTail('0')).toEqual({ n: 0 });
  });

  test('parseTail rejects garbage with a message instead of NaN', () => {
    for (const bad of ['abc', '-1', '1.5', '', ' ']) {
      const r = parseTail(bad);
      expect(r.n).toBe(undefined);
      expect(r.error).toMatch(/--tail/);
    }
  });

  test('validateSources accepts the Contract-1 sources and rejects a typo', () => {
    expect(validateSources(['metro', 'client'])).toEqual({ sources: ['metro', 'client'] });
    expect(validateSources(undefined)).toEqual({ sources: undefined });
    const r = validateSources(['metrro']);
    expect(r.sources).toBe(undefined);
    expect(r.error).toMatch(/metrro/);
    expect(r.error).toMatch(/metro, client, device, build/);
  });

  test('validateSources expands all to every Contract-1 source', () => {
    expect(validateSources(['all'])).toEqual({ sources: ['metro', 'client', 'device', 'build'] });
    expect(validateSources(['client', 'all'])).toEqual({ sources: ['metro', 'client', 'device', 'build'] });
    expect(validateSources(['metrro']).error).toMatch(/or all/);
  });

  test('validateLevel accepts the Contract-1 levels and names the valid set otherwise', () => {
    expect(validateLevel('warn')).toEqual({ level: 'warn' });
    const r = validateLevel('loud');
    expect(r.level).toBe(undefined);
    expect(r.error).toMatch(/debug/);
    expect(r.error).toMatch(/fatal/);
  });
});

describe('logs command', () => {
  let tmpHome: string;
  let project: string;
  let logsDir: string;
  let cwd: string;
  let out: string[];
  let errOut: string[];
  let exitCode: string | number | null | undefined;
  let origLog: typeof console.log;
  let origError: typeof console.error;
  let origExit: typeof process.exit;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-logscmd-home-'));
    process.env.RN_ISO_HOME = tmpHome;
    project = realpathSync(mkdtempSync(join(tmpdir(), 'rn-iso-logscmd-')));
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'demo' }));
    logsDir = workspaceLogsDir(project);
    mkdirSync(logsDir, { recursive: true });
    cwd = process.cwd();
    process.chdir(project);

    out = [];
    errOut = [];
    exitCode = null;
    origLog = console.log;
    origError = console.error;
    origExit = process.exit;
    console.log = (...a) => out.push(a.join(' '));
    console.error = (...a) => errOut.push(a.join(' '));
    process.exit = (code) => {
      exitCode = code;
      throw new Error('exit');
    };
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origError;
    process.exit = origExit;
    process.chdir(cwd);
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    delete process.env.RN_ISO_HOME;
  });

  function writeLog(name: string, records: unknown[]) {
    writeFileSync(join(logsDir, name), records.map((r) => `${JSON.stringify(r)}\n`).join(''));
  }

  function run(opts: Record<string, unknown>) {
    try {
      captureAction(logsCommand)(opts);
    } catch (err) {
      if ((err as Error).message !== 'exit') throw err;
    }
  }

  test('prints the merged timeline, one line per record', () => {
    writeLog('metro.ndjson', [{ ts: 1, src: 'metro', level: 'info', msg: 'bundling' }]);
    writeLog('client.ndjson', [{ ts: 2, src: 'client', level: 'warn', msg: 'deprecated' }]);
    run({});
    expect(exitCode).toBe(null);
    expect(out.length).toBe(2);
    expect(out[0]).toMatch(/ info  metro  bundling$/);
    expect(out[1]).toMatch(/ warn  client deprecated$/);
  });

  test('--json emits the raw records, one valid NDJSON object per line', () => {
    const record = { ts: 1, src: 'metro', level: 'error', msg: 'boom', event: 'bundling_error' };
    writeLog('metro.ndjson', [record]);
    run({ json: true });
    expect(out.length).toBe(1);
    expect(parseNdjsonLine(out[0])).toEqual(record);
  });

  test('exits 0 and prints nothing to stdout when nothing matches', () => {
    writeLog('metro.ndjson', [{ ts: 1, src: 'metro', level: 'info', msg: 'fine' }]);
    run({ errors: true });
    expect(exitCode).toBe(null);
    expect(out).toEqual([]);
  });

  test('exits 0 when the workspace has no log directory at all', () => {
    rmSync(workspaceDir(project), { recursive: true, force: true });
    run({});
    expect(exitCode).toBe(null);
    expect(out).toEqual([]);
  });

  test('--errors applies the marker window across sources', () => {
    writeLog('client.ndjson', [
      { ts: 10, src: 'client', level: 'error', msg: 'stale' },
      { ts: 30, src: 'client', level: 'error', msg: 'fresh' },
    ]);
    writeLog('build-ios.ndjson', [{ ts: 20, src: 'build', level: 'info', msg: 'launched', marker: true }]);
    run({ errors: true, json: true });
    expect(parsedMsgs(out)).toEqual(['fresh']);
  });

  test('--source, --level, --grep and --tail reach the query', () => {
    writeLog('metro.ndjson', [
      { ts: 1, src: 'metro', level: 'debug', msg: 'noise' },
      { ts: 2, src: 'metro', level: 'error', msg: 'Unable to resolve module a' },
      { ts: 3, src: 'metro', level: 'error', msg: 'Unable to resolve module b' },
    ]);
    writeLog('client.ndjson', [{ ts: 4, src: 'client', level: 'error', msg: 'Unable to resolve module c' }]);
    run({ source: ['metro'], level: 'error', grep: 'resolve module', tail: '1', json: true });
    expect(parsedMsgs(out)).toEqual(['Unable to resolve module b']);
  });

  test('a bad --since exits 1 with a message naming the accepted forms', () => {
    writeLog('metro.ndjson', [{ ts: 1, src: 'metro', level: 'info', msg: 'x' }]);
    run({ since: 'soon' });
    expect(exitCode).toBe(1);
    expect(errOut.join('\n')).toMatch(/soon/);
    expect(errOut.join('\n')).toMatch(/30s|5m|2h/);
    expect(out).toEqual([]);
  });

  test('a typo in --source exits 1 rather than reporting an empty pass', () => {
    writeLog('metro.ndjson', [{ ts: 1, src: 'metro', level: 'error', msg: 'boom' }]);
    run({ source: ['metrro'], errors: true });
    expect(exitCode).toBe(1);
    expect(errOut.join('\n')).toMatch(/metrro/);
    expect(out).toEqual([]);
  });

  test('a bad --level exits 1', () => {
    run({ level: 'loud' });
    expect(exitCode).toBe(1);
    expect(errOut.join('\n')).toMatch(/loud/);
  });

  test('a bad --tail exits 1', () => {
    run({ tail: 'lots' });
    expect(exitCode).toBe(1);
    expect(errOut.join('\n')).toMatch(/--tail/);
  });

  test('a bad --grep exits 1 rather than throwing a RegExp stack', () => {
    run({ grep: '[unterminated' });
    expect(exitCode).toBe(1);
    expect(errOut.join('\n')).toMatch(/grep/);
  });

  test('outside a project it exits 1 and says so', () => {
    const bare = mkdtempSync(join(tmpdir(), 'rn-iso-logscmd-bare-'));
    process.chdir(bare);
    try {
      run({});
    } finally {
      process.chdir(project);
      rmSync(bare, { recursive: true, force: true });
    }
    expect(exitCode).toBe(1);
    expect(errOut.join('\n')).toMatch(/project/i);
  });

  test('--since is honoured against real timestamps', () => {
    const now = Date.now();
    writeLog('metro.ndjson', [
      { ts: now - 3600000, src: 'metro', level: 'info', msg: 'an hour ago' },
      { ts: now - 1000, src: 'metro', level: 'info', msg: 'a second ago' },
    ]);
    run({ since: '30s', json: true });
    expect(parsedMsgs(out)).toEqual(['a second ago']);
  });

  describe('--errors, after the field test', () => {
    test('the device stream is out of scope by default', () => {
      writeLog('device.ndjson', [
        { ts: 1, src: 'device', level: 'error', msg: 'nw_socket_handle_socket_event [C1:2] Socket SO_ERROR [54]' },
        { ts: 2, src: 'device', level: 'fatal', msg: 'UIScene lifecycle will soon be required' },
      ]);
      run({ errors: true });
      expect(exitCode).toBe(null);
      expect(out).toEqual([]);
    });

    test('--source device puts it back, and so does --source all', () => {
      writeLog('device.ndjson', [{ ts: 1, src: 'device', level: 'error', msg: 'native crash' }]);
      writeLog('client.ndjson', [{ ts: 2, src: 'client', level: 'error', msg: 'js crash' }]);

      run({ errors: true, source: ['device'], json: true });
      expect(parsedMsgs(out)).toEqual(['native crash']);

      out.length = 0;
      run({ errors: true, source: ['all'], json: true });
      expect(parsedMsgs(out)).toEqual(['native crash', 'js crash']);
    });

    test('a plain logs (no --errors) still prints the device stream', () => {
      writeLog('device.ndjson', [{ ts: 1, src: 'device', level: 'error', msg: 'device line' }]);
      run({});
      expect(out.length).toBe(1);
      expect(out[0]).toMatch(/device line$/);
    });

    test(`--errors prints at most ${ERRORS_PRINT_CAP} records and says how many are left`, () => {
      const many = [];
      for (let i = 0; i < 3004; i += 1) {
        many.push({ ts: 1000 + i, src: 'client', level: 'error', msg: `boom ${i}` });
      }
      writeLog('client.ndjson', many);
      run({ errors: true });
      expect(out.length).toBe(ERRORS_PRINT_CAP + 1);
      expect(out[0]).toMatch(/boom 0$/);
      expect(out[ERRORS_PRINT_CAP - 1]).toMatch(/boom 19$/);
      const hidden = 3004 - ERRORS_PRINT_CAP;
      expect(out[ERRORS_PRINT_CAP]).toMatch(new RegExp(`and ${hidden} more`));
      expect(out[ERRORS_PRINT_CAP]).toMatch(new RegExp(`--tail ${hidden}`));
      expect(out[ERRORS_PRINT_CAP]).toMatch(/--json/);
    });

    test('the cap does not apply to --json, or to an explicit --tail', () => {
      const many = [];
      for (let i = 0; i < 25; i += 1) many.push({ ts: 1000 + i, src: 'client', level: 'error', msg: `boom ${i}` });
      writeLog('client.ndjson', many);

      run({ errors: true, json: true });
      expect(out.length).toBe(25);

      out.length = 0;
      run({ errors: true, tail: '25' });
      expect(out.length).toBe(25);
    });

    test('a result at the cap prints no trailer', () => {
      const many = [];
      for (let i = 0; i < ERRORS_PRINT_CAP; i += 1)
        many.push({ ts: 1000 + i, src: 'client', level: 'error', msg: `boom ${i}` });
      writeLog('client.ndjson', many);
      run({ errors: true });
      expect(out.length).toBe(ERRORS_PRINT_CAP);
      expect(!out.join('\n').includes('more')).toBeTruthy();
    });

    test('a bundle marker one second after a startup crash does not hide it', () => {
      const at = (sec: number) => Date.parse(`2026-08-24T16:03:${sec}Z`);
      writeLog('build-ios.ndjson', [{ ts: at(50), src: 'build', level: 'info', msg: 'launched', marker: true }]);
      writeLog('client.ndjson', [
        { ts: at(54), src: 'client', level: 'error', msg: '[Error: Exception in HostFunction]' },
      ]);
      writeLog('metro.ndjson', [
        { ts: at(55), src: 'metro', level: 'info', msg: 'bundle build done (1)', marker: true },
      ]);
      run({ errors: true, json: true });
      expect(parsedMsgs(out)).toEqual(['[Error: Exception in HostFunction]']);
    });
  });
});
