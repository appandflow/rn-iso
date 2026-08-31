# Stim — the remote device backend

Date: 2026-08-26
Status: draft
Scope: iOS only. Android remote is a follow-up and is named where it changes
a decision.

## Purpose

Stim brokers two contended resources: the Metro port and the device. The
port is cheap and Stim can mint as many as it needs. The device is not. A
simulator costs RAM and a CPU share, and a machine runs out of them long
before an agent fleet runs out of work. That ceiling is the reason to reach
for a device that is not on this machine.

This spec adds a second **device backend** to Stim. The build stays local:
the fingerprint, the shared build cache and single-flight builds are the
reason Stim is fast, and none of them care where the device is. Only the
device moves.

Two hosted forms exist, and the useful discovery is that they are the same
interface:

- **EAS Simulator** (`eas sim`, EXPERIMENTAL, waitlist-gated) creates a cloud
  simulator session. For `--type agent-device`, the default, it hands back
  `AGENT_DEVICE_DAEMON_BASE_URL` and `AGENT_DEVICE_DAEMON_AUTH_TOKEN`.
- **`agent-device proxy`** runs on a Mac you own and is reached over a
  tunnel. It hands back the same two values.

So Stim implements one backend, against an agent-device daemon, and both
forms fall out of it.

## The principle, unchanged

> Stim brokers contended resources — the device and the Metro port. It
> allocates them, records them, and reaps them. It never invokes the
> project's tooling.

A remote device is still a brokered device. The ownership rule survives with
its terms substituted: Stim only ever creates, uses or destroys a session
it created itself, named `stim-<label>`.

## What does not change

Worth stating first, because it is most of the system.

- The fingerprint, the local build cache, the project's own build-cache
  provider, and single-flight builds. The `.app` is the same artifact.
- The Metro supervisor and port reservation. Metro stays local.
- `commands/ios.ts`'s phase sequence. Every phase keeps its name and its
  order. Only the callee behind the device phases changes.
- The state file, its lock, and the config lock.

## The seam

Three modules reach for a device today. They become one interface.

| Module                                  | Local                       | Remote                          |
| --------------------------------------- | --------------------------- | ------------------------------- |
| `engine/device.ts` `ensureOwnedDevice`  | `simctl create` / `boot`    | `eas sim` session create        |
| `engine/app-install.ts` `installIosApp` | `simctl install`            | `agent-device install <path>`   |
| `engine/app-install.ts` `launchIosApp`  | `simctl openurl` / `launch` | `agent-device open <app> <url>` |
| `collector/ios.ts`                      | `simctl spawn log stream`   | not in v1, see Logs             |

**The seam already existed, so no new abstraction was added.** `DEFAULT_DEPS`
in `commands/ios.ts` is documented as "the test seam. Every engine call goes
through it", and four of its entries are the whole device surface:
`checkDeviceCapacity`, `ensureOwnedDevice`, `ensureBooted`, `installIosApp`
and `launchIosApp`. Remote mode replaces those and nothing else.
`engine/device-remote.ts` supplies the replacements, each matching its local
counterpart's signature exactly.

The consequence is that the local path is not refactored at all: every call
site, every phase line and every existing test is untouched, so a regression
there cannot be caused by this change. An earlier draft of this spec proposed
extracting a `DeviceBackend` interface; that would have been a second way to
say what the dep seam already says.

Selection is a `--remote` flag on `stim ios`, plus an `ios.remote` key in
settings, which must also be added to `KNOWN_SETTINGS` in `settings.ts` or it
silently becomes a no-op.

The command surface stays closed. A remote device is a property of the
device, not a new verb. The option surface does grow by one flag, which
`CLAUDE.md` says must be a deliberate decision rather than a drift: it is
recorded here and in that file's option-surface list.

## Session lifecycle

Stim creates the session:

```
eas sim --platform ios --json --non-interactive --out-config-type env \
        --name stim-<label> --max-duration-minutes <N>
```

Three flags carry weight.

`--out-config-type env` is not optional. The default, `dotenv`, writes
`.env.eas-simulator` into the project directory, and it does so even under
`--json`. Stim does not edit the project's files; `engine/remote-cache.ts`
states that rule and this honours it.

`--json` makes the command print `{id, name, type, deviceRunSessionUrl,
remoteConfig}` and return immediately, leaving the session running. That is
the same detached model the supervisor already uses.

`--name stim-<label>` carries ownership. It replaces the `stim-` simulator
name prefix as the marker every destructive path checks, so
`eas simulator:list --name stim-` is the analog of the local sweep and `gc`
can find leaked sessions with it.

**The token is never persisted.** `remoteConfig` carries
`agentDeviceRemoteSessionUrl` and `agentDeviceRemoteSessionToken`. Stim
records only the session id, under a new `remoteDevice` key in the global
workspace `state.json`, written through the same
`withWorkspaceStateLock` as `supervisor` and `collectors`. Later commands
re-read the token with `eas simulator:get --id <id> --json`, which returns
`remoteConfig` too. A leaked state file or a pasted build log then cannot
carry a live credential.

## Metro

Stim keeps owning Metro, and the cloud simulator reaches it through
agent-device's companion tunnel. That tunnel is a detached local process
which dials **outward** to the daemon and registers Stim's local Metro. The
daemon exposes it to the simulator on a device-side port. No inbound firewall
hole and no third-party tunnel service.

Stim does NOT drive `metro prepare` itself. `agent-device connect` defers
and then performs Metro preparation, and `disconnect` releases the lease and
stops the companion it owns. Stim passes `metroProjectRoot` in the
connection profile and lets agent-device own the tunnel; a second driver
would fight it.

The consequence worth naming: **`verify` keeps working unchanged.** Its check
is "did a bundle request reach _this workspace's_ Metro", and with the tunnel
it is literally the same Metro process. Going remote does not weaken Stim's
central guarantee.

### The expo-dev-client deep link

agent-device's own Metro hint writes bare-RN's `RCT_jsLocation` only, which an
expo-dev-client ignores. That is upstream issue callstack/agent-device#1245,
open and unresolved.

It does not block Stim, because `agent-device open <app> <url>` runs
`simctl openurl` with the URL verbatim. Stim already composes the correct
`exp+<scheme>://expo-development-client/?url=` link in
`engine/app-install.ts` `devClientUrl`, verified against
`EXDevLauncherURLHelper.swift`. Stim passes that link as the URL positional
and bypasses the hint mechanism entirely.

Contributing Stim's mechanism upstream would eventually remove this
workaround. It is not a dependency.

## Logs

Native device logs are **not** in v1, deliberately.

Two things prevent a clean port. Stim runs `log stream --style ndjson` and
its parser needs `subsystem`, `category`, `messageType` and
`processImagePath`; agent-device runs the same tool with `--style compact`,
which carries none of them in parseable form, so the `NOISE_RULES` table
cannot match. Separately, Stim's collector reads a live pipe while
agent-device writes to a session artifact on the daemon host, served over an
HTTP download route. Remote would be poll-and-download, not stream.

What makes the gap acceptable is that device logs are the smaller half.
Stim's other log source is its own Metro NDJSON reporter in `@stim-cli/metro`,
which runs locally and is untouched by the device being remote. JS redboxes,
bundling failures and console output all come from there, and they are the
overwhelming majority of what `logs --errors` surfaces in an agent loop.

The requirement this places on the implementation: on remote, `stim logs`
must **say** that device logs are unavailable. An empty device section reads
as a pass, and `empty is the pass condition` is the contract `logs --errors`
sells. A silent gap here would be a lie.

The fix is upstream and small. `buildIosSimulatorLogStreamArgs` in
`packages/platform-apple/src/logs/log-predicate.ts` hardcodes `--style
compact`; an opt-in style parameter threaded through `logs/descriptor.ts` and
`logs/start.ts` is the whole change. Default stays compact, because `logs
path` hands back a raw file a person reads. Once that lands, Stim's existing
parser and noise rules work verbatim and the collector ports without a second
implementation.

## Teardown, gc, doctor

`engine/device-remote.ts` exposes `endRecordedSession({root, sessionId})`,
which resolves its own eas-cli because a teardown runs long after the `ios`
that created the session, in a process with none of its context.

**Implemented: `stop`.** It reads the `remoteDevice` record from state.json,
ends the session, and drops the record only on success. A failure keeps the
record and exits non-zero, matching how a failed local teardown keeps its
device record: the record is the only handle left to retry with.

**Implemented: `gc` and `worktree remove`,** through `reclaim.ts`, the shared
path both go through. The timing is the whole constraint: the session id
lives in the workspace's `state.json` and `eas simulator:stop` needs a
project directory (its `contextDefinition` includes `ProjectDir`), so both
are gone the moment `git worktree remove` runs. Ending the session therefore
happens inside `reclaimProject`, which already precedes the caller's removal
step.

It runs regardless of `deleteOwnedDevices`. That flag guards destroying a
local device, which is a real choice because a shut-down simulator can be
booted again; a session cannot be handed back, so the only choice is ending
it now or paying to its cap.

**Still uncovered: a workspace deleted by hand.** `rm -rf` on a worktree
takes `state.json` with it, and with it the only record of the session id.
`gc` cannot recover it either, because listing sessions needs a project
directory that no longer exists. The `--max-duration-minutes` cap is the
backstop for that case.

**`stop` will delete, and today it never does.** The documented rule is that
`stop` shuts a device down and never destroys it. A cloud session bills while
it lives, so leaving one running is the worse failure. The rule gains an
explicit exception for remote sessions, recorded in `CLAUDE.md` rather than
left as an undocumented inconsistency.

`gc` gains the remote analog of `findOrphanedDevices`, listing live sessions
with `eas simulator:list --name stim- --status new,in-progress --json` and
reporting any whose name matches no known project. This matters more than the
local case: a leaked simulator wastes RAM, a leaked session spends money until
`--max-duration-minutes` expires.

`doctor` already has `checkEasAuth`. Remote adds two findings on top of it:
whether `agent-device` is on PATH, and whether the account has EAS Simulator
access. The second has a known signature, since eas-cli emits a waitlist
pointer for accounts without access, so the finding can carry that URL as its
fix.

## Testing

Every remote call goes through `getExecutor()`, so the existing vitest mock
executor covers them exactly as it covers `simctl`, `adb` and `xcodebuild`
today. No network, no new machinery.

The pure functions get the same treatment as their local siblings: parsing
`eas sim --json` into a session record, mapping a session status to a
`TeardownOutcome`, composing the `agent-device` argv, and choosing a backend
from flags plus settings are all pure.

What unit tests cannot cover is the two live integrations. Those go through
the existing `docs/field-test-protocol.md`, once against a real
`agent-device proxy` and once against a real EAS session.

## Android, and why it is an adapter

An earlier draft of this spec argued Android could not work, because its two
Metro mechanisms are host-relative: `adb reverse` maps a device port to the
host running adb, and the dev-client link uses `10.0.2.2`, the emulator's
route to **its own** host. Both name the wrong machine on a remote emulator.

That was the wrong conclusion. Neither mechanism is USED on the remote path.
The single public origin replaces both, exactly as it replaces `localhost` on
iOS -- which means the remote launch is the same operation on both platforms,
and the only real differences are what the two command files call their
fields (udid/serial, bundleId/packageName, appPath/apkPath).

So `engine/device-remote.ts` holds one platform-neutral core and two thin
adapters. The Metro hint still reaches the app: agent-device writes
`debug_http_host`, and `dev_server_https` which a tunnel on 443 needs, from
`--metro-host`/`--metro-port`, running adb against ITS OWN emulator where a
reverse issued from here would be meaningless.

What is NOT yet proven for Android is the live loop: an EAS Android session
driving a dev-client emulator over a tunnel. iOS has been exercised end to
end; Android is the same code path with different field names, and the unit
tests pin the argv, but CLAUDE.md item 9 is explicit that this is not the
same as having run it.

## Phasing

1. Extract the seam, local backend only, behaviour identical, suite green.
2. The remote backend against `agent-device proxy`. Same daemon interface as
   EAS, no waitlist, testable today.
3. The `eas sim` session layer on top of it.
4. Upstream the ndjson log style. Independent of the above.
5. Port the collector once 4 lands. Device logs arrive.

Steps 1 and 2 give a working remote device without any EAS dependency. Step 3
is the only part gated on account access, and if that access never arrives,
1 and 2 still stand.

## Open questions

- Whether the `agent-device` CLI exposes artifact **download** as a command or
  only `artifacts` to list. The daemon HTTP route exists. This affects step 5
  only.
- What `--max-duration-minutes` should default to. Too long wastes money on an
  abandoned session; too short kills a build mid-flight.
