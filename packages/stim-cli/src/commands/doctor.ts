import chalk from 'chalk';
import { InvalidArgumentError, type Command } from 'commander';
import { findProjectRoot } from '../project.ts';
import { repoRoot } from '../worktree.ts';
import {
  allowanceSearchPaths,
  applyClaudeAllowance,
  claudeLocalSettingsPath,
  detectHarness,
  missingAllowance,
  sandboxAllowance,
  sandboxFinding,
} from '../sandbox.ts';
import { detectFingerprintParity, detectXcodeMajor, runDoctor } from '../doctor.ts';
import type { DoctorPlatform, Finding } from '../doctor.ts';
import { phaseLine } from '../command-output.ts';
import { compareStimVersions, inspectStimVersions, type StimVersionReport } from '../stim-installations.ts';

interface DoctorOptions {
  json?: boolean;
  fix?: boolean;
  platform?: DoctorPlatform;
}

export function parseDoctorPlatform(value: string): DoctorPlatform {
  if (value === 'ios' || value === 'android') return value;
  throw new InvalidArgumentError('expected one of: ios, android');
}

function doctorTarget(platform?: DoctorPlatform): string {
  if (platform === 'ios') return 'iOS';
  if (platform === 'android') return 'Android';
  return 'all platforms';
}

function stimVersionLines(report: StimVersionReport): string[] {
  const resolved = report.resolved
    ? `${report.resolved.version ?? 'unknown version'} at ${report.resolved.path}`
    : 'not found on PATH';
  const paths = `${report.installations.length} distinct PATH install${report.installations.length === 1 ? '' : 's'}`;
  const pathVersions = [...new Set(report.installations.map((entry) => entry.version).filter(Boolean))];
  const versions = pathVersions.length > 1 ? ` (${pathVersions.join(', ')})` : '';
  return [
    phaseLine('version', report.runningVersion),
    phaseLine('resolved', resolved),
    phaseLine('installs', paths + versions),
  ];
}

export function doctorSuccessLines(platform: DoctorPlatform | undefined, stim: StimVersionReport): string[] {
  const lines = [
    `Doctor (${doctorTarget(platform)})`,
    phaseLine('result', 'PASS'),
    phaseLine('findings', '0'),
    ...stimVersionLines(stim),
    '',
    'Project',
    phaseLine('project', 'main checkout, dependencies, local upstream'),
    phaseLine('settings', 'every Stim setting type'),
  ];

  if (platform !== 'android') {
    lines.push('', 'iOS');
    lines.push(phaseLine('setup', 'CocoaPods, warm state, dev client'));
    lines.push(phaseLine('caches', 'Metro, Xcode compilation, ccache, build provider'));
    lines.push(phaseLine('devices', 'remote device, SimSlim profile'));
  }
  if (platform !== 'ios') {
    lines.push('', 'Android');
    lines.push(phaseLine('setup', 'warm state, dev client'));
    lines.push(phaseLine('caches', 'Metro, Gradle, ccache, build provider'));
    lines.push(phaseLine('devices', 'remote device'));
  }

  lines.push('', 'Shared');
  lines.push(phaseLine('services', 'EAS session'));
  lines.push(phaseLine('fingerprint', 'parity when dependencies are absent'));
  lines.push('', 'Handled automatically');
  const suppliedCaches =
    platform === 'ios'
      ? 'Metro transform store, Xcode compilation cache'
      : platform === 'android'
        ? 'Metro transform store, Gradle build cache, ccache'
        : 'Metro transform store, Xcode compilation cache, Gradle build cache, ccache';
  lines.push(phaseLine('caches', suppliedCaches));
  lines.push(phaseLine('meaning', 'missing project cache settings are healthy'));
  return lines;
}

export function shadowedStimFinding(report: StimVersionReport): Finding | null {
  if (!report.resolvedIsOlder || !report.resolved?.version || !report.highestVersion) return null;
  const newer = [
    ...((compareStimVersions(report.runningVersion, report.resolved.version) ?? 0) > 0
      ? [{ path: report.runningPath, version: report.runningVersion }]
      : []),
    ...report.installations.filter(
      (entry) => entry.version && (compareStimVersions(entry.version, report.resolved?.version ?? '') ?? 0) > 0,
    ),
  ].find((entry) => entry.version === report.highestVersion);
  const newerLocation = newer?.path ? ` at ${newer.path}` : '';
  return {
    level: 'cost',
    title: 'The Stim resolved from PATH is older than another installation',
    detail: `${report.resolved.path} reports ${report.resolved.version}, while ${report.highestVersion} is also installed${newerLocation}. A shell command named stim uses the first executable on PATH, so newer commands and fixes can appear to be missing.`,
    fix: `Update or remove ${report.resolved.path}, or put the ${report.highestVersion} installation earlier on PATH. Then run \`stim doctor\` again.`,
  };
}

/**
 * Status goes to stderr so `--json --fix` still prints one parseable payload
 * on stdout, and the report that follows shows what the write left.
 */
export function applySandboxFix(root: string, env: NodeJS.ProcessEnv = process.env): void {
  const harness = detectHarness(env);
  if (harness === 'codex') {
    console.error(chalk.yellow('Nothing to apply under Codex.'));
    console.error(
      chalk.dim(
        'Its sandbox is one setting, `sandbox_mode`, with no per-path allowance: the only value that clears Stim is `danger-full-access`, which turns the sandbox off rather than allowing these three. Run Stim with the sandbox off instead, or set it yourself.',
      ),
    );
    process.exitCode = 1;
    return;
  }
  if (harness !== 'claude-code') {
    console.error(chalk.dim('No sandboxing harness detected, so there is nothing to apply.'));
    return;
  }

  const settingsRoot = repoRoot(root) ?? root;
  const stimHome = env.STIM_HOME || '~/.stim';
  const target = claudeLocalSettingsPath(settingsRoot);
  const missing = missingAllowance(allowanceSearchPaths(settingsRoot), stimHome);
  if (missing.length === 0) {
    console.error(chalk.green('Stim is already allowed through this sandbox. Nothing to apply.'));
    return;
  }

  const result = applyClaudeAllowance(target, sandboxAllowance(stimHome));
  if (result.status === 'refused') {
    console.error(chalk.red(result.reason));
    console.error(chalk.dim(`Nothing was written. Add ${missing.join(', ')} by hand.`));
    process.exitCode = 1;
    return;
  }
  console.error(chalk.green(`${result.status === 'created' ? 'Wrote' : 'Updated'} ${target}`));
  console.error(
    chalk.dim(
      "Added writes to Stim's state directory, the simulator XPC service, and local port binding. Claude Code reads project settings from the directory a session starts in, so this file only counts for sessions rooted there. Restart the session for it to take effect.",
    ),
  );
}

export default function doctorCommand(
  program: Command,
  version: string,
  inspectVersions: (version: string) => StimVersionReport | Promise<StimVersionReport> = inspectStimVersions,
): void {
  program
    .command('doctor')
    .description(
      'Inspect the main checkout and report project state that can make native worktrees slow or invalid. Read-only unless --fix is passed; --platform filters native findings.',
    )
    .option('--json', 'print the findings as JSON')
    .option(
      '--platform <platform>',
      'report shared findings plus only this native platform: ios or android',
      parseDoctorPlatform,
    )
    .option(
      '--fix',
      'apply the findings Stim can repair itself and report the rest, which stay read-only. Every repair writes a per-user file, never a committed one, and refuses a file it cannot read back rather than replace it. Today one finding qualifies: the sandbox allowance.',
    )
    .action(async (opts: DoctorOptions) => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project (no package.json found).'));
        process.exitCode = 1;
        return;
      }

      if (opts.fix) applySandboxFix(root);

      const stim = await inspectVersions(version);

      const findings: Finding[] = runDoctor(root, {
        xcodeMajor: opts.platform === 'android' ? null : detectXcodeMajor(),
        platform: opts.platform,
      });

      const parity = await detectFingerprintParity(root, { platform: opts.platform });
      if (parity) findings.push(parity);

      if (detectHarness()) {
        const sandbox = sandboxFinding(repoRoot(root) ?? root);
        if (sandbox) findings.push(sandbox);
      }

      const shadowed = shadowedStimFinding(stim);
      if (shadowed) findings.push(shadowed);

      if (opts.json) {
        console.log(JSON.stringify({ project: root, platform: opts.platform ?? null, stim, findings }));
        return;
      }

      if (findings.length === 0) {
        const lines = doctorSuccessLines(opts.platform, stim);
        for (const [index, line] of lines.entries()) {
          if (index === 1) console.log(chalk.green(line));
          else if (line && !line.startsWith('  ')) console.log(chalk.bold(line));
          else console.log(chalk.dim(line));
        }
        return;
      }

      const ordered = findings.toSorted((a, b) => (a.level === b.level ? 0 : a.level === 'cost' ? -1 : 1));
      console.log(chalk.bold(`Doctor (${doctorTarget(opts.platform)})`));
      for (const line of stimVersionLines(stim)) console.log(chalk.dim(line));
      for (const f of ordered) {
        const tag = f.level === 'cost' ? chalk.yellow('costs time') : chalk.dim('note');
        console.log(`\n${tag}  ${chalk.bold(f.title)}`);
        console.log(`  ${f.detail}`);
        if (f.fix) console.log(chalk.dim(`  -> ${f.fix}`));
      }

      console.log(
        chalk.dim(
          `\n${findings.length} finding(s). Fix relevant "costs time" findings before copying the main checkout into a native worktree.`,
        ),
      );
    });
}
