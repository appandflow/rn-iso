// This package is CommonJS on purpose -- a metro.config.js and a supervisor
// hosting Metro in-process both reach it through require() -- so its tests are
// CommonJS too: `node --test` reparses an ESM test file in a typeless package
// and warns about it on every run.
//
// What is under test is the record shape, not Metro. The events fed in are the
// shapes Metro's reporter actually emits (a `client_log` with a data array, a
// `bundling_error` carrying an Error), plus the shapes it does not, because a
// reporter that throws takes the dev server down with it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const { ndjsonReporter } = require('../index.js');

function tempDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'rn-iso-reporter-')));
}

function records(dir, file) {
  const text = fs.readFileSync(path.join(dir, file), 'utf-8');
  return text
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
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
  withDir(dir => {
    const reporter = ndjsonReporter({ dir });
    const before = Date.now();
    reporter.update({ type: 'client_log', level: 'log', data: ['hello', 42, { a: 1 }] });

    const lines = records(dir, 'client.ndjson');
    assert.equal(lines.length, 1);
    const rec = lines[0];
    assert.equal(rec.src, 'client');
    assert.equal(rec.level, 'info', 'console.log is info, not a level of its own');
    assert.equal(rec.msg, 'hello 42 {"a":1}');
    assert.equal(rec.event, 'client_log');
    assert.ok(Number.isInteger(rec.ts) && rec.ts >= before && rec.ts <= Date.now());
    assert.equal(fs.existsSync(path.join(dir, 'metro.ndjson')), false, 'client logs do not touch metro.ndjson');
  });
});

test('client_log levels map onto the contract, and a stack passes through', () => {
  withDir(dir => {
    const reporter = ndjsonReporter({ dir });
    const stack = [{ file: '/src/App.js', line: 12, column: 3, fn: 'render' }];
    reporter.update({ type: 'client_log', level: 'warn', data: ['careful'] });
    reporter.update({ type: 'client_log', level: 'error', data: ['boom'], stack });
    reporter.update({ type: 'client_log', level: 'trace', data: ['tracing'] });

    const lines = records(dir, 'client.ndjson');
    assert.deepEqual(lines.map(r => r.level), ['warn', 'error', 'debug']);
    assert.deepEqual(lines[1].stack, stack);
    assert.equal(lines[0].stack, undefined, 'no stack means no stack field');
  });
});

test('bundling_error and transformer_error are metro-side errors with the message extracted', () => {
  withDir(dir => {
    const reporter = ndjsonReporter({ dir });
    const error = new Error('Unable to resolve module ./nope from /src/App.js');
    reporter.update({ type: 'bundling_error', error });
    reporter.update({ type: 'transformer_error', error: { message: 'transform failed' } });

    const lines = records(dir, 'metro.ndjson');
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map(r => r.level), ['error', 'error']);
    assert.deepEqual(lines.map(r => r.src), ['metro', 'metro']);
    assert.equal(lines[0].msg, 'Unable to resolve module ./nope from /src/App.js');
    assert.equal(lines[0].event, 'bundling_error');
    assert.equal(lines[1].msg, 'transform failed');
  });
});

test('bundle_build_done is the marker that resets the --errors window', () => {
  withDir(dir => {
    const reporter = ndjsonReporter({ dir });
    reporter.update({ type: 'bundle_build_done', buildID: 'build_1' });

    const [rec] = records(dir, 'metro.ndjson');
    assert.equal(rec.level, 'info');
    assert.equal(rec.src, 'metro');
    assert.equal(rec.marker, true);
    assert.equal(rec.event, 'bundle_build_done');
    assert.ok(rec.msg.length > 0);
  });
});

test('unstable_server_log carries its own level', () => {
  withDir(dir => {
    const reporter = ndjsonReporter({ dir });
    reporter.update({ type: 'unstable_server_log', level: 'warn', data: ['port', 8081] });

    const [rec] = records(dir, 'metro.ndjson');
    assert.equal(rec.level, 'warn');
    assert.equal(rec.src, 'metro');
    assert.equal(rec.msg, 'port 8081');
  });
});

// Metro emits dozens of event types and adds more between minors. They are kept
// -- at debug, so they cost nothing to a default query -- rather than dropped,
// because the event name is often the only evidence of what the server was
// doing before it failed.
test('every other event is kept at debug with its event name', () => {
  withDir(dir => {
    const reporter = ndjsonReporter({ dir });
    reporter.update({ type: 'dep_graph_loading' });
    reporter.update({ type: 'bundle_transform_progressed', buildID: 'build_1', transformedFileCount: 3, totalFileCount: 9 });

    const lines = records(dir, 'metro.ndjson');
    assert.deepEqual(lines.map(r => r.level), ['debug', 'debug']);
    assert.deepEqual(lines.map(r => r.event), ['dep_graph_loading', 'bundle_transform_progressed']);
    assert.ok(lines.every(r => typeof r.msg === 'string'));
  });
});

// A reporter that throws takes the dev server down with it, and the shapes it
// is handed come from a package rn-iso does not version.
test('unknown and malformed shapes never throw, and never write a corrupt line', () => {
  withDir(dir => {
    const reporter = ndjsonReporter({ dir });
    const circular = { self: null };
    circular.self = circular;

    assert.doesNotThrow(() => {
      reporter.update();
      reporter.update(null);
      reporter.update({});
      reporter.update({ type: 'client_log' });
      reporter.update({ type: 'client_log', level: 'log', data: circular });
      reporter.update({ type: 'bundling_error' });
      reporter.update({ type: 42 });
    });

    for (const file of ['metro.ndjson', 'client.ndjson']) {
      const full = path.join(dir, file);
      if (!fs.existsSync(full)) continue;
      for (const rec of records(dir, file)) {
        assert.ok(Number.isInteger(rec.ts));
        assert.ok(['debug', 'info', 'warn', 'error', 'fatal'].includes(rec.level));
        assert.equal(typeof rec.msg, 'string');
        assert.ok(rec.src === 'metro' || rec.src === 'client');
      }
    }
  });
});

test('the log directory is created on the first write, not on construction', () => {
  withDir(outer => {
    const dir = path.join(outer, 'logs');
    const reporter = ndjsonReporter({ dir });
    assert.equal(fs.existsSync(dir), false);
    reporter.update({ type: 'bundle_build_done' });
    assert.equal(fs.existsSync(path.join(dir, 'metro.ndjson')), true);
  });
});

// Logging failure is not server failure: it is counted and swallowed.
test('an unwritable directory costs records, not the server', { skip: process.getuid && process.getuid() === 0 ? 'runs as root' : false }, () => {
  withDir(dir => {
    // Locked before the first write on purpose: a read-only directory stops the
    // log files being CREATED, while a file that already exists goes on taking
    // appends regardless of the directory's mode.
    const reporter = ndjsonReporter({ dir });
    fs.chmodSync(dir, 0o500);
    assert.doesNotThrow(() => {
      reporter.update({ type: 'client_log', level: 'log', data: ['lost'] });
      reporter.update({ type: 'bundling_error', error: new Error('also lost') });
    });
    assert.equal(reporter.drops, 2);
    assert.equal(fs.existsSync(path.join(dir, 'metro.ndjson')), false);

    fs.chmodSync(dir, 0o700);
    reporter.update({ type: 'bundle_build_done' });
    assert.equal(records(dir, 'metro.ndjson').length, 1, 'writing resumes once the directory is writable again');
    assert.equal(reporter.drops, 2, 'a recovered write is not a drop');
  });
});

test('dir defaults to .rn-iso/logs under the working directory', () => {
  withDir(dir => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const reporter = ndjsonReporter();
      reporter.update({ type: 'bundle_build_done' });
      assert.equal(fs.existsSync(path.join(dir, '.rn-iso', 'logs', 'metro.ndjson')), true);
    } finally {
      process.chdir(cwd);
    }
  });
});

test('records append rather than replace', () => {
  withDir(dir => {
    const reporter = ndjsonReporter({ dir });
    for (let i = 0; i < 5; i++) reporter.update({ type: 'unstable_server_log', level: 'info', data: [`line ${i}`] });
    const lines = records(dir, 'metro.ndjson');
    assert.equal(lines.length, 5);
    assert.deepEqual(lines.map(r => r.msg), ['line 0', 'line 1', 'line 2', 'line 3', 'line 4']);
  });
});
