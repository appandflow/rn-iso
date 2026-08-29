import assert from 'node:assert/strict';
import test from 'node:test';
import { launchEvidenceMessage, noCompileEvidenceMessage } from './native/assertions.mjs';

test('native launch evidence accepts verified, bundling, and unverified states', () => {
  assert.match(launchEvidenceMessage(true, 'wt1'), /verified/);
  assert.match(launchEvidenceMessage('bundling', 'wt1'), /still building/);
  assert.match(launchEvidenceMessage('unverified', 'wt1'), /UNVERIFIED/);
});

test('native launch evidence rejects reserved and unknown states', () => {
  assert.throws(() => launchEvidenceMessage(false, 'wt1'), /did not launch/);
  assert.throws(() => launchEvidenceMessage('other', 'wt1'), /did not launch/);
});

test('native no-compile evidence fails closed when the build log is missing', () => {
  assert.throws(
    () => noCompileEvidenceMessage({ cwd: '/tmp/wt2', logPath: null, text: '', compileSigns: [] }),
    /proof is missing/,
  );
});

test('native no-compile evidence rejects compiler signatures and accepts a clean log', () => {
  const input = { cwd: '/tmp/wt2', logPath: '/tmp/build.ndjson', compileSigns: [/xcodebuild/i] };
  assert.throws(() => noCompileEvidenceMessage({ ...input, text: 'xcodebuild app' }), /compile signature/);
  assert.match(noCompileEvidenceMessage({ ...input, text: 'installed from cache' }), /no-compile proof/);
});
