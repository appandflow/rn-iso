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

The option copies safe gitignored paths, such as `node_modules`, `ios/Pods`, and
native build output. APFS clone copies remain space-efficient on one volume.
Stim reports when it must make a normal byte copy.

Stim excludes:

- Nested registered git worktrees.
- Any `.DerivedData` directory.
- Paths matched by `.worktreeexclude` or `worktree.exclude`.

Use `.worktreeinclude` or `worktree.include` to copy a small explicit set during
a normal create. This is useful for `.env` files. Stim only copies paths that
git already ignores.

Compatible uncommitted tracked changes are also applied with
`--carry-ignored`. Untracked files that are not ignored are not copied. Review
the reported working state before committing.

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
