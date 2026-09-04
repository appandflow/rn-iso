import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { tmpdir, userInfo } from 'node:os';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  backgroundProcessesFor,
  benchmarkEnvironment,
  estimateTokenCost,
  eventsFor,
  exportBenchmark,
  sanitizeBenchmarkText,
  sanitizeCommandOutput,
  summarizeRun,
} from './export-benchmark-viewer.mjs';

const tempDirs = [];

function stamp(arrivedAt, event) {
  return JSON.stringify({ arrivedAt, stream: 'stdout', line: JSON.stringify(event) });
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('benchmark viewer export', () => {
  it('extends detached processes through commands that monitor their PID or PID file', () => {
    const commands = [
      {
        id: 'wrong-launch',
        startSeconds: 1,
        endSeconds: 1.1,
        command: 'nohup npx expo run:ios --udid U1 > tmp/build.log 2>&1 &\necho $! > tmp/build.pid',
        output: '1001',
        exitCode: 0,
      },
      {
        id: 'wrong-check',
        startSeconds: 2,
        endSeconds: 3,
        command: 'ps -p 1001; cat tmp/build.pid',
        output: '',
        exitCode: 0,
      },
      {
        id: 'launch',
        startSeconds: 4,
        endSeconds: 4.1,
        command: 'nohup npx expo run:ios --device U1 > tmp/run.log 2>&1 &\necho $! > tmp/build.pid',
        output: 'PID=2002',
        exitCode: 0,
      },
      {
        id: 'poll',
        startSeconds: 10,
        endSeconds: 20,
        command: 'ps -p 2002; tail tmp/run.log',
        output: '',
        exitCode: 0,
      },
    ];

    expect(backgroundProcessesFor(commands)).toEqual([
      {
        id: 'background-wrong-launch',
        label: 'npx expo run:ios --udid U1',
        startSeconds: 1.1,
        endSeconds: 3,
        launcherCommandId: 'wrong-launch',
        monitorCount: 1,
      },
      {
        id: 'background-launch',
        label: 'npx expo run:ios --device U1',
        startSeconds: 4.1,
        endSeconds: 20,
        launcherCommandId: 'launch',
        monitorCount: 1,
      },
    ]);
  });

  it('omits detached launchers without an identifier or later monitoring evidence', () => {
    expect(
      backgroundProcessesFor([
        {
          id: 'no-identifier',
          startSeconds: 0,
          endSeconds: 1,
          command: 'nohup npx expo start > tmp/metro.log 2>&1 &',
          output: '',
          exitCode: 0,
        },
        {
          id: 'not-monitored',
          startSeconds: 2,
          endSeconds: 3,
          command: 'nohup npx expo start > tmp/metro.log 2>&1 &\necho $! > tmp/metro.pid',
          output: '3003',
          exitCode: 0,
        },
      ]),
    ).toEqual([]);
  });

  it('does not treat PID cleanup or incidental numbers as process monitoring', () => {
    expect(
      backgroundProcessesFor([
        {
          id: 'launch',
          startSeconds: 0,
          endSeconds: 1,
          command: 'nohup npx expo start > tmp/metro.log 2>&1 &\necho $! > tmp/metro.pid',
          output: '4004',
          exitCode: 0,
        },
        {
          id: 'incidental',
          startSeconds: 2,
          endSeconds: 3,
          command: 'echo "build 4004 finished"',
          output: '',
          exitCode: 0,
        },
        {
          id: 'cleanup',
          startSeconds: 4,
          endSeconds: 5,
          command: 'rm tmp/metro.pid',
          output: '',
          exitCode: 0,
        },
      ]),
    ).toEqual([]);
  });

  it('summarizes the recorded preparation, launcher, proof, and failed attempts', () => {
    const commands = [
      {
        id: 'worktree',
        startSeconds: 0,
        endSeconds: 1,
        command: 'git worktree add worktree/native-control',
        output: '',
        exitCode: 0,
      },
      {
        id: 'launch',
        startSeconds: 2,
        endSeconds: 3,
        command: 'nohup npx expo run:ios --device U1 > tmp/run.log 2>&1 &',
        output: '2002',
        exitCode: 0,
      },
      {
        id: 'monitor',
        startSeconds: 3.1,
        endSeconds: 3.5,
        command: 'ps -p 2002',
        output: '',
        exitCode: 0,
      },
      {
        id: 'proof',
        startSeconds: 4,
        endSeconds: 5,
        command: 'agent-device screenshot proof.png',
        output: '',
        exitCode: 1,
      },
    ];

    expect(
      summarizeRun({ variant: 'native', screen: { valid: true } }, commands, backgroundProcessesFor(commands)),
    ).toBe(
      'Created an isolated worktree, worked on the native iOS change, and started the local Expo/Xcode workflow. It started one process with nohup and monitored the detached work through later commands. The record includes 1 failed command attempt before completion.',
    );
  });

  it('uses neutral wording when no successful build command is recorded', () => {
    const commands = [
      {
        id: 'open',
        startSeconds: 0,
        endSeconds: 1,
        command: 'agent-device open com.example.app --platform ios --udid U1',
        output: '',
        exitCode: 0,
      },
      {
        id: 'failed-proof',
        startSeconds: 1,
        endSeconds: 2,
        command: 'agent-device screenshot proof.png',
        output: '',
        exitCode: 1,
      },
    ];

    expect(summarizeRun({ variant: 'native', screen: { valid: false } }, commands, [])).toBe(
      'Prepared the benchmark workspace, worked on the native iOS change, and opened the app with agent-device. The record includes 1 failed command attempt before completion.',
    );
  });

  it('preserves a failed Claude Bash exit code when reconstructing events', () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-claude-events-'));
    tempDirs.push(root);
    writeFileSync(
      join(root, 'events.jsonl'),
      `${[
        stamp('2026-09-04T12:00:01.000Z', {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'failed', name: 'Bash', input: { command: 'npx expo run:ios' } }],
          },
        }),
        stamp('2026-09-04T12:00:02.000Z', {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'failed', content: 'failed' }] },
          tool_use_result: { exit_code: 1 },
        }),
      ].join('\n')}\n`,
    );

    expect(eventsFor(root, '2026-09-04T12:00:00.000Z', []).commands[0].exitCode).toBe(1);
  });

  it('summarizes a Stim-assisted launch-failure diagnosis separately from a normal change', () => {
    const commands = [
      {
        id: 'launch',
        startSeconds: 1,
        endSeconds: 10,
        command: 'stim ios',
        output: 'ERROR launch crash',
        exitCode: 0,
      },
      {
        id: 'logs',
        startSeconds: 11,
        endSeconds: 12,
        command: 'stim logs --errors',
        output: 'ERROR launch crash',
        exitCode: 0,
      },
    ];

    expect(summarizeRun({ variant: 'launch-crash', screen: { valid: false } }, commands, [])).toBe(
      "Prepared the benchmark workspace, worked on the JavaScript launch failure, and ran Stim's iOS workflow. It used the captured Stim error log to identify the injected failure before repairing it.",
    );
  });

  it('replaces machine paths, run ids, and simulator ids', () => {
    const source =
      '/Volumes/ExternalSSD/Developer/bench/results/run-123/proof/settings.png ' +
      '/tmp/run-123-settings.png 3372C014-23D1-4939-ABF6-94912654C56E 10.0.0.188 [::1] ' +
      'com.janic.agentdevice.runner.uitests.xctrunner';
    const output = sanitizeBenchmarkText(source, [
      ['/Volumes/ExternalSSD/Developer/bench/results/run-123', 'results/luna/javascript-stim'],
      ['run-123', 'javascript-stim'],
    ]);

    expect(output).toBe(
      'results/luna/javascript-stim/proof/settings.png tmp/javascript-stim-settings.png <simulator-udid> <local-ip> <local-ip> <agent-device-helper>',
    );
  });

  it('redacts both the label and target of a Markdown path link', () => {
    const path = '/Volumes/ExternalSSD/Developer/stim-bench/worktrees/native-control';

    expect(sanitizeBenchmarkText(`[${path}](${path})`)).toBe('[worktree/native-control](worktree/native-control)');
  });

  it('makes user-home paths relative before replacing the username', () => {
    const username = userInfo().username;

    expect(sanitizeBenchmarkText(`/Users/${username}/.agent-device/sessions/example`)).toBe('workspace/example');
  });

  it('removes Homebrew executables and shell search paths', () => {
    expect(
      sanitizeBenchmarkText(
        'PATH=/opt/homebrew/bin:/usr/bin /opt/homebrew/bin/node ./node_modules/expo/bin/cli run:ios',
      ),
    ).toBe('PATH=<toolchain-path> node ./node_modules/expo/bin/cli run:ios');
  });

  it('redacts absolute compiler paths attached to flags', () => {
    expect(
      sanitizeBenchmarkText(
        '-L/Volumes/ExternalSSD/Developer/bench/worktrees/native-control/DerivedData/Build/Products',
      ),
    ).toBe('-Lworktree/native-control/DerivedData/Build/Products');
  });

  it('makes Xcode, system-tool, and root-relative build paths portable', () => {
    expect(
      sanitizeBenchmarkText(
        '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang ' +
          '/usr/bin/screen /bin/sh /Library/Frameworks/universal ' +
          '/Pods.build/Debug-iphonesimulator/App.build/object.o /XPCServices',
      ),
    ).toBe(
      'Xcode/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang screen sh ' +
        'system/Library/Frameworks/universal build/Pods.build/Debug-iphonesimulator/App.build/object.o ' +
        'app/XPCServices',
    );
  });

  it('does not mistake ordinary slash-prefixed words for filesystem roots', () => {
    expect(sanitizeBenchmarkText('/variant /options /variable /optional')).toBe(
      '/variant /options /variable /optional',
    );
  });

  it('strips terminal color codes before making machine paths relative', () => {
    const coloredPath =
      '\u001b[331m/\u001b[339mVolumes\u001b[49m\u001b[331m/\u001b[3103mExternalSSD\u001b[49m\u001b[331m/\u001b[3103mDeveloper\u001b[49m\u001b[331m/\u001b[3103mstim-bench\u001b[49m';

    expect(sanitizeBenchmarkText(coloredPath)).toBe('workspace/stim-bench');
  });

  it('redacts local hostnames and complete or abbreviated simulator identifiers', () => {
    expect(
      sanitizeBenchmarkText('Janics-Mac-mini.local A35AFE7E-06D9-4E4B-A14D-0451595A13BC grep A35AFE7E (3372..)'),
    ).toBe('<local-host> <simulator-udid> grep <simulator-udid-prefix> (<simulator-udid-prefix>)');
    expect(sanitizeBenchmarkText('estimated cost 0.02353276')).toBe('estimated cost 0.02353276');
    expect(sanitizeBenchmarkText('http%3A%2F%2F127.0.0.1%3A8081')).toBe('http%3A%2F%2F<local-ip>%3A8081');
  });

  it('omits machine-global process output', () => {
    const output = sanitizeCommandOutput(
      '/bin/zsh -lc "ps -axo command= | rg \'expo|metro\'"',
      'node ./node_modules/.bin/expo start\n/bin/zsh -c tail -F workspace/release-rc7/qa-progress.log',
    );

    expect(output).toBe('<process output omitted from public artifact>');
  });

  it('omits interactive shell transcripts with cursor-control fragments', () => {
    const output = sanitizeCommandOutput(
      'zsh',
      '\u001b[331m/\u001b[339mVolumes\r<external path rewritten by the terminal',
    );

    expect(output).toBe('<interactive shell transcript omitted from public artifact>');
  });

  it('omits machine-global device inventories', () => {
    const output = sanitizeCommandOutput(
      'xcrun simctl boot <simulator-udid>\nxcrun simctl list devices | grep benchmark',
      'Old iPhone (ios device target=mobile) booted=true\nJanics-Mac-mini.local booted=true',
    );

    expect(output).toBe('<device inventory omitted from public artifact>');
  });

  it('omits machine-global storage inventories', () => {
    expect(sanitizeCommandOutput('df -h /Volumes/ExternalSSD; diskutil info /Volumes/ExternalSSD', 'private')).toBe(
      '<machine storage inventory omitted from public artifact>',
    );
  });

  it('omits branch inventories that can contain user-scoped remote refs', () => {
    expect(
      sanitizeCommandOutput('git status --short; git branch -a', 'remotes/origin/@janic/issue-1-clear-filters'),
    ).toBe('<branch inventory omitted from public artifact>');
  });

  it('redacts a user-scoped remote branch outside an inventory', () => {
    expect(sanitizeBenchmarkText('checked remotes/origin/@private-user/feature')).toBe(
      'checked remotes/origin/@<user>/feature',
    );
  });

  it('redacts a helper identifier before replacing an OS username inside it', () => {
    const username = userInfo().username;
    const output = sanitizeBenchmarkText(`com.owner.agentdevice.${username}.uitests.xct${username}`);

    expect(output).toBe('<agent-device-helper>');
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

  it('combines sanitized hardware with recorded toolchain and simulator facts', () => {
    const environment = benchmarkEnvironment(
      {
        preflight: {
          actual: {
            MACOS_VERSION: '26.5.2',
            MACOS_BUILD: '25F84',
            XCODE_VERSION: '26.6',
            XCODE_BUILD: '17F113',
            NODE_VERSION: '26.7.0',
          },
          parkedSimulator: {
            deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
            runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
          },
        },
      },
      { model: 'Mac mini', chip: 'Apple M4 Pro', memory: '64 GB' },
    );

    expect(environment).toEqual({
      machine: { model: 'Mac mini', chip: 'Apple M4 Pro', memory: '64 GB' },
      macos: 'macOS 26.5.2 (25F84)',
      xcode: 'Xcode 26.6 (17F113)',
      node: 'Node 26.7.0',
      simulator: 'iPhone 17 / iOS 26.5',
    });
  });

  it('extracts Claude Bash commands, output, and text messages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stim-claude-events-'));
    tempDirs.push(dir);
    writeFileSync(
      join(dir, 'events.jsonl'),
      [
        stamp('2026-09-03T20:00:01.000Z', {
          type: 'assistant',
          uuid: 'note-1',
          message: { content: [{ type: 'text', text: 'Checking the app.' }] },
        }),
        stamp('2026-09-03T20:00:02.000Z', {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'stim ios' } }],
          },
        }),
        stamp('2026-09-03T20:00:05.000Z', {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'build ok', is_error: false }] },
        }),
      ].join('\n'),
    );

    expect(eventsFor(dir, '2026-09-03T20:00:00.000Z', [])).toEqual({
      messages: [{ id: 'note-1-0', atSeconds: 1, text: 'Checking the app.' }],
      commands: [
        {
          id: 'tool-1',
          startSeconds: 2,
          endSeconds: 5,
          command: 'stim ios',
          output: 'build ok',
          exitCode: 0,
        },
      ],
    });
  });

  it('omits invalid attempts and their proof from a complete export', () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-benchmark-export-'));
    tempDirs.push(root);
    const stageDir = join(root, 'results', 'test-rc1');
    const invalidRunDir = join(stageDir, 'private-invalid-run-id');
    const validRunDir = join(stageDir, 'private-valid-run-id');
    mkdirSync(join(invalidRunDir, 'proof'), { recursive: true });
    mkdirSync(join(validRunDir, 'proof'), { recursive: true });
    writeFileSync(
      join(invalidRunDir, 'meta.json'),
      JSON.stringify({ dispatchAt: '2026-09-03T20:00:00.000Z', finishedAt: '2026-09-03T20:00:01.000Z' }),
    );
    writeFileSync(
      join(invalidRunDir, 'run.json'),
      JSON.stringify({
        runId: 'private-invalid-run-id',
        model: 'gpt-5.6-sol',
        variant: 'native',
        arm: 'stim',
        valid: false,
        invalidReasons: ['missing command for A35AFE7E-06D9-4E4B-A14D-0451595A13BC (3372..) on Janics-Mac-mini.local'],
        commandCount: 0,
        screen: { valid: true },
      }),
    );
    writeFileSync(join(invalidRunDir, 'proof', 'settings.png'), 'invalid proof');
    writeFileSync(
      join(validRunDir, 'meta.json'),
      JSON.stringify({ dispatchAt: '2026-09-03T20:00:02.000Z', finishedAt: '2026-09-03T20:00:03.000Z' }),
    );
    writeFileSync(
      join(validRunDir, 'run.json'),
      JSON.stringify({
        runId: 'private-valid-run-id',
        model: 'gpt-5.6-sol',
        variant: 'native',
        arm: 'control',
        valid: true,
        invalidReasons: [],
        dispatchToScreenReadySeconds: 1,
        commandCount: 0,
        screen: { valid: true, expected: 'Offline maps', dimensions: { width: 402, height: 874 } },
      }),
    );
    writeFileSync(join(validRunDir, 'proof', 'settings.png'), 'valid proof');

    const proofDir = join(root, 'proof');
    mkdirSync(proofDir, { recursive: true });
    writeFileSync(join(proofDir, 'native-stim-invalid-1.png'), 'stale invalid proof');
    const payload = exportBenchmark(stageDir, join(root, 'benchmark.json'), proofDir, {
      model: 'Test Mac',
      chip: 'Test chip',
      memory: 'Test memory',
    });

    expect(payload.runs.map((run) => run.id)).toEqual(['native-control']);
    expect(payload.recordedOn).toBe('2026-09-03');
    expect(readdirSync(proofDir)).toEqual(['native-control.png']);
  });

  it('refuses to publish a block with no valid attempts', () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-benchmark-export-'));
    tempDirs.push(root);
    const stageDir = join(root, 'results', 'test-rc1');
    const runDir = join(stageDir, 'private-invalid-run-id');
    mkdirSync(join(runDir, 'proof'), { recursive: true });
    writeFileSync(
      join(runDir, 'meta.json'),
      JSON.stringify({ dispatchAt: '2026-09-03T20:00:00.000Z', finishedAt: '2026-09-03T20:00:01.000Z' }),
    );
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify({
        runId: 'private-invalid-run-id',
        model: 'gpt-5.6-sol',
        variant: 'native',
        arm: 'stim',
        valid: false,
        commandCount: 0,
        screen: { valid: false },
      }),
    );

    expect(() => exportBenchmark(stageDir, join(root, 'benchmark.json'), join(root, 'proof'))).toThrow(
      'no valid benchmark runs found',
    );
  });

  it('exports launch-crash diagnosis metrics as a separate suite', () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-launch-crash-export-'));
    tempDirs.push(root);
    const stageDir = join(root, 'results', 'sol-launch-crash');
    const runDir = join(stageDir, 'private-run-id');
    mkdirSync(join(runDir, 'proof'), { recursive: true });
    writeFileSync(
      join(runDir, 'meta.json'),
      JSON.stringify({
        dispatchAt: '2026-09-04T12:00:00.000Z',
        finishedAt: '2026-09-04T12:03:00.000Z',
        platform: 'ios',
      }),
    );
    const token = 'STIM_BENCH_LAUNCH_CRASH_ABCDEF123456';
    const commandEvents = [
      [
        'skill',
        '2026-09-04T12:00:01.000Z',
        '2026-09-04T12:00:02.000Z',
        'sed -n 1,200p /bench/skills/stim/SKILL.md',
        'skill',
      ],
      ['worktree', '2026-09-04T12:00:03.000Z', '2026-09-04T12:00:05.000Z', 'stim worktree create bench/run', 'ready'],
      ['launch', '2026-09-04T12:00:10.000Z', '2026-09-04T12:00:20.000Z', 'stim ios', token],
      ['logs', '2026-09-04T12:00:25.000Z', '2026-09-04T12:00:30.000Z', 'stim logs --errors', token],
      [
        'diagnosis',
        '2026-09-04T12:01:29.000Z',
        '2026-09-04T12:01:30.000Z',
        `rg ${token} app/_layout.tsx`,
        `${token}\napp/_layout.tsx:28 in RootLayout`,
      ],
      ['relaunch', '2026-09-04T12:01:40.000Z', '2026-09-04T12:02:00.000Z', 'stim ios', 'OK: com.example.app'],
      [
        'screenshot',
        '2026-09-04T12:02:29.000Z',
        '2026-09-04T12:02:30.000Z',
        'agent-device screenshot /tmp/settings.png',
        'saved',
      ],
    ];
    writeFileSync(
      join(runDir, 'events.jsonl'),
      `${commandEvents
        .flatMap(([id, startedAt, endedAt, command, output]) => [
          stamp(startedAt, { type: 'item.started', item: { id, type: 'command_execution', command } }),
          stamp(endedAt, {
            type: 'item.completed',
            item: { id, type: 'command_execution', command, aggregated_output: output, exit_code: 0 },
          }),
        ])
        .join('\n')}\n`,
    );
    const proofPath = join(runDir, 'proof', 'settings.png');
    copyFileSync(join(process.cwd(), 'website/static/benchmarks/sol-launch-crash/launch-crash-stim.png'), proofPath);
    const rolloutPath = join(runDir, 'rollout.jsonl');
    writeFileSync(
      rolloutPath,
      `${JSON.stringify({
        timestamp: '2026-09-04T12:01:30.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 100_000,
              cached_input_tokens: 80_000,
              output_tokens: 1_000,
              reasoning_output_tokens: 100,
            },
          },
        },
      })}\n`,
    );
    const recordPath = join(runDir, 'run.json');
    writeFileSync(
      recordPath,
      JSON.stringify({
        runId: 'private-run-id',
        runner: 'codex',
        model: 'gpt-5.6-sol',
        variant: 'launch-crash',
        arm: 'stim',
        valid: true,
        invalidReasons: [],
        dispatchToDiagnosisSeconds: 90,
        diagnosisCommandCount: 5,
        diagnosisUsage: {
          input_tokens: 100_000,
          cached_input_tokens: 80_000,
          output_tokens: 1_000,
          reasoning_output_tokens: 100,
        },
        diagnosis: {
          valid: true,
          observedAt: '2026-09-04T12:01:30.000Z',
          commandId: 'diagnosis',
          initialLaunchCommandId: 'launch',
          errorCaptureCommandId: 'logs',
        },
        dispatchToScreenReadySeconds: 150,
        commandCount: 10,
        usage: {
          input_tokens: 200_000,
          cached_input_tokens: 160_000,
          output_tokens: 2_000,
          reasoning_output_tokens: 200,
        },
        proof: { valid: true, expected: `${token} removed and original source restored` },
        recovery: { valid: true, repairedLaunchCommandId: 'relaunch', screenshotCommandId: 'screenshot' },
        screen: {
          valid: true,
          expected: 'Keep map tiles for saved trails on device',
          dimensions: { width: 402, height: 874 },
          observedAt: '2026-09-04T12:02:30.000Z',
          dispatchToScreenReadySeconds: 150,
          screenshotCommandId: 'screenshot',
        },
        evidenceSha256: {
          events: sha256(join(runDir, 'events.jsonl')),
          settingsPng: sha256(proofPath),
          transcript: sha256(rolloutPath),
        },
      }),
    );

    const payload = exportBenchmark(stageDir, join(root, 'benchmark.json'), join(root, 'proof'));

    expect(payload).toMatchObject({
      suite: 'launch-crash',
      platform: 'ios',
      primaryMetric: 'Dispatch to first actionable diagnosis; repaired Settings screenshot reported separately',
    });
    expect(payload.runs[0]).toMatchObject({
      id: 'launch-crash-stim',
      platform: 'ios',
      diagnosisSeconds: 90,
      diagnosisCommandCount: 5,
      launchCrashAudit: {
        initialLaunchCommandId: 'launch',
        errorCaptureCommandId: 'logs',
        diagnosisCommandId: 'diagnosis',
        repairedLaunchCommandId: 'relaunch',
        screenshotCommandId: 'screenshot',
      },
      estimatedDiagnosisCostUsd: 0.132,
    });
    expect(payload.runs[0].markers).toContainEqual({
      id: 'diagnosis',
      kind: 'diagnosis',
      label: 'Actionable diagnosis',
      atSeconds: 90,
    });

    const original = JSON.parse(readFileSync(recordPath, 'utf8'));
    for (const mutate of [
      (record) => (record.dispatchToDiagnosisSeconds = 1),
      (record) => (record.diagnosisCommandCount = 1),
      (record) => (record.dispatchToScreenReadySeconds = 1),
      (record) => (record.diagnosisUsage.input_tokens = 1),
    ]) {
      const changed = structuredClone(original);
      mutate(changed);
      writeFileSync(recordPath, JSON.stringify(changed));
      expect(() => exportBenchmark(stageDir, join(root, 'benchmark.json'), join(root, 'proof'))).toThrow(
        'no valid benchmark runs found',
      );
    }
    writeFileSync(recordPath, JSON.stringify(original));
  });

  it('refuses a launch-crash record without audited recovery proof', () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-launch-crash-invalid-'));
    tempDirs.push(root);
    const stageDir = join(root, 'results', 'sol-launch-crash');
    const runDir = join(stageDir, 'private-run-id');
    mkdirSync(join(runDir, 'proof'), { recursive: true });
    writeFileSync(
      join(runDir, 'meta.json'),
      JSON.stringify({ dispatchAt: '2026-09-04T12:00:00.000Z', finishedAt: '2026-09-04T12:03:00.000Z' }),
    );
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify({
        runId: 'private-run-id',
        model: 'gpt-5.6-sol',
        variant: 'launch-crash',
        arm: 'stim',
        valid: true,
        dispatchToDiagnosisSeconds: 90,
        diagnosisCommandCount: 5,
        diagnosis: { valid: true },
        proof: { valid: true },
        screen: { valid: true },
      }),
    );
    writeFileSync(join(runDir, 'proof', 'settings.png'), 'unverified proof');

    expect(() => exportBenchmark(stageDir, join(root, 'benchmark.json'), join(root, 'proof'))).toThrow(
      'no valid benchmark runs found',
    );
  });
});
