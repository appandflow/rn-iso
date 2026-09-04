import { describe, expect, it } from 'vitest';
import {
  changedPathsFromGitOutputs,
  injectRootRenderCrash,
  launchCrashDiagnosis,
  launchCrashRecovery,
  launchCrashRepair,
  launchCrashToken,
} from './launch-crash-benchmark.mjs';

describe('launch crash benchmark', () => {
  it('combines staged, unstaged, and untracked repair paths', () => {
    expect(changedPathsFromGitOutputs('app/_layout.tsx\0', '')).toEqual(['app/_layout.tsx']);
    expect(changedPathsFromGitOutputs('app/_layout.tsx\0', 'notes.txt\0')).toEqual(['app/_layout.tsx', 'notes.txt']);
    expect(changedPathsFromGitOutputs('src/native.ts\0app/_layout.tsx\0', 'src/native.ts\0')).toEqual([
      'app/_layout.tsx',
      'src/native.ts',
    ]);
  });

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

  it('allows planning activity before the first error capture', () => {
    const token = launchCrashToken('run');
    expect(
      launchCrashDiagnosis(
        [
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
        ],
        {
          dispatchAt: '2026-09-04T12:00:00.000Z',
          token,
          activities: [
            {
              id: 'plan',
              command: 'tool:todo_list {}',
              startedAt: '2026-09-04T12:00:01.000Z',
              endedAt: '2026-09-04T12:00:01.000Z',
            },
          ],
        },
      ),
    ).toMatchObject({ valid: true, commandId: 'logs' });
  });

  it('unwraps a shell command whose nested quoting changes the closing quote', () => {
    const token = launchCrashToken('run');
    expect(
      launchCrashDiagnosis(
        [
          {
            id: 'metro',
            command:
              '/bin/zsh -lc "nohup ./node_modules/.bin/expo start > /tmp/metro.log 2>&1 & pid="\'$!; echo "$pid"\'',
            output: '1234',
            exitCode: 0,
            startedAt: '2026-09-04T12:00:01.000Z',
            endedAt: '2026-09-04T12:00:02.000Z',
          },
          {
            id: 'launch',
            command: '/opt/homebrew/bin/node ./node_modules/expo/bin/cli run:ios --device SIMULATOR',
            output: 'started',
            exitCode: 0,
            startedAt: '2026-09-04T12:00:03.000Z',
            endedAt: '2026-09-04T12:00:10.000Z',
          },
          {
            id: 'logs',
            command: 'tail /tmp/native.log',
            output: `${token}\napp/_layout.tsx in RootLayout`,
            exitCode: 0,
            startedAt: '2026-09-04T12:00:11.000Z',
            endedAt: '2026-09-04T12:00:15.000Z',
          },
        ],
        { dispatchAt: '2026-09-04T12:00:00.000Z', token, arm: 'control' },
      ),
    ).toMatchObject({ valid: true, commandId: 'logs' });
  });

  it('allows isolated device interaction needed to expose the runtime error', () => {
    const token = launchCrashToken('run');
    expect(
      launchCrashDiagnosis(
        [
          {
            id: 'launch',
            command: 'npx expo run:ios --device SIMULATOR',
            output: 'started',
            exitCode: 0,
            startedAt: '2026-09-04T12:00:01.000Z',
            endedAt: '2026-09-04T12:00:10.000Z',
          },
          {
            id: 'device',
            command:
              'env AGENT_DEVICE_STATE_DIR=/tmp/state AGENT_DEVICE_SESSION=run agent-device click "Enter URL manually"',
            output: 'clicked',
            exitCode: 0,
            startedAt: '2026-09-04T12:00:11.000Z',
            endedAt: '2026-09-04T12:00:12.000Z',
          },
          {
            id: 'logs',
            command: 'rg STIM_BENCH /tmp/metro.log',
            output: `${token}\napp/_layout.tsx in RootLayout`,
            exitCode: 0,
            startedAt: '2026-09-04T12:00:13.000Z',
            endedAt: '2026-09-04T12:00:15.000Z',
          },
        ],
        { dispatchAt: '2026-09-04T12:00:00.000Z', token, arm: 'control' },
      ),
    ).toMatchObject({ valid: true, commandId: 'logs' });
  });

  it('allows directory-only dependency and native-cache inventory before launch diagnosis', () => {
    const token = launchCrashToken('run');
    expect(
      launchCrashDiagnosis(
        [
          {
            id: 'inventory',
            command:
              'find . -maxdepth 3 -type d \\( -name node_modules -o -name Pods -o -name build -o -name .gradle -o -name DerivedData \\) -print',
            output: './node_modules\n./ios/Pods\n./ios/build',
            exitCode: 0,
            startedAt: '2026-09-04T12:00:01Z',
            endedAt: '2026-09-04T12:00:02Z',
          },
          {
            id: 'launch',
            command: 'npx expo run:ios --device SIMULATOR',
            output: 'started',
            exitCode: 0,
            startedAt: '2026-09-04T12:00:03Z',
            endedAt: '2026-09-04T12:00:10Z',
          },
          {
            id: 'logs',
            command: 'rg STIM_BENCH logs/runtime.log',
            output: `${token}\napp/_layout.tsx in RootLayout`,
            exitCode: 0,
            startedAt: '2026-09-04T12:00:11Z',
            endedAt: '2026-09-04T12:00:12Z',
          },
        ],
        { dispatchAt: '2026-09-04T12:00:00Z', token, arm: 'control' },
      ),
    ).toMatchObject({ valid: true, commandId: 'logs' });
  });

  it('allows iOS project-container discovery before launch diagnosis', () => {
    const token = launchCrashToken('run');
    expect(
      launchCrashDiagnosis(
        [
          {
            id: 'inventory',
            command: "find ios -maxdepth 1 \\( -name '*.xcworkspace' -o -name '*.xcodeproj' \\) -print",
            output: 'ios/Trailhead.xcworkspace\nios/Trailhead.xcodeproj',
            exitCode: 0,
            startedAt: '2026-09-04T12:00:01Z',
            endedAt: '2026-09-04T12:00:02Z',
          },
          {
            id: 'launch',
            command: 'npx expo run:ios --device SIMULATOR',
            output: 'started',
            exitCode: 0,
            startedAt: '2026-09-04T12:00:03Z',
            endedAt: '2026-09-04T12:00:10Z',
          },
          {
            id: 'logs',
            command: 'rg STIM_BENCH logs/runtime.log',
            output: `${token}\napp/_layout.tsx in RootLayout`,
            exitCode: 0,
            startedAt: '2026-09-04T12:00:11Z',
            endedAt: '2026-09-04T12:00:12Z',
          },
        ],
        { dispatchAt: '2026-09-04T12:00:00Z', token, arm: 'control' },
      ),
    ).toMatchObject({ valid: true, commandId: 'logs' });
  });

  it('allows installed iOS URL-scheme discovery before launch diagnosis', () => {
    const token = launchCrashToken('run');
    expect(
      launchCrashDiagnosis(
        [
          {
            id: 'scheme',
            command:
              'app_container=$(xcrun simctl get_app_container SIMULATOR com.example.app app); plutil -p "$app_container/Info.plist" | rg -A 8 CFBundleURLSchemes',
            output: 'CFBundleURLSchemes => [ trailhead ]',
            exitCode: 0,
            startedAt: '2026-09-04T12:00:01Z',
            endedAt: '2026-09-04T12:00:02Z',
          },
          {
            id: 'launch',
            command: 'npx expo run:ios --device SIMULATOR',
            output: 'started',
            exitCode: 0,
            startedAt: '2026-09-04T12:00:03Z',
            endedAt: '2026-09-04T12:00:10Z',
          },
          {
            id: 'logs',
            command: 'rg STIM_BENCH logs/runtime.log',
            output: `${token}\napp/_layout.tsx in RootLayout`,
            exitCode: 0,
            startedAt: '2026-09-04T12:00:11Z',
            endedAt: '2026-09-04T12:00:12Z',
          },
        ],
        { dispatchAt: '2026-09-04T12:00:00Z', token, arm: 'control' },
      ),
    ).toMatchObject({ valid: true, commandId: 'logs' });
  });

  it('does not accept source searches as control error capture', () => {
    const token = launchCrashToken('run');
    for (const command of [`rg ${token} app/_layout.tsx`, `rg ${token} .`]) {
      expect(
        launchCrashDiagnosis(
          [
            {
              id: 'launch',
              command: 'npx expo run:ios --device SIMULATOR',
              output: 'started',
              exitCode: 0,
              endedAt: '2026-09-04T12:00:10Z',
            },
            {
              id: 'source',
              command,
              output: `${token}\napp/_layout.tsx in RootLayout`,
              exitCode: 0,
              startedAt: '2026-09-04T12:00:11Z',
              endedAt: '2026-09-04T12:00:12Z',
            },
          ],
          { dispatchAt: '2026-09-04T12:00:00Z', token, arm: 'control' },
        ),
      ).toEqual({ valid: false, reason: 'launch-crash-error-capture-missing' });
    }
  });

  it('rejects mixed log-capture and source-inspection commands', () => {
    const token = launchCrashToken('run');
    for (const command of [
      `rg ${token} app/_layout.tsx tmp/runtime.log`,
      'cat app/_layout.tsx; tail tmp/runtime.log',
    ]) {
      expect(
        launchCrashDiagnosis(
          [
            {
              id: 'launch',
              command: 'npx expo run:ios --device SIMULATOR',
              output: 'started',
              exitCode: 0,
              startedAt: '2026-09-04T12:00:01Z',
              endedAt: '2026-09-04T12:00:10Z',
            },
            {
              id: 'mixed',
              command,
              output: `${token}\napp/_layout.tsx in RootLayout`,
              exitCode: 0,
              startedAt: '2026-09-04T12:00:11Z',
              endedAt: '2026-09-04T12:00:12Z',
            },
          ],
          { dispatchAt: '2026-09-04T12:00:00Z', token, arm: 'control' },
        ),
      ).toEqual({
        valid: false,
        reason: 'launch-crash-pre-capture-command-not-allowed',
        commandId: 'mixed',
      });
    }
  });

  it('requires an explicit zero exit code for every diagnosis and recovery phase', () => {
    const token = launchCrashToken('run');
    const launch = {
      id: 'launch',
      command: 'stim ios',
      output: token,
      exitCode: 0,
      endedAt: '2026-09-04T12:00:10Z',
    };
    const logs = {
      id: 'logs',
      command: 'stim logs --errors',
      output: token,
      exitCode: 0,
      startedAt: '2026-09-04T12:00:11Z',
      endedAt: '2026-09-04T12:00:12Z',
    };
    const diagnosis = {
      id: 'diagnosis',
      command: 'rg token logs/runtime.log',
      output: `${token}\napp/_layout.tsx in RootLayout`,
      exitCode: 0,
      startedAt: '2026-09-04T12:00:13Z',
      endedAt: '2026-09-04T12:00:14Z',
    };
    expect(
      launchCrashDiagnosis([{ ...launch, exitCode: null }, logs, diagnosis], {
        dispatchAt: '2026-09-04T12:00:00Z',
        token,
      }),
    ).toEqual({ valid: false, reason: 'launch-crash-initial-launch-evidence-missing' });
    expect(
      launchCrashDiagnosis([launch, { ...logs, exitCode: undefined }, diagnosis], {
        dispatchAt: '2026-09-04T12:00:00Z',
        token,
      }),
    ).toEqual({ valid: false, reason: 'launch-crash-error-capture-missing' });
    expect(
      launchCrashDiagnosis([launch, logs, { ...diagnosis, exitCode: null }], {
        dispatchAt: '2026-09-04T12:00:00Z',
        token,
      }),
    ).toEqual({ valid: false, reason: 'actionable-launch-crash-diagnosis-missing' });

    const validDiagnosis = { valid: true, commandId: 'diagnosis' };
    const reload = {
      id: 'reload',
      command: 'agent-device metro reload --metro-port 8082',
      output: 'Reload broadcast sent',
      exitCode: 0,
      startedAt: '2026-09-04T12:00:15Z',
      endedAt: '2026-09-04T12:00:20Z',
    };
    const screenshot = {
      id: 'screenshot',
      command: 'agent-device screenshot /tmp/settings.png',
      output: 'saved',
      exitCode: 0,
      startedAt: '2026-09-04T12:00:21Z',
      endedAt: '2026-09-04T12:00:22Z',
    };
    const screen = { valid: true, observedAt: screenshot.endedAt, screenshotCommandId: screenshot.id };
    expect(
      launchCrashRecovery([diagnosis, { ...reload, exitCode: null }, screenshot], {
        diagnosis: validDiagnosis,
        screen,
      }),
    ).toEqual({
      valid: false,
      reason: 'launch-crash-repaired-reload-missing',
    });
    expect(
      launchCrashRecovery([diagnosis, reload, { ...screenshot, exitCode: undefined }], {
        diagnosis: validDiagnosis,
        screen,
      }),
    ).toEqual({ valid: false, reason: 'launch-crash-settings-command-invalid' });
  });

  it('requires a repaired Metro reload and Settings proof', () => {
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
        id: 'reload',
        command: 'env AGENT_DEVICE_SESSION=run agent-device metro reload --metro-port 8082',
        output: 'Reload broadcast sent',
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
    ).toEqual({ valid: false, reason: 'launch-crash-settings-proof-before-reload' });
    expect(
      launchCrashRecovery(commands, {
        diagnosis,
        screen: { valid: true, observedAt: '2026-09-04T12:00:21Z', screenshotCommandId: 'screenshot' },
      }),
    ).toEqual({
      valid: true,
      repairedReloadCommandId: 'reload',
      screenshotCommandId: 'screenshot',
    });
  });

  it('does not accept a second Stim platform run as JavaScript recovery', () => {
    const diagnosis = { valid: true, commandId: 'diagnosis' };
    const commands = [
      {
        id: 'diagnosis',
        command: 'stim logs --errors',
        output: 'app/_layout.tsx',
        exitCode: 0,
        endedAt: '2026-09-04T12:00:10Z',
      },
      {
        id: 'second-ios',
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
        startedAt: '2026-09-04T12:00:21Z',
        endedAt: '2026-09-04T12:00:22Z',
      },
    ];

    expect(
      launchCrashRecovery(commands, {
        diagnosis,
        screen: {
          valid: true,
          observedAt: '2026-09-04T12:00:22Z',
          screenshotCommandId: 'screenshot',
        },
      }),
    ).toEqual({ valid: false, reason: 'launch-crash-repaired-reload-missing' });
  });

  it('accepts a control Metro reload when later Settings proof succeeds', () => {
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
        id: 'reload',
        command: 'agent-device metro reload --metro-port 8081',
        output: 'Reload broadcast sent',
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
    ).toEqual({ valid: true, repairedReloadCommandId: 'reload', screenshotCommandId: 'screenshot' });
  });

  it('rejects a reload without an explicit Metro port', () => {
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
        id: 'reload',
        command: 'agent-device metro reload',
        output: 'Reload broadcast sent',
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
    ).toEqual({ valid: false, reason: 'launch-crash-repaired-reload-missing' });
  });

  it('rejects crash evidence observed after the purported repaired reload', () => {
    const diagnosis = { valid: true, commandId: 'diagnosis' };
    const commands = [
      {
        id: 'diagnosis',
        command: 'rg token logs/runtime.log',
        output: 'app/_layout.tsx',
        exitCode: 0,
        endedAt: '2026-09-04T12:00:10Z',
      },
      {
        id: 'reload',
        command: 'agent-device metro reload --metro-port 8081',
        output: 'Reload broadcast sent',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:11Z',
        endedAt: '2026-09-04T12:00:12Z',
      },
      {
        id: 'crash',
        command: 'tail logs/runtime.log',
        output: 'STIM_BENCH_LAUNCH_CRASH_ABCDEF123456',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:13Z',
        endedAt: '2026-09-04T12:00:14Z',
      },
      {
        id: 'screenshot',
        command: 'agent-device screenshot /tmp/settings.png',
        output: 'saved',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:15Z',
        endedAt: '2026-09-04T12:00:16Z',
      },
    ];

    expect(
      launchCrashRecovery(commands, {
        diagnosis,
        arm: 'control',
        screen: { valid: true, observedAt: '2026-09-04T12:00:16Z', screenshotCommandId: 'screenshot' },
      }),
    ).toEqual({ valid: false, reason: 'launch-crash-token-observed-after-reload', commandId: 'crash' });
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
