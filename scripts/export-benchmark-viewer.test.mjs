import { describe, expect, it } from 'vitest';
import { estimateTokenCost, sanitizeBenchmarkText } from './export-benchmark-viewer.mjs';

describe('benchmark viewer export', () => {
  it('replaces machine paths, run ids, and simulator ids', () => {
    const source =
      '/Volumes/ExternalSSD/Developer/bench/results/run-123/proof/settings.png ' +
      '/tmp/run-123-settings.png 3372C014-23D1-4939-ABF6-94912654C56E 10.0.0.188';
    const output = sanitizeBenchmarkText(source, [
      ['/Volumes/ExternalSSD/Developer/bench/results/run-123', 'results/luna/javascript-stim'],
      ['run-123', 'javascript-stim'],
    ]);

    expect(output).toBe(
      'results/luna/javascript-stim/proof/settings.png tmp/javascript-stim-settings.png <simulator-udid> <local-ip>',
    );
  });

  it('prices cached input separately without double-counting reasoning tokens', () => {
    const cost = estimateTokenCost(
      {
        input_tokens: 447_299,
        cached_input_tokens: 392_448,
        output_tokens: 3_928,
        reasoning_output_tokens: 1_171,
      },
      'gpt-5.6-luna',
    );

    expect(cost).toBeCloseTo(0.02353276, 8);
  });
});
