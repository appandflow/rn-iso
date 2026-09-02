import chalk from 'chalk';
import type { Command } from 'commander';
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
import type { Finding } from '../doctor.ts';

interface DoctorOptions {
  json?: boolean;
  fix?: boolean;
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

export default function doctorCommand(program: Command): void {
  program
    .command('doctor')
    .description(
      'Inspect the main checkout and report project state that can make native worktrees slow or invalid. Read-only unless --fix is passed.',
    )
    .option('--json', 'print the findings as JSON')
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

      const findings: Finding[] = runDoctor(root, {
        xcodeMajor: detectXcodeMajor(),
      });

      const parity = await detectFingerprintParity(root);
      if (parity) findings.push(parity);

      if (detectHarness()) {
        const sandbox = sandboxFinding(repoRoot(root) ?? root);
        if (sandbox) findings.push(sandbox);
      }

      if (opts.json) {
        console.log(JSON.stringify({ project: root, findings }, null, 2));
        return;
      }

      if (findings.length === 0) {
        console.log(chalk.green('Nothing to flag.'));
        console.log(
          chalk.dim(
            'Checked: main-checkout dependencies, CocoaPods, native warm state and local upstream; dev client, ccache, Metro cacheStores, compilation cache, build cache provider, EAS session, SimSlim profile and, on a checkout without installed dependencies, fingerprint parity.',
          ),
        );
        console.log(
          chalk.dim(
            'Nothing to flag means nothing Stim cannot handle itself: it supplies the Metro transform store, the Xcode compilation cache and the Gradle build cache on its own command lines, so a project that configures none of them is clean here.',
          ),
        );
        return;
      }

      const ordered = findings.toSorted((a, b) => (a.level === b.level ? 0 : a.level === 'cost' ? -1 : 1));
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
