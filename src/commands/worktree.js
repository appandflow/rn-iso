import { existsSync, rmSync } from 'fs';
import { resolve } from 'path';
import chalk from 'chalk';
import { detectPackageManager } from '../runner.js';
import { resolveSettings } from '../settings.js';
import { getSetupStatus, setSetupStatus, upsertProject } from '../config.js';
import { getExecutor } from '../exec.js';
import { formatBytes } from '../artifacts.js';
import { reclaimProject } from '../reclaim.js';
import {
  addWorktree,
  carryOverFiles,
  defaultWorktreeDir,
  gitCommonDir,
  hasRemote,
  hasUncommittedWork,
  listWorktrees,
  readWorktreeInclude,
  removeWorktree,
  repoRoot,
  resolveBaseRef,
  unpushedCommits,
  worktreePath,
} from '../worktree.js';

// A pipeline, not a boolean: one `install` is not enough for a monorepo, where
// a failed postinstall silently leaves later setup steps unrun.
//
// Pure: `packageManager` is resolved by the caller (via `detectPackageManager`,
// which walks the filesystem for lockfiles) rather than by this function, so
// the whole decision tree here -- including the fallback branch -- is
// unit-testable without touching disk.
export function resolveInstallPipeline(settings, packageManager) {
  const configured = settings?.worktree?.install;
  if (configured === false) return [];
  if (typeof configured === 'string') return [configured];
  if (Array.isArray(configured)) return configured;
  const pm = settings?.packageManager || packageManager;
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
      const message = String(e?.message || e).slice(0, 500);
      results.push({ command, ok: false, error: message });
      console.error(chalk.yellow(`  failed: ${command}`));
      // Print the captured reason too: the motivating failure cascade was
      // only found after multi-minute builds, and "failed: <command>" alone
      // gives no clue why.
      console.error(chalk.yellow(`  ${message}`));
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
      // `name` comes from a hook (session text), not a hand-typed argument,
      // and flows unescaped into a shell command (`-b "worktree-${name}"`,
      // and later `cd "${cwd}" && ...`) and into a filesystem join. Reject
      // anything outside a safe charset before creating anything.
      if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        console.error(chalk.red(`Invalid worktree name: "${name}". Use only letters, numbers, dots, dashes, and underscores.`));
        process.exitCode = 1;
        return;
      }

      const root = repoRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not a git repository.'));
        process.exitCode = 1;
        return;
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
        process.exitCode = 1;
        return;
      }

      // Fall back to settings on emptiness, not just on null: a
      // `.worktreeinclude` that exists but is blank/comment-only returns
      // `[]`, which is truthy, and must not shadow the settings fallback.
      const included = readWorktreeInclude(root);
      const patterns = included && included.length ? included : (settings?.worktree?.include || []);
      const { copied, failed } = carryOverFiles({ root, target, patterns });
      if (copied.length) console.error(chalk.dim(`Carried over ${copied.length} file(s).`));
      for (const f of failed) {
        console.error(chalk.yellow(`Failed to carry over ${f.file}: ${f.error}`));
      }

      let results = [];
      let skipped = false;
      if (opts.install !== false) {
        results = runPipeline(resolveInstallPipeline(settings, detectPackageManager(target)), target);
      } else {
        skipped = true;
      }
      const complete = !skipped && results.every(r => r.ok);

      // Register the label now, before `rn-iso ios` ever runs, and mark this
      // entry as a worktree root. Without the label, the project would later
      // register under its directory basename, and in a monorepo every
      // worktree's app dir shares that basename (every worktree of
      // tlon-apps is "tlon-mobile"), so the shortcuts collide. The
      // `worktreeRoot` marker lets a project registered later from inside
      // this worktree (e.g. `cd apps/tlon-mobile && rn-iso ios`) find this
      // label and this setup status -- see findEnclosingWorktreeRoot in
      // config.js.
      upsertProject(target, { label: opts.label || name, worktreeRoot: true });
      setSetupStatus(
        target,
        skipped ? { complete: false, skipped: true, commands: [] } : { complete, commands: results }
      );

      if (!complete) {
        if (skipped) {
          console.error(chalk.dim('Setup pipeline skipped (--no-install).'));
        } else {
          const failedCommands = results.filter(r => !r.ok).map(r => r.command);
          console.error(chalk.yellow(`Setup incomplete. Failed: ${failedCommands.join(', ')}`));
          console.error(chalk.dim('The worktree is usable but may not build until these succeed.'));
        }
      }

      // The WorktreeCreate hook reads stdout as the directory to use. Nothing
      // else may be written here, and a setup failure must still exit 0 or the
      // session spawn dies.
      console.log(target);
    });
}

// Pure: takes the already-computed dirty/unpushed facts and turns them into
// human-readable reasons to refuse removal. `worktree remove` is called
// unattended (agents, phone-driven sessions) and `git worktree remove
// --force` silently discards uncommitted changes and any commits that exist
// on no remote -- this is the only check standing between that and lost
// work, so it must be right and it must be tested without touching git.
export function removalBlockers({ dirty, unpushed }) {
  const blockers = [];
  if (dirty) blockers.push('uncommitted changes or untracked files');
  if (unpushed && unpushed.length) {
    blockers.push(`${unpushed.length} commit(s) not on any remote`);
  }
  return blockers;
}

export function registerRemove(worktree) {
  worktree
    .command('remove <target>')
    .description('Remove a worktree and reclaim its build artifacts, sim claim, and Metro port.')
    .option('--force', 'remove even when the worktree holds uncommitted or unpushed work')
    .action((target, opts) => {
      const path = resolve(target);
      if (!existsSync(path)) {
        console.error(chalk.red(`No such worktree: ${path}`));
        process.exitCode = 1;
        return;
      }

      const dirty = hasUncommittedWork(path);
      const unpushed = unpushedCommits(path);
      const blockers = removalBlockers({ dirty, unpushed });
      if (blockers.length && !opts.force) {
        console.error(chalk.red(`Refusing to remove ${path}:`));
        for (const b of blockers) console.error(chalk.red(`  - ${b}`));
        if (unpushed.length && !hasRemote(path)) {
          // Every commit reaches this branch when no remote is configured at
          // all -- that is the safe direction (refuse), but a bare count
          // reads like a bug rather than a missing remote. Say so.
          console.error(chalk.dim('  (no remote is configured for this worktree, so every commit counts as unpushed)'));
        }
        console.error(chalk.dim('Push the branch, or re-run with --force to discard this work.'));
        process.exitCode = 1;
        return;
      }

      // Find artifacts before the directory disappears; findDerivedDataFor
      // (inside reclaimProject) matches on WorkspacePath prefixes that only
      // resolve while the path still exists on disk.
      const result = reclaimProject(path, { deleteArtifacts: false });

      try {
        removeWorktree(path, { force: opts.force });
      } catch (e) {
        // reclaimProject already dropped rn-iso's own tracking for this
        // project (and may have killed its Metro process) before this ran,
        // per the ordering requirement above -- but the directory and its
        // git worktree registration are untouched, since `git worktree
        // remove` failed before deleting anything. Say so plainly rather
        // than crash with a raw stack trace.
        console.error(chalk.red(`git worktree remove failed: ${String(e?.message || e)}`));
        console.error(chalk.dim(`The directory at ${path} was not removed; rn-iso's own tracking for it was already cleared.`));
        console.error(chalk.dim('Common cause: this command must be run with the shell inside the target repo (any of its worktrees).'));
        process.exitCode = 1;
        return;
      }
      console.log(chalk.green(`Removed worktree ${path}`));
      if (result.freed.length) console.log(chalk.dim(`  freed: ${result.freed.join(', ')}`));
      if (result.killedPid) console.log(chalk.dim(`  killed Metro pid ${result.killedPid}`));

      // directorySize (behind result.artifacts[].bytes) returns 0 both for a
      // genuinely empty directory and for one it could not measure, so a
      // per-artifact 0 is not safe to print as "0K reclaimed". Sum first and
      // only report a total when it is actually positive.
      let bytes = 0;
      for (const artifact of result.artifacts) {
        rmSync(artifact.dir, { recursive: true, force: true });
        bytes += artifact.bytes;
      }
      if (bytes > 0) {
        console.log(chalk.dim(`  reclaimed ${formatBytes(bytes)} of build artifacts`));
      } else if (result.artifacts.length > 0) {
        console.log(chalk.dim(`  removed ${result.artifacts.length} build artifact dir(s) (size unknown)`));
      }
    });
}

export function registerList(worktree) {
  worktree
    .command('list')
    .description("List this repository's worktrees with their setup status.")
    .action(() => {
      const entries = listWorktrees(process.cwd());
      if (entries.length <= 1) {
        console.log(chalk.dim('No worktrees besides the main checkout.'));
        return;
      }
      for (const entry of entries.slice(1)) {
        const status = getSetupStatus(entry.path);
        const label = status
          ? status.complete
            ? chalk.green('setup ok')
            : chalk.yellow('setup incomplete')
          : chalk.dim('unmanaged');
        console.log(`${entry.path}  [${entry.branch || 'detached'}]  ${label}`);
      }
    });
}

export default function worktreeCommand(program) {
  const worktree = program.command('worktree').description('Create and remove isolated worktrees');
  registerCreate(worktree);
  registerRemove(worktree);
  registerList(worktree);
}
