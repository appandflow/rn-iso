import { afterEach, describe, expect, it } from 'vitest';
import { tmpdir, userInfo } from 'node:os';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  benchmarkEnvironment,
  estimateTokenCost,
  eventsFor,
  exportBenchmark,
  sanitizeBenchmarkText,
  sanitizeCommandOutput,
} from './export-benchmark-viewer.mjs';

const tempDirs = [];

function stamp(arrivedAt, event) {
  return JSON.stringify({ arrivedAt, stream: 'stdout', line: JSON.stringify(event) });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('benchmark viewer export', () => {
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
    mkdirSync(validRunDir, { recursive: true });
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
        screen: { valid: false },
      }),
    );

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
    expect(readdirSync(proofDir)).toEqual([]);
  });

  it('refuses to publish a block with no valid attempts', () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-benchmark-export-'));
    tempDirs.push(root);
    const stageDir = join(root, 'results', 'test-rc1');
    const runDir = join(stageDir, 'private-invalid-run-id');
    mkdirSync(runDir, { recursive: true });
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
});
