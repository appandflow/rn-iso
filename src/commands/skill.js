// src/commands/skill.js
//
// Installs the skill that ships INSIDE this package, so the agent-facing docs
// and the binary are the same version by construction.
//
// The reported failure: the copy under ~/.agents/skills/rn-iso is a plain
// copy, so `npm i -g rn-iso@latest` leaves it untouched. A 0.10.0 CLI ran
// against a 0.6.x skill for a while before anyone noticed. `npm install`
// cannot fix that on its own -- nothing about upgrading the package knows
// where the skill was copied to -- so this makes refreshing it one command.
import chalk from 'chalk';
import { copyFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Where agents look. Both are plain directories of skill folders.
export function skillTargets(home = homedir()) {
  return [
    join(home, '.claude', 'skills', 'rn-iso'),
    join(home, '.agents', 'skills', 'rn-iso'),
  ];
}

export function bundledSkillPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skill', 'SKILL.md');
}

// Pure: decides what an install would do, so the report is testable without
// touching a filesystem.
export function planSkillInstall(targets, { exists, readVersion }) {
  return targets.map((dir) => {
    const file = join(dir, 'SKILL.md');
    if (!exists(dir)) return { dir, action: 'create' };
    const current = readVersion(file);
    return { dir, action: current === null ? 'create' : 'overwrite', current };
  });
}

export default function skillCommand(program, version) {
  const skill = program
    .command('skill')
    .description('Manage the bundled agent skill (the docs other AI agents read)');

  skill
    .command('install')
    .description('Copy this version\'s SKILL.md into ~/.claude/skills and ~/.agents/skills, replacing any older copy. Run after upgrading rn-iso so the skill and the CLI stay in step.')
    .option('--print', 'Write the bundled SKILL.md to stdout instead of installing it')
    .action((opts) => {
      const source = bundledSkillPath();
      if (!existsSync(source)) {
        console.error(chalk.red(`Bundled skill not found at ${source}.`));
        process.exit(1);
      }
      if (opts.print) {
        console.log(readFileSync(source, 'utf-8'));
        return;
      }
      let installed = 0;
      for (const dir of skillTargets()) {
        try {
          mkdirSync(dir, { recursive: true });
          copyFileSync(source, join(dir, 'SKILL.md'));
          console.log(chalk.green(`Installed rn-iso ${version} skill -> ${join(dir, 'SKILL.md')}`));
          installed++;
        } catch (e) {
          console.error(chalk.yellow(`Could not install into ${dir}: ${String(e?.message || e)}`));
        }
      }
      if (installed === 0) {
        console.error(chalk.red('Installed nowhere.'));
        process.exit(1);
      }
      console.log(chalk.dim('Restart or re-scan skills in your agent for it to pick up the change.'));
    });
}
