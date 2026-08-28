---
title: 'Why stim-cli exists'
sidebar_position: 1
description: 'What breaks when coding agents share one machine, and what stim-cli does about it'
---

The React Native / Expo CLI for AI agents. One isolated dev environment per project or worktree: `stim-cli start` runs the dev server on a reserved, collision-free Metro port under a detached supervisor; `stim-cli ios` / `stim-cli android` boot a dedicated, **owned** simulator/emulator, install a build from a shared fingerprint cache when nothing native changed, and launch the app wired to that port; `stim-cli logs --errors` answers "did that work" from a captured timeline instead of a scraped terminal. Multiple worktrees or coding agents can each get their own environment and build the same app in parallel without port or device collisions.

It never prompts, prints on the order of ten lines, takes `--json` everywhere, and reports a failing build as the _extracted_ compiler diagnostic plus a log path rather than four thousand lines of transcript.

> **Experimental.** APIs, flags, and on-disk state may change. [File issues](https://github.com/appandflow/stim-cli/issues) if anything breaks.

## The problem

Coding agents are moving to the cloud, and React Native is one of the places
that goes badly. A cloud agent needs macOS, a matching Xcode, a booted
simulator, a signing identity, and every MCP server re-authenticated -- on
runners that cost several times a Linux box and lag Xcode releases by months.
Physical devices are simply out of reach.

Locally, none of that is a problem. The environment is already set up, the
Mac is already paid for, simulators work, you are already logged into
everything, and the agent harness already provides the isolation that a cloud
sandbox is there to provide.

What breaks locally is that agents share one machine. Two of them reach for
port 8081, or the same booted simulator, and both end up talking to the wrong
bundler -- silently, because nothing tells you a build attached to somebody
else's Metro. When an agent is killed mid-run it leaves a simulator booted, a
Metro squatting on a port, and an `xcodebuild` test runner pinning a device
nothing can now delete.

That is the first job of this tool: arbitrate the contended resources, and
reclaim them when the agent that owned them dies badly. The second is the dev
server, which every agent otherwise backgrounds by hand and then scrapes a log
file for: `start` runs it on the reserved port and captures its output as
structured records, so `logs --errors` replaces the scraping. What stays out is
the build -- which command, which flags, when to install -- because that is
judgment a coding agent already has from reading the repo, and stim-cli
deliberately does not take it back.

### Where local honestly loses

- **CPU and memory are finite.** Two or three live environments on a 16 GB
  machine, not ten. Cloud wins this outright.
- **Paths are not stable.** CI checks out to the same path every run, so
  path-keyed caches (ccache, Xcode's compilation cache, a CocoaPods sandbox)
  just work. Locally every worktree sits somewhere different, and those caches
  quietly miss everything -- measured on one project as 0 ccache hits out of
  1094 across two workspaces. It is fixable, but it is a tax cloud does not pay.
- **Disk grows without bound.** Simulators and the shared caches that make any
  of this fast all accumulate. `gc` exists for that reason.

State lives in `~/.stim-cli/config.json`, keyed by absolute project path. Worktrees count as separate projects. There is no shared mutex -- each project gets its own port and its own device.
