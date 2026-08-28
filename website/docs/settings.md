---
title: 'Settings'
sidebar_position: 1
description: 'The layered settings files and every key stim-cli reads'
---

`worktree create`, `start`, `ios` and `android` resolve settings from three layers, merged with the first match winning (nested objects merge key by key; arrays -- like `worktree.include` -- are replaced wholesale, never concatenated):

1. **Project settings** -- per absolute project path, stored in `~/.stim-cli/config.json`. Highest precedence.
2. **Repo settings** -- shared by every worktree of the same repository (keyed by the repo's git common dir), also stored in `~/.stim-cli/config.json`. Local to this machine.
3. **Committed settings** -- `.stim-cli.json` at the repo root, checked into git and shared with everyone who clones the repo. Lowest precedence, but the only layer that travels with the repo -- and, with the `config` command gone, normally the one you want.

The keys stim-cli reads are `ios.deviceType`, `ios.runtime`, `android.systemImage`, `worktreeDir`, `caches`, and, under `worktree`: `baseRef` (`"fresh"` or `"head"`), `include` (carry-over patterns, same role as `.worktreeinclude`) and `exclude` (the `--carry-ignored` skip list, same role as `.worktreeexclude`). **Anything else is ignored, and stim-cli warns about it by name on every run that resolves settings** -- a `worktree.install` pipeline, for instance, is not a key stim-cli reads. Example `.stim-cli.json`:

```json
{
  "ios": { "deviceType": "iPhone 17 Pro" },
  "worktree": {
    "baseRef": "fresh",
    "include": [".env", ".env.*"]
  }
}
```

**Never put secrets in `.stim-cli.json`.** It's committed to git and readable by anyone with repo access. Secrets belong in gitignored files (`.env` and friends) that `worktree create`'s carry-over feature copies into each new worktree -- that mechanism exists specifically so gitignored, secret-bearing files reach a fresh worktree without ever being committed to `.stim-cli.json` or anywhere else in git history.
