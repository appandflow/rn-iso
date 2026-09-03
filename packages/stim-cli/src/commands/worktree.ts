import { existsSync, readdirSync, realpathSync } from 'fs';
import { basename, dirname, resolve } from 'path';
import chalk from 'chalk';
import { type Command, InvalidArgumentError } from 'commander';
import { phaseLine, plural, releasedLeaseFact, shortUdid } from '../command-output.ts';
import { resolveSettings, SETTING_SHAPE_REMEDY, settingShapeErrors, unknownSettingKeys } from '../settings.ts';
import { getProject, isPathPrefix, loadConfig, removeProject, upsertProject } from '../config.ts';
import type { ReleasedLease } from '../engine/device-lease.ts';
import { podInstallCommand } from '../engine/bundler.ts';
import { reclaimProject } from '../reclaim.ts';
import { parkedMaxSetting, POOL_SETTING_REMEDY } from '../sim-pool.ts';
import type { ParkedDevice } from '../teardown.ts';
import { withManagedRemoteWorktreeRemovalLock, withManagedTunnelRemovalLock } from '../engine/tunnel.ts';
import { readMetroTunnel, readRemoteSession } from '../supervisor/state.ts';
import {
  addWorktree,
  branchExists,
  carryOverFiles,
  carryUncommittedChanges,
  depsOutOfSync,
  deleteBranch,
  cloneIgnoredEntries,
  defaultWorktreeDir,
  dirtyPaths,
  gitCommonDir,
  hasRemote,
  hasUncommittedWork,
  isMainWorkingTree,
  isPodInstallChurn,
  listCarryableIgnoredEntries,
  listTrackedPaths,
  listWorktrees,
  podsOutOfSync,
  readWorktreeExclude,
  readWorktreeInclude,
  removeWorktree,
  repoRoot,
  resolveBaseRef,
  resolveFullRef,
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

export interface WarmCarryCategories {
  dependencies: boolean;
  pods: boolean;
  nativeOutput: boolean;
}

export function warmCarryCategories(entries: string[], root?: string): WarmCarryCategories {
  const categories = {
    dependencies: root ? false : entries.some((rel) => rel === 'node_modules' || rel.endsWith('/node_modules')),
    pods: entries.some((rel) => rel === 'Pods' || rel.endsWith('/Pods')),
    nativeOutput: entries.some(
      (rel) =>
        /(?:^|\/)ios\/build(?:\/|$)/.test(rel) || /(?:^|\/)android\/(?:.*\/)?(?:build|\.gradle)(?:\/|$)/.test(rel),
    ),
  };
  if (!root || (categories.dependencies && categories.pods && categories.nativeOutput)) return categories;

  const inspect = (rel: string): void => {
    if (categories.dependencies && categories.pods && categories.nativeOutput) return;
    if (rel === 'node_modules' || rel.endsWith('/node_modules')) {
      if (existsSync(resolve(root, dirname(rel), 'package.json'))) categories.dependencies = true;
      return;
    }
    if (rel === 'Pods' || rel.endsWith('/Pods')) {
      categories.pods = true;
      return;
    }
    if (/(?:^|\/)ios\/build(?:\/|$)/.test(rel) || /(?:^|\/)android\/(?:.*\/)?(?:build|\.gradle)(?:\/|$)/.test(rel)) {
      categories.nativeOutput = true;
      return;
    }
    try {
      for (const entry of readdirSync(resolve(root, rel), { withFileTypes: true })) {
        if (entry.isDirectory()) inspect(rel ? `${rel}/${entry.name}` : entry.name);
      }
    } catch {
      // A copied entry can disappear while the summary is generated.
    }
  };
  for (const rel of entries) inspect(rel);
  return categories;
}

function warmCategoryNames(categories: WarmCarryCategories): string[] {
  const names: string[] = [];
  if (categories.dependencies) names.push('dependencies');
  if (categories.pods) names.push('CocoaPods');
  if (categories.nativeOutput) names.push('native build output');
  return names;
}

export function warmCarrySummary(entries: string[], root: string | undefined, cloned: boolean): string {
  const categories = warmCarryCategories(entries, root);
  const carried: string[] = [];
  const absent: string[] = [];
  for (const [name, present] of [
    ['node_modules', categories.dependencies],
    ['Pods', categories.pods],
    ['native build output', categories.nativeOutput],
  ] as const) {
    (present ? carried : absent).push(name);
  }
  const mode = cloned ? 'APFS clone' : 'byte copy';
  const parts = carried.length ? [`${carried.join(', ')} (${mode})`] : [];
  return [...parts, ...absent.map((name) => `no ${name}`)].join('; ');
}

export function dependencyInstallCommand(target: string, dir = '.'): string {
  const installRoot = resolve(target, dir);
  let command = 'npm install';
  if (existsSync(resolve(installRoot, 'pnpm-lock.yaml'))) command = 'pnpm install';
  else if (existsSync(resolve(installRoot, 'yarn.lock'))) command = 'yarn install';
  else if (existsSync(resolve(installRoot, 'bun.lock')) || existsSync(resolve(installRoot, 'bun.lockb')))
    command = 'bun install';
  else if (existsSync(resolve(installRoot, 'package-lock.json'))) command = 'npm ci';
  return `cd '${installRoot.replaceAll("'", "'\\''")}' && ${command}`;
}

function dependencyInstallCommands(target: string): string[] {
  const lockfiles = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']);
  const dirs = new Set(
    (listTrackedPaths(target) || [])
      .filter((path) => lockfiles.has(path.split('/').at(-1) || ''))
      .map((path) => path.split('/').slice(0, -1).join('/') || '.'),
  );
  if (!dirs.size) dirs.add('.');
  return [...dirs].map((dir) => dependencyInstallCommand(target, dir));
}

const BRANCH_EXISTS_CODE = 'STIM_WORKTREE_BRANCH_EXISTS';

const GIT_BRANCH_ALREADY_EXISTS = /a branch named .* already exists/i;

function gitFailureText(error: unknown): string {
  return `${(error as Error)?.message || String(error)}\n${String((error as { stderr?: unknown })?.stderr ?? '')}`;
}

function rollBackCreatedBranch({
  root,
  branch,
  baseRef,
  baseSha,
  error,
}: {
  root: string;
  branch: string;
  baseRef: string;
  baseSha: string | null;
  error: unknown;
}): void {
  const keep = (reason: string) => {
    console.error(chalk.yellow(`Kept the branch ${branch}: ${reason}`));
    console.error(chalk.dim(`  Delete it before retrying: git -C ${root} branch -D -- ${branch}`));
  };
  if (GIT_BRANCH_ALREADY_EXISTS.test(gitFailureText(error))) {
    keep('git refused to create it because it already existed, so this create did not make it');
    return;
  }
  const stranded = resolveFullRef(root, `refs/heads/${branch}`);
  if (!stranded) return;
  if (!baseSha || stranded !== baseSha) {
    keep(`it points at ${stranded}, not at the ${baseRef} this create asked for, so Stim cannot prove it made it`);
    return;
  }
  const checkedOutAt = listWorktrees(root).find((candidate) => candidate.branch === branch)?.path;
  if (checkedOutAt) {
    keep(`it is checked out at ${checkedOutAt}`);
    return;
  }
  try {
    deleteBranch(root, branch, stranded);
    console.error(chalk.dim(`Deleted ${branch}, which git created before the failure, so a retry starts clean.`));
  } catch (deleteError) {
    keep(String((deleteError as Error)?.message || deleteError));
  }
}

export function registerCreate(worktree: Command): void {
  worktree
    .command('create <name>')
    .description('Create a git worktree with its environment set up. Prints the worktree path on stdout.')
    .option(
      '--base <ref>',
      'base ref: "head" (current HEAD, default), "fresh" (origin/HEAD), or any ref this repo resolves (branch, tag, sha)',
    )
    .option(
      '--dir <path>',
      'directory to create the worktree under, resolved against the current directory; overrides the worktreeDir setting for this run',
      (v: string) => {
        if (!v.trim()) throw new InvalidArgumentError('must name a directory, e.g. --dir .worktrees');
        return v;
      },
    )
    .option('--label <label>', 'Stim shortcut for the worktree (defaults to the worktree name)')
    .option(
      '--carry-ignored',
      "clone the source's working state: every safe gitignored path (node_modules, Pods, build output) except nested Git worktrees and paths in .worktreeexclude, plus its uncommitted tracked changes (applied when they fit this base)",
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
      const shapeErrors = settingShapeErrors(settings);
      if (shapeErrors.length) {
        for (const message of shapeErrors) console.error(chalk.red(message));
        console.error(chalk.dim(SETTING_SHAPE_REMEDY));
        process.exitCode = 1;
        return;
      }
      for (const key of unknownSettingKeys(settings)) {
        console.error(chalk.yellow(`Warning: setting "${key}" is not read by Stim and will be ignored.`));
      }

      const base = opts.base || settings?.worktree?.baseRef || 'head';

      const dir = canonicalExistingPath(
        opts.dir || (settings.worktreeDir ? resolve(root, settings.worktreeDir) : defaultWorktreeDir(root)),
      );
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
      const branchSha = reusedBranch ? resolveRef(root, `refs/heads/${branch}`) : null;

      if (opts.base && reusedBranch) {
        const diverged = branchSha !== baseSha;
        console.error(
          chalk.red(
            `${BRANCH_EXISTS_CODE}: Refusing to create ${name}: the branch ${branch} already exists at ${branchSha || 'an unresolvable commit'}, ` +
              (diverged
                ? `but --base ${base} resolves to ${baseSha}.`
                : `which is where --base ${base} resolves right now.`),
          ),
        );
        console.error(
          chalk.dim(
            diverged
              ? '  `git worktree add` attaches to an existing branch and ignores the base, so this worktree would NOT be based on what you asked for.'
              : '  `git worktree add` attaches to an existing branch and ignores the base, so the two agreeing here is a coincidence, not the guarantee --base exists to give.',
          ),
        );
        console.error(chalk.dim('  Either create it under a different name:'));
        console.error(chalk.dim(`    stim worktree create <other-name> --base ${base}`));
        console.error(
          chalk.dim(
            '  or delete the existing branch (Stim keeps branches it did not create and branches with unique commits) and retry:',
          ),
        );
        console.error(chalk.dim(`    git -C ${root} branch -D ${branch}`));
        process.exitCode = 1;
        return;
      }

      const createBranch = !reusedBranch;
      const baseFullSha = createBranch ? resolveFullRef(root, baseRef) : null;
      try {
        addWorktree({ path: target, branch, baseRef, createBranch });
      } catch (e) {
        console.error(String((e as Error)?.message || e));
        if (createBranch) rollBackCreatedBranch({ root, branch, baseRef, baseSha: baseFullSha, error: e });
        process.exitCode = 1;
        return;
      }

      console.error(
        chalk.dim(
          phaseLine(
            'branch',
            reusedBranch
              ? `attached to the existing ${branch}${branchSha ? ` (${branchSha})` : ''}; its tip is the base, ${baseRef} was not applied`
              : `${branch} from ${baseRef} (${baseSha})`,
          ),
        ),
      );
      if (!reusedBranch && base === 'fresh') {
        console.error(
          chalk.dim(
            phaseLine(
              '',
              `${baseRef} is a local ref, current as of the last \`git fetch\`. If you need the very latest, ` +
                `run \`git -C ${root} fetch\` first.`,
            ),
          ),
        );
      }

      const included = readWorktreeInclude(root);
      const patterns = included && included.length ? included : settings?.worktree?.include || [];
      const { copied, failed } = carryOverFiles({ root, target, patterns });
      if (copied.length) console.error(chalk.dim(phaseLine('carry', plural(copied.length, 'configured file'))));
      for (const f of failed) {
        console.error(chalk.yellow(phaseLine('carry', `could not carry ${f.file}: ${f.error}`)));
      }

      let carriedDeps = false;
      let warmSource: string[] = [];
      if (opts.carryIgnored) {
        const excluded = readWorktreeExclude(root);
        const skip = excluded && excluded.length ? excluded : settings?.worktree?.exclude || [];
        const res = cloneIgnoredEntries({ root, target, patterns: skip });
        carriedDeps = warmCarryCategories(res.copied, target).dependencies;
        if (res.copied.length) {
          console.error(chalk.dim(phaseLine('carry', warmCarrySummary(res.copied, target, res.cloned))));
        }
        for (const f of res.failed) {
          console.error(chalk.yellow(phaseLine('carry', `could not clone ${f.file}: ${f.error}`)));
        }
        const changes = carryUncommittedChanges({ root, target });
        if (changes?.applied) {
          console.error(chalk.dim(phaseLine('carry', carriedChangesLine(changes.files))));
        } else if (changes?.conflicted) {
          console.error(chalk.yellow(phaseLine('carry', carryConflictWarning(changes.files))));
        }
        const staleDeps = depsOutOfSync(root, target, res.copied);
        if (staleDeps.length) {
          const manifests = staleDeps.map((d) => (d.dir === '.' ? d.lockfile : `${d.dir}/${d.lockfile}`)).join(', ');
          const remedies = [
            ...new Set(staleDeps.map((dependency) => dependencyInstallCommand(target, dependency.dir))),
          ];
          console.error(
            chalk.yellow(
              phaseLine(
                'carry',
                `carried dependencies may be stale: they do not match ${manifests}. Run ${remedies.map((command) => `\`${command}\``).join(' and ')} before building.`,
              ),
            ),
          );
        }
        for (const p of podsOutOfSync(target, res.copied)) {
          const where = p.dir === '.' ? 'Podfile.lock' : `${p.dir}/Podfile.lock`;
          const pod = podInstallCommand(p.dir === '.' ? target : resolve(target, p.dir, '..'));
          console.error(
            chalk.yellow(
              phaseLine(
                'carry',
                p.reason === 'missing'
                  ? `carried ${p.dir === '.' ? 'Pods' : `${p.dir}/Pods`} but there is no ${where}. Run \`${pod}\` before building.`
                  : `carried ${p.dir === '.' ? 'Pods' : `${p.dir}/Pods`} does not match the ${where} on disk here. Pods are gitignored and cloned; Podfile.lock is tracked, so the two can disagree. Run \`${pod}\` before building, or xcodebuild fails with "sandbox is not in sync" only after every pod has compiled.`,
              ),
            ),
          );
        }
      } else {
        const excluded = readWorktreeExclude(root);
        const skip = excluded && excluded.length ? excluded : settings?.worktree?.exclude || [];
        warmSource = warmCategoryNames(warmCarryCategories(listCarryableIgnoredEntries(root, skip), root));
      }

      const mainRoot = listWorktrees(root).find((candidate) => isMainWorkingTree(candidate.path))?.path || root;
      upsertProject(target, {
        label: opts.label || name,
        worktreeRoot: true,
        worktreeBranch: branch,
        worktreeBranchOwned: !reusedBranch,
        worktreeMainRoot: mainRoot,
      });

      if (!carriedDeps) {
        const remedies = dependencyInstallCommands(target);
        console.error(
          chalk.yellow(
            phaseLine(
              'carry',
              `no dependencies carried. Run ${remedies.map((command) => `\`${command}\``).join(' and ')} before building.`,
            ),
          ),
        );
      }
      if (warmSource.length) {
        console.error(
          chalk.yellow(
            phaseLine(
              'carry',
              `warm source not carried: ${warmSource.join(', ')}. For the next worktree, use: stim worktree create <name> --carry-ignored`,
            ),
          ),
        );
      }
      console.error(chalk.dim(phaseLine('ready', target)));

      console.log(target);
    });
}

function carriedFileList(files: string[]): string {
  const shown = files.slice(0, 3).join(', ');
  return files.length > 3 ? `${shown}, +${files.length - 3}` : shown;
}

export function carriedChangesLine(files: string[]): string {
  return `carried ${plural(files.length, 'uncommitted change')} from the source (${carriedFileList(files)}) -- uncommitted here too; commit deliberately`;
}

export function carryConflictWarning(files: string[]): string {
  return (
    `could not carry the source's uncommitted changes (${carriedFileList(files)}): this worktree's base diverges from the source HEAD, so the patch does not apply and nothing was changed here. ` +
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

interface MatchedWorktreeEntry extends WorktreeEntry {
  index: number;
}

export function matchWorktreeEntry(
  entries: WorktreeEntry[] | null | undefined,
  path: string,
): MatchedWorktreeEntry | null {
  let best: MatchedWorktreeEntry | null = null;
  (entries || []).forEach((entry, index) => {
    if (!entry?.path || !isPathPrefix(entry.path, path)) return;
    if (!best || entry.path.length > best.path.length) best = { ...entry, index };
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
    blockers.push(`${plural(unpushed.length, 'commit')} not on any remote or any other local branch`);
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
  parkedDevices: ParkedDevice[];
  evictedDevices: ParkedDevice[];
  poolNotes: string[];
  parkedMax: number;
  skippedDevices: SkippedDevice[];
  keptEntries: string[];
  retainedResources: RetainedResource[];
  reclaimedKeys: string[];
  stoppedSessions: string[];
  stoppedTunnels: string[];
  releasedLeases: ReleasedLease[];
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
  { preserveRootProject = false }: { preserveRootProject?: boolean } = {},
): Promise<ReclaimAllResult> {
  const dereferenced: string[] = [];
  const killedPids: number[] = [];
  const deletedDevices: string[] = [];
  const parkedDevices: ParkedDevice[] = [];
  const evictedDevices: ParkedDevice[] = [];
  const poolNotes: string[] = [];
  const skippedDevices: SkippedDevice[] = [];
  const keptEntries: string[] = [];
  const retainedResources: RetainedResource[] = [];
  const stoppedSessions: string[] = [];
  const stoppedTunnels: string[] = [];
  const releasedLeases: ReleasedLease[] = [];
  const removedWorkspaceDirs: string[] = [];
  const failedWorkspaceDirs: string[] = [];
  for (const key of keys) {
    const r = await reclaimProject(key, {
      deleteOwnedDevices: true,
      parkOwnedDevices: true,
      preserveProjectRecord: preserveRootProject && key === rootPath,
    });
    dereferenced.push(...r.dereferenced);
    if (r.killedPid) killedPids.push(r.killedPid);
    deletedDevices.push(...r.deletedDevices);
    parkedDevices.push(...r.parkedDevices);
    evictedDevices.push(...r.evictedDevices);
    poolNotes.push(...r.poolNotes);
    skippedDevices.push(...r.skippedDevices);
    if (r.stoppedSession) stoppedSessions.push(r.stoppedSession);
    if (r.stoppedTunnel) stoppedTunnels.push(r.stoppedTunnel);
    releasedLeases.push(...r.releasedLeases);
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
    parkedDevices,
    evictedDevices,
    poolNotes,
    parkedMax: parkedMaxSetting('ios').max,
    skippedDevices,
    keptEntries,
    retainedResources,
    reclaimedKeys: [...keys],
    stoppedSessions,
    stoppedTunnels,
    releasedLeases,
    removedWorkspaceDirs,
    failedWorkspaceDirs,
  };
}

function poolLines(result: ReclaimAllResult): string[] {
  const lines: string[] = [];
  for (const device of result.parkedDevices) {
    lines.push(chalk.dim(phaseLine('device', `parked ${device.name} (${shortUdid(device.udid)})`)));
  }
  for (const device of result.evictedDevices) {
    lines.push(chalk.dim(phaseLine('device', `deleted ${device.name} (pool over ${result.parkedMax})`)));
  }
  for (const note of result.poolNotes) lines.push(chalk.yellow(phaseLine('device', note)));
  return lines;
}

function reportRetainedResources(root: string, result: ReclaimAllResult): void {
  console.error(chalk.red(`Refusing to remove ${root}: Stim could not release owned resources.`));
  for (const resource of result.retainedResources) {
    console.error(chalk.yellow(`  - Stim still tracks ${describeKeptDevice(resource)} for ${resource.project}`));
    console.error(chalk.dim(`    ${resource.reason}`));
  }
  for (const kept of result.keptEntries) {
    if (result.retainedResources.some((resource) => resource.project === kept)) continue;
    console.error(chalk.yellow(`  - retained Stim ownership state for ${kept}`));
  }
  console.error(chalk.dim('Fix the reported cause, then run `stim worktree remove` again.'));
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
      for (const line of poolLines(result)) console.error(line);
      for (const device of result.deletedDevices) {
        console.error(chalk.dim(phaseLine('device', `deleted ${device}`)));
      }
      for (const session of result.stoppedSessions) {
        console.error(chalk.dim(phaseLine('device', `stopped remote session ${session}`)));
      }
      for (const tunnel of result.stoppedTunnels) {
        console.error(chalk.dim(phaseLine('lan', `stopped the ${tunnel} tunnel`)));
      }
      for (const lease of result.releasedLeases) {
        console.error(chalk.dim(phaseLine('lease', releasedLeaseFact(lease))));
      }
      for (const pid of result.killedPids) console.error(chalk.dim(phaseLine('metro', `killed pid ${pid}`)));
      for (const dir of result.removedWorkspaceDirs) {
        console.error(chalk.dim(phaseLine('workspace', `removed ${dir}`)));
      }
      for (const dir of result.failedWorkspaceDirs) {
        console.error(chalk.yellow(phaseLine('workspace', `could not remove ${dir}`)));
      }
      if (result.dereferenced.length) {
        console.error(chalk.dim(phaseLine('workspace', `no longer referenced: ${result.dereferenced.join(', ')}`)));
      }
      if (result.keptEntries.length) {
        reportRetainedResources(root, result);
        return;
      }
      for (const s of result.skippedDevices) {
        console.error(chalk.yellow(phaseLine('device', `kept ${describeKeptDevice(s)} (${s.reason})`)));
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

export function removalPath(target: string | undefined): string {
  return canonicalExistingPath(target ?? process.cwd());
}

// The registry keys a worktree by the path git reports, which is the real
// path. Canonicalize from the deepest ancestor that exists so a symlinked or
// not-yet-created directory yields the same key git will.
function canonicalExistingPath(target: string): string {
  const resolved = resolve(target);
  let existing = resolved;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return resolved;
    missing.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...missing);
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
  for (const line of poolLines(result)) console.error(line);
  for (const device of result.deletedDevices) {
    console.error(chalk.dim(phaseLine('device', `deleted ${device}`)));
  }
  for (const session of result.stoppedSessions) {
    console.error(chalk.dim(phaseLine('device', `stopped remote session ${session}`)));
  }
  for (const tunnel of result.stoppedTunnels) {
    console.error(chalk.dim(phaseLine('lan', `stopped the ${tunnel} tunnel`)));
  }
  for (const lease of result.releasedLeases) {
    console.error(chalk.dim(phaseLine('lease', releasedLeaseFact(lease))));
  }
  for (const pid of result.killedPids) console.error(chalk.dim(phaseLine('metro', `killed pid ${pid}`)));
  if (!failed) {
    for (const dir of result.removedWorkspaceDirs) console.error(chalk.dim(phaseLine('workspace', `removed ${dir}`)));
  }
  if (result.dereferenced.length) {
    console.error(chalk.dim(phaseLine('workspace', `no longer referenced: ${result.dereferenced.join(', ')}`)));
  }
  for (const skipped of result.skippedDevices) {
    console.error(
      (failed ? chalk.dim : chalk.yellow)(
        phaseLine('device', `kept ${describeKeptDevice(skipped)} (${skipped.reason})`),
      ),
    );
  }
}

async function runRemove(target: string | undefined, opts: RemoveOptions = {}): Promise<void> {
  const poolError = parkedMaxSetting('ios').error;
  if (poolError) {
    console.error(chalk.red(poolError));
    console.error(chalk.dim(POOL_SETTING_REMEDY));
    process.exitCode = 1;
    return;
  }
  let path = removalPath(target);
  if (!existsSync(path)) {
    const pending = getProject(path);
    if (
      pending?.worktreeRemovalComplete === true &&
      pending.worktreeBranchOwned === true &&
      pending.worktreeBranch &&
      pending.worktreeMainRoot &&
      pending.worktreePendingBranchSha
    ) {
      const branch = pending.worktreeBranch;
      const mainRoot = pending.worktreeMainRoot;
      if (!existsSync(mainRoot)) {
        console.error(chalk.red(`Cannot finish branch cleanup for ${path}: main worktree ${mainRoot} is missing.`));
        console.error(chalk.dim(`Delete ${branch} from the repository, then run \`stim gc --delete\`.`));
        process.exitCode = 1;
        return;
      }
      if (!branchExists(mainRoot, branch)) {
        removeProject(path);
        console.error(
          chalk.dim(phaseLine('branch', `${branch} is already absent; cleared its pending cleanup record`)),
        );
        return;
      }
      const checkedOutAt = listWorktrees(mainRoot).find(
        (candidate) => candidate.branch === branch && resolve(candidate.path) !== resolve(path),
      )?.path;
      if (checkedOutAt) {
        console.error(chalk.red(`Refusing pending cleanup for ${branch}: it is checked out at ${checkedOutAt}.`));
        console.error(chalk.dim('Switch that worktree to another branch, then retry this command.'));
        process.exitCode = 1;
        return;
      }
      const currentSha = resolveFullRef(mainRoot, branch);
      if (currentSha !== pending.worktreePendingBranchSha) {
        console.error(
          chalk.red(
            `Refusing pending cleanup for ${branch}: its tip changed from ${pending.worktreePendingBranchSha} to ${currentSha || 'an unknown commit'}.`,
          ),
        );
        console.error(chalk.dim('The branch can contain new work. Inspect it and delete it manually if appropriate.'));
        process.exitCode = 1;
        return;
      }
      try {
        deleteBranch(mainRoot, branch, pending.worktreePendingBranchSha);
        removeProject(path);
        console.error(chalk.dim(phaseLine('branch', `deleted ${branch}; cleared its pending cleanup record`)));
      } catch (error) {
        console.error(chalk.red(`Could not delete branch ${branch}: ${String((error as Error)?.message || error)}`));
        console.error(chalk.dim(`Retry with: stim worktree remove ${path}`));
        process.exitCode = 1;
      }
      return;
    }
    console.error(chalk.red(`No such worktree: ${path}`));
    process.exitCode = 1;
    return;
  }

  const worktrees = listWorktrees(path);
  const entry = matchWorktreeEntry(worktrees, path);
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

  const project = getProject(path);
  const branch = entry.branch;
  const ownsBranch = Boolean(branch && project?.worktreeBranchOwned === true && project.worktreeBranch === branch);
  const approvedBranchSha = ownsBranch ? resolveFullRef(path, 'HEAD') : null;
  const inspection = inspectRemoval(path);
  if (inspection.blockers.length && !opts.force) {
    printRemovalRefusal(path, inspection);
    return;
  }

  const deleteOwnedBranch = Boolean(ownsBranch && approvedBranchSha && inspection.unpushed?.length === 0);
  const retainedBranchReason = !branch
    ? null
    : !ownsBranch
      ? 'Stim did not create it'
      : inspection.unpushed === null
        ? 'Stim could not verify whether it has unique commits'
        : inspection.unpushed.length > 0
          ? `it has ${plural(inspection.unpushed.length, 'unique commit')}`
          : null;
  const branchDeleteCwd = worktrees.find((candidate) => isMainWorkingTree(candidate.path))?.path;

  await withManagedRemoteWorktreeRemovalLock(path, () =>
    withReclaimLocks(path, async (lockedKeys) => {
      const result = await reclaimAll(path, lockedKeys, { preserveRootProject: true });
      if (result.keptEntries.length) {
        reportRetainedResources(path, result);
        return;
      }
      restorePodChurn(path, inspection.podChurn);
      try {
        removeWorktree(path, { force: opts.force });
      } catch (error) {
        console.error(chalk.red(`git worktree remove failed: ${String((error as Error)?.message || error)}`));
        console.error(chalk.dim(`The directory and Stim ownership record for ${path} were kept.`));
        printRemovalCleanup(result, true);
        process.exitCode = 1;
        return;
      }
      const finish = (): void => {
        printRemovalCleanup(result, false);
        console.error(chalk.dim(phaseLine('removed', path)));
      };
      if (deleteOwnedBranch && branch) {
        if (!approvedBranchSha) {
          console.error(
            chalk.yellow(phaseLine('branch', `kept ${branch} (Stim could not record its commit before removal)`)),
          );
          process.exitCode = 1;
          finish();
          return;
        }
        upsertProject(path, { worktreeRemovalComplete: true, worktreePendingBranchSha: approvedBranchSha });
        if (!branchDeleteCwd) {
          console.error(chalk.yellow(phaseLine('branch', `kept ${branch} (Stim could not find the main worktree)`)));
          console.error(chalk.dim(`  Retry with: stim worktree remove ${path}`));
          process.exitCode = 1;
          finish();
          return;
        }
        const checkedOutAt = listWorktrees(branchDeleteCwd).find(
          (candidate) => candidate.branch === branch && resolve(candidate.path) !== resolve(path),
        )?.path;
        if (checkedOutAt) {
          console.error(chalk.yellow(phaseLine('branch', `kept ${branch} (it is checked out at ${checkedOutAt})`)));
          console.error(
            chalk.dim(`  Switch that worktree to another branch, then retry: stim worktree remove ${path}`),
          );
          process.exitCode = 1;
          finish();
          return;
        }
        try {
          deleteBranch(branchDeleteCwd, branch, approvedBranchSha);
          console.error(chalk.dim(phaseLine('branch', `deleted ${branch}`)));
        } catch (error) {
          console.error(
            chalk.yellow(phaseLine('branch', `kept ${branch} (${String((error as Error)?.message || error)})`)),
          );
          console.error(chalk.dim(`  Retry with: git -C ${branchDeleteCwd} branch -D -- ${branch}`));
          process.exitCode = 1;
          finish();
          return;
        }
      } else if (branch && retainedBranchReason) {
        console.error(chalk.dim(phaseLine('branch', `kept ${branch} (${retainedBranchReason})`)));
      }
      removeProject(path);
      finish();
    }),
  );
}

export function registerRemove(worktree: Command): void {
  worktree
    .command('remove [target]')
    .description(
      'Remove a worktree, its unused Stim-created branch, build artifacts, owned devices, and Metro port. Defaults to the current workspace. On the main checkout it reclaims the environment only and leaves the tree in place.',
    )
    .option('--force', 'remove even when the worktree holds uncommitted or unpushed work')
    .action(runRemove);
}

export default function worktreeCommand(program: Command): void {
  const worktree = program.command('worktree').description('Create and remove isolated worktrees');
  registerCreate(worktree);
  registerRemove(worktree);
}
