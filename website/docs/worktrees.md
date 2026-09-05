---
title: 'Worktree isolation'
sidebar_position: 2
description: 'Parallel worktrees that share expensive build caches'
---

import StimTabs from '@site/src/components/StimTabs';

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim-cli`.

Stim creates worktrees under a sibling `<repo>-worktrees/` directory by default.
Override it with `worktreeDir` or `--dir`. Nested worktrees can confuse Metro,
TypeScript, and other filesystem scanners even when git ignores them.

<StimTabs
code={`stim worktree create feature-x
cd <printed-path>`}
/>

The default base is the current checkout's `HEAD` unless `worktree.baseRef` is
set. Use `--base fresh` for `origin/HEAD`, or pass any branch, tag, or commit
that git resolves.

If `worktree-<name>` already exists, Stim attaches to it and reports the branch.
Passing `--base` in that case refuses with `STIM_WORKTREE_BRANCH_EXISTS`:
attaching to an existing branch cannot guarantee the requested starting point.
Pick another name to create a branch from that base.

When `git worktree add` fails after git has created the branch, Stim deletes
only the branch created by that attempt so a retry can use the requested base.

## Carry a warm working state

<StimTabs
code={`stim worktree create feature-x --carry-ignored`}
/>

If a harness or `git worktree add` already created the linked worktree, run
this inside it instead:

<StimTabs code={`stim worktree warm`} />

Warm uses the repository's main checkout as its source, regardless of either
branch's `HEAD`. The main checkout must still be available. It preserves the
current branch, tracked files, and every existing destination entry, including
dangling symlinks. An existing directory such as `node_modules` is skipped
whole; warm does not fill missing children. It also skips destination paths
that overlap registered nested worktrees or have symlink ancestors.

Both operations copy safe gitignored paths, such as `node_modules`, `ios/Pods`, and
native build output, `.env`, and local configuration files. APFS clone copies remain space-efficient on one volume.
Stim reports when it must make a normal byte copy.

Stim excludes:

- Nested registered git worktrees.
- Any `.DerivedData` directory.
- Paths matched by the source checkout's nonempty `.worktreeexclude`, or its
  resolved `worktree.exclude` setting when that file is absent or empty. Warm
  reads both from main; create reads both from its current source checkout.

Use `.worktreeinclude` or `worktree.include` to copy a small explicit set during
a normal create. This is useful for `.env` files. Stim only copies paths that
git already ignores.

Compatible uncommitted tracked changes are also applied with
`--carry-ignored`. Untracked files that are not ignored are not copied. Review
the reported working state before committing.

Warm writes only to stderr: copied, kept, and failed entry counts, plus any
lockfile remedies. A failure exits 1; files already published remain. Inspect
the named failure before retrying, because a partially published directory is
kept on retry. A completed copy does not prove dependencies are installed or
match the current branch. Install missing dependencies with the project's
package manager when the source has none to copy.

## Parallel environments

Each worktree receives a unique label, Metro port, state directory, and owned
device. Build and Metro caches remain shared. Several agents can therefore work
in parallel without sharing live resources.

`stim status` shows created and unprovisioned worktrees with their environment
state.

## Remove a worktree

<StimTabs
code={`stim stop
stim worktree remove`}
/>

The remove command reclaims the environment, port, build output, and owned
device before it removes the linked worktree. It parks the iOS simulator when
parking is enabled and deletes owned Android emulators. It keeps branches with
unique commits. It refuses uncommitted, untracked, or unpushed work unless you
pass `--force`.

On the main checkout, `worktree remove` only reclaims the Stim environment. It
does not remove the source directory.
