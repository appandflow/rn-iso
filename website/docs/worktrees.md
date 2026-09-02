---
title: 'Worktree isolation'
sidebar_position: 2
description: 'Parallel worktrees that share expensive build caches'
---

Stim places each created worktree in a sibling directory. A nested worktree can
confuse Metro, TypeScript, and other filesystem scanners even when git ignores
it.

```bash
stim worktree create feature-x
cd ../<repo>-worktrees/feature-x
```

The default base is the current checkout's `HEAD`. Use `--base fresh` for
`origin/HEAD`, or pass any branch, tag, or commit that git resolves.

`git worktree add` attaches to a branch named `worktree-<name>` when one
already exists, and ignores the base. So `--base` with an existing branch is
refused as `STIM_WORKTREE_BRANCH_EXISTS`, even when that branch currently sits
on the requested base: the agreement is luck, not the guarantee the flag is
for. Pick another name, or delete the branch and retry. Without `--base`,
attaching is still the behaviour, and the create says which branch it attached
to.

When `git worktree add` fails after git has created the branch, Stim deletes
that branch, so a retry branches from the base instead of attaching to a
leftover. It rolls back only a branch this create made, judged by whether the
run passed `-b` rather than by re-reading the refs afterwards.

## Carry a warm working state

```bash
stim worktree create feature-x --carry-ignored
```

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

```bash
stim stop
stim worktree remove
```

The remove command reclaims the environment, port, build output, and owned
device before it removes the linked worktree. It keeps branches with unique
commits. It refuses uncommitted, untracked, or unpushed work unless you pass
`--force`.

On the main checkout, `worktree remove` only reclaims the Stim environment. It
does not remove the source directory.
