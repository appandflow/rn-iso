import { describe, expect, it } from 'vitest';
import {
  injectRootRenderCrash,
  launchCrashDiagnosis,
  launchCrashRecovery,
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
          exitCode: 0,
          endedAt: '2026-09-04T12:00:10.000Z',
        },
        {
          id: 'logs',
          command: 'stim logs --errors',
          output: `${token}\napp/_layout.tsx:28 in RootLayout`,
          exitCode: 0,
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
      initialLaunchCommandId: 'launch',
      errorCaptureCommandId: 'logs',
    });
  });

  it('rejects source inspection before launch and error capture', () => {
    const token = launchCrashToken('run');
    const commands = [
      {
        id: 'inspect',
        command: 'sed -n 1,80p app/_layout.tsx',
        output: `${token}\napp/_layout.tsx:28 in RootLayout`,
        exitCode: 0,
        endedAt: '2026-09-04T12:00:01.000Z',
      },
      {
        id: 'launch',
        command: 'stim ios',
        output: token,
        exitCode: 0,
        endedAt: '2026-09-04T12:00:10.000Z',
      },
      {
        id: 'logs',
        command: 'stim logs --errors',
        output: token,
        exitCode: 0,
        endedAt: '2026-09-04T12:00:15.000Z',
      },
    ];

    expect(launchCrashDiagnosis(commands, { dispatchAt: '2026-09-04T12:00:00.000Z', token })).toEqual({
      valid: false,
      reason: 'launch-crash-source-inspected-before-error-capture',
    });
  });

  it('requires a repaired relaunch and Settings proof', () => {
    const diagnosis = { valid: true, commandId: 'diagnosis' };
    const commands = [
      { id: 'diagnosis', command: 'rg TOKEN app/_layout.tsx', output: 'app/_layout.tsx', exitCode: 0 },
      { id: 'relaunch', command: 'stim ios', output: 'OK: com.example.app', exitCode: 0 },
    ];
    expect(launchCrashRecovery(commands, { diagnosis, screen: { valid: false } })).toEqual({
      valid: false,
      reason: 'launch-crash-settings-proof-missing',
    });
    expect(launchCrashRecovery(commands, { diagnosis, screen: { valid: true } })).toEqual({
      valid: true,
      repairedLaunchCommandId: 'relaunch',
    });
  });

  it('rejects generic errors and verifies that the injected source was restored', () => {
    const token = launchCrashToken('run');
    expect(
      launchCrashDiagnosis(
        [
          { id: 'launch', command: 'stim ios', output: token, exitCode: 0, endedAt: '2026-09-04T12:00:10Z' },
          {
            id: 'logs',
            command: 'stim logs --errors',
            output: 'Generic error',
            exitCode: 0,
            endedAt: '2026-09-04T12:00:15Z',
          },
        ],
        { dispatchAt: '2026-09-04T12:00:00Z', token },
      ),
    ).toEqual({ valid: false, reason: 'launch-crash-error-capture-missing' });
    expect(launchCrashRepair(`throw new Error('${token}')`, token)).toEqual({
      valid: false,
      reason: 'launch-crash-token-remains-in-source',
    });
    expect(launchCrashRepair('', token)).toEqual({
      valid: false,
      reason: 'launch-crash-repaired-source-empty',
    });
    const source = 'return <App />;';
    const sourceSha256 = '536c73d86cc5b77dc1a134a6d90687ec5c9c848e67beadf8ff45cdd2da649908';
    expect(launchCrashRepair(source, token, sourceSha256)).toEqual({ valid: true, sourceSha256 });
    expect(launchCrashRepair(`${source}\n`, token, sourceSha256)).toMatchObject({
      valid: false,
      reason: 'launch-crash-source-not-restored',
    });
  });
});
