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
          startedAt: '2026-09-04T12:00:01.000Z',
          endedAt: '2026-09-04T12:00:10.000Z',
        },
        {
          id: 'logs',
          command: 'stim logs --errors',
          output: `${token}\napp/_layout.tsx:28 in RootLayout`,
          exitCode: 0,
          startedAt: '2026-09-04T12:00:11.000Z',
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
        command: "node -e \"console.log(require('fs').readFileSync('app/_layout.tsx', 'utf8'))\"",
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
      reason: 'launch-crash-pre-capture-command-not-allowed',
      commandId: 'inspect',
    });
  });

  it('rejects source inspection hidden after an allowed compound-command prefix', () => {
    const token = launchCrashToken('run');
    const tail = [
      {
        id: 'launch',
        command: 'stim ios',
        output: token,
        exitCode: 0,
        startedAt: '2026-09-04T12:00:02.000Z',
        endedAt: '2026-09-04T12:00:10.000Z',
      },
      {
        id: 'logs',
        command: 'stim logs --errors',
        output: `${token}\napp/_layout.tsx in RootLayout`,
        exitCode: 0,
        startedAt: '2026-09-04T12:00:11.000Z',
        endedAt: '2026-09-04T12:00:15.000Z',
      },
    ];

    for (const command of ["pwd && sed -n '1,80p' app/secret.tsx", 'git status && git diff']) {
      expect(
        launchCrashDiagnosis(
          [
            {
              id: 'inspect',
              command,
              output: 'source',
              exitCode: 0,
              startedAt: '2026-09-04T12:00:01.000Z',
              endedAt: '2026-09-04T12:00:01.500Z',
            },
            ...tail,
          ],
          { dispatchAt: '2026-09-04T12:00:00.000Z', token },
        ),
      ).toEqual({
        valid: false,
        reason: 'launch-crash-pre-capture-command-not-allowed',
        commandId: 'inspect',
      });
    }
  });

  it('requires a repaired relaunch and Settings proof', () => {
    const diagnosis = { valid: true, commandId: 'diagnosis' };
    const commands = [
      {
        id: 'diagnosis',
        command: 'rg TOKEN app/_layout.tsx',
        output: 'app/_layout.tsx',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:09Z',
        endedAt: '2026-09-04T12:00:10Z',
      },
      {
        id: 'relaunch',
        command: 'stim ios',
        output: 'OK: com.example.app',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:11Z',
        endedAt: '2026-09-04T12:00:20Z',
      },
      {
        id: 'screenshot',
        command: 'agent-device screenshot /tmp/settings.png',
        output: 'saved',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:20.500Z',
        endedAt: '2026-09-04T12:00:21Z',
      },
    ];
    expect(launchCrashRecovery(commands, { diagnosis, screen: { valid: false } })).toEqual({
      valid: false,
      reason: 'launch-crash-settings-proof-missing',
    });
    expect(
      launchCrashRecovery(commands, {
        diagnosis,
        screen: { valid: true, observedAt: '2026-09-04T12:00:19Z', screenshotCommandId: 'screenshot' },
      }),
    ).toEqual({ valid: false, reason: 'launch-crash-settings-proof-before-relaunch' });
    expect(
      launchCrashRecovery(commands, {
        diagnosis,
        screen: { valid: true, observedAt: '2026-09-04T12:00:21Z', screenshotCommandId: 'screenshot' },
      }),
    ).toEqual({
      valid: true,
      repairedLaunchCommandId: 'relaunch',
      screenshotCommandId: 'screenshot',
    });
  });

  it('accepts control relaunch output when later Settings proof succeeds', () => {
    const diagnosis = { valid: true, commandId: 'diagnosis' };
    const commands = [
      {
        id: 'diagnosis',
        command: 'rg TOKEN app/_layout.tsx',
        output: 'app/_layout.tsx',
        exitCode: 0,
        endedAt: '2026-09-04T12:00:10Z',
      },
      {
        id: 'relaunch',
        command: 'npx expo run:ios --device SIMULATOR',
        output: 'com.appandflow.trailhead: 90210',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:11Z',
        endedAt: '2026-09-04T12:00:20Z',
      },
      {
        id: 'screenshot',
        command: 'agent-device screenshot /tmp/settings.png',
        output: 'saved',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:20.500Z',
        endedAt: '2026-09-04T12:00:21Z',
      },
    ];

    expect(
      launchCrashRecovery(commands, {
        diagnosis,
        arm: 'control',
        screen: { valid: true, observedAt: '2026-09-04T12:00:21Z', screenshotCommandId: 'screenshot' },
      }),
    ).toEqual({ valid: true, repairedLaunchCommandId: 'relaunch', screenshotCommandId: 'screenshot' });
  });

  it('accepts a control dev-client URL relaunch', () => {
    const diagnosis = { valid: true, commandId: 'diagnosis' };
    const commands = [
      {
        id: 'diagnosis',
        command: 'tail logs/initial.log',
        output: 'STIM_BENCH_LAUNCH_CRASH_TOKEN app/_layout.tsx',
        exitCode: 0,
        endedAt: '2026-09-04T12:00:10Z',
      },
      {
        id: 'relaunch',
        command:
          "xcrun simctl openurl SIMULATOR 'com.example.app://expo-development-client/?url=http://localhost:8081'",
        output: '',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:11Z',
        endedAt: '2026-09-04T12:00:12Z',
      },
      {
        id: 'screenshot',
        command: 'agent-device screenshot /tmp/settings.png',
        output: 'saved',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:13Z',
        endedAt: '2026-09-04T12:00:14Z',
      },
    ];

    expect(
      launchCrashRecovery(commands, {
        diagnosis,
        arm: 'control',
        screen: { valid: true, observedAt: '2026-09-04T12:00:14Z', screenshotCommandId: 'screenshot' },
      }),
    ).toEqual({ valid: true, repairedLaunchCommandId: 'relaunch', screenshotCommandId: 'screenshot' });
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
