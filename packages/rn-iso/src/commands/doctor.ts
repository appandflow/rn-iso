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
      'Report what rn-iso cannot handle on its own: project configuration that will silently defeat rn-iso or the builds you run outside it. Read-only; changes nothing.',
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

      // LAST, because it is the expensive one: it computes a real fingerprint
      // twice (once in a temporary clean worktree of HEAD, removed on every
      // exit path). Every failure mode inside it is a silent skip -- doctor
      // always exits 0.
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
            'Checked: dev client, ccache, a conditionally-wired Metro cacheStores, a compilation-cache CAS left per-workspace, the build cache provider key, the EAS session, the .gitignore entry, fingerprint parity.',
          ),
        );
        console.log(
          chalk.dim(
            'Nothing to flag means nothing rn-iso cannot handle itself: it supplies the Metro transform store, the Xcode compilation cache and the Gradle build cache on its own command lines, so a project that configures none of them is clean here.',
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
      console.log(
        chalk.dim(
          `\n${findings.length} finding(s). Nothing here fails a build -- these are the things rn-iso cannot supply or work around on its own.`,
        ),
      );
    });
}
