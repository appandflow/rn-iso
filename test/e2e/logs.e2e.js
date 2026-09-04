import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceLogsDir } from '../../packages/stim-cli/src/paths.ts';

const CLI = fileURLToPath(new URL('../../packages/stim-cli/bin/cli.ts', import.meta.url));
let home;
let project;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-logs-e2e-home-')));
  process.env.STIM_HOME = home;
  project = realpathSync(mkdtempSync(join(tmpdir(), 'stim-logs-e2e-project-')));
  writeFileSync(join(project, 'package.json'), '{"name":"logs-fixture","private":true}\n');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('an empty error query exits 0, with a human-only note on stderr', () => {
  writeLogs([{ ts: 1, src: 'metro', level: 'info', msg: 'bundling' }]);
  const human = run();
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.stdout, '');
  assert.match(human.stderr, /No matching log records/);

  const json = run(['--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(json.stdout, '');
  assert.equal(json.stderr, '');
});

test('matching errors also exit 0, so a successful query alone is not a clean check', () => {
  const error = { ts: 2, src: 'metro', level: 'error', msg: 'App failed to render' };
  writeLogs([{ ts: 1, src: 'metro', level: 'info', msg: 'bundle completed', marker: true }, error]);
  const human = run();
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /App failed to render/);
  assert.doesNotMatch(human.stderr, /No matching log records/);

  const json = run(['--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(json.stdout.trim().split('\n').map(JSON.parse), [error]);
  assert.equal(json.stderr, '');
});

test('no log directory is a successful empty query without evidence of capture', () => {
  const result = run(['--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('an invalid query exits 1 with empty stdout and a diagnostic on stderr', () => {
  const result = run(['--json', '--source', 'unknown']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Unknown --source value/);
});

function writeLogs(records) {
  const dir = workspaceLogsDir(project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'metro.ndjson'), records.map((record) => `${JSON.stringify(record)}\n`).join(''));
}

function run(args = []) {
  return spawnSync(process.execPath, [CLI, 'logs', '--errors', ...args], {
    cwd: project,
    env: process.env,
    encoding: 'utf-8',
  });
}
