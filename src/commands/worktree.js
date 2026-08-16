import { existsSync } from 'fs';
import chalk from 'chalk';
import { detectPackageManager } from '../runner.js';
import { resolveSettings } from '../settings.js';
import { setSetupStatus, upsertProject } from '../config.js';
import { getExecutor } from '../exec.js';
import {
  addWorktree,
  carryOverFiles,
  defaultWorktreeDir,
  gitCommonDir,
  readWorktreeInclude,
  repoRoot,
  resolveBaseRef,
  worktreePath,
} from '../worktree.js';

// A pipeline, not a boolean: one `install` is not enough for a monorepo, where
// a failed postinstall silently leaves later setup steps unrun.
export function resolveInstallPipeline(settings, projectRoot) {
  const configured = settings?.worktree?.install;
  if (configured === false) return [];
  if (typeof configured === 'string') return [configured];
  if (Array.isArray(configured)) return configured;
  const pm = settings?.packageManager || detectPackageManager(projectRoot) || 'npm';
  return [`${pm} install`];
}

function runPipeline(commands, cwd) {
  const exec = getExecutor();
  const results = [];
  for (const command of commands) {
    // stderr, so stdout stays reserved for the worktree path (hook contract).
    console.error(chalk.dim(`> ${command}`));
    try {
      exec.run(`cd "${cwd}" && ${command}`);
      results.push({ command, ok: true });
    } catch (e) {
      results.push({ command, ok: false, error: String(e?.message || e).slice(0, 500) });
      console.error(chalk.yellow(`  failed: ${command}`));
      // Keep going: later commands may still be useful, and the recorded
      // status tells the next `rn-iso ios` exactly what to re-run.
    }
  }
  return results;
}

export function registerCreate(worktree) {
  worktree
    .command('create <name>')
    .description('Create a git worktree with its environment set up. Prints the worktree path on stdout.')
    .option('--base <ref>', 'base ref: "fresh" (origin/HEAD, default) or "head"')
    .option('--no-install', 'skip the setup pipeline')
    .option('--label <label>', 'rn-iso shortcut for the worktree (defaults to the worktree name)')
    .action((name, opts) => {
      const root = repoRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not a git repository.'));
        process.exit(1);
      }
      const common = gitCommonDir(process.cwd());
      const settings = resolveSettings({ gitCommonDir: common, repoRoot: root });

      const dir = settings.worktreeDir || defaultWorktreeDir(root);
      const target = worktreePath({ worktreeDir: dir, name });

      // Idempotent: a hook retry must not fail.
      if (existsSync(target)) {
        console.error(chalk.dim(`Worktree already exists at ${target}`));
        console.log(target);
        return;
      }

      const baseRef = resolveBaseRef(root, opts.base || settings?.worktree?.baseRef || 'fresh');
      try {
        addWorktree({ path: target, branch: `worktree-${name}`, baseRef });
      } catch (e) {
        console.error(String(e?.message || e));
        process.exit(1);
      }

      const patterns = readWorktreeInclude(root) || settings?.worktree?.include || [];
      const copied = carryOverFiles({ root, target, patterns });
      if (copied.length) console.error(chalk.dim(`Carried over ${copied.length} file(s).`));

      let results = [];
      if (opts.install !== false) {
        results = runPipeline(resolveInstallPipeline(settings, target), target);
      }
      const complete = results.every(r => r.ok);

      // Register the label now, before `rn-iso ios` ever runs. Without this,
      // the project would later register under its directory basename, and in
      // a monorepo every worktree's app dir shares that basename (every
      // worktree of tlon-apps is "tlon-mobile"), so the shortcuts collide.
      upsertProject(target, { label: opts.label || name });
      setSetupStatus(target, { complete, commands: results });

      if (!complete) {
        const failed = results.filter(r => !r.ok).map(r => r.command);
        console.error(chalk.yellow(`Setup incomplete. Failed: ${failed.join(', ')}`));
        console.error(chalk.dim('The worktree is usable but may not build until these succeed.'));
      }

      // The WorktreeCreate hook reads stdout as the directory to use. Nothing
      // else may be written here, and a setup failure must still exit 0 or the
      // session spawn dies.
      console.log(target);
    });
}

export default function worktreeCommand(program) {
  const worktree = program.command('worktree').description('Create and remove isolated worktrees');
  registerCreate(worktree);
}
