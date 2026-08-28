---
title: 'Getting started'
sidebar_position: 2
description: 'Install the skill, then describe what you want built. rn-iso needs no changes to your repo.'
---

rn-iso is a CLI **humans never run** — your coding agent does. There are two
steps, and **rn-iso needs no changes to your repo**: point it at a clean
checkout and the whole loop works, caches included. Trying it out costs no PR.

## 1. Install the agent skill

```bash
npx skills add appandflow/rn-iso
```

That installs one skill into your agent's skill directory (`~/.claude/skills`,
`~/.agents/skills`): **rn-iso** — how to drive the CLI (the lifecycle, the
ownership model, the destructive-command rules). Re-run the same command after
upgrading rn-iso to refresh it.

## 2. Describe what you want

```
Build and run the app on the iOS simulator and fix anything that breaks.
```

That's the whole interface. Under the hood the agent drives:

```bash
npx rn-iso start             # dev server on a reserved port, under a supervisor
npx rn-iso ios               # owned simulator, cached native build, launch
npx rn-iso logs --errors     # no output + exit 0 = nothing is broken
npx rn-iso stop              # supervisor down, sim shut down, port freed
```

— its own dev server on a reserved port, its own **owned** simulator,
a native build that installs from the shared cache when nothing native
changed, and a queryable log timeline to check its work. About ten lines of
output for the whole cycle, `--json` everywhere.

There is no setup step and no init command. The Xcode compilation cache,
Gradle's build cache and a shared Metro transform store all ride on the command
lines rn-iso composes itself, so none of them is a file you have to commit.

## If something is blocked or slow

```bash
npx rn-iso doctor
```

Read-only, always exits 0, and it reports **only what rn-iso cannot handle on
its own** — a missing `expo-dev-client` (a native dependency: without it a
reserved port cannot reach the app), ccache (the one thing that makes rn-iso
skip its own compilation cache), a checkout that does not fingerprint like a
fresh worktree of HEAD (every worktree then misses the build cache), a
`buildCacheProvider` on a key your SDK ignores, a broken EAS session. Anything
else it prints is a note about builds you make _outside_ rn-iso (Xcode,
`npx expo run:ios`, Android Studio, CI), and is optional. A clean run means
there is nothing rn-iso needs from your repo.

## A second loop: a bug you can only see on screen

The cycle above ends at "it runs". Most tickets need one more thing — looking at
the app. rn-iso deliberately stops at the glass: it reports what built, what
launched and what errored, and nothing about what is drawn. Pair it with a
device tool for that half. The examples below use
[agent-device](https://agent-device.dev), which drives the simulator from the
same kind of small, JSON-shaped surface.

The join between the two is one field. `rn-iso ios --json` reports the **owned**
simulator it installed onto — as `udid`, and as `deviceName`, the
`rn-iso-<label>` name it created the device under. Pass whichever the device
tool addresses devices by, explicitly, every time:

```bash
device=$(npx rn-iso ios --json | jq -r .deviceName)
agent-device open com.example.app --device "$device" --foreground
```

Never let a device tool pick "the booted one". On a machine running three
agents, three simulators are booted and only one is yours — that is the whole
reason rn-iso reports the device instead of letting anything assume it.

### The loop, on a real ticket

> The History tab groups hikes into month sections, and the sections come out
> alphabetically: "April 2026", then "August 2026", then "December 2025".
> Expected: newest first.

None of that is visible from a log. The build succeeds, nothing throws,
`logs --errors` is empty — and the screen is still wrong.

**1. Get an isolated app running.**

```bash
cd "$(npx rn-iso worktree create history-order --carry-ignored)"
npx rn-iso start
device=$(npx rn-iso ios --json | jq -r .deviceName)
```

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

There is no rn-iso command in this step. Nothing native changed, so nothing
rebuilds — Fast Refresh has the new code on the simulator before you have
switched windows.

**4. Verify both halves.**

```bash
agent-device snapshot            # headers now read newest-first
npx rn-iso logs --errors         # empty, exit 0 — the fix broke nothing
```

Two different questions. The device tool answers "is the screen right now
correct", the log timeline answers "did fixing it break something quieter" — a
render loop, a failed bundle, a redbox on another tab. A loop that only asks the
first one ships regressions; a loop that only asks the second one never sees the
bug at all.

**5. Tear it down.**

```bash
npx rn-iso stop
npx rn-iso worktree remove
```

`stop` shuts the owned simulator down and frees the port, so coming back to the
branch costs a boot rather than a rebuild. `worktree remove` reclaims the device
and the build artifacts along with the tree.

## Parallel agents

Each git worktree is its own environment — own port, own device — so two
agents build the same app side by side without fighting. Agents create and
tear these down themselves (`rn-iso worktree create` / `remove`); teardown
reclaims the device, the port and the build artifacts with the tree.

## Where next

The [command reference](/docs/commands) documents everything the agent runs,
and the Concepts section covers the ownership model, the dev server, the
caches and worktrees — useful for understanding what is happening on your
machine, not because you need to type any of it.
