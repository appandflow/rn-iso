import { join } from 'path';
import chalk from 'chalk';
import type { Command } from 'commander';
import { findProjectRoot } from '../project.ts';
import { repoRoot } from '../worktree.ts';
import {
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

export default function doctorCommand(program: Command): void {
  program
    .command('doctor')
    .description(
      'Inspect the main checkout and report project state that can make native worktrees slow or invalid. Read-only; changes nothing.',
    )
    .option('--json', 'print the findings as JSON')
    .option(
      '--fix',
      "allow Stim through this session's sandbox by writing the three keys into .claude/settings.local.json, the per-user file. Applies nothing else, and refuses where the harness has no per-path allowance.",
    )
    .action(async (opts: DoctorOptions) => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project (no package.json found).'));
        process.exitCode = 1;
        return;
      }

      if (opts.fix) {
        const harness = detectHarness();
        const settingsRoot = repoRoot(root) ?? root;
        const home = process.env.STIM_HOME || '~/.stim';
        if (harness === 'claude-code') {
          const path = claudeLocalSettingsPath(settingsRoot);
          if (missingAllowance([path, join(settingsRoot, '.claude', 'settings.json')], home).length === 0) {
            console.log(chalk.green('Stim is already allowed through this sandbox. Nothing to apply.'));
            return;
          }
          const { created } = applyClaudeAllowance(path, sandboxAllowance(home));
          console.log(chalk.green(`${created ? 'Wrote' : 'Updated'} ${path}`));
          console.log(
            chalk.dim(
              "Added writes to Stim's state directory, the simulator XPC service, and local port binding. Restart the session for it to take effect.",
            ),
          );
          return;
        }
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
        console.log(chalk.dim('No sandboxing harness detected, so there is nothing to apply.'));
        return;
      }

      const findings: Finding[] = runDoctor(root, {
        xcodeMajor: detectXcodeMajor(),
      });

      const parity = await detectFingerprintParity(root);
      if (parity) findings.push(parity);

      const sandbox = sandboxFinding(repoRoot(root) ?? root);
      if (sandbox) findings.push(sandbox);

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
