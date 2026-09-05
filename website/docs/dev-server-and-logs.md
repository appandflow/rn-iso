---
title: 'Dev server and logs'
sidebar_position: 4
description: 'A supervised Metro server and a queryable launch timeline'
---

import StimTabs from '@site/src/components/StimTabs';

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim-cli`.

`stim start` reserves a port for the workspace and starts its React Native or
Expo dev server under a detached supervisor. The command exits only after the
server answers and Stim verifies its project identity.

Bare React Native runs Metro in the supervisor. Expo runs the project's Expo CLI
as a supervised child. A healthy server that another process started for the
same project can be reused, but Stim cannot capture its full output.

## Launch readiness

`stim ios` and `stim android` open the installed app, then check launch
evidence. Debug runs observe Metro; when bundling finishes within the wait
window, Stim also observes three seconds of launch logs. The summary can report
that bundling is still in progress or that launch is unverified. Release runs
check process liveness without Metro.

Stim reports bundle, red-screen, and fatal launch errors when those signals are
available. These checks do not prove that a screen rendered correctly.

A nonfatal error still appears as launch evidence. The agent can read the error
and decide whether the change caused it.

## Query the timeline

<StimTabs
code={`stim logs --errors
stim logs --source client --since 5m
stim logs --follow --level warn
stim logs --errors --json`}
/>

The merged timeline includes Metro, client, device, and build records. Logs live
in the global workspace directory under `$STIM_HOME/workspaces`, not in the
project checkout.

Exit code 0 means the query succeeded, including when it prints errors. A clean
`stim logs --errors` check requires exit code 0 and no matching errors in the
captured logs. Human mode prints `No matching log records` on stderr for zero
matches; JSON mode writes NDJSON and writes zero bytes for zero matches. An
empty result does not prove launch or log capture succeeded: a workspace with
no log directory also returns an empty result.

`stim stop` ends the supervisor and log collectors. It also frees the reserved
port and shuts down the owned local device.
