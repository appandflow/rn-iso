import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveInstallPipeline } from '../src/commands/worktree.js';
import { upsertProject, setSetupStatus, getSetupStatus } from '../src/config.js';

let tmpHome;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

test('uses the configured pipeline verbatim', () => {
  const pipeline = resolveInstallPipeline(
    { worktree: { install: ['pnpm install', 'pnpm build:packages'] } },
    '/proj'
  );
  assert.deepEqual(pipeline, ['pnpm install', 'pnpm build:packages']);
});

test('accepts a single string as a one-command pipeline', () => {
  assert.deepEqual(resolveInstallPipeline({ worktree: { install: 'yarn' } }, '/proj'), ['yarn']);
});

test('install false disables the pipeline', () => {
  assert.deepEqual(resolveInstallPipeline({ worktree: { install: false } }, '/proj'), []);
});

test('falls back to the detected package manager', () => {
  const pipeline = resolveInstallPipeline({ packageManager: 'pnpm' }, '/proj');
  assert.deepEqual(pipeline, ['pnpm install']);
});

test('setup status round-trips and reports incompleteness', () => {
  upsertProject('/proj', {});
  setSetupStatus('/proj', {
    complete: false,
    commands: [
      { command: 'pnpm install', ok: false },
      { command: 'pnpm build:packages', ok: true },
    ],
  });
  const status = getSetupStatus('/proj');
  assert.equal(status.complete, false);
  assert.equal(status.commands[0].ok, false);
});

test('getSetupStatus returns null for an unknown project', () => {
  assert.equal(getSetupStatus('/nope'), null);
});
