---
title: 'Getting started'
sidebar_position: 2
description: 'Install Stim, add the agent skill, and run the first isolated app'
---

import StimTabs, { StimInstallTabs } from '@site/src/components/StimTabs';

## Install Stim

Install the CLI once. The package name remains `stim-cli`, but the installed
command is `stim`.

<StimInstallTabs />

Install the bundled skill for your coding agent:

```bash
npx skills add appandflow/stim
```

The skill stays small and asks the installed CLI for version-specific guidance,
so upgrading Stim does not require reinstalling the skill.

## Ask the agent to run the app

Give the agent an outcome, not a command sequence:

```text
Build and run the app on the iOS simulator. Fix any build or launch errors.
```

The agent normally runs:

<StimTabs
code={`stim doctor           # inspect the main checkout and warm-state gaps
stim start            # start this workspace's dev server
stim ios              # build or restore, install, launch, and verify
stim logs --errors    # no matching records means the launch is healthy
stim stop             # release the live environment`}
/>

Use `stim android` for Android. Stim works with React Native Community CLI and
Expo projects. It needs no project initialization and writes no runtime state
into the repository.

## Run work in parallel

An agent can create a separate worktree when a task needs isolation:

<StimTabs
code={`stim worktree create feature-name --carry-ignored
cd <path-printed-by-stim>
stim start
stim ios

# After the work is preserved:

stim stop
stim worktree remove`}
/>

`--carry-ignored` copies safe ignored dependencies and native outputs from the
source checkout. This can make the first worktree build much faster. Stim skips
nested git worktrees and patterns in `.worktreeexclude`.

The worktree gets a separate port and device. It can still use native and Metro
cache entries created by the main checkout or another worktree.

## What success means

`stim ios` and `stim android` exit after the app is installed, opened, and
checked for three seconds after Metro finishes the bundle. The final summary
reports the exact device, app identifier, cache result, Metro state, launch
state, and log path.

Use a device automation tool only when the task requires visual interaction or
a screenshot. Stim owns the build and launch. It does not require a separate
device tool for that workflow.

## Next steps

- Read [Why Stim](/docs/why) for the design and benefits.
- Read the concept guides for caches, devices, logs, and worktrees.
- Use the [command reference](/docs/commands) for every command and option.
- Run `stim guide` for reference text that matches the installed version.
