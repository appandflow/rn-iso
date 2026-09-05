---
title: 'Agent skill'
sidebar_position: 4
description: 'Install the small Stim workflow skill for coding agents'
---

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim-cli`.

Install the bundled skill from the repository:

```bash
npx skills add appandflow/stim
```

The installed skill is named `stim`. It is a small discovery router that asks
the agent to load `stim guide agent` before using Stim. The normal workflow,
ownership rules, destructive-command rules, and routing to detailed topics all
come from the installed CLI and therefore match its version.

You normally ask for the outcome: "build and run the app on iOS", "show the
recent app errors", or "run this on my connected phone". Those requests match
the skill without naming Stim. Add "use Stim" only when you want to override a
project wrapper or another tool choice.

Stim uses the current checkout by default. Ask for a separate worktree when you
want isolated or parallel work; the agent may also choose one when the task
already requires that isolation.

Upgrading Stim also upgrades the guidance. The static skill does not need to be
reinstalled when commands or behavior change.

Stim handles local build, install, launch, and readiness checks itself. The skill
does not require a device automation package. An agent can use one separately
when a task needs taps, text input, snapshots, screenshots, or recordings.
