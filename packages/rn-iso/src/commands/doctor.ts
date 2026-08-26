import chalk from 'chalk';
import type { Command } from 'commander';
import { findProjectRoot } from '../project.ts';
import { detectXcodeMajor, runDoctor } from '../doctor.ts';
import type { Finding } from '../doctor.ts';

interface DoctorOptions {
  json?: boolean;
}

export default function doctorCommand(program: Command) {
  program
    .command('doctor')
    .description(
      'Report configuration that makes a second workspace slower than it needs to be. Read-only; changes nothing.',
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

      if (opts.json) {
        console.log(JSON.stringify({ project: root, findings }, null, 2));
        return;
      }

      if (findings.length === 0) {
        console.log(chalk.green('Nothing to flag.'));
        console.log(
          chalk.dim(
            'Checked: dev client, Metro cache, compilation cache, ccache conflict, .gitignore entry, build cache provider, EAS session.',
          ),
        );
        return;
      }

      // Costs first: those are the ones silently spending time.
      const ordered = [...findings].sort((a, b) => (a.level === b.level ? 0 : a.level === 'cost' ? -1 : 1));
      for (const f of ordered) {
        const tag = f.level === 'cost' ? chalk.yellow('costs time') : chalk.dim('note');
        console.log(`\n${tag}  ${chalk.bold(f.title)}`);
        console.log(`  ${f.detail}`);
        if (f.fix) console.log(chalk.dim(`  -> ${f.fix}`));
      }

      // Deliberately exit 0: none of this is broken, and a non-zero exit would
      // make doctor unusable in the `&&` chain of a setup script.
      console.log(chalk.dim(`\n${findings.length} finding(s). Nothing here fails a build; it only makes one slower.`));
    });
}
