import { describe, expect, it } from 'vitest';
import { completedCleanupRecord, durableRunRecord } from './run-record.mjs';

const hashes = { events: 'events', settingsPng: 'settings', transcript: 'transcript' };
const valid = { valid: true, invalidReasons: [], evidenceSha256: hashes, collectedAt: 'first' };

describe('durable benchmark run records', () => {
  it('requires a successful recorded worktree cleanup', () => {
    expect(completedCleanupRecord({ cleanedAt: 'now', actions: ['stim worktree remove --force'] })).toBe(true);
    expect(completedCleanupRecord({ cleanedAt: 'now', actions: ['verified agent-device sessions empty'] })).toBe(false);
    expect(
      completedCleanupRecord({
        cleanedAt: 'now',
        actions: ['remove worktree worktree/run', 'failed: remove worktree worktree/run: busy'],
      }),
    ).toBe(false);
  });

  it('preserves a valid integrity-matched record after live worktree cleanup', () => {
    const recollected = {
      valid: false,
      invalidReasons: ['launch-crash-worktree-missing', 'worktree-evidence-missing'],
      evidenceSha256: hashes,
      collectedAt: 'second',
    };
    expect(durableRunRecord(valid, recollected, true)).toBe(valid);
  });

  it('does not preserve a record across changed evidence or a stricter audit failure', () => {
    const changed = {
      valid: false,
      invalidReasons: ['launch-crash-worktree-missing'],
      evidenceSha256: { ...hashes, events: 'changed' },
    };
    const auditFailure = {
      valid: false,
      invalidReasons: ['launch-crash-pre-capture-command-not-allowed'],
      evidenceSha256: hashes,
    };
    const missingSource = {
      valid: false,
      invalidReasons: ['launch-crash-source-missing'],
      evidenceSha256: hashes,
    };
    const missingEdit = {
      valid: false,
      invalidReasons: ['source-edit-missing'],
      evidenceSha256: hashes,
    };
    expect(durableRunRecord(valid, changed)).toBe(changed);
    expect(durableRunRecord(valid, auditFailure)).toBe(auditFailure);
    expect(durableRunRecord(valid, missingSource)).toBe(missingSource);
    expect(durableRunRecord(valid, missingEdit)).toBe(missingEdit);
    expect(durableRunRecord(valid, missingSource, true)).toBe(valid);
    expect(durableRunRecord(valid, missingEdit, true)).toBe(valid);
  });
});
