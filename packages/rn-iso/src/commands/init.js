import chalk from 'chalk';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { findProjectRoot } from '../project.js';
import { projectFacts, renderDevScript, renderWorkflow, renderWorktreeExclude } from '../init.js';
import { runDoctor } from '../doctor.js';

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export default function initCommand(program) {
  program
    .command('init')
    .description('Write the loop documentation a repo needs before several agents can work in it at once, then report what is still costing time.')
    .option('--force', 'overwrite files that already exist')
    .action(opts => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project (no package.json found).'));
        process.exitCode = 1;
        return;
      }

      const facts = projectFacts({
        pkg: readJson(join(root, 'package.json')),
        appConfig: readJson(join(root, 'app.json')),
        hasPodfile: existsSync(join(root, 'ios', 'Podfile')),
        // Lockfiles are the evidence for which package manager this repo uses,
        // so the generated commands invoke the one it actually has.
        files: readdirSync(root),
      });

      const files = [
        { path: join(root, 'WORKFLOW.md'), contents: renderWorkflow(facts) },
        { path: join(root, '.worktreeexclude'), contents: renderWorktreeExclude() },
        // Executable: it is meant to be run, and a script you have to chmod
        // before it works is a papercut on every fresh clone.
        { path: join(root, 'scripts', 'dev'), contents: renderDevScript(facts), mode: 0o755 },
      ];

      let wrote = 0;
      for (const file of files) {
        if (existsSync(file.path) && !opts.force) {
          // Never clobber a workflow someone has edited: the generated one is a
          // starting point, and by the second week theirs is the better document.
          console.error(chalk.yellow(`Kept existing ${file.path}`));
          console.error(chalk.dim('  --force overwrites it.'));
          continue;
        }
        mkdirSync(dirname(file.path), { recursive: true });
        writeFileSync(file.path, file.contents, file.mode ? { mode: file.mode } : undefined);
        console.error(chalk.green(`Wrote ${file.path}`));
        wrote++;
      }

      console.error(
        chalk.dim(
          `\nDetected: ${facts.isExpo ? `Expo${facts.sdkMajor ? ` SDK ${facts.sdkMajor}` : ''}` : 'bare React Native'}` +
          `, ${facts.pm}` +
          `${facts.scripts?.ios ? ", using this repo's own scripts" : ''}` +
          `${facts.hasPodfile ? ', with an ios/Podfile' : ''}.`
        )
      );

      // The generated document tells you what to do; doctor tells you what is
      // still wrong. Running it here means init ends on the truth about this
      // repo rather than on a template's assumptions.
      const findings = runDoctor(root);
      if (findings.length === 0) {
        console.error(chalk.green('\nNothing else to flag.'));
      } else {
        console.error(chalk.bold(`\n${findings.length} thing(s) still costing time:`));
        for (const f of findings) {
          console.error(`  ${f.level === 'cost' ? chalk.yellow('costs time') : chalk.dim('note')}  ${f.title}`);
          if (f.fix) console.error(chalk.dim(`    -> ${f.fix}`));
        }
        console.error(chalk.dim('\n`rn-iso doctor` explains each of these in full.'));
      }

      if (wrote === 0) console.error(chalk.dim('\nNothing written.'));
    });
}
