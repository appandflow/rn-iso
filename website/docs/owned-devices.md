---
title: 'Devices and cleanup'
sidebar_position: 3
description: 'Owned devices, physical-device leases, and cleanup'
---

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim-cli`.

Stim creates and records its local simulators and emulators. Their names start
with `stim-`. It never creates, boots, or deletes a simulator or emulator that
another tool made.

`stim android --device [serial]` and `stim ios --device [udid]` install, launch,
and read available logs on connected physical devices. Stim leases the device
for the run, then releases the lease. Use `stim device lock` to hold it across
runs. Hardware never enters the owned-device registry and is never booted,
shut down, or deleted by Stim.

Each workspace keeps its owned-device assignment for later runs.

## Local devices

`stim ios` selects the newest suitable iPhone model and installed runtime by
default. `stim android` selects the newest installed system image matching the
host architecture: `arm64-v8a` on ARM64 or `x86_64` on x64. Set `.stim.json`
defaults or use `ios --device-type`, `ios --runtime`, and
`android --system-image` for a specific target.

`stim stop` shuts down an owned local device but does not delete it. The command
assumes that the caller finished all device automation for that Stim session.
It does not block on other processes attached to the owned device.

## Remote devices

Stim supports two optional remote backends:

- `proxy` connects through an Agent Device daemon that already owns a session.
- `eas` creates and owns an EAS simulator session.

The app still builds on the local machine. `stim start --remote` creates the
Metro route required by the remote device. Remote EAS sessions can incur cost.

## Cleanup behavior

- `stim stop` releases the live environment and device leases. It ends an owned
  remote session. On a physical iPhone, stopping the log collector also closes
  the app; it does not shut down the phone or uninstall anything.
- `stim worktree remove` releases leases, parks the owned iOS simulator for
  another workspace, and deletes owned Android emulators. The iOS pool keeps up
  to three simulators by default and deletes the oldest when full. Disabling
  parking makes removal delete the simulator; see [settings](/docs/settings).
- `stim gc` reports stale and orphaned resources.
- `stim gc --delete` removes verified resources from the report, including
  parked simulators and expired device lease files.

If deletion fails, Stim keeps the ownership record and exits with an error. A
later cleanup can then retry without losing track of the resource.

Runtime state lives under `$STIM_HOME`, which defaults to `~/.stim`. Each
workspace stores state and logs in a directory derived from its absolute path.
