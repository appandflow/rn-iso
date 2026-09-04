import { describe, expect, it } from 'vitest';
import { durableRunRecord } from './run-record.mjs';

const hashes = { events: 'events', settingsPng: 'settings', transcript: 'transcript' };
const valid = { valid: true, invalidReasons: [], evidenceSha256: hashes, collectedAt: 'first' };

describe('durable benchmark run records', () => {
  it('preserves a valid integrity-matched record after live worktree cleanup', () => {
    const recollected = {
      valid: false,
      invalidReasons: ['launch-crash-worktree-missing', 'worktree-evidence-missing'],
      evidenceSha256: hashes,
      collectedAt: 'second',
    };
    expect(durableRunRecord(valid, recollected)).toBe(valid);
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
    expect(durableRunRecord(valid, changed)).toBe(changed);
    expect(durableRunRecord(valid, auditFailure)).toBe(auditFailure);
  });
});
