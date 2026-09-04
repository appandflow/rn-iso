import { describe, expect, it } from 'vitest';
import {
  injectRootRenderCrash,
  launchCrashDiagnosis,
  launchCrashRepair,
  launchCrashToken,
} from './launch-crash-benchmark.mjs';

describe('launch crash benchmark', () => {
  it('injects a unique deterministic exception at the root render', () => {
    const token = launchCrashToken('sol-stim-123');
    const source = 'const value = 1;\n\nexport default function RootLayout() {\n  return value;\n}\n';

    expect(token).toMatch(/^STIM_BENCH_LAUNCH_CRASH_[0-9A-F]{12}$/);
    expect(launchCrashToken('sol-stim-123')).toBe(token);
    expect(injectRootRenderCrash(source, token)).toContain(
      `export default function RootLayout() {\n  throw new Error('${token}');\n`,
    );
  });

  it('refuses an unknown layout shape or an already injected token', () => {
    const token = launchCrashToken('run');
    expect(() => injectRootRenderCrash('export default function App() {}', token)).toThrow(
      'RootLayout function was not found',
    );
    expect(() => injectRootRenderCrash(`export default function RootLayout() {\n  // ${token}\n}`, token)).toThrow(
      'launch-crash token is already present',
    );
  });

  it('uses the first command that reports both the token and source location', () => {
    const token = launchCrashToken('run');
    const diagnosis = launchCrashDiagnosis(
      [
        {
          id: 'launch',
          command: 'stim ios',
          output: token,
          endedAt: '2026-09-04T12:00:10.000Z',
        },
        {
          id: 'logs',
          command: 'stim logs --errors',
          output: `${token}\napp/_layout.tsx:28 in RootLayout`,
          endedAt: '2026-09-04T12:00:15.000Z',
        },
      ],
      { dispatchAt: '2026-09-04T12:00:00.000Z', token },
    );

    expect(diagnosis).toEqual({
      valid: true,
      observedAt: '2026-09-04T12:00:15.000Z',
      dispatchToDiagnosisSeconds: 15,
      commandCount: 2,
      commandId: 'logs',
      command: 'stim logs --errors',
    });
  });

  it('rejects generic errors and verifies that the injected token was removed', () => {
    const token = launchCrashToken('run');
    expect(
      launchCrashDiagnosis(
        [{ id: 'logs', command: 'stim logs --errors', output: 'Generic error', endedAt: '2026-09-04T12:00:15Z' }],
        { dispatchAt: '2026-09-04T12:00:00Z', token },
      ),
    ).toEqual({ valid: false, reason: 'actionable-launch-crash-diagnosis-missing' });
    expect(launchCrashRepair(`throw new Error('${token}')`, token)).toEqual({
      valid: false,
      reason: 'launch-crash-token-remains-in-source',
    });
    expect(launchCrashRepair('return <App />;', token)).toEqual({ valid: true });
  });
});
