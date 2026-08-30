import chalk from 'chalk';
import type { Command } from 'commander';
import { findProjectRoot } from '../project.ts';
import { detectFingerprintParity, detectXcodeMajor, runDoctor } from '../doctor.ts';
import type { Finding } from '../doctor.ts';

interface DoctorOptions {
  json?: boolean;
}

export default function doctorCommand(program: Command): void {
  program
    .command('doctor')
    .description(
      'Inspect the main checkout and report project state that can make native worktrees slow or invalid. Read-only; changes nothing.',
    )
    .option('--json', 'print the findings as JSON')
    .action(async (opts: DoctorOptions) => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project (no package.json found).'));
        process.exitCode = 1;
        return;
      }

      const findings: Finding[] = runDoctor(root, {
        xcodeMajor: detectXcodeMajor(),
      });

      const parity = await detectFingerprintParity(root);
      if (parity) findings.push(parity);

      if (opts.json) {
        console.log(JSON.stringify({ project: root, findings }, null, 2));
        return;
      }

      if (findings.length === 0) {
        console.log(chalk.green('Nothing to flag.'));
        console.log(
          chalk.dim(
            'Checked: main-checkout dependencies, CocoaPods, native warm state and local upstream; dev client, ccache, Metro cacheStores, compilation cache, build cache provider, EAS session, SimSlim profile and fingerprint parity.',
          ),
        );
        console.log(
          chalk.dim(
            'Nothing to flag means nothing stim-cli cannot handle itself: it supplies the Metro transform store, the Xcode compilation cache and the Gradle build cache on its own command lines, so a project that configures none of them is clean here.',
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
