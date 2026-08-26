import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { getExecutor } from './exec.js';
import { WORKSPACE_DIR_NAME as WORKSPACE_DIR } from './paths.js';

// `.rn-iso/` is never carried into a new worktree, at any depth and whatever
// any pattern file says. It holds THIS workspace's derived data, its logs and
// the supervisor pidfile: build output keyed to a path the new worktree does
// not have, and a pidfile naming a process that is not running. Carrying that
// is strictly worse than starting cold, so it is code rather than
// configuration -- `.worktreeexclude` extends this list and cannot shorten it.
//
// Matched segment-wise rather than by prefix because a monorepo has one of
// these per app directory (`apps/mobile/.rn-iso`), and because the entry `git
// ls-files --directory` collapses to is the directory itself.
export function isWorkspaceArtifact(rel) {
  return String(rel).split('/').includes(WORKSPACE_DIR);
}

export function gitCommonDir(cwd) {
  const out = getExecutor().runQuiet(`git -C "${cwd}" rev-parse --path-format=absolute --git-common-dir`);
  return out ? out.trim() : null;
}

export function repoRoot(cwd) {
  const out = getExecutor().runQuiet(`git -C "${cwd}" rev-parse --show-toplevel`);
  return out ? out.trim() : null;
}

// Sibling of the repo, on the same volume. Not inside the repo: a worktree
// under the repo root puts a second copy of every package.json inside Metro's
// watch root, which causes jest-haste-map naming collisions.
export function defaultWorktreeDir(root) {
  return join(dirname(root), `${basename(root)}-worktrees`);
}

export function worktreePath({ worktreeDir, name }) {
  return join(worktreeDir, name);
}

// gitignore-style matching, limited to the subset a carry-over list needs:
// a bare name matches that exact path segment chain, `**/` matches any depth.
// A `*` requires at least one character, so e.g. `*.env` does not match the
// bare dotfile `.env` (that is what the literal `.env` pattern is for) -
// this keeps a wildcard pattern from silently absorbing a more specific one.
// A leading `/` is a root anchor (standard gitignore idiom): `/config/x`
// matches only `config/x` at the repo root, never a nested `a/config/x`.
// `git ls-files` output never has a leading slash, so without stripping it
// a root-anchored pattern could never match anything.
export function matchesInclude(path, patterns) {
  for (const pattern of patterns || []) {
    const rooted = pattern.startsWith('/');
    const body = rooted ? pattern.slice(1) : pattern;
    const escaped = body
      .replace(/[.+^${}()|[\]\\?]/g, '\\$&')
      .replace(/\*\*\//g, '::GLOBSTAR::')
      .replace(/\*/g, '[^/]+')
      .replace(/::GLOBSTAR::/g, '(?:.*/)?')
      .replace(/\\\?/g, '[^/]');
    const anchor = rooted ? '^' : '(^|/)';
    const re = new RegExp(`${anchor}${escaped}$`);
    if (re.test(path)) return true;
  }
  return false;
}

export function readWorktreeInclude(root) {
  return readPatternFile(join(root, '.worktreeinclude'));
}

export function readWorktreeExclude(root) {
  return readPatternFile(join(root, '.worktreeexclude'));
}

function readPatternFile(p) {
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

// `--directory` is the load-bearing flag here: when an entire directory is
// ignored (e.g. node_modules), git prints just that directory name with a
// trailing slash instead of recursing into it and listing every file
// inside. On a real monorepo node_modules is a multi-GB, multi-hundred-
// thousand-file tree; without `--directory` this call alone takes several
// seconds and its stdout can run into tens of MB (used to silently blow
// execSync's default maxBuffer -- see src/exec.js -- and make carry-over a
// silent no-op). The pathspec exclude is redundant defense for the case
// where node_modules is only PARTIALLY ignored (e.g. a repo that un-ignores
// one file inside it), where `--directory` alone would still recurse.
// Verified against a real 3+ GB node_modules monorepo: ~6s -> ~0.03s, and
// apps/tlon-mobile/.env (a genuinely single ignored file, not part of a
// wholly-ignored directory) still comes back.
export function listGitignoredFiles(root) {
  const out = getExecutor().runQuiet(
    `git -C "${root}" ls-files --others --ignored --exclude-standard --directory -- . ":(exclude,glob)**/node_modules/**"`
  );
  if (!out) return [];
  // A collapsed directory entry (trailing slash) is not a file
  // carryOverFiles can copy; drop it here rather than make every caller
  // re-filter.
  return out.split('\n').filter(Boolean).filter(f => !f.endsWith('/'));
}

// Paths the worktree at `dir` TRACKS. NUL-delimited because `ls-files`
// C-quotes any path that is non-ASCII or holds a newline, and a quoted path
// can never compare equal to the entry the carry-over is about to copy -- the
// guard below would wave it through.
//
// Null (not []) when git could not answer at all -- a target that is not a
// worktree, an index.lock held by a concurrent process, a permission error --
// which callers must read as "no idea", never as "tracks nothing". Same
// distinction hasUncommittedWork makes, for the same reason.
export function listTrackedPaths(dir) {
  const out = getExecutor().runQuiet(`git -C "${dir}" ls-files -z`);
  if (out === null) return null;
  return out.split('\0').filter(Boolean);
}

// The fail-closed half of carry-over, and the reason it exists:
//
// What is "gitignored" is a PER-WORKTREE fact. git computes it from the
// `.gitignore` files that worktree has checked out, and those are themselves
// tracked, branch-varying files -- so "ignored and untracked in the source"
// says nothing about the destination, which `--base` explicitly allows to sit
// on a different branch. Enumerating with git (see listGitignoredEntries)
// gets negations, nested pattern files and directory collapsing right, but it
// answers about the SOURCE only.
//
// Observed on tlon-apps, whose app .gitignore ignores `*.keystore` and then
// re-includes `!android/app/debug.keystore` so the whole team shares one debug
// signing identity. From a source worktree whose branch predates that
// re-include, the keystore enumerates as ignored+untracked, and the carry-over
// wrote that machine's copy over the tracked one the new worktree had just
// checked out: a tracked file silently replaced by a sibling workspace's, and
// by tlon's own comment the exact file whose drift breaks cross-machine APK
// installs and poisons their EAS build cache.
//
// So: a tracked path comes from the branch, never from another workspace,
// whatever the ignore enumeration says. `covers` answers for directories too,
// because the carry copies collapsed directory entries (`node_modules`,
// `ios/Pods`) wholesale and a directory holding even one tracked file cannot
// be copied over without destroying it.
export function trackedGuard(dir) {
  const paths = listTrackedPaths(dir);
  if (paths === null) return { known: false, covers: () => false };
  const set = new Set();
  for (const p of paths) {
    set.add(p);
    for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) set.add(p.slice(0, i));
  }
  return { known: true, covers: rel => set.has(rel) };
}

// One decision, shared by both carry paths, so they cannot drift apart:
// 'tracked' when the destination tracks it, 'unverified' when git could not
// be asked and something is already sitting at that path (the destination of a
// real `worktree create` is always a worktree, so an unanswerable `ls-files`
// means something is wrong enough that guessing is not allowed), null when
// copying is safe.
function refuseReason(guard, rel, destPath) {
  if (guard.covers(rel)) return 'tracked';
  if (!guard.known && existsSync(destPath)) return 'unverified';
  return null;
}

// Only files that are BOTH matched by a pattern AND gitignored are copied, so
// tracked files are never duplicated into the worktree. Per-file failures are
// collected rather than thrown -- a single unreadable file must not abort
// worktree creation -- but they are returned (not swallowed) so the caller
// can warn about them.
export function carryOverFiles({ root, target, patterns }) {
  if (!patterns || patterns.length === 0) return { copied: [], skipped: [], failed: [] };
  const copied = [];
  const skipped = [];
  const failed = [];
  const guard = trackedGuard(target);
  for (const rel of listGitignoredFiles(root)) {
    if (isWorkspaceArtifact(rel)) continue;
    if (!matchesInclude(rel, patterns)) continue;
    const from = join(root, rel);
    const to = join(target, rel);
    const reason = refuseReason(guard, rel, to);
    if (reason) {
      skipped.push({ file: rel, reason });
      continue;
    }
    try {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      copied.push(rel);
    } catch (e) {
      failed.push({ file: rel, error: String(e?.message || e) });
    }
  }
  return { copied, skipped, failed };
}

// carryOverFiles is file-by-file, which is right for a handful of small config
// files but not for the multi-GB trees a worktree needs to build without a
// reinstall: node_modules, ios/Pods, and ios/build (RN codegen output, without
// which xcodebuild fails on a missing States.cpp before pod install regenerates
// it). Unlike listGitignoredFiles this keeps git's collapsed directory entries
// -- they are the whole point here -- and does not exclude node_modules.
export function listGitignoredEntries(root) {
  const out = getExecutor().runQuiet(
    `git -C "${root}" ls-files --others --ignored --exclude-standard --directory --no-empty-directory`
  );
  if (!out) return [];
  return out.split('\n').filter(Boolean).map(e => (e.endsWith('/') ? e.slice(0, -1) : e));
}

// An exclude list rather than an include list: the failure mode of naming what
// to copy is that a new ignored artifact is silently absent months later and
// surfaces as a confusing build error, whereas the failure mode of naming what
// to skip is a directory copied needlessly.
//
// `patterns` are the caller's additions on top of the built-in exclusion of
// `.rn-iso/` (see isWorkspaceArtifact): they extend it, and cannot un-exclude
// it.
//
// `cloned` is false when `cp -c` was refused and the entry had to be copied for
// real -- APFS clonefiles only work same-volume, and that is the difference
// between ~40 MB and several GB per worktree, so the caller warns about it.
export function cloneIgnoredEntries({ root, target, patterns }) {
  const copied = [];
  const skipped = [];
  const failed = [];
  let cloned = true;
  const guard = trackedGuard(target);
  for (const rel of listGitignoredEntries(root)) {
    if (isWorkspaceArtifact(rel)) continue;
    if (matchesInclude(rel, patterns)) continue;
    const from = join(root, rel);
    const to = join(target, rel);
    const reason = refuseReason(guard, rel, to);
    if (reason) {
      skipped.push({ file: rel, reason });
      continue;
    }
    try {
      mkdirSync(dirname(to), { recursive: true });
      // No shell: `from` = join(root, rel), and `rel` comes straight from
      // `git ls-files --others --ignored --directory`, which does NOT quote
      // `$`, backticks or spaces. A top-level ignored path named
      // `a$(touch INJECTED).log` used to execute inside `cp -Rc "${from}" ...`;
      // as an argv element it is one literal path. The -Rc APFS-clone-then-fall-
      // back-to-plain-copy logic is unchanged: runFile throws on the clonefile
      // refusal (different volume / not APFS) exactly where runQuiet returned
      // null, and the plain `cp -R` runs in the catch. A genuine copy failure
      // rethrows from `cp -R` into the outer catch, landing in `failed` as before.
      try {
        getExecutor().runFile('cp', ['-Rc', from, to]);
      } catch {
        getExecutor().runFile('cp', ['-R', from, to]);
        cloned = false;
      }
      copied.push(rel);
    } catch (e) {
      failed.push({ file: rel, error: String(e?.message || e) });
    }
  }
  return { copied, skipped, failed, cloned };
}

// `ios/Pods/` is gitignored, so --carry-ignored clones it wholesale, including
// the `Pods/Manifest.lock` that records which Podfile.lock produced it.
// `ios/Podfile.lock` is TRACKED, so the new worktree gets the committed version
// instead. When the source worktree's installed Pods do not match its own
// committed Podfile.lock -- common on a branch mid-upgrade, or when a
// `pod install` was never committed -- the clone imports that contradiction.
//
// Xcode notices only in the very last build phase, after every pod has
// compiled: "The sandbox is not in sync with the Podfile.lock". On a real
// project that is ~25 minutes and 10k log lines before anything says so, which
// is why this cheap file comparison is worth doing at create time.
//
// Driven off the cloned entry list rather than a hardcoded `ios/Pods` so it
// covers a monorepo, where the app (and its Pods) sit under e.g. `apps/mobile`.
// Returns one entry per Pods directory that is out of sync; an empty array
// means every carried Pods directory matches its Podfile.lock.
export function podsOutOfSync(target, copiedEntries, { read = readFileSync } = {}) {
  const problems = [];
  for (const rel of copiedEntries || []) {
    if (rel !== 'Pods' && !rel.endsWith('/Pods')) continue;
    const iosDir = rel === 'Pods' ? '' : rel.slice(0, -'/Pods'.length);
    const manifest = join(target, rel, 'Manifest.lock');
    const podfileLock = join(target, iosDir, 'Podfile.lock');
    if (!existsSync(manifest)) continue;
    // No Podfile.lock next to a carried Pods directory is the same failure
    // wearing a different hat: the sandbox check compares against a file that
    // is not there.
    if (!existsSync(podfileLock)) {
      problems.push({ dir: iosDir || '.', reason: 'missing' });
      continue;
    }
    try {
      if (read(manifest, 'utf-8') !== read(podfileLock, 'utf-8')) {
        problems.push({ dir: iosDir || '.', reason: 'mismatch' });
      }
    } catch {
      // Unreadable is not the same as out of sync, and this is advisory.
    }
  }
  return problems;
}

// Returns null (indeterminate) when `runQuiet` could not get an answer from
// git at all -- e.g. index.lock held by a concurrent process, a permission
// error, or `dir` not being a git worktree -- as distinct from `false`
// (git answered, and the answer is "clean"). A destructive caller like
// `worktree remove` must be able to tell "clean" from "unknown" and treat
// the latter as a blocker, not as clean.
export function hasUncommittedWork(dir) {
  const out = getExecutor().runQuiet(`git -C "${dir}" status --porcelain`);
  if (out === null) return null;
  return out.trim().length > 0;
}

// The paths behind a `dirty` verdict, as `git status --porcelain` short codes
// plus path. The refusal message used to name only the CocoaPods case, which is
// the common cause but not the only one: on member-app the dirty files are
// brand assets a shell script rewrites (app icons, config.json, Config.xcconfig),
// and following the printed `git checkout -- ios/Podfile.lock` does not clear
// the refusal. Naming what is actually dirty points at the real cause.
//
// Returns [] when git could not answer; the caller already treats that as its
// own blocker via hasUncommittedWork returning null.
export function dirtyPaths(dir, { limit = 10 } = {}) {
  const out = getExecutor().runQuiet(`git -C "${dir}" status --porcelain`);
  if (out === null) return [];
  const lines = out.split('\n').map(l => normalizePorcelainLine(l.trimEnd())).filter(Boolean);
  return lines.slice(0, limit);
}

// The executor trims the WHOLE command output (src/exec.js), which eats the
// leading space of a first line whose status is unstaged-only: git's ` M
// ios/Podfile.lock` arrives as `M ios/Podfile.lock`, one column short. Every
// consumer of these lines slices a fixed two-character status field
// (porcelainPath, isPodInstallChurn, the `??` test in removalRemedy), so the
// damaged line silently mis-parsed -- `porcelainPath` returned `s/Podfile.lock`
// for it, and the workspace-artifact and self-healed-gitignore filters could
// never match the first line of a listing. Re-shape it here, once, rather than
// teach every consumer about it.
//
// A well-formed porcelain line always has a space in column three; a damaged
// one has the first character of the path there, and cannot itself start with a
// space (it was trimmed). So the test is exact, not a guess.
function normalizePorcelainLine(line) {
  if (line === '' || line[2] === ' ') return line;
  return ` ${line}`;
}

// The UNSTAGED diff of one path -- worktree against index, which is exactly the
// change `git checkout -- <file>` would undo. Null when git could not answer,
// which callers must read as "no idea", never as "no change".
//
// The path is interpolated into a shell command, so it is only ever passed one
// the caller has already constrained (see SAFE_DIFF_PATH in commands/worktree.js);
// `--` keeps a leading dash from being read as an option either way.
export function unstagedDiff(dir, file) {
  return getExecutor().runQuiet(`git -C "${dir}" diff -- "${file}"`);
}

// Restores one path from the index. False when git refused or could not run,
// so a caller can say so rather than assume the file is back.
export function restoreFile(dir, file) {
  return getExecutor().runQuiet(`git -C "${dir}" checkout -- "${file}"`) !== null;
}

// Whether the dirty set is only the files a `pod install` rewrites. That is the
// case where "restore and retry" actually works, so the advice is only printed
// when it applies.
export function isPodInstallChurn(paths) {
  if (!paths || paths.length === 0) return false;
  return paths.every(line => /(?:^|\/)(?:Podfile\.lock|project\.pbxproj)$/.test(line.slice(3).trim()));
}

// Commits reachable from HEAD but from no remote ref. Removing the worktree
// would destroy these.
//
// HEAD must be passed explicitly: once any revision argument (including a
// negated one like --not --remotes) is present, `git log` no longer falls
// back to HEAD on its own, so `git log --oneline --not --remotes` silently
// returns nothing even when there are unpushed commits. Verified against a
// real repo (see task-8-report.md).
//
// Returns null (indeterminate), not [], when `runQuiet` could not get an
// answer from git -- see hasUncommittedWork above for why that distinction
// matters here.
export function unpushedCommits(dir) {
  const out = getExecutor().runQuiet(
    `git -C "${dir}" log --oneline HEAD --not --remotes`
  );
  if (out === null) return null;
  return out.split('\n').map(l => l.trim()).filter(Boolean);
}

// Whether the repo at `dir` has any remote configured at all. Used to make
// the "not on any remote" removal blocker read sensibly: a repo with no
// remote makes unpushedCommits() return every commit reachable from HEAD,
// which is the safe direction (refuse), but the count alone can look like a
// bug rather than an unconfigured remote.
export function hasRemote(dir) {
  const out = getExecutor().runQuiet(`git -C "${dir}" remote`);
  return Boolean(out && out.trim().length > 0);
}

// True when `branch` already exists in the repo at `cwd`. Used by
// addWorktree so a `create -> remove -> create` cycle with the same name
// does not fail: `git worktree remove` deletes the worktree directory but
// never the branch, so a second `-b worktree-<name>` collides with the
// branch left behind by the first.
export function branchExists(cwd, branch) {
  const out = getExecutor().runQuiet(`git -C "${cwd}" rev-parse --verify --quiet "refs/heads/${branch}"`);
  return Boolean(out);
}

// The short sha `ref` names, or null when this repo cannot resolve it to a
// commit at all. One call does both jobs `worktree create --base` needs: it
// VALIDATES the ref (an unresolvable one must not reach `git worktree add`,
// which would leave a half-made worktree behind) and produces the sha the
// command prints, so a tester can tell what the branch was actually cut from.
//
// `^{commit}` rather than the bare ref: a tag object resolves to itself under a
// plain rev-parse, and `git worktree add` wants the commit. --quiet keeps a
// miss at exit 1 with no stderr, which runQuiet turns into null.
// No shell: `git` runs via runFile with an argv array, so `ref` -- which comes
// from committed settings (worktree.baseRef) and `--base`, both repo-controlled
// -- reaches git as one literal argument. `${ref}^{commit}` is a single argv
// element, so a value like `$(touch PWNED)` is looked up as a (nonexistent) ref
// named exactly that, never evaluated by a shell.
//
// `--end-of-options` guards the argument-injection case runFile alone does not:
// a ref beginning with `-` would otherwise be parsed as a git flag. After it,
// every remaining token is a ref, so `-badref^{commit}` is a lookup miss (git
// exits 1), not an option. (`--` is wrong here -- rev-parse reads it as the
// rev/path separator and would treat the ref as a pathspec.)
//
// runFile THROWS on a nonzero exit where the old runQuiet returned null, so the
// try/catch restores the "sha or null" contract: --quiet keeps a miss at exit 1
// with no stderr, which becomes null here just as before.
export function resolveRef(cwd, ref) {
  try {
    const out = getExecutor().runFile('git', [
      '-C', cwd,
      'rev-parse', '--verify', '--quiet', '--short',
      '--end-of-options', `${ref}^{commit}`,
    ]);
    return out && out.trim() ? out.trim() : null;
  } catch {
    return null;
  }
}

// A worktree path beginning with `-` would be parsed as a git flag even via
// runFile (no shell strips it), so `git worktree add <path>` could be turned
// into option injection by a repo-controlled worktreeDir. The metachar set is
// the same defense-in-depth guard fs-util.js uses (`` ` ``, `$`, `"`, `\`):
// none of these belong in a real worktree path, and rejecting them here also
// closes the downstream shell interpolations of this path (trackedGuard /
// listGitignoredEntries run `git -C "<target>"`), which addWorktree always
// precedes. `--` in the git command below is the robust terminator; this is
// belt-and-suspenders on top of it.
function assertSafeWorktreePath(path) {
  if (typeof path !== 'string' || path.startsWith('-')) {
    throw new Error(`Refusing worktree path ${JSON.stringify(path)}: a path beginning with "-" would be parsed as a git option.`);
  }
  if (/[`$"\\]/.test(path)) {
    throw new Error(`Refusing worktree path ${JSON.stringify(path)}: it contains shell metacharacters that have no place in a path.`);
  }
}

// A base ref beginning with `-` would be read as a git flag (e.g. a crafted
// `--upload-pack=...`) rather than a commit-ish. Only a LEADING `-` is the
// risk: real branch names, tags and shas hold `/`, `.` and `-` mid-string, so
// nothing else is rejected. resolveRef's --end-of-options already turns such a
// value into a lookup miss upstream, so this throw is normally unreachable in
// `worktree create`; it stands as an explicit, testable guard on the fresh
// path, where the ref is actually handed to git.
function assertSafeBaseRef(baseRef) {
  if (typeof baseRef !== 'string' || baseRef.startsWith('-')) {
    throw new Error(`Refusing base ref ${JSON.stringify(baseRef)}: a ref beginning with "-" would be parsed as a git option.`);
  }
}

export function addWorktree({ path, branch, baseRef, cwd }) {
  assertSafeWorktreePath(path);
  mkdirSync(dirname(path), { recursive: true });
  // Name reuse is likely from phone/agent-spawned sessions ("fix-login",
  // "bugfix"): if the branch this worktree would use already exists (left
  // behind by an earlier `remove`), attach to it instead of erroring on
  // `-b` for a branch that is already taken. `baseRef` is meaningless once
  // attaching to an existing branch, so it is only used on the fresh-branch
  // path.
  //
  // runFile (no shell) + `--` (git's options terminator, which `git worktree
  // add` honours before the positional <path> [<commit-ish>]) means neither the
  // repo-controlled path nor the repo-controlled baseRef can be parsed as an
  // option or evaluated by a shell. Both are single literal argv elements.
  if (branchExists(cwd || dirname(path), branch)) {
    getExecutor().runFile('git', ['worktree', 'add', '--', path, branch]);
  } else {
    assertSafeBaseRef(baseRef);
    getExecutor().runFile('git', ['worktree', 'add', '-b', branch, '--', path, baseRef]);
  }
  return path;
}

export function removeWorktree(path, { force = false } = {}) {
  const flag = force ? ' --force' : '';
  // `-C`-scoped, not a bare `git worktree remove`: the bare form depends on
  // process.cwd() being inside the repo, which is not guaranteed for an
  // unattended agent/phone-spawned invocation (the primary use case here).
  // Validation just above (in registerRemove) already uses `git -C
  // "${path}" worktree list`; this matches that.
  getExecutor().run(`git -C "${path}" worktree remove${flag} "${path}"`);
}

export function listWorktrees(cwd) {
  const out = getExecutor().runQuiet(`git -C "${cwd}" worktree list --porcelain`);
  if (!out) return [];
  const entries = [];
  let current = {};
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) entries.push(current);
      current = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace('refs/heads/', '');
    }
  }
  if (current.path) entries.push(current);
  return entries;
}

// `baseRef` here is one of the two SENTINEL strings callers pass, not a git ref
// itself. 'head' means "branch from the current HEAD"; 'fresh' means "branch
// from the repository's default branch on the remote", resolved via origin/HEAD.
// A caller passing a real ref does not come through here at all -- see
// registerCreate, which only translates the sentinels and hands anything else
// to git as written.
export function resolveBaseRef(cwd, baseRef) {
  if (baseRef === 'head') return 'HEAD';
  const head = getExecutor().runQuiet(`git -C "${cwd}" rev-parse --abbrev-ref origin/HEAD`);
  if (head) return head.trim();
  // Falls back silently otherwise -- a repo with no `origin` remote (or one
  // where `origin/HEAD` was never set, e.g. a fresh bare-remote clone) makes
  // every "fresh" worktree branch from local HEAD instead of the intended
  // default branch. That is a silent behavior change worth a stderr note,
  // not a hard failure -- HEAD is still a reasonable fallback.
  console.error('warning: origin/HEAD not found; falling back to HEAD as the base ref.');
  return 'HEAD';
}
