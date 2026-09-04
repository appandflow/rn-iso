# Agent benchmark

This protocol measures rendered-screen readiness with auditable device proof.
Its timings are not comparable with the earlier process-liveness experiment,
which stopped before navigating the app.

## Question and pilot gate

The primary question is whether Stim reduces elapsed time from agent dispatch
to a changed Trailhead app visibly ready on its Settings screen. JavaScript and
native changes are different workloads and are never combined into one run or
one headline number.

Each model and platform contains four sequential cells:

| Change     | Arm     | Device state                                                  |
| ---------- | ------- | ------------------------------------------------------------- |
| JavaScript | Stim    | adopt the prepared parked iOS simulator or create Android AVD |
| JavaScript | Control | create a new simulator or AVD                                 |
| Native     | Stim    | adopt the prepared parked iOS simulator or create Android AVD |
| Native     | Control | create a new simulator or AVD                                 |

Results from different platforms, change kinds, models, or deliberately changed
pins remain separate. Never pool iOS and Android timings into one number.

## Pins and preparation

Pin the exact published `stim-cli` version and package integrity, fixture
commit, runner version, model, reasoning effort, service tier, `agent-device`
version and executable hash, Node.js, host machine, and platform toolchain
before preparing the block. iOS also pins CocoaPods, Xcode, iPhone model, and
runtime. Android pins the SDK tools, emulator, adb, and system-image package.

Preparation runs outside the timer. On iOS it creates one Stim-owned simulator,
warms the fixed fixture, removes its seed worktree, and verifies that cleanup
parked the simulator. The iOS golden contains exactly one available, shut-down
pool record whose device name starts with `stim-parked`, plus the matching build
artifact. Android preparation warms the matching APK cache but retains no AVD;
both Android arms create a fresh AVD during the timed run.

Before each dispatch, verify the package version and integrity, fixture commit,
clean main checkout, golden build artifact, exact parked simulator identity and
state, required disk space, no benchmark-owned process from an earlier run,
and no unexpected listener on Metro ports 8081 through 8090. Wait for a
one-minute load average at or below 3.0 for two consecutive 15-second samples.
Runs are sequential.

Give the campaign its own `AGENT_DEVICE_STATE_DIR`, separate from the
operator's normal sessions, and set `AGENT_DEVICE_SESSION` to the exact run id.
The runner environment is not proof that nested shell tools inherit those
values: repeat both assignments explicitly on every `agent-device` command.
Before dispatch, require an empty session inventory and no ownership claim on
the prepared simulator. If prior campaign state cannot be proven clean, stop
the daemon with `daemon stop --clean` against that campaign state directory
before starting the timer. Never stop the operator's global daemon.

## Fixed changes

The JavaScript cell changes only the Settings Offline maps subtitle:

```diff
-subtitle="Keep map tiles for saved trails on device"
+subtitle="Keep saved trail maps available offline"
```

The iOS native cell changes only `ios/Trailhead/AppDelegate.swift`, immediately
after the existing window assignment:

```swift
window?.accessibilityIdentifier = "Trailhead <run-id>"
```

The native marker must appear as the live app window label in the
`agent-device` accessibility snapshot. This proves that the changed compiled
AppDelegate executed; searching an optimized Swift executable for an ASCII
literal is not sufficient.

The Android native cell changes only the `app_name` string in
`android/app/src/main/res/values/strings.xml` to `Trailhead <run-id>`. The live
app is opened on the exact run emulator, and the installed APK's application
label must equal that run marker. The collector preserves the label read from
the installed APK before cleanup.

## Arm isolation

Each run uses a disposable runner home and starts in the clean fixture main
checkout. The Stim profile exposes only the pinned Stim skill and the
independently pinned `agent-device` skill. The control profile exposes only
`agent-device`; the Stim binary and skill are unavailable. Both profiles have
the same model settings, filesystem authority, and app task.

The agent creates its own worktree after dispatch. Stim must use this exact
slash-containing form, which also exercises branch/path handling:

```text
stim worktree create bench/<run-id> --dir <worktree-parent> --carry-ignored
```

The Stim worktree must therefore use Git branch
`worktree-bench/<run-id>`. Its filesystem leaf may encode the slash. The
control creates the corresponding Git worktree using local Git. Both carry the
same installed dependencies and native outputs from the fixture checkout.

The Stim arm uses the inherited isolated `STIM_HOME` and invokes the pinned
published CLI as exactly `stim`. On iOS it requests the pinned model/runtime and
must report adoption of the prepared simulator. On Android it requests the
pinned system image. The control must not inspect that home or use Stim; it
creates a new benchmark-named device with the same platform configuration.
Android control uses the same `avdmanager` default profile, 8 GiB data
partition, system image, and no-snapshot boot flags as Stim.

## Settings readiness proof

App-process liveness is retained as a secondary milestone. The primary
readiness endpoint is completion of the successful Settings screenshot command
after the expected changed content is present. Copying that PNG into retained
results is a validity gate, not a later timing endpoint.

After launch, every agent must use `agent-device`. The required command
sequence is:

```text
env AGENT_DEVICE_STATE_DIR=<campaign-state> AGENT_DEVICE_SESSION=<run-id> agent-device open com.appandflow.trailhead --foreground --platform ios --udid <run-udid>
env AGENT_DEVICE_STATE_DIR=<campaign-state> AGENT_DEVICE_SESSION=<run-id> agent-device record start /tmp/<run-id>-session.mp4 --scope device --quality high --hide-touches
<handle Expo onboarding if it appears and navigate by semantic label to Settings>
env AGENT_DEVICE_STATE_DIR=<campaign-state> AGENT_DEVICE_SESSION=<run-id> agent-device wait text "<expected text>"
env AGENT_DEVICE_STATE_DIR=<campaign-state> AGENT_DEVICE_SESSION=<run-id> agent-device screenshot /tmp/<run-id>-settings.png
cp /tmp/<run-id>-settings.png <run-dir>/proof/settings.png
env AGENT_DEVICE_STATE_DIR=<campaign-state> AGENT_DEVICE_SESSION=<run-id> agent-device record stop
cp /tmp/<run-id>-session.mp4 <run-dir>/proof/session.mp4
env AGENT_DEVICE_STATE_DIR=<campaign-state> AGENT_DEVICE_SESSION=<run-id> agent-device close
```

The run-scoped MP4 captures Expo onboarding and Settings navigation for audit
and promotional use. Every arm records with the same settings so capture
overhead stays symmetric. Record each proof step as its own top-level shell command. Do not hide proof in
an interactive shell, script, chained command, or redirected background job.
Using a bare or mismatched agent-device state directory/session, or restarting
its daemon inside the timed interval, invalidates the attempt. The collector
also requires `open` and `close` output to name the exact run session; command
shape alone is insufficient.

The agent reads `<run-udid>` or `<run-serial>` from the platform launch output.
The explicit device identifier prevents an existing automation session from
selecting unrelated hardware; a bundle identifier alone is insufficient. The
temporary screenshot and recording paths avoid Simulator write restrictions on
external volumes. JavaScript waits for `Keep saved trail maps available offline`; native
waits for `Offline maps`.

The collector accepts the screenshot only when the targeted open command names
the same UDID recorded by the independent app watcher, all required commands
completed in order after dispatch, the PNG has a valid signature and
dimensions, its timestamps fit the run, and the copied file exists. It also
requires an integrity-bound MP4 between the recorded start and stop commands.
The JavaScript source and captured Metro bundle must contain the changed
subtitle. iOS native must expose the exact run marker in the live window
accessibility node; Android native must preserve the same marker from the
installed APK application label.
Missing proof makes the attempt invalid even when the app process is alive.

Android uses the same command sequence with `--platform android --serial
<run-serial>`. Every current run must bind proof to the independently observed
device identifier.

## Metrics and records

The primary metric is `dispatchToScreenReadySeconds`: dispatch to completion
of the successful, validated `agent-device screenshot` command. Report
`dispatchToAppAliveSeconds` separately. Also retain command count, raw token
fields, worktree and simulator evidence, cache and adoption/build output, and
invalid-attempt reasons.

The coordinator timestamps every runner event and reconstructs every command's
start, end, duration, exit status, and output. The website's interactive
benchmark viewer provides per-run tabs, agent messages, non-overlapping command
lanes, inferred spans for detached processes that later process-inspection
commands monitor, app-alive and screen-ready milestones, terminal output
drill-down, timeline zoom and playback, a concise evidence-derived activity
summary, token usage, estimated token cost, and the proof image. A detached
span ends at the last recorded PID or PID-file
reference; it does not assert that the process exited then. Exported website
data includes only valid attempts and uses relative paths and redacted device
identifiers. Private raw results retain invalid attempts for diagnosis. The
Markdown report is the machine-readable summary; the viewer is an audit view
and does not redefine metrics.

The executable coordinator and its machine-local setup contract live in
[`scripts/agent-benchmark/`](../scripts/agent-benchmark/README.md). The driver
prepares and commits launch-failure fixtures, dispatches Codex or Claude,
collects and audits proof, writes `run.json`, cleans owned resources, and
generates the private report. Credentials, pins, golden build state, and raw
transcripts remain outside the repository.

![A benchmark timeline with separate shell and monitored background-process lanes](images/benchmark-background-process.png)

![A benchmark timeline expanded to 4x with its lane labels pinned during horizontal scrolling](images/benchmark-timeline-zoom.jpg)

Export a completed block into the website with:

```bash
node scripts/export-benchmark-viewer.mjs \
  /path/to/results/<stage> \
  website/src/data/benchmarks/<stage>.json \
  website/static/benchmarks/<stage> \
  /path/to/sanitized-machine.json
```

The optional machine JSON contains only `model`, `chip`, and `memory`. The
exporter combines those fields with the recorded macOS, platform toolchain,
Node, device model, and runtime. Never include a hostname, serial number,
hardware UUID, username, device identifier, or path in that file.

The exporter refuses data that still contains a local username or an absolute
home, volume, temporary, or simulator path. It omits machine-global process,
device, storage, and branch listings, plus interactive shell transcripts whose
cursor-control output cannot be made portable. Review the generated diff before
publishing because command output can contain other project-specific data.

Invalid attempts are immutable audit records. Fix only a coordinator defect or
environmental prerequisite, then reschedule the same cell under a new run id.
Never relabel an invalid attempt to improve a result. Collector-only proof
logic may be corrected without rerunning when preserved live evidence already
demonstrates the intended invariant.

## Cleanup

After collection, close the exact run-scoped `agent-device` session and verify
that the campaign session inventory is empty before a simulator can be parked
or reused. If closure cannot be proven, stop and clean only the campaign-owned
daemon. Remove the temporary screenshot and terminate only benchmark-owned
processes. For Stim, run `stim stop` and `stim worktree remove --force`. On iOS,
then verify that the same simulator is shut down, renamed as parked, and is the
sole pool record. Android follows Stim's owned-emulator teardown contract. For
control, remove its worktree and branch and shut down and delete only the newly
created benchmark simulator or emulator. Do not touch unrelated physical-device
leases or automation sessions.

## JavaScript launch-crash extension

A launch-crash diagnostic is a separate suite, not a fifth performance cell.
Inject a deterministic root-render JavaScript exception before the first app
screen, then give each agent the same repair task. Compare dispatch to the
first actionable diagnosis, commands and tokens to diagnosis, and dispatch to
a repaired Settings screenshot. The Stim arm must preserve `stim ios` launch
output and `stim logs --errors`; control collects the equivalent Metro and
simulator logs manually. The injected error text is unique per run so the
collector can prove that the reported stack and repair refer to this failure.

The coordinator creates a per-run fixture branch, injects and commits the
exception, and checks out that fixture before dispatch, outside the timed
interval. The agent starts in the fixture checkout and creates its own isolated
run worktree from that HEAD, so worktree setup remains part of the measured
workflow. The agent must launch before inspecting source. An actionable
diagnosis contains both the run's unique error token and the root-layout source
location. A valid repair removes that token, relaunches the app, and reaches the
unchanged Settings proof on the same explicitly targeted simulator. Report
diagnosis and repair timing separately; do not add crash-suite results to the
readiness charts.

Run the crash suite only after the four-cell readiness pilot is accepted. Keep
its goldens, prompts, metrics, and report separate from the normal JS/native
speed results.
