import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldShutdown } from '../src/commands/release.js';

test('shuts down an unoccupied sim', () => {
  assert.deepEqual(shouldShutdown({ occupied: false, force: false }), { shutdown: true, reason: null });
});

test('withholds shutdown for an occupied sim', () => {
  const result = shouldShutdown({ occupied: true, force: false });
  assert.equal(result.shutdown, false);
  assert.match(result.reason, /in use/i);
});

test('--force overrides occupancy', () => {
  assert.deepEqual(shouldShutdown({ occupied: true, force: true }), { shutdown: true, reason: null });
});
