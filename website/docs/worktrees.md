---
title: 'Worktrees'
sidebar_position: 4
description: 'Isolated git worktrees with carried gitignored files, and teardown that reclaims everything'
---

```bash
npx --package=stim-cli stim worktree create feature-x        # creates ../<repo>-worktrees/feature-x
npx --package=stim-cli stim worktree remove                  # removes it, deleting its owned device(s) and freeing its Metro port
```

`worktree create <name>` does three things in one step: creates the git worktree itself (branched `worktree-<name>` off `origin/HEAD` by default -- pass `--base head` to branch off the current `HEAD` instead), carries over gitignored files (see "Carry-over" below), and registers a label for the worktree root so `stim-cli` shortcuts don't collide across a monorepo's worktrees (every worktree of a monorepo shares the same app-dir basename). Prefer it over a raw `git worktree add` for that reason. It prints only the resulting worktree path to stdout; everything else goes to stderr (see "Wiring into Claude Code" below).

It deliberately does **not** install dependencies. Which commands a repo actually needs -- a plain install, a workspace filter, a codegen step after it -- is project-specific judgment. Install them yourself (or from your agent) before building, or use `--carry-ignored` to clone the source worktree's `node_modules`.

`worktree remove [<path>]` defaults to the current workspace. It reclaims the worktree's build artifacts, Metro port, and every owned device registered under it (deleting them, not just clearing the claim -- the environment dies whole) before removing the git worktree itself. It refuses if the worktree has uncommitted changes, untracked files, or commits that exist on no remote -- pass `--force` to override, but note `--force` only discards uncommitted/untracked state; committed work stays safe on the branch either way.

There is no `worktree list`: `stim status` shows the same worktrees _with_ their devices, ports and supervisors, including ones that have no environment yet.

### Carry-over

Gitignored files (like `.env`, local certs, or IDE state) don't exist in a fresh worktree by default. `worktree create` copies any gitignored file matching a pattern from either:

- `.worktreeinclude` at the repo root -- one gitignore-style pattern per line (`#` comments allowed), e.g.:
  ```
  .env
  .env.*
  **/*.local.json
  ```
- or the `worktree.include` setting (see "Settings" below), if no `.worktreeinclude` file exists.

Only files that are both gitignored and pattern-matched are copied -- tracked files are never duplicated into the worktree.

#### `--carry-ignored`

That carry-over is file-by-file, which suits a handful of small config files but not the multi-gigabyte trees a worktree needs in order to build without reinstalling. `worktree create --carry-ignored` instead clones **every** gitignored path -- `node_modules`, `ios/Pods`, `ios/build` (React Native codegen output, without which `xcodebuild` fails on a missing `States.cpp` until `pod install` regenerates it) -- minus:

- `.stim-cli/`, at any depth, **always**. It holds the workspace's own derived data, logs and supervisor pidfile: build output keyed to a path the new worktree does not have, and a pidfile for a process that is not running. That exclusion is in code, and no pattern file can turn it off.
- anything matching `.worktreeexclude` at the repo root, same gitignore-style syntax as `.worktreeinclude`, e.g.:
  ```
  bench/results/logs
  ```
- or the `worktree.exclude` setting, if no `.worktreeexclude` file exists.

It is a skip list rather than a copy list on purpose: forgetting to name something you needed shows up months later as a confusing build error, while forgetting to skip something only costs a needless copy.

Each path is cloned with `cp -Rc`, so on APFS the copy is copy-on-write -- a 3.6 GB tree costs roughly 12s and tens of MB of real disk. Off by default because that only holds on APFS, within one volume: elsewhere the clone is refused and the fallback is a real copy of every byte, which `worktree create` warns about.

Cloned dependencies match the source worktree, not necessarily the new branch's manifests -- the same contract as restoring a CI cache. Reinstall if the branch changes them.

`--carry-ignored` carries the source's **working state**, not just its gitignored trees: after the clone it also carries the source tree's uncommitted **tracked** changes (`git diff HEAD --binary`, checked with `git apply --check` and then applied), because the cloned artifacts were installed and fingerprinted against that working tree, not against a clean HEAD. When the patch applies, the worktree says so on stderr and leaves the changes uncommitted:

```
Carried 2 uncommitted change(s) from the source (app.json, ios/Podfile.lock) -- uncommitted here too; commit deliberately.
```

When the worktree's `--base` diverges from the source HEAD and the patch does not apply, **nothing is changed** and a warning names the files instead: the carried artifacts were installed for the source's uncommitted state, so fingerprints and cache keys in the worktree will differ from the source's until the two are reconciled. Untracked (non-ignored) files are not carried, same as always -- and a plain `worktree create` without the flag stays pure HEAD: no clone, no diff carry, no warning.

### Why worktrees live next to the repo, not inside it

`worktree create` places new worktrees in a sibling directory (`../<repo>-worktrees/<name>`), never under the repo root. A worktree nested inside the repo puts a second copy of every `package.json` inside Metro's watch root, which causes jest-haste-map naming collisions (two files claiming the same module name). Its multi-gigabyte `node_modules` also gets walked by Metro, TypeScript, and ESLint on every run. Gitignoring the nested worktree directory does not fix either problem: those tools walk the filesystem directly, not `git`, so a `.gitignore` entry is invisible to them.

### Wiring into Claude Code (`WorktreeCreate` hook)

Claude Code's `WorktreeCreate` hook fires when a session for a new worktree starts, and uses the hook command's stdout as the directory for that session. `stim worktree create` is built for exactly this contract -- it prints only the resulting path to stdout, and everything else goes to stderr. Wire it in `.claude/settings.json`:

```json
{
  "hooks": {
    "WorktreeCreate": [{ "hooks": [{ "type": "command", "command": "stim worktree create \"$(jq -r .name)\"" }] }]
  }
}
```
