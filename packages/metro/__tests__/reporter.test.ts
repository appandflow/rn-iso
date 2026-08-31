import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { ndjsonReporter } from '../index.ts';

function tempDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'stim-reporter-')));
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

test('bundle_build_failed is a marker too, written before the bundling_error it precedes', () => {
  withDir((dir) => {
    const reporter = ndjsonReporter({ dir });
    reporter.update({ type: 'bundle_build_failed', buildID: 'build_2' });
    reporter.update({ type: 'bundling_error', error: new Error('Unable to resolve module ./nope') });

    const lines = records(dir, 'metro.ndjson');
    expect(lines.length).toBe(2);
    const [marker, error] = lines;
    expect(marker.marker).toBe(true);
    expect(marker.level).toBe('info');
    expect(marker.event).toBe('bundle_build_failed');
    expect(marker.msg).toBe('bundle build failed (build_2)');
    expect(error.level).toBe('error');
    expect(error.marker).toBe(undefined);
    expect(error.ts >= marker.ts).toBeTruthy();
  });
});

test('overlapping bundle records keep their build id and platform', () => {
  withDir((dir) => {
    const reporter = ndjsonReporter({ dir });
    reporter.update({ type: 'bundle_build_started', buildID: 'ios_1', bundleDetails: { platform: 'ios' } });
    reporter.update({ type: 'bundle_build_started', buildID: 'android_1', bundleDetails: { platform: 'android' } });
    reporter.update({ type: 'bundle_build_done', buildID: 'android_1' });
    reporter.update({ type: 'bundle_build_failed', buildID: 'ios_1' });
    reporter.update({ type: 'bundling_error', error: new Error('Unable to resolve module ./ios-only') });

    const lines = records(dir, 'metro.ndjson');
    expect(lines.map((record) => [record.event, record.buildID, record.platform])).toEqual([
      ['bundle_build_started', 'ios_1', 'ios'],
      ['bundle_build_started', 'android_1', 'android'],
      ['bundle_build_done', 'android_1', 'android'],
      ['bundle_build_failed', 'ios_1', 'ios'],
      ['bundling_error', 'ios_1', 'ios'],
    ]);
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

test.skipIf(Boolean(process.getuid) && process.getuid!() === 0)(
  'an unwritable directory costs records, not the server',
  () => {
    withDir((dir) => {
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

test('dir defaults to the readable collision-safe workspace under STIM_HOME', () => {
  withDir((dir) => {
    const cwd = process.cwd();
    const previousHome = process.env.STIM_HOME;
    const stateHome = path.join(dir, 'state-home');
    process.chdir(dir);
    process.env.STIM_HOME = stateHome;
    try {
      const reporter = ndjsonReporter();
      reporter.update({ type: 'bundle_build_done' });
      const workspaces = fs.readdirSync(path.join(stateHome, 'workspaces'));
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]).toMatch(new RegExp(`^${path.basename(dir).toLowerCase()}--[a-f0-9]{16}$`));
      expect(fs.existsSync(path.join(stateHome, 'workspaces', workspaces[0]!, 'logs', 'metro.ndjson'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '.stim'))).toBe(false);
    } finally {
      process.chdir(cwd);
      if (previousHome === undefined) delete process.env.STIM_HOME;
      else process.env.STIM_HOME = previousHome;
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
