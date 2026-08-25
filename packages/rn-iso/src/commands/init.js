import chalk from 'chalk';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { findProjectRoot } from '../project.js';
import { projectFacts, renderDevScript, renderGitignoreAdditions, renderWorkflow, renderWorktreeExclude } from '../init.js';
import { detectXcodeMajor, pendingCacheMigrations, runDoctor } from '../doctor.js';

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

// The shared caches moved under the config directory, and one left at its old
// address is invisible: nothing looks there any more, so it costs the disk twice
// and every project on the machine rebuilds cold once. They run to many GB, and
// a rename within a volume is instantaneous whatever the size -- which is the
// only reason this belongs inside a command people run casually.
//
// Two rules, both the standing fail-closed one:
//   - move only when the destination is free. Merging two caches means deciding
//     which copy of a colliding entry wins, and neither answer is knowable here.
//   - a rename that cannot happen (a different volume, a permission) is
//     reported, never turned into a copy-and-delete. The directory stays exactly
//     where it is and `doctor` keeps naming it.
export function migrateLegacyCaches(pending = pendingCacheMigrations()) {
  return pending.map(entry => {
    if (entry.destExists) return { ...entry, status: 'skipped' };
    try {
      mkdirSync(dirname(entry.dest), { recursive: true });
      renameSync(entry.legacy, entry.dest);
      return { ...entry, status: 'moved' };
    } catch (e) {
      return { ...entry, status: 'failed', error: e.message };
    }
  });
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
      });

      const files = [
        { path: join(root, 'WORKFLOW.md'), contents: renderWorkflow(facts) },
        { path: join(root, '.worktreeexclude'), contents: renderWorktreeExclude() },
        // Executable: it is meant to be run, and a script you have to chmod
        // before it works is a papercut on every fresh clone.
        { path: join(root, 'scripts', 'dev'), contents: renderDevScript(), mode: 0o755 },
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
        // writeFileSync's `mode` applies only when it creates the file, so
        // --force over an existing scripts/dev keeps whatever bits that file
        // already had. chmod every time instead.
        if (file.mode) chmodSync(file.path, file.mode);
        console.error(chalk.green(`Wrote ${file.path}`));
        wrote++;
      }

      // Both halves of the layout land here: `.worktreeexclude` above, and the
      // matching .gitignore entry now. Missing either one is silent -- see
      // checkArtifactLayout in src/doctor.js, which runs a few lines below.
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
          `${facts.hasFingerprint ? '' : ', WITHOUT @expo/fingerprint (builds cannot be cached until it is installed)'}.`
        )
      );

      // Before doctor, so its report describes the machine as it is once init
      // has done what it can rather than flagging something init just fixed.
      for (const moved of migrateLegacyCaches()) {
        if (moved.status === 'moved') {
          console.error(chalk.green(`Moved the ${moved.label} from ${moved.legacy} to ${moved.dest}`));
        } else if (moved.status === 'skipped') {
          console.error(chalk.yellow(`Left ${moved.legacy} where it is: ${moved.dest} already exists.`));
          console.error(chalk.dim('  Merging two caches is not a decision init can make. Move or delete it by hand.'));
        } else {
          console.error(chalk.yellow(`Could not move ${moved.legacy} to ${moved.dest}: ${moved.error}`));
          console.error(chalk.dim('  Nothing was copied and nothing was deleted; it is still readable where it is.'));
        }
      }

      // The generated document tells you what to do; doctor tells you what is
      // still wrong. Running it here means init ends on the truth about this
      // repo rather than on a template's assumptions.
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
