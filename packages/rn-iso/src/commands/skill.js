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
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Where agents look. Both are plain directories of skill folders, one folder
// per skill -- so a second bundled skill installs alongside, not on top of, the
// first.
export function skillTargets(home = homedir(), name = 'rn-iso') {
  return [
    join(home, '.claude', 'skills', name),
    join(home, '.agents', 'skills', name),
  ];
}

// Every skill this package ships: the always-on one describing the CLI, and the
// task-shaped ones an agent invokes by name.
export function bundledSkills() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skill');
  return [
    { name: 'rn-iso', source: join(root, 'SKILL.md') },
    { name: 'rn-iso-init', source: join(root, 'rn-iso-init', 'SKILL.md') },
  ];
}

// The installed copy is a plain file copy, so nothing about it records which
// CLI produced it and nothing can tell an agent that its copy is four minors
// behind. Stamping the version in is what makes staleness detectable at all.
// An HTML comment because it must not disturb the frontmatter a skill loader
// parses, and must not render as text.
const VERSION_MARKER = /<!--\s*rn-iso-skill-version:\s*([0-9][^\s]*)\s*-->/;

export function stampSkillVersion(text, version) {
  const marker = `<!-- rn-iso-skill-version: ${version} -->`;
  const body = text.replace(VERSION_MARKER, '').trimEnd();
  return `${body}\n\n${marker}\n`;
}

export function parseSkillVersion(text) {
  const m = VERSION_MARKER.exec(String(text || ''));
  return m ? m[1] : null;
}

// The version stamped into each installed copy, or null for a copy that
// predates stamping (which is itself a stale copy worth reporting).
export function installedSkillVersions(home = homedir(), name = 'rn-iso', { read = readFileSync, exists = existsSync } = {}) {
  const found = [];
  for (const dir of skillTargets(home, name)) {
    const file = join(dir, 'SKILL.md');
    if (!exists(file)) continue;
    try {
      found.push({ file, version: parseSkillVersion(read(file, 'utf-8')) });
    } catch {
      // An unreadable copy is not evidence of anything; stay quiet.
    }
  }
  return found;
}

// Pure: which installed copies disagree with the running CLI. An installed
// copy NEWER than the CLI counts too -- that is the npx-served-a-stale-binary
// case, where the docs an agent reads describe commands the running CLI does
// not have.
export function staleSkillCopies(installed, cliVersion) {
  return (installed || []).filter(s => s.version !== cliVersion);
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
      for (const skillToInstall of bundledSkills()) {
        if (!existsSync(skillToInstall.source)) continue;
        for (const dir of skillTargets(homedir(), skillToInstall.name)) {
          try {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, 'SKILL.md'), stampSkillVersion(readFileSync(skillToInstall.source, 'utf-8'), version));
            console.log(chalk.green(`Installed ${skillToInstall.name} ${version} skill -> ${join(dir, 'SKILL.md')}`));
            installed++;
          } catch (e) {
            console.error(chalk.yellow(`Could not install into ${dir}: ${String(e?.message || e)}`));
          }
        }
      }
      if (installed === 0) {
        console.error(chalk.red('Installed nowhere.'));
        process.exit(1);
      }
      console.log(chalk.dim('Restart or re-scan skills in your agent for it to pick up the change.'));
    });
}
