// This package is CommonJS on purpose -- a metro.config.js and a supervisor
// hosting Metro in-process both reach it through require() -- so its tests are
// CommonJS too: `node --test` reparses an ESM test file in a typeless package
// and warns about it on every run.
//
// What is under test is the record shape, not Metro. The events fed in are the
// shapes Metro's reporter actually emits (a `client_log` with a data array, a
// `bundling_error` carrying an Error), plus the shapes it does not, because a
// reporter that throws takes the dev server down with it.
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { ndjsonReporter } from '../index.ts';

function tempDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'rn-iso-reporter-')));
}

function records(dir, file) {
  const text = fs.readFileSync(path.join(dir, file), 'utf-8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function withDir(fn) {
  const dir = tempDir();
  try {
    fn(dir);
  } finally {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a client_log becomes one client.ndjson record with the level mapped and the data joined', () => {
  withDir((dir) => {
    const reporter = ndjsonReporter({ dir });
    const before = Date.now();
    reporter.update({ type: 'client_log', level: 'log', data: ['hello', 42, { a: 1 }] });

    const lines = records(dir, 'client.ndjson');
    expect(lines.length).toBe(1);
    const rec = lines[0];
    expect(rec.src).toBe('client');
    expect(rec.level).toBe('info');
    expect(rec.msg).toBe('hello 42 {"a":1}');
    expect(rec.event).toBe('client_log');
    expect(Number.isInteger(rec.ts) && rec.ts >= before && rec.ts <= Date.now()).toBeTruthy();
    expect(fs.existsSync(path.join(dir, 'metro.ndjson'))).toBe(false);
  });
});

test('client_log levels map onto the contract, and a stack passes through', () => {
  withDir((dir) => {
    const reporter = ndjsonReporter({ dir });
    const stack = [{ file: '/src/App.js', line: 12, column: 3, fn: 'render' }];
    reporter.update({ type: 'client_log', level: 'warn', data: ['careful'] });
    reporter.update({ type: 'client_log', level: 'error', data: ['boom'], stack });
    reporter.update({ type: 'client_log', level: 'trace', data: ['tracing'] });

    const lines = records(dir, 'client.ndjson');
    expect(lines.map((r) => r.level)).toEqual(['warn', 'error', 'debug']);
    expect(lines[1].stack).toEqual(stack);
    expect(lines[0].stack).toBe(undefined);
  });
});

test('bundling_error and transformer_error are metro-side errors with the message extracted', () => {
  withDir((dir) => {
    const reporter = ndjsonReporter({ dir });
    const error = new Error('Unable to resolve module ./nope from /src/App.js');
    reporter.update({ type: 'bundling_error', error });
    reporter.update({ type: 'transformer_error', error: { message: 'transform failed' } });

    const lines = records(dir, 'metro.ndjson');
    expect(lines.length).toBe(2);
    expect(lines.map((r) => r.level)).toEqual(['error', 'error']);
    expect(lines.map((r) => r.src)).toEqual(['metro', 'metro']);
    expect(lines[0].msg).toBe('Unable to resolve module ./nope from /src/App.js');
    expect(lines[0].event).toBe('bundling_error');
    expect(lines[1].msg).toBe('transform failed');
  });
});

test('bundle_build_done is the marker that resets the --errors window', () => {
  withDir((dir) => {
    const reporter = ndjsonReporter({ dir });
    reporter.update({ type: 'bundle_build_done', buildID: 'build_1' });

    const [rec] = records(dir, 'metro.ndjson');
    expect(rec.level).toBe('info');
    expect(rec.src).toBe('metro');
    expect(rec.marker).toBe(true);
    expect(rec.event).toBe('bundle_build_done');
    expect(rec.msg.length > 0).toBeTruthy();
  });
});

test('unstable_server_log carries its own level', () => {
  withDir((dir) => {
    const reporter = ndjsonReporter({ dir });
    reporter.update({ type: 'unstable_server_log', level: 'warn', data: ['port', 8081] });

    const [rec] = records(dir, 'metro.ndjson');
    expect(rec.level).toBe('warn');
    expect(rec.src).toBe('metro');
    expect(rec.msg).toBe('port 8081');
  });
});

// Metro emits dozens of event types and adds more between minors. They are kept
// -- at debug, so they cost nothing to a default query -- rather than dropped,
// because the event name is often the only evidence of what the server was
// doing before it failed.
test('every other event is kept at debug with its event name', () => {
  withDir((dir) => {
    const reporter = ndjsonReporter({ dir });
    reporter.update({ type: 'dep_graph_loading' });
    reporter.update({
      type: 'bundle_transform_progressed',
      buildID: 'build_1',
      transformedFileCount: 3,
      totalFileCount: 9,
    });

    const lines = records(dir, 'metro.ndjson');
    expect(lines.map((r) => r.level)).toEqual(['debug', 'debug']);
    expect(lines.map((r) => r.event)).toEqual(['dep_graph_loading', 'bundle_transform_progressed']);
    expect(lines.every((r) => typeof r.msg === 'string')).toBeTruthy();
  });
});

// A reporter that throws takes the dev server down with it, and the shapes it
// is handed come from a package rn-iso does not version.
test('unknown and malformed shapes never throw, and never write a corrupt line', () => {
  withDir((dir) => {
    const reporter = ndjsonReporter({ dir });
    const circular = { self: null };
    circular.self = circular;

    expect(() => {
      reporter.update();
      reporter.update(null);
      reporter.update({});
      reporter.update({ type: 'client_log' });
      reporter.update({ type: 'client_log', level: 'log', data: circular });
      reporter.update({ type: 'bundling_error' });
      reporter.update({ type: 42 });
    }).not.toThrow();

    for (const file of ['metro.ndjson', 'client.ndjson']) {
      const full = path.join(dir, file);
      if (!fs.existsSync(full)) continue;
      for (const rec of records(dir, file)) {
        expect(Number.isInteger(rec.ts)).toBeTruthy();
        expect(['debug', 'info', 'warn', 'error', 'fatal'].includes(rec.level)).toBeTruthy();
        expect(typeof rec.msg).toBe('string');
        expect(rec.src === 'metro' || rec.src === 'client').toBeTruthy();
      }
    }
  });
});

test('the log directory is created on the first write, not on construction', () => {
  withDir((outer) => {
    const dir = path.join(outer, 'logs');
    const reporter = ndjsonReporter({ dir });
    expect(fs.existsSync(dir)).toBe(false);
    reporter.update({ type: 'bundle_build_done' });
    expect(fs.existsSync(path.join(dir, 'metro.ndjson'))).toBe(true);
  });
});

// Logging failure is not server failure: it is counted and swallowed.
test.skipIf(Boolean(process.getuid) && process.getuid!() === 0)(
  'an unwritable directory costs records, not the server',
  () => {
    withDir((dir) => {
      // Locked before the first write on purpose: a read-only directory stops the
      // log files being CREATED, while a file that already exists goes on taking
      // appends regardless of the directory's mode.
      const reporter = ndjsonReporter({ dir });
      fs.chmodSync(dir, 0o500);
      expect(() => {
        reporter.update({ type: 'client_log', level: 'log', data: ['lost'] });
        reporter.update({ type: 'bundling_error', error: new Error('also lost') });
      }).not.toThrow();
      expect(reporter.drops).toBe(2);
      expect(fs.existsSync(path.join(dir, 'metro.ndjson'))).toBe(false);

      fs.chmodSync(dir, 0o700);
      reporter.update({ type: 'bundle_build_done' });
      expect(records(dir, 'metro.ndjson').length).toBe(1);
      expect(reporter.drops).toBe(2);
    });
  },
);

test('dir defaults to .rn-iso/logs under the working directory', () => {
  withDir((dir) => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const reporter = ndjsonReporter();
      reporter.update({ type: 'bundle_build_done' });
      expect(fs.existsSync(path.join(dir, '.rn-iso', 'logs', 'metro.ndjson'))).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });
});

test('records append rather than replace', () => {
  withDir((dir) => {
    const reporter = ndjsonReporter({ dir });
    for (let i = 0; i < 5; i++) reporter.update({ type: 'unstable_server_log', level: 'info', data: [`line ${i}`] });
    const lines = records(dir, 'metro.ndjson');
    expect(lines.length).toBe(5);
    expect(lines.map((r) => r.msg)).toEqual(['line 0', 'line 1', 'line 2', 'line 3', 'line 4']);
  });
});
