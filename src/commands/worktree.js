import { existsSync, realpathSync, rmSync } from 'fs';
import { resolve } from 'path';
import chalk from 'chalk';
import { detectPackageManager } from '../runner.js';
import { resolveSettings } from '../settings.js';
import { getSetupStatus, isPathPrefix, loadConfig, setSetupStatus, upsertProject } from '../config.js';
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

// Streams one pipeline command via spawn rather than buffering it through
// exec.run/execSync. Two reasons:
//   1. A chatty `pnpm install` on a large monorepo can run 40s+ and print
//      well past execSync's maxBuffer; buffering also means the user sees
//      nothing until the whole command finishes (or gets killed).
//   2. The stdout contract for `worktree create` is absolute: stdout carries
//      ONLY the worktree path, so the child's stdout is piped to OUR stderr,
//      never to our stdout. Its stderr goes to our stderr too.
function runOne(command, cwd) {
  return new Promise((resolvePromise) => {
    console.error(chalk.dim(`> ${command}`));
    const exec = getExecutor();
    let child;
    try {
      child = exec.spawn('sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const message = String(e?.message || e).slice(0, 500);
      console.error(chalk.yellow(`  failed: ${command}`));
      console.error(chalk.yellow(`  ${message}`));
      resolvePromise({ command, ok: false, error: message });
      return;
    }
    // Keep a bounded tail of combined output for the failure message --
    // "failed: <command>" alone gives no clue why, but we must not hold the
    // whole (potentially huge) output in memory just to report 500 chars.
    let tail = '';
    const onData = (chunk) => {
      process.stderr.write(chunk);
      tail = (tail + chunk.toString()).slice(-2000);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      const message = String(err?.message || err).slice(0, 500);
      console.error(chalk.yellow(`  failed: ${command}`));
      console.error(chalk.yellow(`  ${message}`));
      resolvePromise({ command, ok: false, error: message });
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise({ command, ok: true });
        return;
      }
      const message = `exit ${code}${tail.trim() ? `: ${tail.trim().slice(-500)}` : ''}`;
      console.error(chalk.yellow(`  failed: ${command}`));
      console.error(chalk.yellow(`  ${message}`));
      // Keep going (handled by the caller's loop): later commands may still
      // be useful, and the recorded status tells the next `rn-iso ios`
      // exactly what to re-run.
      resolvePromise({ command, ok: false, error: message });
    });
  });
}

async function runPipeline(commands, cwd) {
  const results = [];
  for (const command of commands) {
    results.push(await runOne(command, cwd));
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
    .action(async (name, opts) => {
      // `name` comes from a hook (session text), not a hand-typed argument,
      // and flows unescaped into a shell command (`-b "worktree-${name}"`)
      // and into a filesystem join. Reject anything outside a safe charset
      // before creating anything.
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

      // `--base` reaches here as a raw string -- commander does not
      // validate `.option()` values against an enum. resolveBaseRef treats
      // anything other than the 'head' sentinel as 'fresh', so a typo like
      // `--base=orign/HEAD` used to resolve silently instead of erroring.
      // Nothing has been created yet, so exit 1 here is correct.
      const base = opts.base || settings?.worktree?.baseRef || 'fresh';
      if (base !== 'fresh' && base !== 'head') {
        console.error(chalk.red(`Invalid --base: "${base}". Use "fresh" or "head".`));
        process.exitCode = 1;
        return;
      }

      const dir = settings.worktreeDir || defaultWorktreeDir(root);
      const target = worktreePath({ worktreeDir: dir, name });

      // Idempotent: a hook retry must not fail.
      if (existsSync(target)) {
        console.error(chalk.dim(`Worktree already exists at ${target}`));
        console.log(target);
        return;
      }

      const baseRef = resolveBaseRef(root, base);
      try {
        addWorktree({ path: target, branch: `worktree-${name}`, baseRef, cwd: root });
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
        results = await runPipeline(resolveInstallPipeline(settings, detectPackageManager(target)), target);
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
// `dirty` / `unpushed` are `null` (not `false` / `[]`) when the caller could
// not get an answer from git at all -- see hasUncommittedWork/unpushedCommits
// in worktree.js. For a destructive command the unknown case must fail
// CLOSED: treat "could not determine" as a blocker in its own right, rather
// than defaulting to "clean" the way a falsy check would.
export function removalBlockers({ dirty, unpushed }) {
  const blockers = [];
  if (dirty === null || unpushed === null) {
    blockers.push('could not determine git status; re-run with --force to override');
  }
  if (dirty) blockers.push('uncommitted changes or untracked files');
  if (unpushed && unpushed.length) {
    blockers.push(`${unpushed.length} commit(s) not on any remote`);
  }
  return blockers;
}

// A monorepo worktree registers more than one config key: `worktree create`
// registers the worktree root itself, but `rn-iso ios`/`android` run from a
// nested app dir (e.g. `<worktree>/apps/tlon-mobile`) register THAT path --
// a different key, since every worktree of a monorepo shares the same app
// dir basename and needs its own label. That nested key is where
// `metroPort` and the device claim actually live; the worktree-root entry
// has `platforms: {}` and `metroPort: null`. Reclaiming only the root key
// (the old behaviour) frees nothing and leaves the Metro process and its
// port claim to leak until someone runs `prune`.
//
// Reclaims `rootPath` itself plus every registered key that is a
// path-segment prefix match under it (reusing isPathPrefix from config.js,
// the same helper findEnclosingWorktreeRoot uses for the inverse lookup),
// and aggregates the freed devices, killed pids, artifacts, and owned-device
// deletions across all of them. The environment dies whole: `deleteOwnedDevices`
// is always on here, so every owned iOS sim / AVD registered under the
// worktree (including nested monorepo app-dir keys) is reaped along with it.
// An occupied owned sim is left running (see reclaimOwnedDevices in
// reclaim.js) and comes back in `skippedDevices` instead of `deletedDevices`.
// The `freed:` line identifies an iOS device by udid (describeFreed uses
// `ios.deviceUdid`, never deviceName). A `kept ...` line built from
// `s.name` alone (deviceName-or-udid) can show a different string for the
// same device -- e.g. "freed: ios sim U1" next to "kept rn-iso-x: ..." --
// leaving a reader unable to tell the two lines are about the same
// simulator. Include the udid alongside the name whenever they differ so
// the two lines are visibly the same device; android skips have no
// separate udid (their `name` already is the freed identifier, the AVD
// name), so this is a no-op for them.
function describeKeptDevice(s) {
  return s.udid && s.udid !== s.name ? `${s.name} (${s.udid})` : s.name;
}

async function reclaimAll(rootPath) {
  const cfg = loadConfig();
  const keys = new Set([rootPath]);
  if (cfg?.projects) {
    for (const key of Object.keys(cfg.projects)) {
      if (isPathPrefix(rootPath, key)) keys.add(key);
    }
  }
  const freed = [];
  const killedPids = [];
  const artifacts = [];
  const deletedDevices = [];
  const skippedDevices = [];
  for (const key of keys) {
    const r = await reclaimProject(key, { deleteArtifacts: false, deleteOwnedDevices: true });
    freed.push(...r.freed);
    if (r.killedPid) killedPids.push(r.killedPid);
    artifacts.push(...r.artifacts);
    deletedDevices.push(...r.deletedDevices);
    skippedDevices.push(...r.skippedDevices);
  }
  return { freed, killedPids, artifacts, deletedDevices, skippedDevices };
}

export function registerRemove(worktree) {
  worktree
    .command('remove <target>')
    .description('Remove a worktree and reclaim its build artifacts, sim claim, and Metro port.')
    .option('--force', 'remove even when the worktree holds uncommitted or unpushed work')
    .action(async (target, opts) => {
      // Canonicalize with realpath, matching how config keys are
      // canonicalized (CLAUDE.md item 7). A plain resolve() misses a
      // symlinked target (/tmp vs /private/tmp on macOS, or a home dir
      // symlinked onto an external volume): getProject(path) inside
      // reclaimProject would then miss, freeing no sim claim, killing no
      // Metro, and leaving a stale config entry. Fall back to resolve() if
      // realpath fails (e.g. the path does not exist -- handled below).
      let path;
      try {
        path = realpathSync(resolve(target));
      } catch {
        path = resolve(target);
      }
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
        if (unpushed && unpushed.length && !hasRemote(path)) {
          // Every commit reaches this branch when no remote is configured at
          // all -- that is the safe direction (refuse), but a bare count
          // reads like a bug rather than a missing remote. Say so.
          console.error(chalk.dim('  (no remote is configured for this worktree, so every commit counts as unpushed)'));
        }
        // Committed work is not actually at risk here: the branch ref
        // survives `git worktree remove --force`. Only uncommitted changes
        // (and untracked files) are discarded by --force; say so plainly
        // rather than implying --force throws away commits too.
        console.error(chalk.dim('Push the branch, or re-run with --force. --force discards uncommitted changes and untracked files; committed work stays on the branch.'));
        process.exitCode = 1;
        return;
      }

      // Confirm the target actually is a linked worktree of this repo --
      // not the main checkout, and not some unrelated path -- before doing
      // anything that mutates state. Without this, `worktree remove` run
      // against the main checkout (clean, pushed -- the blockers check above
      // passes) would SIGTERM its Metro and drop its sim/AVD claim via
      // reclaimProject below, and only then fail at `git worktree remove`
      // with "is a main working tree" -- silently de-registering a running
      // project that the command never actually removed.
      const entries = listWorktrees(path);
      const entryIndex = entries.findIndex(e => e.path === path);
      if (entryIndex === -1) {
        console.error(chalk.red(`Refusing to remove ${path}: it does not match any worktree root known to git.`));
        console.error(chalk.dim('  Pass the worktree root path, e.g. as printed by `rn-iso worktree list`.'));
        process.exitCode = 1;
        return;
      }
      if (entryIndex === 0) {
        console.error(chalk.red(`Refusing to remove ${path}: it is the main checkout, not a linked worktree.`));
        process.exitCode = 1;
        return;
      }

      // Find artifacts before the directory disappears; findDerivedDataFor
      // (inside reclaimProject) matches on WorkspacePath prefixes that only
      // resolve while the path still exists on disk. Reclaims the worktree
      // root AND every nested registered project under it (see reclaimAll
      // above) so a monorepo's Metro/device claim -- registered under a
      // nested app dir, not the root -- is not left leaking.
      const result = await reclaimAll(path);

      try {
        removeWorktree(path, { force: opts.force });
      } catch (e) {
        // reclaimProject already dropped rn-iso's own tracking for this
        // project (and may have killed its Metro process) before this ran,
        // per the ordering requirement above -- but the directory and its
        // git worktree registration are untouched, since `git worktree
        // remove` failed before deleting anything. Say so plainly rather
        // than crash with a raw stack trace, and report exactly what was
        // already released (the same two lines the success path prints
        // below) so the user knows which sim was freed and whether their
        // bundler is gone, instead of just "tracking was cleared".
        console.error(chalk.red(`git worktree remove failed: ${String(e?.message || e)}`));
        console.error(chalk.dim(`The directory at ${path} was not removed; rn-iso's own tracking for it was already cleared.`));
        if (result.freed.length) console.error(chalk.dim(`  freed: ${result.freed.join(', ')}`));
        for (const pid of result.killedPids) console.error(chalk.dim(`  killed Metro pid ${pid}`));
        if (result.deletedDevices.length) console.error(chalk.dim(`  deleted device(s): ${result.deletedDevices.join(', ')}`));
        for (const s of result.skippedDevices) console.error(chalk.dim(`  kept ${describeKeptDevice(s)}: ${s.reason}`));
        process.exitCode = 1;
        return;
      }
      console.log(chalk.green(`Removed worktree ${path}`));
      if (result.freed.length) console.log(chalk.dim(`  freed: ${result.freed.join(', ')}`));
      for (const pid of result.killedPids) console.log(chalk.dim(`  killed Metro pid ${pid}`));
      if (result.deletedDevices.length) console.log(chalk.dim(`  deleted device(s): ${result.deletedDevices.join(', ')}`));
      for (const s of result.skippedDevices) {
        console.log(chalk.yellow(`  kept ${describeKeptDevice(s)}: ${s.reason} (left for gc)`));
      }

      // directorySize (behind result.artifacts[].bytes) returns 0 both for a
      // genuinely empty directory and for one it could not measure, so a
      // per-artifact 0 is not safe to print as "0K reclaimed". Sum first and
      // only report a total when it is actually positive.
      let bytes = 0;
      for (const artifact of result.artifacts) {
        // force:true only suppresses ENOENT. EACCES/EPERM/EBUSY still throw,
        // and by this point the worktree itself is already gone -- a
        // failure to delete one leftover artifact dir must not crash an
        // otherwise-successful removal with a raw stack trace.
        try {
          rmSync(artifact.dir, { recursive: true, force: true });
          bytes += artifact.bytes;
        } catch (e) {
          console.error(chalk.yellow(`  could not remove ${artifact.dir}: ${String(e?.message || e)}`));
        }
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
      if (entries.length === 0) {
        // listWorktrees also returns [] outside any git repo -- distinguish
        // that from "this repo just has no linked worktrees" so the message
        // does not imply a main checkout exists when there isn't one.
        console.log(chalk.dim('Not a git repository.'));
        return;
      }
      if (entries.length === 1) {
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
