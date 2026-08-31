---
title: 'Why Stim'
sidebar_position: 1
description: 'Fast, isolated local React Native environments for coding agents'
---

Stim gives each coding agent a complete React Native environment. Each project
or git worktree gets a reserved Metro port and an owned simulator or emulator.
The agent can build, install, launch, inspect errors, and clean up through one
small command surface.

Stim supports React Native Community CLI and Expo projects. Builds run on the
local machine. Apps can run on local or configured remote simulators.

> Stim is a release candidate. Commands and on-disk state can change before the
> stable release. [Report an issue](https://github.com/appandflow/stim/issues)
> when a workflow does not behave as documented.

## Fast builds across worktrees

Stim fingerprints native inputs. A matching app installs from a shared artifact
cache instead of compiling again. Xcode compilation data, Gradle output, and
Metro transforms also use shared cache locations.

The cache works across different worktree paths. If two workspaces miss the
same artifact at the same time, Stim runs one native build. The other workspace
waits for that result.

## Parallel work without collisions

Normal React Native tools assume one developer controls one port and one device.
That assumption fails when several coding agents share a machine.

Stim gives every workspace a separate port and device. An agent can create a
worktree, run the app, and verify a change without using another agent's Metro
server or simulator. Parallel tasks remain independent while they share the
expensive caches.

## An interface designed for agents

Stim never prompts. Plain output streams the current phase and ends with the
device, app, Metro, cache, launch, and log facts. Build failures show the useful
compiler diagnostic and a log path. They do not place a full build transcript
in the agent context.

Every command also supports structured output where it is useful. The agent can
query `stim logs --errors` after a change instead of scraping a terminal. Less
noise means less waiting and fewer tokens.

## Owned resources and cleanup

Stim records the ports, processes, build output, devices, and remote sessions it
creates. It does not operate on physical devices or user-created simulators.

`stim stop` releases a live environment without deleting its local device.
`stim worktree remove` reclaims the worktree environment. `stim gc --delete`
removes orphaned resources. This ownership model makes cleanup safe after an
agent exits early.

## Why run locally

A local Mac already has Xcode, Android tools, simulator runtimes, credentials,
and access to private development services. Stim lets coding agents use that
existing setup with worktree isolation.

A cloud machine for each agent also removes the collisions, but it bills for
every build minute, and macOS runners cost the most. The machine on your desk
is already paid for, and it keeps most of its cores idle. Use that capacity
first. Send work to the cloud only when the local machine cannot hold it.

Shared caches raise how much the local machine can hold. The second and later
workspaces on one commit install a cached artifact instead of compiling again,
so each added agent costs less than the first. A new cloud runner starts cold
every time.

Local CPU, memory, and disk are finite. `stim doctor`, `stim status`, and
`stim gc` make those limits visible. Remote devices remain available when a
local simulator is not the right target.
