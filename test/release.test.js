import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseAction } from '../src/commands/release.js';

test('owned device is deleted', () => {
  assert.deepEqual(releaseAction({ record: { owned: true }, occupied: false, force: false }),
    { action: 'delete', reason: null });
});

test('occupied owned device is cleared, not deleted, without --force', () => {
  const r = releaseAction({ record: { owned: true }, occupied: true, force: false });
  assert.equal(r.action, 'clear');
  assert.match(r.reason, /in use/i);
});

test('--force deletes an occupied owned device', () => {
  assert.equal(releaseAction({ record: { owned: true }, occupied: true, force: true }).action, 'delete');
});

test('legacy and physical assignments are cleared, never deleted', () => {
  assert.equal(releaseAction({ record: { deviceUdid: 'U' }, occupied: false, force: false }).action, 'clear');
  assert.equal(releaseAction({ record: { serial: 'R5', owned: false }, occupied: false, force: true }).action, 'clear');
});
