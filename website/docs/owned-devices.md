---
title: 'Owned devices'
sidebar_position: 1
description: 'Every device rn-iso touches is one it created, and exactly two commands destroy anything'
---

Every simulator or emulator rn-iso uses is one **rn-iso created**, named `rn-iso-<label>`, and recorded with `owned: true`. rn-iso never boots, allocates, or destroys a device it did not create -- it cannot stomp a foreign tool's simulator, because it never touches devices it didn't make. Teardown of the owning project (`worktree remove`, or `gc` on an orphan) destroys the device, not just a claim on it.

That rule has **no exception**. rn-iso has no physical-device support: there is no code path that boots, installs onto, or even probes hardware. A legacy record naming a serial is reported once and replaced by an owned emulator; the serial itself is never touched.

This is a change from earlier versions, where rn-iso picked an existing, unclaimed simulator from the pool instead of creating one. That model existed to avoid accumulating junk simulators -- but the accumulation was really a symptom of creation _without_ a reaper. The reaper now exists, so creating a device and guaranteeing its eventual destruction is no longer the same hazard.

A pre-pivot assignment without `owned: true` ("legacy") is reused only while it is actually running -- rn-iso will not boot, shut down, or delete it. It converges to an owned device naturally, once it is shut down and re-created.

## Destruction lives in exactly two commands

`worktree remove` destroys the workspace you name; `gc --delete` sweeps the machine. **Nothing else deletes anything.**

In particular `stop` does not, by design: it shuts the owned device down and leaves it assigned, so returning to a branch costs a boot rather than a create, a provision and a reinstall. There is no `--delete` on it, because an agent reaching for `stop` to reclaim memory must not have one within reach of a typo. Destruction lives in `worktree remove` and `gc`, never here.

**A delete is not occupancy-guarded.** An owned sim goes away even if another tool is still attached to it. It is a device rn-iso created, for a project that is going away, and the process holding it is almost always the caller's own UI-test runner, which has nothing to return to. Skipping occupied sims there leaked booted sims and live `xcodebuild test-without-building` runners out of `worktree remove`, and "left for a later gc" only asked the same question again forever.

`stop` _is_ occupancy-guarded, because the device it spares survives the call and is still there to come back to: an iOS sim actively driven by a foreign UI-test runner is left running and reported instead of shut down. (Android has no occupancy probe, so an owned, identity-verified AVD is always eligible.)

If a delete fails, the failure is reported, the config record is **kept** so the device stays tracked, and the command exits 1. Dropping the record on a failed teardown is exactly what turns it into a simulator nothing references.

## How devices, ports and config fit together

- **Config** at `~/.rn-iso/config.json`, keyed by absolute project path. Symlinked worktrees collapse via `realpath`. Every write goes through a lockfile and lands by atomic rename, so several agents provisioning at once cannot lose each other's device records. A config that will not parse is reported by name and never reset automatically -- it holds the records of every device rn-iso owns, and resetting it would orphan all of them.
- **Port allocation:** `start` scans upward from 8082 for a port that is both unclaimed in the registry and actually free on the machine, reclaiming ports from dead projects on the way. Claiming is race-safe: the write only lands if the config still shows the port unclaimed, so two parallel runs that probe the same free port cannot both take it. A project whose directory only _looks_ gone because its volume is unmounted keeps its port.
- **Owned device creation:** on iOS, `ios` creates the newest iPhone device type -- highest generation number, base model rather than Pro/Pro Max -- on the newest installed runtime by default (or reuses the project's already-recorded owned sim, booting it if shut down). On Android, it creates an AVD via `avdmanager create avd` against the newest installed arm64 system image (rn-iso never installs system images itself -- it errors with install instructions if none is found). Override the defaults with `ios.deviceType` / `ios.runtime` / `android.systemImage` in a settings file -- see "Settings" below.
- **Build output is workspace-local.** `-derivedDataPath` points at `<worktree>/.rn-iso/derived-data` and gradle builds under `<worktree>/.rn-iso/gradle-build`, so `worktree remove` reclaims them definitionally and there is no global DerivedData directory to reverse-map to a workspace.
- **The port is never baked into a build.** The fingerprint cache shares binaries across workspaces, so a port compiled in would let a binary built for 8082 be served to a workspace holding 8083. iOS gets `RCT_jsLocation` written into the app's simulator defaults (or an `expo-development-client` deep link); Android gets `adb reverse tcp:8081 tcp:<port>`. `RCT_METRO_PORT` is deliberately not passed to builds.
- **Starting the bundler yourself still works.** Both Expo and the RN CLI probe the port and skip spawning a second bundler when one already answers `/status`, and `ios`'s Metro gate accepts a server you started as long as it runs from inside the project -- but nothing is captured that way, so `rn-iso logs` stays empty. Teardown (`stop`, `worktree remove`, `gc`) finds Metro by port via `lsof` and only kills it after confirming it answers `/status` **and** runs from inside the project: a port is not identity, so an unidentified listener is reported instead of killed.

If you need a single shared sim with a mutex instead of one owned device per project, see [`react-native-worktree`](https://github.com/aleqsio/react-native-worktree).

## Device settings

The device model, runtime and system image can be pinned per project so rn-iso's defaults are not what you get. There is no `rn-iso config` command -- rn-iso's commands take no device flags, so settings are **files**. See "Settings" below for the layers; the one that travels with the repo is `.rn-iso.json` at its root:

```json
{
  "ios": { "deviceType": "iPhone 17 Pro", "runtime": "26.2" },
  "android": { "systemImage": "system-images;android-36;google_apis;arm64-v8a" }
}
```

Resolution order: the project layer, then the repo layer, then that committed file, then rn-iso's own default (newest iPhone, base model, on the newest installed runtime; newest installed arm64 system image). A pinned model is honoured on **reuse** as well as on creation: an existing owned sim of a different model is refused rather than silently booted.
