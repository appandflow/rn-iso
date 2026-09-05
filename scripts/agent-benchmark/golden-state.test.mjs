import { describe, expect, it } from 'vitest';
import { matchesGoldenPreparation } from './golden-state.mjs';

const expected = {
  fixtureCommit: 'fixture',
  stimVersion: '1.0.0-rc.15',
  stimIntegrity: 'sha512-current',
  stimCliSha256: 'cli-current',
  agentDeviceVersion: '0.20.10',
  agentDeviceSha256: 'agent-device-current',
};

describe('golden preparation provenance', () => {
  it('accepts an exact preparation identity', () => {
    expect(matchesGoldenPreparation(expected, expected)).toBe(true);
  });

  it('rejects missing or mismatched preparation identity', () => {
    expect(matchesGoldenPreparation(null, expected)).toBe(false);
    expect(matchesGoldenPreparation({ ...expected, stimVersion: '1.0.0-rc.14' }, expected)).toBe(false);
    expect(matchesGoldenPreparation({ ...expected, stimIntegrity: 'sha512-old' }, expected)).toBe(false);
    expect(matchesGoldenPreparation({ ...expected, stimCliSha256: 'cli-old' }, expected)).toBe(false);
  });
});
