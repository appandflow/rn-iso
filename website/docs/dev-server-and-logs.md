---
title: 'The dev server and logs'
sidebar_position: 2
description: 'A detached per-workspace supervisor, and a queryable NDJSON timeline instead of a scraped terminal'
---

`rn-iso start` runs the dev server for you, on the port it reserves for this workspace, under a **detached per-workspace supervisor**. It blocks until the server both answers and verifies as this project's (the same identity check teardown uses, never a bare port probe), then exits leaving it running:

```bash
npx rn-iso start --json
# {"port":8082,"supervisorPid":41233,"mode":"bare-inproc","logsDir":"/path/.rn-iso/logs","alreadyRunning":false}
```

It has two flags and will not grow more: `--json` and `--wait <seconds>` (default 60). Anything a project needs beyond that belongs in its own bundler command. Running `start` twice leaves one supervisor -- a healthy dev server on the port is a no-op, including one you started yourself, which is reported with `supervisorPid: null` and left alone rather than fought over.

There is no machine-wide daemon: one supervisor process per workspace, recorded in `<root>/.rn-iso/state.json` and in the registry before it starts serving, and gone (with its records) on any exit path. Two modes:

- **`bare-inproc`** -- bare React Native: Metro is hosted _inside_ the supervisor, loaded from the project's own `node_modules`, with `@rn-iso/metro`'s NDJSON reporter attached. Bundler events, in-app `console.log` and redboxes all arrive structured. Hosting is the only way to get them: both CLIs overwrite `config.reporter` after loading `metro.config.js`, so a reporter wired in there is discarded.
- **`expo-child`** -- Expo: the project's own `expo start --port <n>` runs as a child and its stdout is parsed into the same records. Expo's dev server is protocol-bearing (manifest, dev-client and expo-router middleware), so reimplementing it would be forking Expo; the cost is that levels are _inferred_ from each line, which those records mark with `raw: true`.

Everything lands as one JSON object per line under `<root>/.rn-iso/logs`, and `rn-iso logs` queries the files merged into one timeline:

```bash
npx rn-iso logs --errors            # errors since the last marker; empty + exit 0 = healthy
npx rn-iso logs --source client --since 5m --grep 'Profile'
npx rn-iso logs --follow --level warn
npx rn-iso logs --errors --json     # raw records, so stdout is valid NDJSON
```

**Nothing matching is exit 0.** `logs --errors` returning nothing is the pass condition of a build loop, so an empty result must never read as a failure; the only exit-1 paths are a malformed query and no project. `--errors` means level `error` or `fatal` strictly after the most recent record carrying `marker: true`, and the marker is searched across every source, so a marker in one file closes the window for all of them. Markers are written when a bundle build finishes -- which is what stops an error you already fixed from being reported forever. `rn-iso status` reports the same count per workspace.

The record is `{ ts, src, level, msg }` plus optional `event`, `stack`, `marker` and `raw`. `src` is one of `metro`, `client`, `device`, `build`: the supervisor writes `metro` (both modes) and `client` (bare only -- in `expo-child` mode Expo's client output arrives on the bundler stream), and `ios` / `android` write `build` (the transcript at level debug, the extracted diagnostics at level error) and `device` (via the `simctl log stream` / `logcat` collector they attach after launch). `.rn-iso/logs/supervisor.log` is deliberately _not_ part of the timeline: it is the supervisor's raw stdio, and it is what `start` quotes when a supervisor dies before it can write a structured record. `.rn-iso/logs/emulator.log` is outside the timeline for the same reason: it is the Android emulator's raw stdio, truncated on each boot, and it is what `android` quotes when a boot fails (the emulator's own `FATAL |` / `PANIC:` line becomes the `RN_ISO_NO_DEVICE` message and remedy).

`rn-iso stop` is the inverse: it halts the supervisor (identity-verified: a pid is only signalled when it is alive, recorded for this workspace, and holding the port this project reserved), SIGTERMs the device-log collectors recorded in the same `state.json`, shuts the owned device down without deleting it, and frees the port. It never escalates to `SIGKILL` -- a supervisor mid-write on the log files is exactly what `SIGTERM` handling exists to finish -- so a supervisor that will not exit is reported with its pid instead.
