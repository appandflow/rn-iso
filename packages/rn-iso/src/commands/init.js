import chalk from 'chalk';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { findProjectRoot } from '../project.js';
import { repoRoot } from '../worktree.js';
import { installCommand, projectFacts, renderDevScript, renderGitignoreAdditions } from '../init.js';
import { detectXcodeMajor, runDoctor } from '../doctor.js';

// The one generated thing that is appended rather than written: .gitignore
// belongs to the repo, so init adds its entry to whatever is already there.
//
// Appending has to be idempotent -- init is re-run after an upgrade, and a
// duplicated block is noise that survives forever. The entry is matched as a
// path rather than as the literal template text, because `/.rn-iso`, `.rn-iso`
// and `.rn-iso/` are one entry to git and a repo that already has any of them
// needs nothing added. `src/doctor.js` reads the same file the same way.
export function appendGitignoreAdditions(root) {
  const path = join(root, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const listed = existing
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .some(line => line.replace(/^\/+/, '').replace(/\/+$/, '') === '.rn-iso');
  if (listed) return { path, changed: false };

  // A blank line before the block when there is something to separate it from,
  // and a newline first if the file did not end with one.
  const separator = existing === '' ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(path, existing + separator + renderGitignoreAdditions());
  return { path, changed: true };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

// Which package manager the repo is actually run with, read from the lockfile.
// In a workspace the lockfile is at the REPO root and the app is several
// directories below it, so this walks up -- bounded by the repo root, because
// above that it would start reading lockfiles belonging to nothing.
//
// It exists for one line of advice, and that line is why it matters: `npm i -D`
// in a pnpm workspace writes a second lockfile and installs into a directory
// nothing resolves from. Null when no lockfile is found, and the caller says it
// in words rather than guessing.
export function detectPackageManager(startDir, stopDir = startDir) {
  const lockfiles = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm']];
  let dir = startDir;
  while (true) {
    for (const [file, name] of lockfiles) {
      if (existsSync(join(dir, file))) return name;
    }
    if (dir === stopDir) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export default function initCommand(program) {
  program
    .command('init')
    .description('Write the files a repo needs before several agents can work in it at once, then report what is still costing time.')
    .option('--force', 'overwrite files that already exist')
    .action(opts => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project (no package.json found).'));
        process.exitCode = 1;
        return;
      }

      // The lockfile that says which package manager this repo uses is at the
      // REPO root in a workspace, several directories above the app, so the
      // search is bounded by it rather than by the project root.
      const facts = projectFacts({
        pkg: readJson(join(root, 'package.json')),
        hasPodfile: existsSync(join(root, 'ios', 'Podfile')),
        projectRoot: root,
        packageManager: detectPackageManager(root, repoRoot(process.cwd()) || root),
      });

      const files = [
        // Executable: it is meant to be run, and a script you have to chmod
        // before it works is a papercut on every fresh clone.
        { path: join(root, 'scripts', 'dev'), contents: renderDevScript(), mode: 0o755 },
      ];

      let wrote = 0;
      for (const file of files) {
        if (existsSync(file.path) && !opts.force) {
          // Never clobber a file someone has edited: `scripts/dev` is the
          // repo's composition point, and by the second week theirs is the
          // better version of it.
          console.error(chalk.yellow(`Kept existing ${file.path}`));
          console.error(chalk.dim('  --force overwrites it.'));
          continue;
        }
        mkdirSync(dirname(file.path), { recursive: true });
        writeFileSync(file.path, file.contents, file.mode ? { mode: file.mode } : undefined);
        // writeFileSync's `mode` applies only when it creates the file, so
        // --force over an existing scripts/dev keeps whatever bits that file
        // already had. chmod every time instead.
        if (file.mode) chmodSync(file.path, file.mode);
        console.error(chalk.green(`Wrote ${file.path}`));
        wrote++;
      }

      // The only file init edits rather than writes. `.rn-iso/` also has to
      // stay out of a fresh worktree, but that is not a second entry to
      // maintain any more: `worktree create --carry-ignored` skips the
      // directory in code (isWorkspaceArtifact in src/worktree.js).
      const gitignore = appendGitignoreAdditions(root);
      if (gitignore.changed) {
        console.error(chalk.green(`Updated ${gitignore.path}`));
        wrote++;
      } else {
        console.error(chalk.dim(`Kept existing ${gitignore.path} (it already ignores .rn-iso/)`));
      }

      console.error(
        chalk.dim(
          `\nDetected: ${facts.isExpo ? `Expo${facts.sdkMajor ? ` SDK ${facts.sdkMajor}` : ''}` : 'bare React Native'}` +
          `${facts.hasDevClient ? ', with expo-dev-client' : ''}` +
          `${facts.hasPodfile ? ', with an ios/Podfile' : ''}` +
          `${facts.packageManager ? `, managed with ${facts.packageManager}` : ''}` +
          `${facts.hasFingerprint ? '' : ', WITHOUT @expo/fingerprint (builds cannot be cached until it is installed)'}.`
        )
      );
      // The remedy names this repo's package manager, or names none: `npm i -D`
      // in a pnpm workspace writes a second lockfile and installs into a
      // directory nothing resolves from.
      if (!facts.hasFingerprint) {
        const install = installCommand(facts.packageManager, '@expo/fingerprint');
        console.error(chalk.dim(`  -> ${install || 'add @expo/fingerprint as a dev dependency with this repo\'s package manager'}`));
      }

      // init writes what it can; doctor names what is left, and every one of
      // those lives in a file the project already owns. Running it here means
      // init ends on the truth about this repo rather than on what it just
      // wrote.
      const findings = runDoctor(root, { xcodeMajor: detectXcodeMajor() });
      if (findings.length === 0) {
        console.error(chalk.green('\nNothing else to flag.'));
      } else {
        console.error(chalk.bold(`\n${findings.length} thing(s) still costing time:`));
        for (const f of findings) {
          console.error(`  ${f.level === 'cost' ? chalk.yellow('costs time') : chalk.dim('note')}  ${f.title}`);
          if (f.fix) console.error(chalk.dim(`    -> ${f.fix}`));
        }
        console.error(chalk.dim('\n`rn-iso doctor` explains each in full, and the rn-iso-init skill'));
        console.error(chalk.dim('walks through fixing them: npx rn-iso skill install'));
      }

      if (wrote === 0) console.error(chalk.dim('\nNothing written.'));
    });
}
