import { existsSync, realpathSync } from 'fs';
import { resolve } from 'path';
import chalk from 'chalk';
import type { Command } from 'commander';
import { resolveSettings, unknownSettingKeys } from '../settings.ts';
import { isPathPrefix, loadConfig, upsertProject } from '../config.ts';
import { reclaimProject } from '../reclaim.ts';
import { withManagedRemoteWorktreeRemovalLock, withManagedTunnelRemovalLock } from '../engine/tunnel.ts';
import { readMetroTunnel, readRemoteSession } from '../supervisor/state.ts';
import {
  addWorktree,
  branchExists,
  carryOverFiles,
  carryUncommittedChanges,
  depsOutOfSync,
  cloneIgnoredEntries,
  defaultWorktreeDir,
  dirtyPaths,
  gitCommonDir,
  hasRemote,
  hasUncommittedWork,
  isMainWorkingTree,
  isPodInstallChurn,
  listWorktrees,
  podsOutOfSync,
  readWorktreeExclude,
  readWorktreeInclude,
  removeWorktree,
  repoRoot,
  resolveBaseRef,
  resolveRef,
  restoreFile,
  unpushedCommits,
  worktreePath,
} from '../worktree.ts';
import type { WorktreeEntry } from '../worktree.ts';

interface WorktreeSettings {
  worktreeDir?: string;
  worktree?: {
    baseRef?: string;
    include?: string[];
    exclude?: string[];
  };
}

export function registerCreate(worktree: Command): void {
  worktree
    .command('create <name>')
    .description('Create a git worktree with its environment set up. Prints the worktree path on stdout.')
    .option(
      '--base <ref>',
      'base ref: "fresh" (origin/HEAD, default), "head", or any ref this repo resolves (branch, tag, sha)',
    )
    .option('--label <label>', 'rn-iso shortcut for the worktree (defaults to the worktree name)')
    .option(
      '--carry-ignored',
      "clone the source's working state: every gitignored path (node_modules, Pods, build output) except those in .worktreeexclude, plus its uncommitted tracked changes (applied when they fit this base)",
    )
    .action(async (name, opts) => {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        console.error(
          chalk.red(`Invalid worktree name: "${name}". Use only letters, numbers, dots, dashes, and underscores.`),
        );
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
      const settings = resolveSettings({ gitCommonDir: common, repoRoot: root }) as WorktreeSettings;
      for (const key of unknownSettingKeys(settings)) {
        console.error(chalk.yellow(`Warning: setting "${key}" is not read by rn-iso and will be ignored.`));
      }

      const base = opts.base || settings?.worktree?.baseRef || 'fresh';

      const dir = settings.worktreeDir || defaultWorktreeDir(root);
      const target = worktreePath({ worktreeDir: dir, name });

      if (existsSync(target)) {
        console.error(chalk.dim(`Worktree already exists at ${target}`));
        console.log(target);
        return;
      }

      const baseRef = base === 'fresh' || base === 'head' ? resolveBaseRef(root, base) : base;
      const baseSha = resolveRef(root, baseRef);
      if (!baseSha) {
        console.error(
          chalk.red(`Invalid --base: "${base}". This repo cannot resolve ${JSON.stringify(baseRef)} to a commit.`),
        );
        console.error(
          chalk.dim('  Use "fresh" (origin/HEAD), "head", or any branch, tag or sha `git rev-parse` accepts.'),
        );
        process.exitCode = 1;
        return;
      }

      const branch = `worktree-${name}`;
      const reusedBranch = branchExists(root, branch);
      const branchSha = reusedBranch ? resolveRef(root, branch) : null;

      if (opts.base && reusedBranch && branchSha !== baseSha) {
        console.error(
          chalk.red(
            `Refusing to create ${name}: the branch ${branch} already exists at ${branchSha || 'an unresolvable commit'}, but --base ${base} resolves to ${baseSha}.`,
          ),
        );
        console.error(
          chalk.dim(
            '  `git worktree add` attaches to an existing branch and ignores the base, so this worktree would NOT be based on what you asked for.',
          ),
        );
        console.error(chalk.dim('  Either create it under a different name:'));
        console.error(chalk.dim(`    rn-iso worktree create <other-name> --base ${base}`));
        console.error(
          chalk.dim(
            '  or delete the leftover branch (it is what an earlier `worktree remove` left behind; removing a worktree never deletes its branch) and retry:',
          ),
        );
        console.error(chalk.dim(`    git -C ${root} branch -D ${branch}`));
        process.exitCode = 1;
        return;
      }

      try {
        addWorktree({ path: target, branch, baseRef, cwd: root });
      } catch (e) {
        console.error(String((e as Error)?.message || e));
        process.exitCode = 1;
        return;
      }

      console.error(
        chalk.dim(
          reusedBranch
            ? `Attached to the existing branch ${branch}${branchSha ? ` (${branchSha})` : ''}; --base does not apply.`
            : `Branched ${branch} from ${baseRef} (${baseSha}).`,
        ),
      );
      if (!reusedBranch && base === 'fresh') {
        console.error(
          chalk.dim(
            `  ${baseRef} is a local ref, current as of the last \`git fetch\`. If you need the very latest, ` +
              `run \`git -C ${root} fetch\` first.`,
          ),
        );
      }

      const included = readWorktreeInclude(root);
      const patterns = included && included.length ? included : settings?.worktree?.include || [];
      const { copied, failed } = carryOverFiles({ root, target, patterns });
      if (copied.length) console.error(chalk.dim(`Carried over ${copied.length} file(s).`));
      for (const f of failed) {
        console.error(chalk.yellow(`Failed to carry over ${f.file}: ${f.error}`));
      }

      let carriedIgnored = false;
      let carriedDeps = false;
      if (opts.carryIgnored) {
        const excluded = readWorktreeExclude(root);
        const skip = excluded && excluded.length ? excluded : settings?.worktree?.exclude || [];
        const res = cloneIgnoredEntries({ root, target, patterns: skip });
        carriedIgnored = res.copied.length > 0;
        carriedDeps = res.copied.some((rel) => rel === 'node_modules' || rel.endsWith('/node_modules'));
        if (res.copied.length) console.error(chalk.dim(`Cloned ${res.copied.length} gitignored path(s).`));
        if (carriedIgnored && !carriedDeps) {
          console.error(
            chalk.yellow(
              'No node_modules among them -- the source worktree has none. Install dependencies before building.',
            ),
          );
        }
        if (!res.cloned) {
          console.error(
            chalk.yellow(
              'Copy-on-write clone unavailable (not APFS, or a different volume) -- these are full copies using real disk.',
            ),
          );
        }
        for (const f of res.failed) {
          console.error(chalk.yellow(`Failed to clone ${f.file}: ${f.error}`));
        }
        for (const d of depsOutOfSync(root, target, res.copied)) {
          const where = d.dir === '.' ? d.lockfile : `${d.dir}/${d.lockfile}`;
          console.error(
            chalk.yellow(
              `Carried ${d.dir === '.' ? 'node_modules' : `${d.dir}/node_modules`} was installed for a different ${d.lockfile} than this branch's ${where}. Reinstall dependencies before building, or the dev server can die on a module the branch added.`,
            ),
          );
        }
        for (const p of podsOutOfSync(target, res.copied)) {
          const where = p.dir === '.' ? 'Podfile.lock' : `${p.dir}/Podfile.lock`;
          console.error(
            chalk.yellow(
              p.reason === 'missing'
                ? `Carried ${p.dir === '.' ? 'Pods' : `${p.dir}/Pods`} but there is no ${where}. Run \`pod install\` before building.`
                : `Carried ${p.dir === '.' ? 'Pods' : `${p.dir}/Pods`} does not match ${where}. Pods are gitignored and cloned; Podfile.lock is tracked and comes from the branch, so the two can disagree. Run \`pod install\` before building, or xcodebuild fails with "sandbox is not in sync" only after every pod has compiled.`,
            ),
          );
        }
        const changes = carryUncommittedChanges({ root, target });
        if (changes?.applied) {
          console.error(chalk.dim(carriedChangesLine(changes.files)));
        } else if (changes?.conflicted) {
          console.error(chalk.yellow(carryConflictWarning(changes.files)));
        }
      }

      upsertProject(target, { label: opts.label || name, worktreeRoot: true });

      console.error(
        chalk.dim(
          carriedIgnored
            ? 'Worktree ready. Cloned dependencies may be stale; reinstall if this branch changes them.'
            : 'Worktree ready. Install dependencies yourself before building.',
        ),
      );

      console.log(target);
    });
}

function carriedFileList(files: string[]): string {
  const shown = files.slice(0, 3).join(', ');
  return files.length > 3 ? `${shown}, +${files.length - 3}` : shown;
}

export function carriedChangesLine(files: string[]): string {
  return `Carried ${files.length} uncommitted change(s) from the source (${carriedFileList(files)}) -- uncommitted here too; commit deliberately.`;
}

export function carryConflictWarning(files: string[]): string {
  return (
    `Could not carry the source's uncommitted changes (${carriedFileList(files)}): this worktree's base diverges from the source HEAD, so the patch does not apply and nothing was changed here. ` +
    "The carried artifacts were installed for the source's uncommitted state, so fingerprints and cache keys in this worktree will differ from the source's until those changes are reconciled."
  );
}

export function porcelainPath(line: string): string | null {
  const raw = String(line).slice(3).trim();
  if (raw === '') return null;
  const renamed = raw.includes(' -> ') ? raw.slice(raw.lastIndexOf(' -> ') + 4) : raw;
  return renamed.replace(/^"(.*)"$/, '$1');
}

const SAFE_DIFF_PATH = /^[A-Za-z0-9._/-]+$/;

const POD_CHURN_PATH = /(?:^|\/)ios\/(?:Podfile\.lock|[^/]+\.xcodeproj\/project\.pbxproj)$/;

interface PodChurnResult {
  lines: string[];
  restore: string[];
}

export function excludePodChurn(lines: string[] | null | undefined): PodChurnResult {
  const kept: string[] = [];
  const restore: string[] = [];
  for (const line of lines || []) {
    const path = porcelainPath(line);
    if (path && String(line).startsWith(' M ') && SAFE_DIFF_PATH.test(path) && POD_CHURN_PATH.test(path)) {
      restore.push(path);
      continue;
    }
    kept.push(line);
  }
  if (kept.length) return { lines: lines ? [...lines] : [], restore: [] };
  return { lines: kept, restore };
}

interface MatchedWorktreeEntry {
  index: number;
  path: string;
}

export function matchWorktreeEntry(
  entries: WorktreeEntry[] | null | undefined,
  path: string,
): MatchedWorktreeEntry | null {
  let best: MatchedWorktreeEntry | null = null;
  (entries || []).forEach((entry, index) => {
    if (!entry?.path || !isPathPrefix(entry.path, path)) return;
    if (!best || entry.path.length > best.path.length) best = { index, path: entry.path };
  });
  return best;
}

export function removalRemedy(
  dirtyLines: string[] | null | undefined,
  { worktree = '<worktree>' }: { worktree?: string } = {},
): string[] {
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const line of dirtyLines || []) {
    if (porcelainPath(line) === null) continue;
    (String(line).startsWith('??') ? untracked : tracked).push(line);
  }

  const lines: string[] = [];
  if (tracked.length) {
    if (isPodInstallChurn(tracked)) {
      lines.push('That is only the files `pod install` rewrites. Restore them and retry:');
      lines.push(`  git -C ${worktree} checkout -- ${pathArgs(tracked)}`);
    } else {
      lines.push('Tracked files were modified -- if a build or a setup script did it, restore them and retry:');
      lines.push(`  git -C ${worktree} checkout -- ${pathArgs(tracked)}`);
    }
  }
  if (untracked.length) {
    lines.push('Untracked files are also present -- `git checkout` cannot clear those. Delete them and retry:');
    lines.push(`  git -C ${worktree} clean -fd ${pathArgs(untracked)}        # or rm them yourself`);
  }
  return lines;
}

function pathArgs(lines: string[] | null | undefined, limit = 5): string {
  const paths = (lines || []).map(porcelainPath).filter((p): p is string => Boolean(p));
  const shown = paths.slice(0, limit).map((p) => (/[\s"'\\$`]/.test(p) ? JSON.stringify(p) : p));
  return `${shown.join(' ')}${paths.length > shown.length ? ' ...' : ''}`;
}

export function removalBlockers({ dirty, unpushed }: { dirty: boolean | null; unpushed: string[] | null }): string[] {
  const blockers: string[] = [];
  if (dirty === null || unpushed === null) {
    blockers.push('could not determine git status; re-run with --force to override');
  }
  if (dirty) blockers.push('uncommitted changes or untracked files');
  if (unpushed && unpushed.length) {
    blockers.push(`${unpushed.length} commit(s) not on any remote or any other local branch`);
  }
  return blockers;
}

interface SkippedDevice {
  platform?: string;
  name: string;
  udid?: string;
  reason: string;
}

interface RetainedResource extends SkippedDevice {
  project: string;
}

function describeKeptDevice(s: SkippedDevice): string {
  return s.udid && s.udid !== s.name ? `${s.name} (${s.udid})` : s.name;
}

interface ReclaimAllResult {
  dereferenced: string[];
  killedPids: number[];
  deletedDevices: string[];
  skippedDevices: SkippedDevice[];
  keptEntries: string[];
  retainedResources: RetainedResource[];
  reclaimedKeys: string[];
  stoppedSessions: string[];
  stoppedTunnels: string[];
  removedWorkspaceDirs: string[];
  failedWorkspaceDirs: string[];
}

function reclaimKeys(rootPath: string): string[] {
  const cfg = loadConfig();
  const keys = new Set([rootPath]);
  if (cfg?.projects) {
    for (const key of Object.keys(cfg.projects)) {
      if (isPathPrefix(rootPath, key)) keys.add(key);
    }
  }
  return [...keys].toSorted();
}

async function withReclaimLocks<T>(rootPath: string, fn: (lockedKeys: readonly string[]) => Promise<T>): Promise<T> {
  const keys = reclaimKeys(rootPath);
  const acquire = (index: number): Promise<T> =>
    index === keys.length ? fn(keys) : withManagedTunnelRemovalLock(keys[index]!, () => acquire(index + 1));
  return acquire(0);
}

async function reclaimAll(
  rootPath: string,
  keys: readonly string[] = reclaimKeys(rootPath),
): Promise<ReclaimAllResult> {
  const dereferenced: string[] = [];
  const killedPids: number[] = [];
  const deletedDevices: string[] = [];
  const skippedDevices: SkippedDevice[] = [];
  const keptEntries: string[] = [];
  const retainedResources: RetainedResource[] = [];
  const stoppedSessions: string[] = [];
  const stoppedTunnels: string[] = [];
  const removedWorkspaceDirs: string[] = [];
  const failedWorkspaceDirs: string[] = [];
  for (const key of keys) {
    const r = await reclaimProject(key, { deleteOwnedDevices: true });
    dereferenced.push(...r.dereferenced);
    if (r.killedPid) killedPids.push(r.killedPid);
    deletedDevices.push(...r.deletedDevices);
    skippedDevices.push(...r.skippedDevices);
    if (r.stoppedSession) stoppedSessions.push(r.stoppedSession);
    if (r.stoppedTunnel) stoppedTunnels.push(r.stoppedTunnel);
    removedWorkspaceDirs.push(...r.removedWorkspaceDirs);
    failedWorkspaceDirs.push(...r.failedWorkspaceDirs);
    if (r.keptEntry) {
      keptEntries.push(key);
      for (const resource of r.failedDevices) retainedResources.push({ ...resource, project: key });
    }
  }
  for (const key of keys) {
    if (keptEntries.includes(key)) continue;
    const tunnel = readMetroTunnel(key);
    const managedTunnel = tunnel?.kind === 'managed' ? tunnel : null;
    const remote = readRemoteSession(key);
    if (!managedTunnel && !remote) continue;
    keptEntries.push(key);
    retainedResources.push({
      platform: remote?.platform ?? 'ios',
      name: remote ? `remote session ${remote.sessionId}` : `${managedTunnel?.provider ?? 'managed'} tunnel`,
      reason: 'A remote ownership record appeared during reclaim and is retained for a later cleanup.',
      project: key,
    });
  }
  for (const key of reclaimKeys(rootPath)) {
    if (keys.includes(key) || keptEntries.includes(key)) continue;
    keptEntries.push(key);
    retainedResources.push({
      name: 'new project ownership state',
      reason:
        'The project was registered after removal acquired its locks. Retry removal after the other command finishes.',
      project: key,
    });
  }
  return {
    dereferenced,
    killedPids,
    deletedDevices,
    skippedDevices,
    keptEntries,
    retainedResources,
    reclaimedKeys: [...keys],
    stoppedSessions,
    stoppedTunnels,
    removedWorkspaceDirs,
    failedWorkspaceDirs,
  };
}

function reportRetainedResources(root: string, result: ReclaimAllResult): void {
  console.error(chalk.red(`Refusing to remove ${root}: rn-iso could not release owned resources.`));
  for (const resource of result.retainedResources) {
    console.error(chalk.yellow(`  - rn-iso still tracks ${describeKeptDevice(resource)} for ${resource.project}`));
    console.error(chalk.dim(`    ${resource.reason}`));
  }
  for (const kept of result.keptEntries) {
    if (result.retainedResources.some((resource) => resource.project === kept)) continue;
    console.error(chalk.yellow(`  - retained rn-iso ownership state for ${kept}`));
  }
  console.error(chalk.dim('Fix the reported cause, then run `rn-iso worktree remove` again.'));
  process.exitCode = 1;
}

function hasRegisteredProjectUnder(rootPath: string): boolean {
  const cfg = loadConfig();
  return Object.keys(cfg?.projects ?? {}).some((key) => isPathPrefix(rootPath, key));
}

async function reclaimEnvironment(root: string, why: string): Promise<void> {
  await withManagedRemoteWorktreeRemovalLock(root, () =>
    withReclaimLocks(root, async (lockedKeys) => {
      const result = await reclaimAll(root, lockedKeys);
      for (const dir of result.removedWorkspaceDirs) {
        console.error(chalk.dim(`  removed ${dir} (this workspace's own output)`));
      }
      for (const dir of result.failedWorkspaceDirs) console.error(chalk.yellow(`  could not remove ${dir}`));
      if (result.dereferenced.length)
        console.error(chalk.dim(`  no longer referenced: ${result.dereferenced.join(', ')}`));
      for (const pid of result.killedPids) console.error(chalk.dim(`  killed Metro pid ${pid}`));
      if (result.deletedDevices.length)
        console.error(chalk.dim(`  deleted device(s): ${result.deletedDevices.join(', ')}`));
      if (result.keptEntries.length) {
        reportRetainedResources(root, result);
        return;
      }
      for (const s of result.skippedDevices) {
        console.error(chalk.yellow(`  kept ${describeKeptDevice(s)}: ${s.reason}`));
      }
      console.error(chalk.green(`Reclaimed the environment; the working tree stays (${why}).`));
    }),
  );
}

interface RemoveOptions {
  force?: boolean;
}

interface RemovalInspection {
  dirtyLines: string[];
  podChurn: string[];
  unpushed: string[] | null;
  blockers: string[];
}

function removalPath(target: string | undefined): string {
  const resolved = resolve(target ?? process.cwd());
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function inspectRemoval(path: string): RemovalInspection {
  const gitAnswered = hasUncommittedWork(path);
  const allDirty = gitAnswered ? dirtyPaths(path, { limit: Infinity }) : [];
  const { lines: dirtyLines, restore: podChurn } = excludePodChurn(allDirty);
  const dirty = gitAnswered === null ? null : dirtyLines.length > 0;
  const unpushed = unpushedCommits(path);
  return { dirtyLines, podChurn, unpushed, blockers: removalBlockers({ dirty, unpushed }) };
}

function printRemovalRefusal(path: string, inspection: RemovalInspection): void {
  const { blockers, dirtyLines, unpushed } = inspection;
  console.error(chalk.red(`Refusing to remove ${path}:`));
  for (const blocker of blockers) console.error(chalk.red(`  - ${blocker}`));
  if (unpushed && unpushed.length && !hasRemote(path)) {
    console.error(
      chalk.dim(
        '  (no remote is configured for this worktree, so every commit no other local branch reaches counts as unpushed)',
      ),
    );
  }
  for (const line of dirtyLines.slice(0, 10)) console.error(chalk.dim(`      ${line}`));
  if (dirtyLines.length) console.error(chalk.dim(`  (git -C ${path} status -s for the full list)`));
  for (const line of removalRemedy(dirtyLines, { worktree: path })) console.error(chalk.dim(line));
  console.error(chalk.dim('Otherwise: commit or push the branch (only commits found nowhere else are counted,'));
  console.error(chalk.dim("so pushing publishes nothing but this worktree's own work). --force is a last"));
  console.error(chalk.dim('resort -- it discards uncommitted changes and untracked files permanently; committed'));
  console.error(chalk.dim('work stays on the branch.'));
  process.exitCode = 1;
}

function restorePodChurn(path: string, files: string[]): void {
  for (const file of files) {
    if (restoreFile(path, file)) {
      console.error(chalk.dim(`  restored ${file} (pod install churn; the worktree is being removed)`));
    } else {
      console.error(chalk.yellow(`  could not restore ${file}; git may refuse to remove the worktree`));
    }
  }
}

function printRemovalCleanup(result: ReclaimAllResult, failed: boolean): void {
  const print = failed ? console.error : console.log;
  if (!failed) {
    for (const dir of result.removedWorkspaceDirs) print(chalk.dim(`  removed workspace output ${dir}`));
  }
  if (result.dereferenced.length) print(chalk.dim(`  no longer referenced: ${result.dereferenced.join(', ')}`));
  for (const pid of result.killedPids) print(chalk.dim(`  killed Metro pid ${pid}`));
  if (result.deletedDevices.length) print(chalk.dim(`  deleted device(s): ${result.deletedDevices.join(', ')}`));
  if (result.stoppedSessions.length)
    print(chalk.dim(`  stopped remote session(s): ${result.stoppedSessions.join(', ')}`));
  if (result.stoppedTunnels.length) print(chalk.dim(`  stopped tunnel(s): ${result.stoppedTunnels.join(', ')}`));
  for (const skipped of result.skippedDevices) {
    print((failed ? chalk.dim : chalk.yellow)(`  kept ${describeKeptDevice(skipped)}: ${skipped.reason}`));
  }
  for (const kept of result.keptEntries) {
    print(
      (failed ? chalk.dim : chalk.yellow)(
        `  rn-iso still tracks ${kept} because environment cleanup failed; re-run \`rn-iso gc --delete\` once the cause is fixed.`,
      ),
    );
  }
}

async function runRemove(target: string | undefined, opts: RemoveOptions = {}): Promise<void> {
  let path = removalPath(target);
  if (!existsSync(path)) {
    console.error(chalk.red(`No such worktree: ${path}`));
    process.exitCode = 1;
    return;
  }

  const entry = matchWorktreeEntry(listWorktrees(path), path);
  if (!entry) {
    if (gitCommonDir(path) === null && hasRegisteredProjectUnder(path)) {
      await reclaimEnvironment(path, 'it is not a git repository');
      return;
    }
    console.error(chalk.red(`Refusing to remove ${path}: it is not inside any worktree known to git.`));
    console.error(
      chalk.dim(
        '  Run it from inside the worktree, or pass the worktree root path, e.g. as printed by `git worktree list`.',
      ),
    );
    process.exitCode = 1;
    return;
  }
  if (isMainWorkingTree(entry.path)) {
    if (entry.path !== path) {
      console.error(chalk.dim(`${path} is inside the main checkout ${entry.path}; reclaiming its environment.`));
    }
    await reclaimEnvironment(entry.path, 'it is the main checkout');
    return;
  }
  if (entry.path !== path) {
    console.error(chalk.dim(`${path} is inside the worktree ${entry.path}; removing that.`));
    path = entry.path;
  }

  const inspection = inspectRemoval(path);
  if (inspection.blockers.length && !opts.force) {
    printRemovalRefusal(path, inspection);
    return;
  }

  await withManagedRemoteWorktreeRemovalLock(path, () =>
    withReclaimLocks(path, async (lockedKeys) => {
      const result = await reclaimAll(path, lockedKeys);
      if (result.keptEntries.length) {
        reportRetainedResources(path, result);
        return;
      }
      restorePodChurn(path, inspection.podChurn);
      try {
        removeWorktree(path, { force: opts.force });
      } catch (error) {
        console.error(chalk.red(`git worktree remove failed: ${String((error as Error)?.message || error)}`));
        console.error(
          chalk.dim(`The directory at ${path} was not removed; rn-iso's own tracking for it was already cleared.`),
        );
        printRemovalCleanup(result, true);
        process.exitCode = 1;
        return;
      }
      console.log(chalk.green(`Removed worktree ${path}`));
      printRemovalCleanup(result, false);
    }),
  );
}

export function registerRemove(worktree: Command): void {
  worktree
    .command('remove [target]')
    .description(
      'Remove a worktree and reclaim its build artifacts, owned devices, and Metro port. Defaults to the current workspace. On the main checkout it reclaims the environment only and leaves the tree in place.',
    )
    .option('--force', 'remove even when the worktree holds uncommitted or unpushed work')
    .action(runRemove);
}

export default function worktreeCommand(program: Command): void {
  const worktree = program.command('worktree').description('Create and remove isolated worktrees');
  registerCreate(worktree);
  registerRemove(worktree);
}
