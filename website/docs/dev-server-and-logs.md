---
title: 'Dev server and logs'
sidebar_position: 4
description: 'A supervised Metro server and a queryable launch timeline'
---

`stim start` reserves a port for the workspace and starts its React Native or
Expo dev server under a detached supervisor. The command exits only after the
server answers and Stim verifies its project identity.

Bare React Native runs Metro in the supervisor. Expo runs the project's Expo CLI
as a supervised child. A healthy server that another process started for the
same project can be reused, but Stim cannot capture its full output.

## Launch readiness

For Debug builds, `stim ios` and `stim android` wait for Metro to finish the
requested bundle. Stim then opens the app and observes the first three seconds
of launch logs. It checks process liveness and reports bundle, red-screen, and
fatal launch errors when those signals are available.

A nonfatal error still appears as launch evidence. The agent can read the error
and decide whether the change caused it.

## Query the timeline

```bash
stim logs --errors
stim logs --source client --since 5m
stim logs --follow --level warn
stim logs --errors --json
```

The merged timeline includes Metro, client, device, and build records. Logs live
in the global workspace directory under `$STIM_HOME/workspaces`, not in the
project checkout.

No matching records is a successful result with exit code 0. JSON mode writes
NDJSON and writes zero bytes for zero matches.

`stim stop` ends the supervisor and log collectors. It also frees the reserved
port and shuts down the owned local device.
