---
title: 'Agent skill'
sidebar_position: 4
description: 'Install the small Stim workflow skill for coding agents'
---

Install the bundled skill from the repository:

```bash
npx skills add appandflow/stim
```

The installed skill is named `stim`. It teaches the stable workflow rules:

- Run `stim doctor` before native worktree work.
- Start Metro before a Debug build.
- Trust the exact device and launch facts that Stim reports.
- Query launch and runtime errors through `stim logs`.
- Treat worktree removal and garbage collection as destructive actions.
- Clean up owned resources when the task finishes.

The skill does not duplicate the full CLI manual. It asks `stim guide <topic>`
for flags, settings, error codes, remote behavior, and release behavior. Those
guides come from the installed CLI and stay aligned with its version.

Run the install command again after upgrading Stim. Installing a new npm version
does not replace a skill that another tool copied earlier.

Stim handles local build, install, launch, and readiness checks itself. The skill
does not require a device automation package. An agent can use one separately
when a task needs taps, text input, snapshots, screenshots, or recordings.
