import { existsSync, readFileSync, realpathSync, rmSync } from 'fs';
import { isAbsolute, relative, resolve } from 'path';
import chalk from 'chalk';
import type { Command } from 'commander';
import { resolveSettings, unknownSettingKeys } from '../settings.ts';
import { isPathPrefix, loadConfig, upsertProject } from '../config.ts';
import { workspaceDir } from '../paths.ts';
import { reclaimProject } from '../reclaim.ts';
import { listsWorkspaceDir, renderWorkspaceIgnoreBlock } from '../engine/workspace.ts';
import {
  addWorktree,
  branchExists,
  carryOverFiles,
  depsOutOfSync,
  cloneIgnoredEntries,
  defaultWorktreeDir,
  dirtyPaths,
  gitCommonDir,
  hasRemote,
  hasUncommittedWork,
  isMainWorkingTree,
  isPodInstallChurn,
  isWorkspaceArtifact,
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
  unstagedDiff,
  worktreePath,
} from '../worktree.ts';
import type { WorktreeEntry } from '../worktree.ts';

// The subset of resolveSettings' layered object this command reads.
// settings.ts returns Record<string, unknown> by design (it merges
// arbitrary project/repo/committed layers); this local shape names only
// the keys worktree create/remove actually read (see KNOWN_SETTINGS in
// settings.ts for the full set rn-iso recognizes).
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
      'clone every gitignored path (node_modules, Pods, build output) except those in .worktreeexclude',
    )
    .action(async (name, opts) => {
      // `name` comes from a hook (session text), not a hand-typed argument,
      // and flows unescaped into a shell command (`-b "worktree-${name}"`)
      // and into a filesystem join. Reject anything outside a safe charset
      // before creating anything.
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
      // stdout carries ONLY the worktree path, so this goes to stderr.
      for (const key of unknownSettingKeys(settings)) {
        console.error(chalk.yellow(`Warning: setting "${key}" is not read by rn-iso and will be ignored.`));
      }

      // `--base` reaches here as a raw string -- commander does not validate
      // `.option()` values against an enum -- and it is checked below rather
      // than against a two-name enum. It used to accept ONLY the two sentinels,
      // which was the wrong shape of guard: the plumbing has always passed the
      // resolved ref straight to `git worktree add`, so branching from a tag, a
      // release branch or a sha needed nothing but permission, and refusing
      // them bought nothing. What the enum was really catching -- a typo like
      // `--base=orign/HEAD` resolving silently to 'fresh' -- is caught better by
      // asking git, which rejects the typo AND accepts every ref that is real.
      const base = opts.base || settings?.worktree?.baseRef || 'fresh';

      const dir = settings.worktreeDir || defaultWorktreeDir(root);
      const target = worktreePath({ worktreeDir: dir, name });

      // Idempotent: a hook retry must not fail.
      if (existsSync(target)) {
        console.error(chalk.dim(`Worktree already exists at ${target}`));
        console.log(target);
        return;
      }

      // The sentinels are translated; anything else is a ref and goes to git as
      // written. Resolving it here both validates it and yields the sha the
      // command reports -- and it happens BEFORE `git worktree add`, so an
      // unresolvable ref leaves nothing behind to clean up.
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

      // `git worktree add` attaches to an existing branch rather than cutting a
      // new one when the name is already taken (a create/remove/create cycle
      // leaves the branch behind), and the base ref means nothing on that path.
      // Asked before the add, so the line below reports what happened rather
      // than what was requested.
      const branch = `worktree-${name}`;
      const reusedBranch = branchExists(root, branch);
      const branchSha = reusedBranch ? resolveRef(root, branch) : null;

      // ... and when the caller EXPLICITLY named a base, that attach is a
      // contradiction rather than a detail. `--base <sha>` with a leftover
      // `worktree-<name>` branch produced a worktree at the branch's stale tip,
      // a single dim line to say so, and an exit 0 -- so the flag read as
      // accepted and did nothing, which is the failure mode the whole `--base`
      // validation exists to prevent. Two facts are in conflict here and rn-iso
      // cannot pick one for you, so it refuses and names both ways out. A base
      // that came from settings, or none at all, promises nothing about the tip
      // and keeps the attach behaviour unchanged -- as does a branch that is
      // already AT the requested base, where there is nothing to disagree about.
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

      // Testers could not tell what the worktree had been cut from -- which is
      // the one fact `--base` exists to control. stdout carries only the path
      // (item 7 in CLAUDE.md), so this is stderr like every other status line.
      console.error(
        chalk.dim(
          reusedBranch
            ? `Attached to the existing branch ${branch}${branchSha ? ` (${branchSha})` : ''}; --base does not apply.`
            : `Branched ${branch} from ${baseRef} (${baseSha}).`,
        ),
      );
      // `fresh` branches from a REMOTE-TRACKING ref that is only as current
      // as the last `git fetch`. rn-iso does not fetch (that is a network
      // call with its own auth/offline failure modes, not a worktree
      // creation's job), so an agent told to work "on latest main" against a
      // ref last fetched days ago would silently build on stale code. Say so.
      // `head` gets no note: it is the checkout's own HEAD, which no fetch
      // moves -- the advice would be inapplicable there (issue #26).
      if (!reusedBranch && base === 'fresh') {
        console.error(
          chalk.dim(
            `  ${baseRef} is a local ref, current as of the last \`git fetch\`. If you need the very latest, ` +
              `run \`git -C ${root} fetch\` first.`,
          ),
        );
      }

      // Fall back to settings on emptiness, not just on null: a
      // `.worktreeinclude` that exists but is blank/comment-only returns
      // `[]`, which is truthy, and must not shadow the settings fallback.
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
        // A count reads like success. It is not: the clone can only carry what
        // the source worktree has, and a source with no node_modules produces a
        // healthy-looking count and a worktree that cannot build.
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
      console.error(
        chalk.dim(
          carriedIgnored
            ? 'Worktree ready. Cloned dependencies may be stale; reinstall if this branch changes them.'
            : 'Worktree ready. Install dependencies yourself before building.',
        ),
      );

      // The WorktreeCreate hook reads stdout as the directory to use. Nothing
      // else may be written here.
      console.log(target);
    });
}

// PURE. The path a `git status --porcelain` line is about.
//
// The format is two status characters, a space, then the path -- except for a
// rename, which is `old -> new`. The NEW path is the one on disk, so that is
// the one a remedy has to name. Quoting (git quotes paths with non-ASCII or
// control characters) is stripped so the comparison below sees the real path;
// the remedy prints the line as git wrote it.
export function porcelainPath(line: string): string | null {
  const raw = String(line).slice(3).trim();
  if (raw === '') return null;
  const renamed = raw.includes(' -> ') ? raw.slice(raw.lastIndexOf(' -> ') + 4) : raw;
  return renamed.replace(/^"(.*)"$/, '$1');
}

// PURE. Drops the workspace's own `.rn-iso/` from a dirty listing.
//
// Unconditional, and this is the field-tested reason: two real e2e runs
// dead-ended here. A workspace that has ever been started holds `.rn-iso/`, and
// on a repo that does not gitignore it `git status` reports `?? .rn-iso/`, which
// `worktree remove` counted as untracked work and refused over -- with the only
// documented escape being `--force`, a flag that ALSO discards real uncommitted
// changes. There was no non-destructive way out of a refusal caused entirely by
// rn-iso's own output.
//
// It is safe because the directory dies with the worktree by design: it holds
// derived data, logs and a supervisor pidfile, all keyed to a path that is about
// to stop existing. `worktree create --carry-ignored` refuses to carry it for
// the same reason (isWorkspaceArtifact, src/worktree.js), so the two ends of the
// lifecycle agree. `start` now adds the gitignore entry itself, which stops the
// `??` line appearing at all -- this is the guard for every workspace that
// predates that, and for a repo whose .gitignore cannot be written.
export function excludeWorkspaceArtifacts(lines: string[] | null | undefined): string[] {
  return (lines || []).filter((line) => {
    const path = porcelainPath(line);
    return path === null || !isWorkspaceArtifact(path);
  });
}

// PURE. The workspace directories in a dirty listing -- the complement of
// excludeWorkspaceArtifacts, and the reason that filter alone was not the whole
// fix. `git worktree remove` runs its OWN cleanliness check and refuses on
// "modified or untracked files", so a `?? .rn-iso/` that rn-iso has decided to
// ignore still stops git one step later, with `--force` as git's only answer --
// which lands the reader right back in the dead end this was meant to remove.
//
// So the directory is deleted first, from the listing git itself produced. That
// is not destruction: it is rn-iso's own output, inside a worktree the command
// is about to delete wholesale, already reclaimed by the time this runs. Taken
// from the listing rather than from a glob so nothing is removed that git did
// not just name.
export function workspaceArtifactPaths(lines: string[] | null | undefined): string[] {
  const paths: string[] = [];
  for (const line of lines || []) {
    const path = porcelainPath(line);
    if (path && isWorkspaceArtifact(path)) paths.push(path);
  }
  return paths;
}

// PURE. Whether a unified diff adds rn-iso's own gitignore block and NOTHING
// else -- the second dead end of the same shape as `?? .rn-iso/`.
//
// `start` / `ios` / `android` append the block to the repo's .gitignore
// (ensureWorkspaceIgnored, the self-heal that replaced `init`). On a repo whose
// .gitignore is TRACKED that is ` M apps/x/.gitignore`, and `worktree remove`
// refused over it: the loop's own write blocking the loop's own teardown, with
// --force -- which also discards real work -- as the only way out.
//
// The rule is deliberately narrow and fails CLOSED, because .gitignore is a
// file the repo owns and an edit to it can be real work:
//   - not one removed line, ever (a diff that took something away is not ours,
//     whatever it added);
//   - every added line is one of the block's own, or the blank separator;
//   - and the `.rn-iso` entry itself is among them, so a diff that only added
//     the comments is not mistaken for the block.
// The allowed set is derived from renderWorkspaceIgnoreBlock rather than
// retyped, so the check cannot drift from the writer, and membership of the
// entry line goes through listsWorkspaceDir, so `.rn-iso`, `/.rn-iso` and
// `.rn-iso/` stay the one entry git treats them as.
export function addsOnlyWorkspaceIgnoreBlock(diff: string | null | undefined): boolean {
  if (typeof diff !== 'string' || diff.trim() === '') return false;
  const allowed = new Set(
    renderWorkspaceIgnoreBlock()
      .split('\n')
      .map((l) => l.trim()),
  );
  allowed.add('');
  let added = 0;
  let sawEntry = false;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    // Everything before the first @@ is the file header, where `+++ b/path`
    // would otherwise read as an added line.
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line.startsWith('-')) return false;
    if (!line.startsWith('+')) continue; // context
    const body = line.slice(1).trim();
    if (!allowed.has(body)) return false;
    if (listsWorkspaceDir(body)) sawEntry = true;
    added += 1;
  }
  return added > 0 && sawEntry;
}

// PURE. Whether a .gitignore file's WHOLE content is rn-iso's own block -- the
// untracked half of the same dead end.
//
// On a repo that has no .gitignore at all, the self-ensure does not modify a
// file, it CREATES one, and git reports `?? .gitignore`. `worktree remove`
// counted that as untracked work and refused, offering --force -- the loop's
// own write blocking the loop's own teardown, exactly as the modified case did
// one file over. A diff cannot decide this one: an untracked file has no index
// side to diff against, so the content itself is the evidence.
//
// The rule is the same shape as addsOnlyWorkspaceIgnoreBlock, and fails CLOSED
// for the same reason: every non-blank line must be one of the block's own, and
// the `.rn-iso` entry itself must be among them, so a file carrying one line
// the repo wrote (or only our comments) is work and stays dirty. The allowed
// set is derived from renderWorkspaceIgnoreBlock rather than retyped, so it
// cannot drift from the writer.
export function isOnlyWorkspaceIgnoreBlock(content: string | null | undefined): boolean {
  if (typeof content !== 'string' || content.trim() === '') return false;
  const allowed = new Set(
    renderWorkspaceIgnoreBlock()
      .split('\n')
      .map((l) => l.trim()),
  );
  let sawEntry = false;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (!allowed.has(line)) return false;
    if (listsWorkspaceDir(line)) sawEntry = true;
  }
  return sawEntry;
}

// A path this code is about to interpolate into a shell command, or resolve
// against the worktree root. Anything outside the set is not examined at all --
// it stays dirty, which is the safe direction, and no quoting question arises.
const SAFE_DIFF_PATH = /^[A-Za-z0-9._/-]+$/;

// Drops a `.gitignore` that is rn-iso's own write from a dirty listing, and
// reports which files those were AND in which of the two ways, because the two
// need opposite treatments afterwards:
//
//   healed   ` M path` -- the repo tracks a .gitignore and the self-ensure
//                         APPENDED the block to it. Undone with `git checkout`.
//   created  `?? path` -- the repo had no .gitignore and the self-ensure WROTE
//                         one. There is nothing to restore it to; it is deleted.
//
// `diff` and `read` are injected (they are the impure steps) so the two
// decisions above stay testable without git and without a filesystem.
//
// For the modified case only an UNSTAGED modification (` M`) qualifies: a staged
// change is not what `git diff` describes and not what `git checkout -- <file>`
// would undo, so it is left to refuse.
interface SelfHealedIgnoresResult {
  lines: string[];
  healed: string[];
  created: string[];
}

export function excludeSelfHealedIgnores(
  lines: string[] | null | undefined,
  { diff, read }: { diff: (file: string) => string | null; read: (file: string) => string },
): SelfHealedIgnoresResult {
  const kept: string[] = [];
  const healed: string[] = [];
  const created: string[] = [];
  for (const line of lines || []) {
    const path = porcelainPath(line);
    const isIgnoreFile = path && /(?:^|\/)\.gitignore$/.test(path) && SAFE_DIFF_PATH.test(path);
    if (isIgnoreFile && String(line).startsWith(' M ') && addsOnlyWorkspaceIgnoreBlock(diff(path))) {
      healed.push(path);
      continue;
    }
    if (isIgnoreFile && String(line).startsWith('?? ') && isOnlyWorkspaceIgnoreBlock(read(path))) {
      created.push(path);
      continue;
    }
    kept.push(line);
  }
  return { lines: kept, healed, created };
}

// The two files a `pod install` rewrites, under an `ios/` directory:
//   <anything>/ios/Podfile.lock
//   <anything>/ios/<Name>.xcodeproj/project.pbxproj
// Narrower than isPodInstallChurn (src/worktree.js), which decides what ADVICE
// to print and may match a Podfile.lock anywhere. This one decides what to
// DELETE, so it names the exact shape rather than the family.
const POD_CHURN_PATH = /(?:^|\/)ios\/(?:Podfile\.lock|[^/]+\.xcodeproj\/project\.pbxproj)$/;

// PURE. Splits a dirty listing into what still refuses the removal and the
// pod-install churn to restore first -- ALL OR NOTHING: one path outside the
// class and nothing is restored.
//
// GATE PROVENANCE (2026-08-24): every `worktree remove` in the release gate
// needed a hand-run `git checkout -- apps/app/ios/Podfile.lock` before it would
// proceed. The repo's own postinstall runs `pod install`, and a hermes-engine
// podspec that bakes the absolute worktree path into Podfile.lock makes that
// file modified in every worktree from the moment dependencies are installed.
// The refusal already recognised this class -- removalRemedy prints the exact
// checkout command for it -- so all it did was make a human paste back a
// command rn-iso had already composed.
//
// WHY THIS IS SAFE, AND WHY IT DOES NOT WEAKEN THE GUARD. The refusal protects
// uncommitted WORK. These two files are not work in a worktree being removed:
// they are inside a directory that is about to be deleted wholesale, so
// restoring them destroys nothing that surviving the command would have saved,
// and lockfile changes anyone MEANT would have been committed. It is the same
// reasoning that already restores rn-iso's own .gitignore append
// (excludeSelfHealedIgnores), one file over -- with the difference that these
// were written by the project's tooling rather than by rn-iso, which is why
// every line says so.
//
// It fails CLOSED in three directions, and each of them matters more than the
// convenience:
//   - ALL OR NOTHING. Any other dirty path and the whole listing is refused,
//     churn included, exactly as today. "Mostly churn" is not a category.
//   - TRACKED AND UNSTAGED ONLY (` M `). `git checkout -- <file>` restores from
//     the INDEX, so a staged change would survive it and leave the tree dirty;
//     an untracked file has nothing to restore to at all.
//   - NAMEABLE ONLY. A path outside SAFE_DIFF_PATH is not examined, because it
//     is about to be interpolated into a shell command.
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
  // One thing that is not churn and the churn stays dirty too, so the refusal
  // lists every file and the reader sees the whole picture.
  if (kept.length) return { lines: lines ? [...lines] : [], restore: [] };
  return { lines: kept, restore };
}

// PURE. The worktree entry a path belongs to: an exact match, or the enclosing
// one when the path is somewhere inside it.
//
// `worktree remove` defaults to the current workspace, and in a monorepo the
// directory an agent is standing in is the APP dir (`<worktree>/apps/mobile`),
// which matches no worktree root and was refused outright -- from a command
// whose whole point is that you do not have to name what you are inside of.
// Returns the entry INDEX as well (entry zero is the main checkout); the
// action itself detects the main checkout with isMainWorkingTree on the
// matched root, so standing in `<repo>/apps/mobile` reclaims the environment
// rather than removing the repo.
//
// Longest match wins, so a worktree nested inside another resolves to the
// nearest enclosing one rather than the outermost.
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

// PURE. The remedy lines for a dirty-tree refusal, named per CLASS of dirt.
//
// The old message offered `git checkout -- <path>` and nothing else, which is
// wrong for half the cases it was printed for: checkout restores tracked files
// and cannot clear an untracked one, so a reader following it saw the identical
// refusal again and concluded the only way out was --force. Untracked files need
// `git clean -fd` (or an rm); tracked ones need checkout; a tree with both needs
// to be told both.
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
      // The lead-in is what this case adds: "a build did this, restoring it is
      // safe". The command under it is built from the paths git NAMED, like
      // every other class of dirt -- the hardcoded `ios/...` example it used to
      // print is wrong in any repo whose app is not at the root, and a monorepo
      // reader got `error: pathspec 'ios/Podfile.lock' did not match any
      // file(s) known to git` from a remedy that was supposed to be pasteable.
      lines.push('That is only the files `pod install` rewrites. Restore them and retry:');
      lines.push(`  git -C ${worktree} checkout -- ${pathArgs(tracked)}`);
    } else {
      lines.push('Tracked files were modified -- if a build or a setup script did it, restore them and retry:');
      lines.push(`  git -C ${worktree} checkout -- ${pathArgs(tracked)}`);
    }
  }
  if (untracked.length) {
    // Said explicitly: the previous advice was checkout, and a reader who tried
    // it on an untracked file got no error and no change.
    lines.push('Untracked files are also present -- `git checkout` cannot clear those. Delete them and retry:');
    lines.push(`  git -C ${worktree} clean -fd ${pathArgs(untracked)}        # or rm them yourself`);
  }
  return lines;
}

// The paths themselves, as arguments. A remedy carrying `<path>...` is one more
// thing to work out before anything can be run, and this function already has
// the answer in its hand. Capped, because a remedy is a thing to read: past the
// cap it ends in `...`, which is the reader's cue to use the status listing
// above it.
function pathArgs(lines: string[] | null | undefined, limit = 5): string {
  const paths = (lines || []).map(porcelainPath).filter((p): p is string => Boolean(p));
  const shown = paths
    .slice(0, limit)
    // porcelainPath strips the quoting git adds around an awkward path; it goes
    // back on before the path is printed as part of a command to run.
    .map((p) => (/[\s"'\\$`]/.test(p) ? JSON.stringify(p) : p));
  return `${shown.join(' ')}${paths.length > shown.length ? ' ...' : ''}`;
}

// Pure: takes the already-computed dirty/unpushed facts and turns them into
// human-readable reasons to refuse removal. `worktree remove` is called
// unattended (agents, phone-driven sessions) and `git worktree remove
// --force` silently discards uncommitted changes and strands any commits
// that exist on no remote and no other local branch -- this is the only
// check standing between that and lost work, so it must be right and it
// must be tested without touching git.
// `dirty` / `unpushed` are `null` (not `false` / `[]`) when the caller could
// not get an answer from git at all -- see hasUncommittedWork/unpushedCommits
// in worktree.js. For a destructive command the unknown case must fail
// CLOSED: treat "could not determine" as a blocker in its own right, rather
// than defaulting to "clean" the way a falsy check would.
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
// The shape reclaimAll/registerRemove read off a skipped device entry. Kept
// local (and looser -- `platform` optional) rather than importing reclaim.ts's
// own SkippedDevice, whose `platform` is a required 'ios' | 'android'.
interface SkippedDevice {
  platform?: string;
  name: string;
  udid?: string;
  reason: string;
}

function describeKeptDevice(s: SkippedDevice): string {
  return s.udid && s.udid !== s.name ? `${s.name} (${s.udid})` : s.name;
}

// The aggregate reclaimAll produces across every registered key under a
// worktree root -- see the comment above this function for why there can be
// more than one. Distinct from reclaim.ts's per-project ReclaimResult.
interface ReclaimAllResult {
  dereferenced: string[];
  killedPids: number[];
  deletedDevices: string[];
  skippedDevices: SkippedDevice[];
  keptEntries: string[];
  // Every key that was reclaimed (the root plus the nested registered ones),
  // for the caller that deletes each key's own `.rn-iso/` rather than the
  // whole tree -- see reclaimEnvironment.
  reclaimedKeys: string[];
}

async function reclaimAll(rootPath: string): Promise<ReclaimAllResult> {
  const cfg = loadConfig();
  const keys = new Set([rootPath]);
  if (cfg?.projects) {
    for (const key of Object.keys(cfg.projects)) {
      if (isPathPrefix(rootPath, key)) keys.add(key);
    }
  }
  const dereferenced: string[] = [];
  const killedPids: number[] = [];
  const deletedDevices: string[] = [];
  const skippedDevices: SkippedDevice[] = [];
  const keptEntries: string[] = [];
  for (const key of keys) {
    const r = await reclaimProject(key, { deleteOwnedDevices: true });
    dereferenced.push(...r.dereferenced);
    if (r.killedPid) killedPids.push(r.killedPid);
    deletedDevices.push(...r.deletedDevices);
    skippedDevices.push(...r.skippedDevices);
    if (r.keptEntry) keptEntries.push(key);
  }
  return { dereferenced, killedPids, deletedDevices, skippedDevices, keptEntries, reclaimedKeys: [...keys] };
}

// Whether rn-iso registered anything at or under `rootPath`. This is what
// makes `worktree remove` meaningful on a directory that is not a git repo at
// all: there is no worktree to remove there, but there can still be an
// environment (a port, an owned device, a `.rn-iso/`) to reclaim.
function hasRegisteredProjectUnder(rootPath: string): boolean {
  const cfg = loadConfig();
  return Object.keys(cfg?.projects ?? {}).some((key) => isPathPrefix(rootPath, key));
}

// `worktree remove` on the MAIN working tree (or on a registered directory
// that is not a git repo at all): everything the normal removal does to
// rn-iso's own state -- reclaim every registered key under the root with the
// owned devices deleted, drop the registry entries, delete each key's
// `.rn-iso/` -- with the source tree itself left completely alone. There is
// no `git worktree remove` here (git cannot remove the main tree) and no
// dirty/unpushed guard: those protect work in a tree about to be deleted,
// and nothing here is deleted but rn-iso's own state dir, so dirt is not
// this command's business and is not mentioned. Every line goes to stderr,
// mirroring the normal removal's reporting.
//
// The exit code follows the normal removal's rule for a failed device
// teardown: the record is kept (dropping it is what turns a failed teardown
// into a simulator nothing references) and the command exits 1.
async function reclaimEnvironment(root: string, why: string): Promise<void> {
  const result = await reclaimAll(root);
  for (const key of result.reclaimedKeys) {
    // Contained by construction: every key is `root` itself or a registered
    // path-segment-prefix child of it (see reclaimAll), and only the key's
    // own `.rn-iso/` is touched -- never anything else in the tree.
    const dir = workspaceDir(key);
    if (!existsSync(dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      console.error(chalk.dim(`  removed ${relative(root, dir) || dir} (this workspace's own output)`));
    } catch {
      console.error(chalk.yellow(`  could not remove ${dir}`));
    }
  }
  if (result.dereferenced.length) console.error(chalk.dim(`  no longer referenced: ${result.dereferenced.join(', ')}`));
  for (const pid of result.killedPids) console.error(chalk.dim(`  killed Metro pid ${pid}`));
  if (result.deletedDevices.length)
    console.error(chalk.dim(`  deleted device(s): ${result.deletedDevices.join(', ')}`));
  for (const s of result.skippedDevices) {
    console.error(chalk.yellow(`  kept ${describeKeptDevice(s)}: ${s.reason}`));
  }
  for (const kept of result.keptEntries) {
    console.error(
      chalk.yellow(
        `  rn-iso still tracks ${kept} because a device delete failed; re-run \`rn-iso gc --delete\` once the cause is fixed.`,
      ),
    );
  }
  console.error(chalk.green(`Reclaimed the environment; the working tree stays (${why}).`));
  if (result.keptEntries.length) process.exitCode = 1;
}

// Deletes the workspace directories `git status` reported inside `root`, and
// returns the relative paths actually removed.
//
// Containment first, every time: a path from git is relative to the worktree,
// but resolving it and checking it still lands inside is what keeps a `..` in
// the listing (or a path this code mis-parsed) from reaching outside the
// directory that is about to be deleted anyway. A removal that fails is
// skipped, not thrown: `git worktree remove` is about to report the same
// problem in better words.
// The two file operations this command performs on a path git named, both
// contained the same way purgeWorkspaceArtifacts is: resolve it, and refuse it
// if it did not land inside the worktree. A `..` in a listing, or a path this
// code mis-parsed, must not reach outside the directory that is about to be
// deleted.
function insidePath(root: string, rel: string): string | null {
  const target = resolve(root, rel);
  const inside = relative(root, target);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null;
  return target;
}

// The content of a file git reported inside the worktree, or '' when it cannot
// be read -- which the caller must treat as "not ours", the safe direction.
function readInside(root: string, rel: string): string {
  const target = insidePath(root, rel);
  if (!target) return '';
  try {
    return readFileSync(target, 'utf-8');
  } catch {
    return '';
  }
}

function removeInside(root: string, rel: string): boolean {
  const target = insidePath(root, rel);
  if (!target) return false;
  try {
    rmSync(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

function purgeWorkspaceArtifacts(root: string, dirtyLines: string[] | null | undefined): string[] {
  const removed: string[] = [];
  for (const rel of workspaceArtifactPaths(dirtyLines)) {
    const target = insidePath(root, rel);
    if (!target) continue;
    if (!existsSync(target)) continue;
    try {
      rmSync(target, { recursive: true, force: true });
      removed.push(rel);
    } catch {
      // Left for `git worktree remove` to complain about by name.
    }
  }
  return removed;
}

export function registerRemove(worktree: Command): void {
  worktree
    .command('remove [target]')
    .description(
      'Remove a worktree and reclaim its build artifacts, owned devices, and Metro port. Defaults to the current workspace. On the main checkout it reclaims the environment only and leaves the tree in place.',
    )
    .option('--force', 'remove even when the worktree holds uncommitted or unpushed work')
    .action(async (target, opts) => {
      // Defaults to the current workspace, like every other command: an
      // agent finishing a ticket is already standing in the worktree it is
      // done with, and making it name a path it is inside of is the kind of
      // ceremony the surface exists to remove. On the main checkout it only
      // reclaims the environment and never touches the tree, so the default
      // cannot become "delete the repo you are in".
      target = target ?? process.cwd();
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

      // Resolve to the worktree ROOT before anything reads git or config,
      // because every step below is keyed to it: `git status` from an app dir
      // reports the whole worktree anyway, `reclaimAll` keys on the root, and
      // `git worktree remove` takes nothing else.
      //
      // Walking up is what makes the default target usable in a monorepo: an
      // agent finishing a ticket is standing in `<worktree>/apps/tlon-mobile`
      // -- the directory `rn-iso ios` runs in -- and that matched no worktree
      // root, so the command that defaults to "where you are" refused to run
      // where you are. It is still a refusal when the path is inside no linked
      // worktree at all and rn-iso registered nothing there; the main checkout
      // takes the environment-reclaim branch below, however deep inside it you
      // were standing.
      const entries = listWorktrees(path);
      const entry = matchWorktreeEntry(entries, path);
      if (!entry) {
        // Inside no worktree git knows about. When the directory is not a git
        // repo AT ALL but rn-iso registered a project there, reclaiming the
        // environment is the only thing `remove` can mean: there is no
        // worktree to hand to git, and no git status to guard.
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
      // The MAIN working tree is the one whose `--git-dir` IS its
      // `--git-common-dir` (the repository lives inside it). git cannot
      // remove it, and deleting the source tree is not what anyone meant --
      // so on it, and only on it, `remove` reclaims the ENVIRONMENT
      // (devices, port, registry entries, `.rn-iso/`) and leaves every file
      // in the tree untouched. This used to be a flat refusal; reclaiming is
      // strictly what the refusal sent you off to do by hand.
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

      // The workspace's own `.rn-iso/` is excluded from the verdict, not just
      // from the printed list: it is the one dirty path this command created
      // itself and the one it is definitely about to delete. hasUncommittedWork
      // is still what distinguishes "clean" from "git could not answer" (null),
      // which must stay a blocker of its own; the line listing then decides
      // whether anything that is NOT ours is dirty.
      //
      // A .gitignore carrying nothing but rn-iso's own block is the same
      // exclusion one file over (addsOnlyWorkspaceIgnoreBlock and
      // isOnlyWorkspaceIgnoreBlock above): rn-iso wrote it, and it is checked
      // line by line against what rn-iso writes rather than assumed. Both
      // shapes count -- the block APPENDED to a tracked .gitignore, and a whole
      // .gitignore CREATED where the repo had none, which is what a repo with
      // no ignore file at all produces and what the refusal was hit on.
      const gitAnswered = hasUncommittedWork(path);
      const allDirty = gitAnswered ? dirtyPaths(path, { limit: Infinity }) : [];
      const {
        lines: afterIgnores,
        healed: selfHealedIgnores,
        created: selfCreatedIgnores,
      } = excludeSelfHealedIgnores(excludeWorkspaceArtifacts(allDirty), {
        diff: (file) => unstagedDiff(path, file),
        read: (file) => readInside(path, file),
      });
      // ... and last, the churn a `pod install` leaves behind, but ONLY when it
      // is all that is left once rn-iso's own writes are out. See
      // excludePodChurn: the refusal protects uncommitted work, and these two
      // files are about to be deleted with the worktree either way. Ordered
      // after the two exclusions above so "the only dirt" really means the only
      // dirt, and not "the only dirt that is not ours".
      const { lines: dirtyLines, restore: podChurn } = excludePodChurn(afterIgnores);
      const dirty = gitAnswered === null ? null : dirtyLines.length > 0;
      const unpushed = unpushedCommits(path);
      const blockers = removalBlockers({ dirty, unpushed });
      if (blockers.length && !opts.force) {
        console.error(chalk.red(`Refusing to remove ${path}:`));
        for (const b of blockers) console.error(chalk.red(`  - ${b}`));
        if (unpushed && unpushed.length && !hasRemote(path)) {
          // With no remote configured, every commit no other local branch
          // reaches counts -- that is the safe direction (refuse), but a bare
          // count reads like a bug rather than a missing remote. Say so.
          console.error(
            chalk.dim(
              '  (no remote is configured for this worktree, so every commit no other local branch reaches counts as unpushed)',
            ),
          );
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
        const shown = dirtyLines.slice(0, 10);
        if (shown.length) {
          for (const line of shown) console.error(chalk.dim(`      ${line}`));
          console.error(chalk.dim(`  (git -C ${path} status -s for the full list)`));
        }
        // With the real path, not the `<worktree>` placeholder the default
        // argument prints: the remedy is meant to be a command a reader can
        // paste, and one carrying a literal `<worktree>` is a command that
        // fails in a way that reads like the tool being broken.
        for (const line of removalRemedy(dirtyLines, { worktree: path })) console.error(chalk.dim(line));
        // "Push the branch" is followable now precisely because of what is
        // counted: only commits no remote AND no other local branch reaches --
        // this worktree's own work, never commits inherited from a local-only
        // base ref (issue #8) -- so pushing publishes nothing but its own.
        console.error(chalk.dim('Otherwise: commit or push the branch (only commits found nowhere else are counted,'));
        console.error(chalk.dim("so pushing publishes nothing but this worktree's own work). --force is a last"));
        console.error(
          chalk.dim('resort -- it discards uncommitted changes and untracked files permanently; committed'),
        );
        console.error(chalk.dim('work stays on the branch.'));
        process.exitCode = 1;
        return;
      }

      // (The target was confirmed to be a linked worktree of this repo, and not
      // the main checkout, before any of the above ran -- see isMainWorkingTree
      // at the top of the action. The main checkout took the environment-reclaim
      // branch there, so nothing on this path can reach `git worktree remove`
      // with a tree git would refuse as "a main working tree".)

      // Release rn-iso's own state before the directory disappears. Reclaims
      // the worktree root AND every nested registered project under it (see
      // reclaimAll above) so a monorepo's Metro/device claim -- registered
      // under a nested app dir, not the root -- is not left leaking. The
      // worktree's build output needs no separate step: it lives inside the
      // directory `git worktree remove` deletes.
      const result = await reclaimAll(path);

      // ... and now the workspace directories themselves, so git's own
      // cleanliness check does not refuse over the one thing rn-iso just
      // decided was not work. Ordered after reclaimAll on purpose: the
      // supervisor writing into .rn-iso/logs is stopped by then.
      for (const purged of purgeWorkspaceArtifacts(path, allDirty)) {
        console.error(chalk.dim(`  removed ${purged} (this workspace's own output)`));
      }

      // ... and the same step for a .gitignore rn-iso wrote to itself, for the
      // same reason and no other: git's cleanliness check counts a modified
      // tracked file, so leaving it to die with the directory is not actually
      // an option -- verified against real git, which refuses with "contains
      // modified or untracked files" and offers only --force. Restoring is the
      // narrowest way through: the only change being undone is one rn-iso made,
      // the file is inside a directory that is about to be deleted anyway, and
      // the line says exactly what was decided and why.
      for (const file of selfHealedIgnores) {
        if (restoreFile(path, file)) {
          console.error(chalk.dim(`  restoring ${file} (only rn-iso's own entry was added)`));
        } else {
          console.error(chalk.yellow(`  could not restore ${file}; git may refuse to remove the worktree`));
        }
      }
      // ... and the same step for `pod install`'s churn, for the same reason:
      // git's own cleanliness check counts these tracked modifications and
      // refuses the removal over them, so leaving them to die with the
      // directory is not an option. The note names the file and says why,
      // because unlike the .gitignore above these were written by the
      // project's own tooling and a reader has to be able to see that rn-iso
      // decided to undo something it did not write.
      for (const file of podChurn) {
        if (restoreFile(path, file)) {
          console.error(chalk.dim(`  restored ${file} (pod install churn; the worktree is being removed)`));
        } else {
          console.error(chalk.yellow(`  could not restore ${file}; git may refuse to remove the worktree`));
        }
      }
      // ... and a .gitignore that exists only because rn-iso wrote it is
      // deleted rather than restored: there is no earlier version to go back
      // to, and git refuses over an untracked file exactly as it refuses over a
      // modified one. Same containment as the workspace purge -- the path is
      // resolved and checked to still be inside the worktree that is about to
      // be deleted anyway.
      for (const file of selfCreatedIgnores) {
        if (removeInside(path, file)) {
          console.error(chalk.dim(`  removed ${file} (rn-iso wrote all of it)`));
        } else {
          console.error(chalk.yellow(`  could not remove ${file}; git may refuse to remove the worktree`));
        }
      }
      // Undoing that entry un-ignores what it was ignoring: `.rn-iso/` was
      // invisible to the listing above precisely BECAUSE the self-heal had
      // added the entry, and the moment it is restored the directory is
      // untracked again -- which is the exact thing git refuses over. Found
      // against real git, where the removal failed here with "contains
      // modified or untracked files" after a clean verdict. So ask git once
      // more, and only when something was actually restored.
      if (selfHealedIgnores.length || selfCreatedIgnores.length) {
        for (const purged of purgeWorkspaceArtifacts(path, dirtyPaths(path, { limit: Infinity }))) {
          console.error(chalk.dim(`  removed ${purged} (this workspace's own output)`));
        }
      }

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
        console.error(chalk.red(`git worktree remove failed: ${String((e as Error)?.message || e)}`));
        console.error(
          chalk.dim(`The directory at ${path} was not removed; rn-iso's own tracking for it was already cleared.`),
        );
        if (result.dereferenced.length)
          console.error(chalk.dim(`  no longer referenced: ${result.dereferenced.join(', ')}`));
        for (const pid of result.killedPids) console.error(chalk.dim(`  killed Metro pid ${pid}`));
        if (result.deletedDevices.length)
          console.error(chalk.dim(`  deleted device(s): ${result.deletedDevices.join(', ')}`));
        for (const s of result.skippedDevices) console.error(chalk.dim(`  kept ${describeKeptDevice(s)}: ${s.reason}`));
        for (const kept of result.keptEntries) {
          console.error(
            chalk.dim(
              `  rn-iso still tracks ${kept} because a device delete failed; re-run \`rn-iso gc --delete\` once the cause is fixed.`,
            ),
          );
        }
        process.exitCode = 1;
        return;
      }
      console.log(chalk.green(`Removed worktree ${path}`));
      if (result.dereferenced.length)
        console.log(chalk.dim(`  no longer referenced: ${result.dereferenced.join(', ')}`));
      for (const pid of result.killedPids) console.log(chalk.dim(`  killed Metro pid ${pid}`));
      if (result.deletedDevices.length)
        console.log(chalk.dim(`  deleted device(s): ${result.deletedDevices.join(', ')}`));
      for (const s of result.skippedDevices) {
        console.log(chalk.yellow(`  kept ${describeKeptDevice(s)}: ${s.reason}`));
      }
      for (const kept of result.keptEntries) {
        console.log(
          chalk.yellow(
            `  rn-iso still tracks ${kept} because a device delete failed; re-run \`rn-iso gc --delete\` once the cause is fixed.`,
          ),
        );
      }
    });
}

// There is no `worktree list`. Its own description read "`rn-iso status` shows
// the same worktrees WITH their environments -- prefer it", and a command whose
// purpose is to redirect to another command has no place in the surface.
// `src/status.js` reports unprovisioned worktrees, so nothing is lost.

export default function worktreeCommand(program: Command): void {
  const worktree = program.command('worktree').description('Create and remove isolated worktrees');
  registerCreate(worktree);
  registerRemove(worktree);
}
