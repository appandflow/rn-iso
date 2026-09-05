---
title: 'Worktree isolation'
sidebar_position: 2
description: 'Parallel worktrees that share expensive build caches'
---

import StimTabs from '@site/src/components/StimTabs';

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim-cli`.

## Create with Git

Use Git to choose the branch, path, and starting commit. Prefer a sibling
worktree directory: nested worktrees can confuse Metro, TypeScript, and other
filesystem scanners even when Git ignores them.

<StimTabs
code={`git worktree add -b feature-x ../feature-x HEAD
cd ../feature-x
stim worktree warm`}
/>

If a harness already created the linked worktree, skip Git creation and run
`stim worktree warm` there.

## Warm ignored state

Warm uses the repository's main checkout as its source, regardless of either
branch's `HEAD`. The main checkout must still be available. It copies missing
ignored entries, including installed dependencies, Pods, native build output,
`.env`, and local configuration files. APFS clones keep copies space-efficient
where supported; a normal byte copy is used when cloning is unavailable.

Warm preserves the current branch, tracked files, and every existing
destination entry, including dangling symlinks. An existing ignored directory
such as `node_modules` is skipped whole; warm does not fill missing children.
Untracked files that Git does not ignore are not copied.

Stim excludes:

- Nested registered Git worktrees, including ignored parents containing them.
- Any `.DerivedData` directory.
- Paths matched by main's nonempty `.worktreeexclude`, or its resolved
  `worktree.exclude` setting when that file is absent or empty.
- Destination paths that overlap a registered nested worktree or have symlink
  ancestors.

Warm writes only to stderr: copied, kept, and failed entry counts, plus any
lockfile remedies. A failure exits 1; files already published remain. Inspect
the named failure before retrying, because a partially published directory is
kept on retry. A completed copy does not prove dependencies are installed or
match the current branch. Install missing dependencies with the project's
package manager when main has none to copy.

## Parallel environments

Each workspace receives a unique Metro port, state directory, and owned
device when Stim starts and runs the app. Build and Metro caches remain shared.
Several agents can work in parallel without sharing live resources.

`stim status` shows linked worktrees with their environment state, including
those with no Stim environment yet.

## Remove a worktree

<StimTabs
code={`stim stop
stim worktree remove`}
/>

Removal works with any linked worktree, warmed or not. Git registration
identifies the worktree; no Stim registry entry is required. The command
reclaims any owned resources before removing the linked checkout. It parks
the iOS simulator when parking is enabled and deletes owned Android emulators.
It refuses uncommitted, untracked, or unpushed work unless you pass `--force`.

Git-created branches stay. An existing Stim ownership record permits deleting
a branch only when it has no unique commits.

On the main checkout, `worktree remove` only reclaims the Stim environment. It
does not remove the source directory.
