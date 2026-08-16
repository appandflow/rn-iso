import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { getExecutor } from './exec.js';

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
  const p = join(root, '.worktreeinclude');
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

// Only files that are BOTH matched by a pattern AND gitignored are copied, so
// tracked files are never duplicated into the worktree. Per-file failures are
// collected rather than thrown -- a single unreadable file must not abort
// worktree creation -- but they are returned (not swallowed) so the caller
// can warn about them.
export function carryOverFiles({ root, target, patterns }) {
  if (!patterns || patterns.length === 0) return { copied: [], failed: [] };
  const copied = [];
  const failed = [];
  for (const rel of listGitignoredFiles(root)) {
    if (!matchesInclude(rel, patterns)) continue;
    const from = join(root, rel);
    const to = join(target, rel);
    try {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      copied.push(rel);
    } catch (e) {
      failed.push({ file: rel, error: String(e?.message || e) });
    }
  }
  return { copied, failed };
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

export function addWorktree({ path, branch, baseRef }) {
  mkdirSync(dirname(path), { recursive: true });
  getExecutor().run(`git worktree add "${path}" -b "${branch}" "${baseRef}"`);
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

// `baseRef` here is one of the sentinel strings callers pass ('fresh' or
// 'head'), not a git ref itself. 'head' means "branch from the current
// HEAD"; anything else (in practice always 'fresh') means "branch from the
// repository's default branch on the remote", resolved via origin/HEAD.
export function resolveBaseRef(cwd, baseRef) {
  if (baseRef === 'head') return 'HEAD';
  const head = getExecutor().runQuiet(`git -C "${cwd}" rev-parse --abbrev-ref origin/HEAD`);
  return head ? head.trim() : 'HEAD';
}
