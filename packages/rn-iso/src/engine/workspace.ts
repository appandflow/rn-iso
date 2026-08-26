// src/engine/workspace.js -- the one thing every command that fills
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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_DIR_NAME as WORKSPACE_DIR } from '../paths.ts';

// Appended rather than generated: .gitignore belongs to the repo, and by the
// second week its contents are none of rn-iso's business.
export function renderWorkspaceIgnoreBlock() {
  return `# rn-iso: this workspace's build output, logs and supervisor pidfile.
# Location-addressed -- meaningful only to the checkout that produced it, so it
# dies with the worktree instead of being reverse-mapped out of a global cache.
${WORKSPACE_DIR}/
`;
}

// PURE. Whether a .gitignore already ignores the workspace directory.
//
// Matched as a path rather than as the literal template text, because
// `/.rn-iso`, `.rn-iso` and `.rn-iso/` are one entry to git and a repo that
// already carries any of them needs nothing added -- appending a second form
// would be noise that survives forever. `src/doctor.js` reads the same file the
// same way; keep the two in step.
export function listsWorkspaceDir(source: unknown) {
  return String(source || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .some(line => line.replace(/^\/+/, '').replace(/\/+$/, '') === WORKSPACE_DIR);
}

// Idempotent. Adds the entry when it is missing, creates the file when there is
// none, and reports which of those happened so the caller can say so once.
//
// A .gitignore that cannot be written is a note, never a failure: the commands
// calling this are starting a dev server or a build, and neither has any
// business dying because a repo is checked out read-only. The error comes back
// on the result instead.
export function ensureWorkspaceIgnored(projectRoot: string) {
  const path = join(projectRoot, '.gitignore');
  let existing = '';
  try {
    if (existsSync(path)) existing = readFileSync(path, 'utf-8');
  } catch (e) {
    return { path, added: false, error: String((e as Error)?.message || e) };
  }
  if (listsWorkspaceDir(existing)) return { path, added: false, error: null };

  // A blank line before the block when there is something to separate it from,
  // and a newline first if the file did not end with one.
  const separator = existing === '' ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  try {
    writeFileSync(path, existing + separator + renderWorkspaceIgnoreBlock());
  } catch (e) {
    return { path, added: false, error: String((e as Error)?.message || e) };
  }
  return { path, added: true, error: null };
}
