---
title: 'Getting started'
sidebar_position: 2
description: 'Install the skill, then tell your agent what you want built.'
---

import StimTabs, { StimInstallTabs } from '@site/src/components/StimTabs';

stim-cli is a CLI **humans never run** — your coding agent does.

## 1. Install the agent skill

```bash
npx skills add appandflow/stim-cli
```

That installs one skill into your agent's skill directory (`~/.claude/skills`,
`~/.agents/skills`): **stim-cli** — how to drive the CLI (the lifecycle, the
ownership model, the destructive-command rules). Re-run the same command after
upgrading stim-cli to refresh it.

The package exports only `stim`. Global installation is the default below.
The selected tab applies to every command block on the website.

<StimInstallTabs />

## 2. Tell your agent what you want

```
Build and run the app on the iOS simulator and fix anything that breaks.
```

That's the whole interface. Under the hood the agent drives:

<StimTabs
code={`stim start             # dev server on a reserved port, under a supervisor
stim ios               # owned simulator, cached native build, launch
stim logs --errors     # no output + exit 0 = nothing is broken
stim stop              # supervisor down, sim shut down, port freed`}
/>

— its own dev server on a reserved port, its own **owned** simulator, a native
build that installs from the shared cache when nothing native changed, and a
queryable log timeline to check its work. About ten lines of output for the
whole cycle, `--json` everywhere.

Point it at a clean checkout and all of that works, caches included: the Xcode
compilation cache, Gradle's build cache and a shared Metro transform store ride
on the command lines stim-cli composes itself.

## If something is blocked or slow

<StimTabs code={`stim doctor`} />

Read-only, always exits 0, and it reports **only what stim-cli cannot handle on
its own** — a missing `expo-dev-client` (a native dependency: without it a
reserved port cannot reach the app), ccache (the one thing that makes stim-cli
skip its own compilation cache), a checkout that does not fingerprint like a
fresh worktree of HEAD (every worktree then misses the build cache), a
`buildCacheProvider` on a key your SDK ignores, a broken EAS session. Anything
else it prints is a note about builds you make _outside_ stim-cli (Xcode,
`npx expo run:ios`, Android Studio, CI), and is optional. A clean run means
there is nothing stim-cli needs from your repo.

## A second loop: a bug you can only see on screen

The cycle above ends at "it runs". Most tickets need one more thing — looking at
the app. stim-cli deliberately stops at the glass: it reports what built, what
launched and what errored, and nothing about what is drawn. Pair it with a
device tool for that half. The examples below use
[agent-device](https://agent-device.dev), which drives the simulator from the
same kind of small, JSON-shaped surface.

The join between the two is one field. `stim ios --json` reports the **owned**
simulator it installed onto — as `udid`, and as `deviceName`, the
`stim-cli-<label>` name it created the device under. Pass whichever the device
tool addresses devices by, explicitly, every time:

<StimTabs code={`device=$(stim ios --json | jq -r .deviceName)\nagent-device open com.example.app --device "$device" --foreground`} />

Never let a device tool pick "the booted one". On a machine running three
agents, three simulators are booted and only one is yours — that is the whole
reason stim-cli reports the device instead of letting anything assume it.

### The loop, on a real ticket

> The History tab groups hikes into month sections, and the sections come out
> alphabetically: "April 2026", then "August 2026", then "December 2025".
> Expected: newest first.

None of that is visible from a log. The build succeeds, nothing throws,
`logs --errors` is empty — and the screen is still wrong.

**1. Get an isolated app running.**

<StimTabs
code={`cd "$(stim worktree create history-order --carry-ignored)"
stim start
device=$(stim ios --json | jq -r .deviceName)`}
/>

On a second worktree of the same commit this costs a boot, not a build:
`fingerprint <hash> hit` and the app installs from the shared cache.

**2. Reproduce it.**

```bash
agent-device open com.example.app --device "$device" --foreground
agent-device click 'label="History, tab, 3 of 4"' --settle
```

The snapshot comes back with the section headers in reading order — "April
2026" above "December 2025" — so the bug arrives as data to assert on, not a
screenshot to squint at.

**3. Fix the code.** The sections were sorted by their label instead of their
date:

```diff
-  sections.sort((a, b) => a.title.localeCompare(b.title));
+  sections.sort((a, b) => b.data[0].startedAt.localeCompare(a.data[0].startedAt));
```

There is no stim-cli command in this step. Nothing native changed, so nothing
rebuilds — Fast Refresh has the new code on the simulator before you have
switched windows.

**4. Verify both halves.**

<StimTabs
code={`agent-device snapshot            # headers now read newest-first
stim logs --errors         # empty, exit 0 — the fix broke nothing`}
/>

Two different questions. The device tool answers "is the screen right now
correct", the log timeline answers "did fixing it break something quieter" — a
render loop, a failed bundle, a redbox on another tab. A loop that only asks the
first one ships regressions; a loop that only asks the second one never sees the
bug at all.

**5. Tear it down.**

<StimTabs
code={`stim stop
stim worktree remove`}
/>

`stop` shuts the owned simulator down and frees the port, so coming back to the
branch costs a boot rather than a rebuild. `worktree remove` reclaims the device
and the build artifacts along with the tree.

## Parallel agents

Each git worktree is its own environment — own port, own device — so two
agents build the same app side by side without fighting. Agents create and
tear these down themselves (`stim worktree create` / `remove`); teardown
reclaims the device, the port and the build artifacts with the tree.

## Where next

The [command reference](/docs/commands) documents everything the agent runs,
and the Concepts section covers the ownership model, the dev server, the
caches and worktrees — useful for understanding what is happening on your
machine, not because you need to type any of it.
