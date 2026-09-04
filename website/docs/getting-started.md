---
title: 'Getting started'
sidebar_position: 2
description: 'Install Stim, add the agent skill, and run the first isolated app'
---

import StimTabs, { StimInstallTabs } from '@site/src/components/StimTabs';
import PromptBox, { PromptGrid } from '@site/src/components/PromptBox';

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

<PromptBox title="Build and run">
  {`Build and run the app on iOS. Fix any build or launch errors.`}
</PromptBox>

You normally do not need to name Stim. Installing the skill lets a compatible
agent route build, run, device, log, and worktree requests to Stim. Say "use
Stim" only when you want to force that choice instead of a project-specific
wrapper.

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

After a build, the agent should report only the exact device and app, launch
state, cache result, total duration, and whether the error log is clean. Ask for
build-performance details when you want history across runs.

## Common prompts

Each prompt has a copy button.

<PromptGrid>
  <PromptBox title="Choose an iOS simulator">
    {`Build and run the app on an iPhone 17 simulator with iOS 26.5. Fix any build or launch errors.`}
  </PromptBox>
  <PromptBox title="Run on a connected phone">
    {`Build and run the app on my connected iPhone. Tell me if I need to approve anything on the phone.`}
  </PromptBox>
  <PromptBox title="Inspect recent errors">
    {`Show me the app errors from the last 10 minutes and explain which ones need action.`}
  </PromptBox>
  <PromptBox title="Check the environment">
    {`Tell me which app build, device, and Metro server are active for this workspace.`}
  </PromptBox>
  <PromptBox title="Review build performance">
    {`Compare this project's iOS build performance: run count, cache hit rate, mean cold and cached duration, and estimated time saved.`}
  </PromptBox>
  <PromptBox title="Work in parallel">
    {`Make this change in a separate worktree, run it on iOS, and preserve the branch when you finish.`}
  </PromptBox>
  <PromptBox title="Record PR validation">
    {`Fix this issue in a separate worktree. Use agent-device to record the affected flow before the change, implement and run the fix on iOS, then record the same flow after the change. Open a PR with the Before and After recordings in a table and summarize the validation.`}
  </PromptBox>
</PromptGrid>

## Run work in parallel

The current checkout is the default. An agent creates a separate worktree only
when the task needs isolation or parallel work, or when you ask for one:

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
