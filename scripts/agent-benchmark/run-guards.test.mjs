import { describe, expect, it } from 'vitest';
import {
  benchmarkSetupInvalidReasons,
  benchmarkTarget,
  benchmarkTiming,
  parseBenchmarkTargets,
  shellCommandSegments,
  stimShellProvenanceInvalidReasons,
} from './run-guards.mjs';

const targetConfig = parseBenchmarkTargets({
  schemaVersion: 1,
  machine: 'Test Mac',
  targets: {
    'android.native.stim': {
      screenReadySeconds: 300,
      platformCommandSeconds: 180,
      runTimeoutSeconds: 600,
    },
  },
});

describe('benchmark run guards', () => {
  it('selects and validates a machine target', () => {
    expect(benchmarkTarget(targetConfig, { platform: 'android', variant: 'native', arm: 'stim' })).toEqual({
      key: 'android.native.stim',
      machine: 'Test Mac',
      screenReadySeconds: 300,
      platformCommandSeconds: 180,
      runTimeoutSeconds: 600,
    });
    expect(() => benchmarkTarget(targetConfig, { platform: 'ios', variant: 'native', arm: 'stim' })).toThrow(
      /target missing/,
    );
    expect(() =>
      parseBenchmarkTargets({
        schemaVersion: 1,
        machine: 'Test Mac',
        targets: { 'android.native.stim': { screenReadySeconds: 300, runTimeoutSeconds: 200 } },
      }),
    ).toThrow(/at least screenReadySeconds/);
    expect(() =>
      parseBenchmarkTargets({
        schemaVersion: 1,
        machine: 'Test Mac',
        targets: {
          'android.native.stim': {
            screenReadySeconds: 100,
            platformCommandSeconds: 300,
            runTimeoutSeconds: 200,
          },
        },
      }),
    ).toThrow(/at least platformCommandSeconds/);
  });

  it('finds commands in shell chains without splitting quoted operators', () => {
    expect(shellCommandSegments(`/bin/zsh -lc 'cd "$WT" && echo "a && b"; stim guide agent'`)).toEqual([
      'cd "$WT"',
      'echo "a && b"',
      'stim guide agent',
    ]);
  });

  it('rejects setup recovery inside the timer', () => {
    const commands = [
      { command: "/bin/zsh -lc 'stim guide agent'", exitCode: 1 },
      { command: "/bin/zsh -lc 'stim worktree warm'", exitCode: 1 },
      { command: "/bin/zsh -lc 'npm install'", exitCode: 0 },
      {
        command: "/bin/zsh -lc 'stim android --system-image image'",
        exitCode: 0,
        output: 'fingerprint abcdef.. miss\nbuild ok',
      },
    ];
    expect(benchmarkSetupInvalidReasons({ arm: 'stim', platform: 'android' }, commands)).toEqual([
      'dependencies-installed-inside-timer',
      'stim-guide-agent-missing-or-failed',
      'stim-worktree-warm-missing-or-failed',
      'stim-gradle-build-cache-missing',
    ]);
  });

  it('accepts a warm native build with the shared Gradle cache enabled', () => {
    const commands = [
      { command: "/bin/zsh -lc 'stim guide agent'", exitCode: 0 },
      { command: "/bin/zsh -lc 'stim worktree warm'", exitCode: 0 },
      {
        command: "/bin/zsh -lc 'stim android --system-image image'",
        exitCode: 0,
        output: 'fingerprint abcdef.. miss\ncache gradle build cache on (--build-cache, shared)',
      },
    ];
    expect(benchmarkSetupInvalidReasons({ arm: 'stim', platform: 'android' }, commands)).toEqual([]);
  });

  it('audits Claude-style chained commands', () => {
    const commands = [
      { command: `/bin/zsh -lc 'cd "$WT" && stim guide agent'`, exitCode: 0 },
      { command: `/bin/zsh -lc 'cd "$WT" && stim worktree warm'`, exitCode: 0 },
      { command: `/bin/zsh -lc 'cd "$WT" && npm install'`, exitCode: 0 },
      {
        command: `/bin/zsh -lc 'cd "$WT" && stim android --system-image image'`,
        exitCode: 0,
        elapsedSeconds: 346,
        output: 'fingerprint abcdef.. miss\nbuild ok',
      },
    ];
    expect(benchmarkSetupInvalidReasons({ arm: 'stim', platform: 'android' }, commands)).toEqual([
      'dependencies-installed-inside-timer',
      'stim-gradle-build-cache-missing',
    ]);
    const target = benchmarkTarget(targetConfig, { platform: 'android', variant: 'native', arm: 'stim' });
    expect(benchmarkTiming(target, commands, 400, false)).toMatchObject({
      platformCommandSeconds: 346,
      platformCommandTargetMet: false,
      invalidReasons: ['platform-command-target-exceeded'],
    });
  });

  it('does not let a later successful command mask failed setup', () => {
    const commands = [
      { command: `/bin/zsh -lc 'stim guide agent; true'`, exitCode: 0 },
      { command: `/bin/zsh -lc 'stim worktree warm\ntrue'`, exitCode: 0 },
    ];
    expect(benchmarkSetupInvalidReasons({ arm: 'stim', platform: 'ios' }, commands)).toEqual([
      'stim-guide-agent-missing-or-failed',
      'stim-worktree-warm-missing-or-failed',
    ]);
  });

  it('reports target status without treating model latency as invalid', () => {
    const target = benchmarkTarget(targetConfig, { platform: 'android', variant: 'native', arm: 'stim' });
    const commands = [
      {
        command: "/bin/zsh -lc 'stim android --system-image image'",
        elapsedSeconds: 346,
      },
    ];
    expect(benchmarkTiming(target, commands, 502, false)).toMatchObject({
      screenReadyTargetMet: false,
      platformCommandTargetMet: false,
      invalidReasons: ['platform-command-target-exceeded'],
    });
  });

  it('requires exact timed-shell Stim provenance', () => {
    const expected = {
      resolvedPath: '/bench/bin/stim',
      version: '1.0.0-rc.15',
      executableSha256: 'shim',
      cliSha256: 'cli',
    };
    expect(
      stimShellProvenanceInvalidReasons({
        arm: 'stim',
        expectedStimShellProvenance: expected,
        stimShellProvenance: expected,
      }),
    ).toEqual([]);
    expect(
      stimShellProvenanceInvalidReasons({
        arm: 'stim',
        expectedStimShellProvenance: expected,
        stimShellProvenance: { ...expected, version: '1.0.0-rc.14' },
      }),
    ).toEqual(['stim-shell-provenance-mismatch']);
  });
});
