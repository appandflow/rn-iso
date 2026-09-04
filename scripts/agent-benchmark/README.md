# Agent benchmark driver

This is the executable coordinator used by the published agent benchmarks. It
keeps machine-local pins, credentials, build artifacts, raw transcripts, and
device identifiers outside the repository while keeping fixture preparation,
dispatch, evidence collection, audit, cleanup, and reporting reviewable.

The driver runs the iOS and Android readiness suites plus the iOS JavaScript
launch-failure suite described in [`../../docs/agent-benchmark.md`](../../docs/agent-benchmark.md).
Runs are sequential. Never dispatch two cells against the same benchmark root.

## Machine-local layout

Create a benchmark root outside the repository with these entries:

```text
benchmark-root/
  bin/stim
  golden/
  pins.env
  runtime/node_modules/stim-cli/
  results/
  state/
```

`bin/stim` is an executable shim for the pinned `stim-cli` in `runtime`.
`pins.env` contains the exact fixture, CLI, agent-device, OS, Xcode, Node, and
CocoaPods values checked by `preflight`; use the keys read by `versionChecks`
in `driver.mjs`. Keep authentication and raw evidence out of Git.

Set the machine-local paths explicitly:

```bash
export STIM_BENCH_ROOT=/path/to/benchmark-root
export STIM_BENCH_FIXTURE=/path/to/clean-trailhead-checkout
export STIM_BENCH_WORKTREE_PARENT=/path/to/benchmark-worktrees
export STIM_BENCH_STIM_PACKAGE="$STIM_BENCH_ROOT/runtime/node_modules/stim-cli"
export STIM_BENCH_CODEX_AUTH=/path/to/codex-auth.json
export STIM_BENCH_SKILLS_ROOT=/path/to/skills
```

`STIM_BENCH_CODEX_BIN`, `STIM_BENCH_CLAUDE_BIN`, and
`STIM_BENCH_AGENT_DEVICE_BIN` can pin non-default executable paths.

## Run a cell

Prepare the platform golden, then dispatch, collect, and clean one cell:

```bash
node scripts/agent-benchmark/driver.mjs preflight
node scripts/agent-benchmark/driver.mjs prepare
node scripts/agent-benchmark/driver.mjs dispatch gpt-5.6-sol stim launch-crash sol-launch-crash
node scripts/agent-benchmark/driver.mjs collect /path/to/run-directory
node scripts/agent-benchmark/driver.mjs cleanup /path/to/run-directory
node scripts/agent-benchmark/driver.mjs report sol-launch-crash
```

Android is selected explicitly and remains a separate result block:

```bash
node scripts/agent-benchmark/driver.mjs preflight android
node scripts/agent-benchmark/driver.mjs prepare android
node scripts/agent-benchmark/driver.mjs dispatch gpt-5.6-sol stim javascript sol-android android
```

`dispatch` creates and commits the broken fixture before the timed turn, gives
the agent the fixture checkout as its starting directory, and requires the
agent to create the measured run worktree itself. `collect` rejects source
inspection before launch/error capture, a missing exact repair, a missing
successful Metro reload, a mismatched device, or missing Settings-screen proof.

Run the self-tests before a campaign:

```bash
node scripts/agent-benchmark/driver.mjs selftest-device-targeting
node scripts/agent-benchmark/driver.mjs selftest-agent-device-isolation
node scripts/agent-benchmark/driver.mjs selftest-launch-crash
node scripts/agent-benchmark/driver.mjs selftest-android
```
