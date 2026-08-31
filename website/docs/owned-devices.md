---
title: 'Devices and cleanup'
sidebar_position: 3
description: 'Owned local and remote devices with safe teardown'
---

Stim creates and records every local simulator or emulator it uses. Local device
names start with `stim-`. Stim does not create, boot, or delete a simulator or
emulator that another tool made.

`stim android --device [serial]` is the one device Stim uses without owning it.
It installs, launches, and reads logs on a connected physical device, and never
creates, boots, shuts down, or deletes it. Stim records nothing about the device,
so `stim stop` and `stim gc` leave it alone.

Each workspace keeps its device assignment. A later run can boot and reuse the
same device.

## Local devices

`stim ios` selects the newest suitable iPhone model and installed runtime by
default. `stim android` selects the newest installed ARM64 system image. Pin
these values in `.stim.json` when a project needs a specific target.

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

- `stim stop` releases the live environment. It ends an owned remote session.
- `stim worktree remove` deletes the worktree's owned local devices.
- `stim gc` reports stale and orphaned resources.
- `stim gc --delete` removes the resources that the report identifies.

If deletion fails, Stim keeps the ownership record and exits with an error. A
later cleanup can then retry without losing track of the resource.

Runtime state lives under `$STIM_HOME`, which defaults to `~/.stim`. Each
workspace stores state and logs in a directory derived from its absolute path.
