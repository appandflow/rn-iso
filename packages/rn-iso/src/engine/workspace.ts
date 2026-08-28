// src/engine/workspace.ts -- the one thing every command that fills
// `<root>/.rn-iso` has to guarantee about it first: that git ignores it.
//
// This used to be `rn-iso init`'s job, which made it a step a repo had to
// remember before its first build, and forgetting it was loud in the worst way:
// a `git status` full of derived data, and a `worktree remove` that refused
// because of `?? .rn-iso/`. It never needed to be a decision. The directory
// holds this checkout's build output, its logs and a supervisor pidfile, all
// location-addressed and meaningless anywhere else, so there is no repo for
// which committing it is right and nothing to ask.
//
// So the commands that create the directory ensure the entry themselves --
// `start` here, and `ios` / `android` at their own call sites -- which is why
// this has to be idempotent, content-based, and cheap enough to run on every
// invocation.
//
// WHERE the entry goes changed in #79: `.git/info/exclude`, not the project's
// `.gitignore`. Git honours the two identically, but the exclude file is
// per-clone and NEVER TRACKED, so the last tracked-file write rn-iso made is
// gone: nothing shows up in `git status`, nothing has to be committed, nothing
// is carried into a worktree as part of the uncommitted-changes patch, and
// `worktree remove` has nothing of rn-iso's to restore. It lives in the COMMON
// git dir, so one write covers the main checkout and every worktree of the
// repo at once.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getExecutor } from '../exec.ts';
import { WORKSPACE_DIR_NAME as WORKSPACE_DIR } from '../paths.ts';

// Appended rather than generated: the exclude file belongs to whoever owns the
// clone, and rn-iso's business with it ends at this one entry.
//
// The text is BYTE-STABLE on purpose. `commands/worktree.ts` matches it against
// `.gitignore` blocks that OLDER rn-iso versions appended, so changing these
// lines would strand every tree that already carries one.
export function renderWorkspaceIgnoreBlock(): string {
  return `# rn-iso: this workspace's build output, logs and supervisor pidfile.
# Location-addressed -- meaningful only to the checkout that produced it, so it
# dies with the worktree instead of being reverse-mapped out of a global cache.
${WORKSPACE_DIR}/
`;
}

// PURE. Whether an ignore file already lists the workspace directory.
//
// Matched as a path rather than as the literal template text, because
// `/.rn-iso`, `.rn-iso` and `.rn-iso/` are one entry to git and a file that
// already carries any of them needs nothing added -- appending a second form
// would be noise that survives forever. `src/doctor.ts` reads a .gitignore the
// same way; keep the two in step.
export function listsWorkspaceDir(source: unknown): boolean {
  return String(source || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .some((line) => line.replace(/^\/+/, '').replace(/\/+$/, '') === WORKSPACE_DIR);
}

// Git's own verdict on the workspace directory, and the ONE predicate for it --
// `doctor` imports this rather than asking a second time its own way
// (appandflow/rn-iso#31 taught it to ask git at all; #79 made the writer ask
// the same question before writing).
//
// It sees every source of ignore rules at once: a committed `.gitignore` entry,
// a parent's (a monorepo app dir covered by the REPO ROOT's file is properly
// ignored though its own file never says so), and the exclude file this module
// writes. `check-ignore` exits 0 for ignored, 1 for not, 128 outside a repo;
// runQuiet nulls the failures, so only a definite "ignored" comes back true.
//
// THE TRAILING SLASH IS LOAD-BEARING, and only real git says so. `check-ignore`
// does not stat the filesystem: it decides from the pathname alone whether it
// is looking at a directory, so a bare `.rn-iso` is a FILE to it and the
// directory-only pattern `.rn-iso/` -- the form nearly every repo commits, and
// the form this module writes -- does not match. That is precisely the case
// that matters, because this runs BEFORE the directory exists. With the slash,
// both `.rn-iso` and `.rn-iso/` patterns match, existing or not.
export function gitIgnoresWorkspaceDir(projectRoot: string): boolean {
  return (
    getExecutor().runQuiet(`git -C ${JSON.stringify(projectRoot)} check-ignore ${WORKSPACE_DIR}/`, {
      timeoutMs: 10000,
    }) != null
  );
}

// The exclude file's directory, asked of git rather than assumed.
//
// NEVER build this from `<root>/.git`: in a linked worktree `.git` is a FILE
// holding a gitdir pointer, and the per-worktree dir it points at is not where
// `info/exclude` is read from anyway. `--git-common-dir` answers with the dir
// SHARED by the main checkout and every worktree, which is exactly why one
// write covers all of them. Output is relative to the `-C` directory in a main
// checkout (`.git`) and absolute from a worktree, so resolve it either way.
function gitCommonDir(projectRoot: string): string | null {
  const out = getExecutor().runQuiet(`git -C ${JSON.stringify(projectRoot)} rev-parse --git-common-dir`, {
    timeoutMs: 10000,
  });
  if (!out) return null;
  return resolve(projectRoot, out.trim());
}

export interface WorkspaceIgnoreResult {
  // The exclude file, or null when there is no git repo to write one in.
  path: string | null;
  added: boolean;
  error: string | null;
}

// Idempotent. Adds the entry when git does not already ignore the directory,
// and reports whether it did so, so the caller can say so once.
//
// Three cases end in silence, and each is deliberate:
//   - not a git repo: there is no `git status` to keep readable, so there is
//     nothing to do and nothing worth saying;
//   - already ignored by ANY source git honours -- a committed `.gitignore`
//     entry, a parent's, a line this already wrote -- because a repo that
//     ignores the directory needs nothing from rn-iso;
//   - the entry already sits in the exclude file's own text, which is the same
//     answer arrived at without git in case check-ignore could not run.
//
// An exclude file that cannot be written is a note, never a failure: the
// commands calling this are starting a dev server or a build, and neither has
// any business dying because a checkout is read-only. The error comes back on
// the result instead.
export function ensureWorkspaceIgnored(projectRoot: string): WorkspaceIgnoreResult {
  const commonDir = gitCommonDir(projectRoot);
  if (!commonDir) return { path: null, added: false, error: null };

  const path = join(commonDir, 'info', 'exclude');
  if (gitIgnoresWorkspaceDir(projectRoot)) return { path, added: false, error: null };

  let existing = '';
  try {
    if (existsSync(path)) existing = readFileSync(path, 'utf-8');
  } catch (e) {
    return { path, added: false, error: String((e as Error)?.message || e) };
  }
  if (listsWorkspaceDir(existing)) return { path, added: false, error: null };

  // A blank line before the block when there is something to separate it from,
  // and a newline first if the file did not end with one. `git init` seeds this
  // file with a comment header, so "something to separate it from" is the norm.
  const separator = existing === '' ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, existing + separator + renderWorkspaceIgnoreBlock());
  } catch (e) {
    return { path, added: false, error: String((e as Error)?.message || e) };
  }
  return { path, added: true, error: null };
}
