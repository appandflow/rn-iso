import { existsSync, realpathSync } from 'fs';
import { resolve } from 'path';
import chalk from 'chalk';
import { resolveSettings, unknownSettingKeys } from '../settings.js';
import { isPathPrefix, loadConfig, upsertProject } from '../config.js';
import { reclaimProject } from '../reclaim.js';
import {
  addWorktree,
  carryOverFiles,
  cloneIgnoredEntries,
  defaultWorktreeDir,
  dirtyPaths,
  gitCommonDir,
  hasRemote,
  hasUncommittedWork,
  isPodInstallChurn,
  listWorktrees,
  podsOutOfSync,
  readWorktreeExclude,
  readWorktreeInclude,
  removeWorktree,
  repoRoot,
  resolveBaseRef,
  unpushedCommits,
  worktreePath,
} from '../worktree.js';

export function registerCreate(worktree) {
  worktree
    .command('create <name>')
    .description('Create a git worktree with its environment set up. Prints the worktree path on stdout.')
    .option('--base <ref>', 'base ref: "fresh" (origin/HEAD, default) or "head"')
    .option('--label <label>', 'rn-iso shortcut for the worktree (defaults to the worktree name)')
    .option('--carry-ignored', 'clone every gitignored path (node_modules, Pods, build output) except those in .worktreeexclude')
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
      // stdout carries ONLY the worktree path, so this goes to stderr.
      for (const key of unknownSettingKeys(settings)) {
        console.error(chalk.yellow(`Warning: setting "${key}" is not read by rn-iso and will be ignored.`));
      }

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

      let carriedIgnored = false;
      let carriedDeps = false;
      if (opts.carryIgnored) {
        const excluded = readWorktreeExclude(root);
        const skip = excluded && excluded.length ? excluded : (settings?.worktree?.exclude || []);
        const res = cloneIgnoredEntries({ root, target, patterns: skip });
        carriedIgnored = res.copied.length > 0;
        carriedDeps = res.copied.some(rel => rel === 'node_modules' || rel.endsWith('/node_modules'));
        if (res.copied.length) console.error(chalk.dim(`Cloned ${res.copied.length} gitignored path(s).`));
        // A count reads like success. It is not: the clone can only carry what
        // the source worktree has, and a source with no node_modules produces a
        // healthy-looking count and a worktree that cannot build.
        if (carriedIgnored && !carriedDeps) {
          console.error(chalk.yellow('No node_modules among them -- the source worktree has none. Install dependencies before building.'));
        }
        if (!res.cloned) {
          console.error(chalk.yellow('Copy-on-write clone unavailable (not APFS, or a different volume) -- these are full copies using real disk.'));
        }
        for (const f of res.failed) {
          console.error(chalk.yellow(`Failed to clone ${f.file}: ${f.error}`));
        }
        for (const p of podsOutOfSync(target, res.copied)) {
          const where = p.dir === '.' ? 'Podfile.lock' : `${p.dir}/Podfile.lock`;
          console.error(chalk.yellow(p.reason === 'missing'
            ? `Carried ${p.dir === '.' ? 'Pods' : `${p.dir}/Pods`} but there is no ${where}. Run \`pod install\` before building.`
            : `Carried ${p.dir === '.' ? 'Pods' : `${p.dir}/Pods`} does not match ${where}. Pods are gitignored and cloned; Podfile.lock is tracked and comes from the branch, so the two can disagree. Run \`pod install\` before building, or xcodebuild fails with "sandbox is not in sync" only after every pod has compiled.`));
        }
      }


      // Register the label now, before `rn-iso ios` ever runs, and mark this
      // entry as a worktree root. Without the label, the project would later
      // register under its directory basename, and in a monorepo every
      // worktree's app dir shares that basename (every worktree of
      // tlon-apps is "tlon-mobile"), so the shortcuts collide. The
      // `worktreeRoot` marker lets a project registered later from inside
      // this worktree (e.g. `cd apps/tlon-mobile && rn-iso ios`) find this
      // label -- see findEnclosingWorktreeRoot in config.js.
      upsertProject(target, { label: opts.label || name, worktreeRoot: true });

      // Cloned dependencies match the source worktree, not necessarily this
      // branch's manifests -- same contract as restoring a CI cache.
      console.error(chalk.dim(carriedIgnored
        ? 'Worktree ready. Cloned dependencies may be stale; reinstall if this branch changes them.'
        : 'Worktree ready. Install dependencies yourself before building.'));

      // The WorktreeCreate hook reads stdout as the directory to use. Nothing
      // else may be written here.
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
// port claim to leak until someone runs `gc --delete`.
//
// Reclaims `rootPath` itself plus every registered key that is a
// path-segment prefix match under it (reusing isPathPrefix from config.js,
// the same helper findEnclosingWorktreeRoot uses for the inverse lookup),
// and aggregates the de-referenced devices, killed pids, and owned-device
// deletions across all of them. The environment dies whole:
// `deleteOwnedDevices` is always on here, so every owned iOS sim / AVD
// registered under the worktree (including nested monorepo app-dir keys) is
// reaped along with it, occupied or not. A device rn-iso does not own, and one
// whose delete failed, come back in `skippedDevices` instead of
// `deletedDevices`.
// The `no longer referenced:` line identifies an iOS device by udid
// (describeDereferenced uses `ios.deviceUdid`, never deviceName). A `kept ...`
// line built from `s.name` alone (deviceName-or-udid) can show a different
// string for the same device, leaving a reader unable to tell the two lines
// are about the same simulator. Include the udid alongside the name whenever
// they differ so the two lines are visibly the same device; android skips have
// no separate udid (their `name` already is the AVD name), so this is a no-op
// for them.
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
  const dereferenced = [];
  const killedPids = [];
  const deletedDevices = [];
  const skippedDevices = [];
  const keptEntries = [];
  for (const key of keys) {
    const r = await reclaimProject(key, { deleteOwnedDevices: true });
    dereferenced.push(...r.dereferenced);
    if (r.killedPid) killedPids.push(r.killedPid);
    deletedDevices.push(...r.deletedDevices);
    skippedDevices.push(...r.skippedDevices);
    if (r.keptEntry) keptEntries.push(key);
  }
  return { dereferenced, killedPids, deletedDevices, skippedDevices, keptEntries };
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
        // A native build rewrites tracked files -- `pod install` always
        // touches Podfile.lock and project.pbxproj -- so this refusal fires
        // after almost every iOS build. Leading with --force taught agents to
        // reach for the destructive flag as the routine response, which is a
        // bad habit to teach: it also discards real uncommitted work. Lead
        // with restore instead.
        //
        // Committed work is not at risk either way: the branch ref survives
        // `git worktree remove --force`. Only uncommitted changes and
        // untracked files are discarded.
        // Name what is actually dirty. `pod install` churn is the common
        // cause but not the only one -- a brand/env script that rewrites
        // tracked assets produces the same refusal, and the CocoaPods restore
        // command does nothing for it, so printing that unconditionally sends
        // the reader down the wrong path.
        const paths = dirty ? dirtyPaths(path) : [];
        if (paths.length) {
          for (const line of paths) console.error(chalk.dim(`      ${line}`));
          console.error(chalk.dim('  (git -C <worktree> status -s for the full list)'));
        }
        if (isPodInstallChurn(paths)) {
          console.error(chalk.dim('That is only the files `pod install` rewrites. Restore them and retry:'));
          console.error(chalk.dim('  git -C <worktree> checkout -- ios/Podfile.lock "ios/*.xcodeproj/project.pbxproj"'));
        } else {
          console.error(chalk.dim('If a build or a setup script rewrote tracked files, restore those paths and retry:'));
          console.error(chalk.dim('  git -C <worktree> checkout -- <path>...'));
        }
        console.error(chalk.dim('Otherwise: commit or push the branch. --force is a last resort -- it discards'));
        console.error(chalk.dim('uncommitted changes and untracked files permanently; committed work stays on the branch.'));
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

      // Release rn-iso's own state before the directory disappears. Reclaims
      // the worktree root AND every nested registered project under it (see
      // reclaimAll above) so a monorepo's Metro/device claim -- registered
      // under a nested app dir, not the root -- is not left leaking. The
      // worktree's build output needs no separate step: it lives inside the
      // directory `git worktree remove` deletes.
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
        if (result.dereferenced.length) console.error(chalk.dim(`  no longer referenced: ${result.dereferenced.join(', ')}`));
        for (const pid of result.killedPids) console.error(chalk.dim(`  killed Metro pid ${pid}`));
        if (result.deletedDevices.length) console.error(chalk.dim(`  deleted device(s): ${result.deletedDevices.join(', ')}`));
        for (const s of result.skippedDevices) console.error(chalk.dim(`  kept ${describeKeptDevice(s)}: ${s.reason}`));
        for (const kept of result.keptEntries) {
          console.error(chalk.dim(`  rn-iso still tracks ${kept} because a device delete failed; re-run \`rn-iso release ${kept}\` once the cause is fixed.`));
        }
        process.exitCode = 1;
        return;
      }
      console.log(chalk.green(`Removed worktree ${path}`));
      if (result.dereferenced.length) console.log(chalk.dim(`  no longer referenced: ${result.dereferenced.join(', ')}`));
      for (const pid of result.killedPids) console.log(chalk.dim(`  killed Metro pid ${pid}`));
      if (result.deletedDevices.length) console.log(chalk.dim(`  deleted device(s): ${result.deletedDevices.join(', ')}`));
      for (const s of result.skippedDevices) {
        console.log(chalk.yellow(`  kept ${describeKeptDevice(s)}: ${s.reason}`));
      }
      for (const kept of result.keptEntries) {
        console.log(chalk.yellow(`  rn-iso still tracks ${kept} because a device delete failed; re-run \`rn-iso release ${kept}\` once the cause is fixed.`));
      }
    });
}

export function registerList(worktree) {
  worktree
    .command('list')
    .description("List this repository's worktrees. `rn-iso status` shows the same worktrees WITH their environments -- prefer it.")
    .action(() => {
      console.error(chalk.dim('`rn-iso status` lists worktrees alongside their devices, ports and what is running.'));
      const entries = listWorktrees(process.cwd());
      if (entries.length === 0) {
        console.log(chalk.dim('Not a git repository.'));
        return;
      }
      if (entries.length === 1) {
        console.log(chalk.dim('No worktrees besides the main checkout.'));
        return;
      }
      for (const entry of entries) {
        console.log(`${entry.path}${entry.branch ? chalk.dim(` [${entry.branch}]`) : ''}`);
      }
    })
}

export default function worktreeCommand(program) {
  const worktree = program.command('worktree').description('Create and remove isolated worktrees');
  registerCreate(worktree);
  registerRemove(worktree);
  registerList(worktree);
}
