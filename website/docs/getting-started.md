---
title: 'Getting started'
sidebar_position: 2
description: 'Install the skill, have the agent run /rn-iso-init, then describe what you want built'
---

rn-iso is a CLI **humans never run** — your coding agent does. Setup is one
command, and it is the only one you type yourself.

## 1. Install the agent skill

```bash
npx skills add appandflow/rn-iso
```

That installs two skills into your agent's skill directory (`~/.claude/skills`,
`~/.agents/skills`): **rn-iso** — how to drive the CLI (the lifecycle, the
ownership model, the destructive-command rules) — and **rn-iso-init** — the
playbook for setting a repo up. Re-run the same command after upgrading rn-iso
to refresh them.

## 2. Have the agent set the project up

In your app's repo, invoke the init skill:

```
/rn-iso-init
```

The agent runs `rn-iso doctor` (read-only), then applies each finding by hand
in the files your project already owns: the shared Metro transform cache, the
local Expo build cache provider, the settings that silently prevent either
from working. There is deliberately no `rn-iso init` generator — every edit
lands in a file with existing project logic in it, which is judgement, not
templating.

## 3. Describe what you want

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
