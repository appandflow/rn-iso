# Trailhead agent benchmark

This protocol compares one fresh agent that uses Stim with one fresh control
agent. It measures the complete path from a clean main checkout to visual proof
from an agent-created worktree.

Use this protocol for issue #102. Do not start a timed run until the changes for
issues #101, #103, and #104 are merged into the Stim candidate.

## Fixed test case

Use the `appandflow/trailhead` repository at commit
`f4a4a3b7b1df2b079959cace34b5caa9c593e76e`. The repository is a single-package
Expo SDK 57 app with committed `ios/` and `android/` directories.

Change only the Offline maps subtitle in `app/(tabs)/settings.tsx`:

```diff
-subtitle="Keep map tiles for saved trails on device"
+subtitle="Keep saved trail maps available offline"
```

The required proof is one iOS screenshot that shows the Settings screen and the
complete new subtitle. A recording is optional because the change is static.

## Prepare the machine

Preparation is outside the timed runs. Record every preparation command and its
output in the coordinator report.

1. Build the merged Stim candidate and install that exact candidate locally.
   Install Agent Device 0.20.10. Record both versions and the candidate commit.
   Use Codex CLI 0.142.0, model `gpt-5.6-sol`, reasoning effort `high`, and
   service tier `priority` for both timed arms.
2. Archive the first benchmark artifacts. Do not reuse its worktrees, branches,
   simulators, logs, or Metro processes.
3. Make sure no other native build, Metro server, simulator automation session,
   or benchmark agent is active. Run the two timed arms sequentially.
4. In the Trailhead main checkout, fetch `origin` and verify that the checkout
   is clean. Record the original branch or detached ref and exact HEAD. Check
   out the fixed commit. Restore the recorded ref after both arms, including
   after an interrupted run. Do not edit the main checkout.
5. Install dependencies and CocoaPods before warming the builds. Record the
   package manager, lockfile, Node.js version, Xcode version, macOS version, and
   available disk space.
6. From the main checkout, run `stim start` and `stim ios`. Keep the complete
   plain-text output. Record the exact app id, simulator UDID, Metro port, cache
   result, and log directory.
7. Build the same main checkout with
   `npx expo run:ios --device <udid> --no-bundler`, using the simulator from step 6. This warms Xcode's normal DerivedData path for the control arm.
8. Run `stim stop`. Confirm that the main checkout is still clean.

Do not tell either timed agent that a build or cache was prepared. The timed
prompt must not contain the words `warm`, `cache`, `DerivedData`, `incremental`,
or `prebuilt`.

If an old benchmark worktree exists, preserve its evidence before cleanup. Do
not reset or remove a dirty old worktree without explicit approval. Use new,
unique worktree names for this run.

## Agent isolation

Start each fresh agent in the Trailhead main checkout. The agent must create its
own worktree after its timer starts. Do not create a worktree for the agent.

Do not rely on the timed prompt to disable skills. An empty `CODEX_HOME` still
discovers `~/.agents/skills`. Use one temporary, isolated Codex home for each
arm and configure explicit path rules under `skills.config`.

Before timing, use `codex debug prompt-input` to record the complete baseline
skill catalog and every canonical `SKILL.md` path. In each isolated config:

- Disable bundled skills with `skills.bundled.enabled = false`.
- Disable plugins with `features.plugins = false`.
- Add an `enabled = false` path rule for every discovered `SKILL.md`.
- For the control arm, set `skills.include_instructions = false`.
- For the Stim arm, copy the merged candidate's `stim-cli` skill and Agent
  Device 0.20.10's `agent-device` skill into its isolated home. Add later
  `enabled = true` path rules for those two copied `SKILL.md` files.

Run `codex login status` against each isolated home before timing. Then run
`codex debug prompt-input` with that home and retain the JSON. The control
prompt input must contain no skills block. The Stim prompt input must list
exactly `stim-cli` and `agent-device`. Any other result blocks the run.

Launch both agents with the same explicit runtime flags:

```text
codex --strict-config exec --ephemeral --json \
  --model gpt-5.6-sol \
  --config model_reasoning_effort='"high"' \
  --config service_tier='"priority"' \
  --sandbox workspace-write \
  --ask-for-approval never \
  --cd <trailhead-main> \
  --add-dir <worktree-parent> \
  --add-dir <results-root> \
  [--add-dir <required-native-tool-write-root> ...]
```

Use the applicable isolated `CODEX_HOME`. Keep its path, configuration, and
launch command outside the timed prompt. Record `codex --version`, the model,
reasoning effort, service tier, sandbox, approval policy, and every write root
in the coordinator report.

The main checkout is the primary workspace because `git worktree add` must
write its Git metadata. The agent must place its worktree under the declared
worktree parent and its evidence under the declared results root. Add only the
native tool roots required for package storage, CocoaPods, Xcode DerivedData,
CoreSimulator, Agent Device, and the benchmark-specific `STIM_CLI_HOME`. Do not
give the control arm access to `STIM_CLI_HOME`.

Before timing, run one no-op agent with each exact permission profile. Verify
that it can create and remove a disposable worktree, write a result file, and
query the simulator. The smoke task must not build Trailhead or reveal build
preparation. A timed permission failure invalidates the arm instead of adding
an interactive approval delay.

The control agent can inspect the repository and use installed local tools,
but no skill appears in its prompt.

Capture each `codex exec` JSONL event stream in the coordinator result directory.
The coordinator transcript is the source of truth for commands and tool calls.
Audit it after each run. A skill file read outside the arm's allowlist invalidates
that run.

Use a unique run id in branch, worktree, result, and device names. Store retained
evidence outside the temporary worktree, under:

```text
<results-root>/<run-id>/stim/
<results-root>/<run-id>/control/
```

Run one arm at a time. Use `control` then `stim` for the first v2 run. Reverse
the order if the benchmark is repeated.

## Stim prompt

Replace the bracketed values before dispatch. Do not add setup or cache details.

```text
This is a timed local iOS implementation and QA task. The coordinator started
this arm at [DISPATCHED_AT]. Use that exact UTC timestamp as startedAt. Do not
replace it with a timestamp that you record later. You are in the clean
Trailhead main checkout. Do not modify the main checkout.

For this benchmark, only the stim-cli and agent-device skills are enabled. Read
and use those two skills. Treat every other skill as disabled. Do not read or
use any Expo skill.

Create a new isolated worktree yourself from the current HEAD. Use a unique
branch and worktree name that includes [RUN_ID]-stim. Make all edits, checks,
builds, and QA work in that worktree.

In app/(tabs)/settings.tsx, change the Offline maps subtitle from "Keep map
tiles for saved trails on device" to "Keep saved trail maps available offline".
Make no other product change.

Run the repository lint and type-check scripts. Build and run the app locally on
iOS. Do not use EAS or another cloud service. Open Settings and capture one
screenshot that clearly shows the complete new subtitle. Check the launch and
runtime output for errors. Report any error that appears, even when the app
remains alive.

Keep a complete evidence record under [RESULTS_ROOT]/[RUN_ID]/stim. It must
contain commands.log, metrics.json, report.md, and proof.png. Record every shell
command, its UTC start and end times, elapsed seconds, exit status, and a short
result. Preserve the full streamed output from each build or launch command.
Record all reported device, app, Metro, launch, log, and build details. Count a
failed or replaced attempt as a retry.

After proof, keep the device automation session active and run `stim stop` as
the first cleanup command. Verify that Stim shuts down its owned simulator.
Then close the Agent Device session to release its session state. Release the
remaining processes and devices that you started. Restore your source edit,
remove your temporary worktree, and verify cleanup. Do not commit, push, or
change the main checkout. The retained evidence directory must remain after
cleanup.
```

## Control prompt

Replace the bracketed values before dispatch. Do not add setup or cache details.

```text
This is a timed local iOS implementation and QA task. The coordinator started
this arm at [DISPATCHED_AT]. Use that exact UTC timestamp as startedAt. Do not
replace it with a timestamp that you record later. You are in the clean
Trailhead main checkout. Do not modify the main checkout.

All skills are disabled for this benchmark. Do not read or use any skill,
including Expo skills.

Create a new isolated worktree yourself from the current HEAD. Use a unique
branch and worktree name that includes [RUN_ID]-control. Make all edits, checks,
builds, and QA work in that worktree.

In app/(tabs)/settings.tsx, change the Offline maps subtitle from "Keep map
tiles for saved trails on device" to "Keep saved trail maps available offline".
Make no other product change.

Run the repository lint and type-check scripts. Build and run the app locally on
iOS. Do not use EAS or another cloud service. Open Settings and capture one
screenshot that clearly shows the complete new subtitle. Check the launch and
runtime output for errors. Report any error that appears, even when the app
remains alive.

Keep a complete evidence record under [RESULTS_ROOT]/[RUN_ID]/control. It must
contain commands.log, metrics.json, report.md, and proof.png. Record every shell
command, its UTC start and end times, elapsed seconds, exit status, and a short
result. Preserve the full streamed output from each build or launch command.
Record all reported device, app, server, launch, log, and build details. Count a
failed or replaced attempt as a retry.

After proof, close any device automation session and release all processes and
devices that you started. Restore your source edit, remove your temporary
worktree, and verify cleanup. Do not commit, push, or change the main checkout.
The retained evidence directory must remain after cleanup.
```

## Required metrics

Use UTC timestamps. `timeToProof` is the primary speed result. Immediately
before each `codex exec` dispatch, the coordinator records `[DISPATCHED_AT]` in
its own log and inserts it into the prompt. The agent must copy that value to
`startedAt`. This includes agent startup and skill loading in the primary timer.

```json
{
  "startedAt": "ISO-8601",
  "worktreeCreatedAt": "ISO-8601",
  "editCompletedAt": "ISO-8601",
  "checksCompletedAt": "ISO-8601",
  "buildStartedAt": "ISO-8601",
  "buildCompletedAt": "ISO-8601",
  "firstAppVisibleAt": "ISO-8601",
  "targetVisibleAt": "ISO-8601",
  "proofCapturedAt": "ISO-8601",
  "cleanupCompletedAt": "ISO-8601",
  "elapsedSeconds": {
    "timeToWorktree": 0,
    "timeToBuildComplete": 0,
    "timeToFirstVisible": 0,
    "timeToTarget": 0,
    "timeToProof": 0,
    "timeToCleanup": 0
  },
  "counts": {
    "commands": 0,
    "retries": 0,
    "findings": 0,
    "evidenceFiles": 0
  }
}
```

The report must also include these measured phases:

- Agent start to worktree creation.
- Worktree creation to completed edit.
- Lint and type-check duration.
- Native build or restore duration.
- App launch to first visible app content.
- First visible content to changed text.
- Changed text to screenshot completion.
- Screenshot completion to full cleanup.

## Cache and build evidence

The coordinator, not the timed prompt, evaluates build reuse.

For the Stim arm, retain the complete `stim ios` output. Quote its fingerprint,
cache result, build or restore duration, full simulator UDID, app id, Metro port,
launch result, and log directory. Confirm whether native compiler output was
present.

For the control arm, retain the complete native build output. Record the Xcode
workspace path, DerivedData path, build duration, and whether compilation or
link steps ran. Compare the worktree DerivedData `WorkspacePath` with the main
checkout path. A different path is evidence of a path-specific Xcode build, not
by itself proof that every compiler cache missed.

Record the candidate's three-second launch observation separately from native
build time. The launch result must state whether Metro completed the bundle,
whether the process was alive after the observation window, and whether a
launch-period error was found.

## Cleanup evidence

Each arm must prove all applicable checks:

- The main checkout status and HEAD are unchanged.
- The temporary worktree and branch are gone.
- No Metro, build, collector, or automation process from the arm remains.
- No simulator created by the arm remains booted.
- The retained result directory contains only the requested evidence.
- The proof image opens and shows the exact changed text.

For the Stim arm, run `stim stop` while the Agent Device session remains active.
Record the command output and verify that the owned simulator stops. Then close
the Agent Device session and record whether it releases its session state. Do
not kill an unknown `xctrunner` directly.

After both arms, restore the main checkout to the original ref and exact HEAD
recorded during preparation. Verify a clean status. If the exact state cannot
be restored without discarding a change, stop and request user direction.

## Comparison report

Compare the two arms only after both evidence sets pass validation. Report:

1. `timeToProof`, `timeToFirstVisible`, total cleanup time, commands, and retries.
2. The exact native build or restore path for each arm.
3. The build reuse evidence and any uncertainty.
4. Every failed command and recovery, with time cost.
5. Product proof quality and report completeness.
6. Launch errors, runtime errors, false positives, and missed errors.
7. Cleanup results, including device automation ownership.
8. Where Stim saved time and where it added work.
9. Concrete changes that would improve the next run.

A run is invalid if an agent modifies the main checkout, uses a disabled skill,
starts before preparation finishes, overlaps the other timed arm, omits command
evidence, leaves owned resources running, or fails to produce readable proof.
