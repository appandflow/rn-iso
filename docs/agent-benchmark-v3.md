# Agent benchmark v3

Date: 2026-09-02. Issue: #281. This protocol supersedes the single-pair v2
protocol in [`trailhead-agent-benchmark.md`](./trailhead-agent-benchmark.md).
The later Settings-readiness and parked-simulator pilot is specified separately
in [`agent-benchmark.md`](./agent-benchmark.md); its timings are not pooled
with v3.
The versions share an application test case, but their runner setup, cache
preparation, and timing definitions differ, so v2 timings are historical
context rather than samples in the v3 result.

## Question and stages

The primary question is whether Stim reduces elapsed time from dispatching an
agent to observing the changed iOS app alive in a newly created worktree. The
native case is confirmatory because it exercises both Stim's portable build
artifact and Xcode's compilation work. JavaScript-only model breadth is a
separate descriptive screen.

| Stage        | Models                         | Variant    | Repetitions                                 | Purpose                                  |
| ------------ | ------------------------------ | ---------- | ------------------------------------------- | ---------------------------------------- |
| Calibration  | `gpt-5.6-sol`                  | Native     | 3 per arm                                   | Estimate variance; excluded from results |
| Confirmatory | `gpt-5.6-sol`, `claude-opus-5` | Native     | Fixed after calibration, minimum 4 per cell | Compare Stim with control                |
| Screening    | All pinned models              | JavaScript | 1 per cell                                  | Descriptive model breadth only           |

The screening models are `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`,
`claude-opus-5`, and `claude-sonnet-5`. Vendors may run in separate resumable
blocks. A plan limit pauses that vendor's block without invalidating completed
blocks or changing their order.

After calibration, the driver records each arm's standard deviation and fixes
the confirmatory sample size before its first run. It chooses the smallest even
`n` from 4 through 10 whose normal-approximation 95% interval for a two-arm
mean difference has half-width at most 40 seconds:

```text
1.96 * sqrt((stim_sd^2 + control_sd^2) / n) <= 40
```

If none qualifies, `n = 10`. Forty seconds is the pre-registered minimum
detectable effect at useful precision. The report also gives medians, complete
ranges, and paired run-order plots; it does not turn screening observations
into comparative claims or select models for repeats after seeing outcomes.

## OpenAI recorder pilot

The first recorder pilot completed one valid matched JavaScript pair on each
available OpenAI model below. These runs validate the harness and remain
descriptive screening evidence; they are not native calibration or
confirmatory samples.

| Model          | Stim      | Control   | Speedup | Commands           | Estimated model cost |
| -------------- | --------- | --------- | ------- | ------------------ | -------------------- |
| `gpt-5.6-luna` | 138.872 s | 406.534 s | 2.93x   | 15 vs 48, 69% less | $0.028 vs $0.114     |
| `gpt-5.6-sol`  | 122.393 s | 510.613 s | 4.17x   | 18 vs 23, 22% less | $0.508 vs $1.058     |

The treatment used simulator-pool commit `3f3d55e`, stacked on the redundant
simulator-list and boot/fingerprint-overlap changes, rather than the published
package. The pool code was present but deliberately not exercised: the protocol
required every timed run to create and later delete a fresh simulator, and each
treatment run recorded `created`, never `adopted`. The measured difference
therefore includes Stim's orchestration and portable build cache, not parked
simulator reuse. Both treatment runs recorded the expected native build-cache
hit and all four valid runs retained a Metro bundle containing the requested
changed string. Luna's changed-bundle proof completed in 150.924 seconds with
Stim and 478.739 seconds in control, a 3.17x difference outside the primary
app-alive metric.

Two earlier Luna control attempts remain immutable invalid records. One reached
an app-alive observation at 470.438 seconds but the changed-bundle proof timed
out. The other has no coordinator app-alive record or stamped event stream;
operator process inspection found Expo waiting in a macOS System Events query,
while its preserved rollout shows later build/install/launch activity followed
by repeated Metro liveness failures. The coordinator rescheduled the same cell
until the valid control run above completed. Invalid attempts are reported for
harness audit and are not substituted into the matched result.

Cost estimates use the direct token rates recorded on 2026-09-03 from the
official [`gpt-5.6-luna`](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
and [`gpt-5.6-sol`](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
model pages; they exclude tool and machine runtime. One pair per model is not a
variance estimate.

## Pins

`pins.env` is created before golden preparation and is immutable for a block.
Preflight fails rather than merely recording a mismatch. The initial execution
pins are:

```text
TRAILHEAD_UPSTREAM_COMMIT=f4a4a3b7b1df2b079959cace34b5caa9c593e76e
STIM_COMMIT=3f3d55e
CODEX_VERSION=0.145.0-alpha.11
CLAUDE_VERSION=2.1.257
MACOS_VERSION=26.5.2
MACOS_BUILD=25F84
XCODE_VERSION=26.6
XCODE_BUILD=17F113
NODE_VERSION=26.7.0
COCOAPODS_VERSION=1.17.0
CODEX_SERVICE_TIER=priority
CODEX_REASONING_EFFORT=high
```

Preparation appends the fixture commit, exact model identifiers, runner
executable hashes, Stim tarball hash, simulator model and runtime, lockfile
hash, and complete price table. Any deliberate pin change starts a new named
block and is not pooled with earlier results.

## Fixed fixture and changes

Preparation creates a benchmark fixture commit from the pinned Trailhead
commit. It replaces the sentence in `AGENTS.md` that names Stim with
`Use local commands for builds and simulator sessions.` and normalizes the
committed Pod lockfile to the pinned CocoaPods version. The first change removes
the control arm's Stim-probe cue identically for both arms; the second makes the
carried `Pods/Manifest.lock` equal the tracked lockfile before timing. The
derived fixture commit is recorded in `pins.env`, and every run starts in a
clean main checkout at that commit.

The variants never share a run.

**JavaScript-only.** In `app/(tabs)/settings.tsx`:

```diff
-subtitle="Keep map tiles for saved trails on device"
+subtitle="Keep saved trail maps available offline"
```

**Native.** In `ios/Trailhead/AppDelegate.swift`, immediately after the
existing `window = UIWindow(frame: UIScreen.main.bounds)` assignment:

```swift
window?.accessibilityIdentifier = "Trailhead <run-id>"
```

This changes compiled Swift, not a copied plist. For both arms the installed
executable must contain the exact run id. A Stim hit under the old fingerprint,
or a control build without Swift compile/link evidence, invalidates the run.

## Exact prompts

The coordinator substitutes only `<run-id>`, `<run-dir>`, `<main-checkout>`,
and `<worktree-parent>`. The timed prompt never mentions preparation, cache
state, DerivedData, or the other arm.

### Stim, JavaScript

```text
In <main-checkout>, create a git worktree for branch bench/<run-id> under <worktree-parent>. In that worktree, change the Settings offline-map subtitle from "Keep map tiles for saved trails on device" to "Keep saved trail maps available offline". Use the Stim skill and only the pinned command available on PATH as exactly `stim` (never through npx or an absolute path). Keep the inherited STIM_HOME unchanged. Run the iOS app on a new iPhone 17 simulator running iOS 26.5; do not use an existing simulator. Leave the changed app and its Metro server running. Carry installed dependencies and native outputs from the main checkout into the new worktree. Do not use subagents. Do not read or write outside the checkout, the worktree, and <run-dir>. When the app is running, report the worktree path and stop; the coordinator will verify and clean up.
```

### Control, JavaScript

```text
In <main-checkout>, create a git worktree for branch bench/<run-id> under <worktree-parent>. In that worktree, change the Settings offline-map subtitle from "Keep map tiles for saved trails on device" to "Keep saved trail maps available offline". Run the iOS app with the project's local Expo and Apple tooling on a new iPhone 17 simulator running iOS 26.5; do not use an existing simulator. Start Metro as a detached process and leave both Metro and the changed app running. Do not use Stim. Carry installed dependencies and native outputs from the main checkout into the new worktree. Do not use subagents. Do not read or write outside the checkout, the worktree, and <run-dir>. When the app is running, report the worktree path and stop; the coordinator will verify and clean up.
```

### Stim, native

```text
In <main-checkout>, create a git worktree for branch bench/<run-id> under <worktree-parent>. In that worktree, edit ios/Trailhead/AppDelegate.swift so that immediately after the existing window assignment it sets the window accessibilityIdentifier to "Trailhead <run-id>". Use the Stim skill and only the pinned command available on PATH as exactly `stim` (never through npx or an absolute path). Keep the inherited STIM_HOME unchanged. Run the iOS app and leave it running on a new iPhone 17 simulator running iOS 26.5; do not use an existing simulator. Carry installed dependencies and native outputs from the main checkout into the new worktree. Do not use subagents. Do not read or write outside the checkout, the worktree, and <run-dir>. When the app is running, report the worktree path and stop; the coordinator will verify and clean up.
```

### Control, native

```text
In <main-checkout>, create a git worktree for branch bench/<run-id> under <worktree-parent>. In that worktree, edit ios/Trailhead/AppDelegate.swift so that immediately after the existing window assignment it sets the window accessibilityIdentifier to "Trailhead <run-id>". Run the iOS app with the project's local Expo and Apple tooling on a new iPhone 17 simulator running iOS 26.5; do not use an existing simulator. Leave the changed app running. Do not use Stim. Carry installed dependencies and native outputs from the main checkout into the new worktree. Do not use subagents. Do not read or write outside the checkout, the worktree, and <run-dir>. When the app is running, report the worktree path and stop; the coordinator will verify and clean up.
```

## Primary metric and proof

The primary metric is `dispatchToAppAliveSeconds`. It starts immediately
before the coordinator dispatches the prompt. It ends at the first coordinator
observation that all of these are true on the run's newly created simulator:

1. `com.appandflow.trailhead` was installed after dispatch.
2. `simctl get_app_container` resolves the installed bundle.
3. Host `ps -A -o command=` contains the live Trailhead application executable
   under that simulator's UDID-specific CoreSimulator data path. This host-side
   check is used because current iOS simulator runtimes do not ship `ps`.

The watcher polls independently of the runner command. This makes a
long-running Expo/Metro process and a short-lived Stim command equivalent. The
simulator UDID is discovered from post-dispatch `simctl list --json` changes;
exactly one newly created simulator must exist. The Stim arm must record it as
owned, while the control arm records its benchmark name. Ambiguity invalidates
the run.

For the JavaScript variant, the watcher also requests the development bundle
at the first app-alive observation and saves it under `proof/`. The collector
must find the requested changed string in that captured bundle. This avoids
depending on either runner's background-process lifetime after the measured
app has already become live.

The proof gate is separate from the headline time:

- Native: copy the installed executable to the run directory and search it for
  the exact `Trailhead <run-id>` string while the app remains alive.
- JavaScript: query the Metro bundle used by the installed app and retain the
  bundle response containing the exact changed subtitle. If a stable
  accessibility-tree route becomes available, it may replace this proof for
  an entire block, never midway through one.

No screenshot navigation or click geometry is part of v3. A run without proof
is invalid even if the app process was observed.

## Secondary metrics

Coordinator timestamps are authoritative for dispatch, app observation,
proof, and cleanup. It prefixes every runner stdout/stderr JSON line with an
arrival timestamp in `events.jsonl`. Codex's stream has no native timestamps,
so its phase boundaries are arrival-time approximations and may include pipe
buffering. Codex rollouts are retained until collection, used as a timestamp
cross-check, then copied with secrets redacted before the disposable runner
home is deleted.

Claude message events have timestamps but Bash results do not. A command start
is the timestamp of the assistant event containing its tool call and its end is
the matching result's arrival. Parallel tool calls receive only a shared
message-start bound and are marked `parallelTimingAmbiguous`; they are excluded
from command-duration summaries, not from wall time.

| Field                       | Base           | Definition                                           |
| --------------------------- | -------------- | ---------------------------------------------------- |
| `dispatchToWorktreeSeconds` | dispatch       | first observation of the run worktree                |
| `worktreeToEditSeconds`     | worktree       | target file first contains the requested edit        |
| `editToBuildStartSeconds`   | edit           | first build/run command event                        |
| `dispatchToAppAliveSeconds` | dispatch       | independent watcher event above                      |
| `dispatchToProofSeconds`    | dispatch       | proof gate completed                                 |
| `proofToCleanupSeconds`     | proof          | cleanup verified                                     |
| `bootstatusSeconds`         | command        | bounded `simctl bootstatus -b` duration              |
| `firstSimctlPenaltySeconds` | boot           | first successful post-boot query duration            |
| `fingerprintSeconds`        | command        | Stim fingerprint phase when present                  |
| `buildIntervalSeconds`      | build start    | build start to app-alive observation                 |
| `retrySecondsByClass`       | command events | object mapping fixed class to failed-attempt seconds |

`commands.log` is generated after the run by the collector from stamped event
streams. It is never written or timed by the agent. It contains UTC start/end,
elapsed time or ambiguity, exit status, and source event offsets. Struggles are
collector classifications backed by those offsets, not agent self-report.

The fixed classes are `port-collision`, `stale-metro`, `sim-boot`,
`sim-missing`, `pod-install`, `signing`, `dependency-install`,
`cache-surprise`, `tool-missing`, `wrong-directory`, `permission`,
`flag-misuse`, `bundler-attach`, `disk-space`, `tcc-denied`, and `other`.

## Machine and cache state

Goldens live on the same APFS volume as each restore target. Preparation and
every reset compare `diskutil info -plist` volume UUIDs and fail if they differ.
`cp -c` success alone is not accepted as proof of a clone. Restores target only
benchmark-owned paths:

- A run-specific `STIM_HOME` cloned from the Stim golden. The current pilot
  golden retains the pre-normalization artifact and the post-normalization
  `7d04e2...-debug-sim` artifact. Only the latter matches the fixture's current
  JavaScript fingerprint; preflight resolves that exact key before every run.
  The golden also carries the pinned `compilation-cache` and `metro-cache`; it
  has no workspace registry or device records.
- Trailhead-named DerivedData directories plus golden
  `ModuleCache.noindex` and `CompilationCache.noindex`. Other projects' Xcode
  state is untouched.
- A run-specific control `$TMPDIR` cloned from its golden, including a fixed
  Metro transform-cache state.
- Shared read-mostly npm/pnpm and CocoaPods download caches, whose paths,
  sizes, and hashes of index metadata are recorded before each block.

Stim's portable, content-addressed build artifact is intentionally available
only to the Stim arm: that portability is the feature under test. A fresh
worktree gives the control arm cold path-keyed build products. Both arms share
the prepared Xcode module and compilation caches. The report labels control
native values as cold-DerivedData builds and records Xcode compilation-cache
hit/miss statistics for both arms, plus Stim's artifact and compilation-cache
results. A warm-worktree incremental Xcode comparison is a separate benchmark,
not silently mixed into this one.

Every timed run gets a newly created simulator with the pinned model and
runtime. No simulator is reused between timed runs. Reset requires all earlier
benchmark simulators deleted, no unrelated simulator booted, ports 8081-8090
without listeners, no earlier benchmark process alive, and the main checkout
clean at the fixture commit. Any unrelated booted simulator or listener pauses
preflight for operator cleanup; it is never killed automatically. Each run's
simulator is shut down and deleted after artifacts are copied.

Reset also:

1. Prunes only benchmark-owned DerivedData, runner homes, worktrees,
   simulators, and result staging paths from prior completed runs.
2. Records free bytes for the volumes holding CoreSimulator, checkout,
   goldens, results, and `STIM_HOME`; dispatch requires at least 12 GiB free on
   the CoreSimulator volume and 8 GiB on every other target volume.
3. Waits for one-minute load average at or below 3.0 for two consecutive
   15-second samples, up to 10 minutes. A timeout preserves a `not-started`
   record and moves to the next scheduled window; it never deletes a cell.
4. Records `pmset -g therm` at dispatch and build start. A reported CPU or
   thermal warning invalidates and reschedules the run.
5. Records first `simctl` latency and the later `bootstatus` interval.

Golden preparation logs show which single current key preflight resolves from
the retained artifacts, plus the compilation-cache hit ratios. A golden is
never rebuilt within a block. If it must change, remaining cells move to a new
block id.

## Runner and tool isolation

Each run has a disposable runner home. Authentication material alone is copied
from the operator profile, with permissions preserved; histories, memories,
settings, plugins, MCP configuration, and sessions are not copied.

Codex runs without `--ephemeral` so the timestamped rollout remains available
to the collector:

```text
CODEX_HOME=<run-home>/.codex codex --ask-for-approval never exec \
  --strict-config --ignore-rules --json --model <model> \
  --sandbox danger-full-access --add-dir <results-block> --cd <main-checkout>
```

The isolated config pins `service_tier = "priority"` and
`model_reasoning_effort = "high"`. Bundled skills and plugins are disabled. All
discovered external skill paths are disabled; the Stim profile enables only a
copied, hash-verified Stim skill.
`codex debug prompt-input` must show no skills in control and only Stim in the
Stim arm. It must also show the pinned cwd and no connector/plugin tools.

Claude is launched with `cwd=<main-checkout>` by the coordinator:

```text
CLAUDE_CONFIG_DIR=<run-home> claude -p --output-format stream-json --verbose \
  --model <model> --permission-mode bypassPermissions --strict-mcp-config \
  --mcp-config <empty-config> --disallowedTools Task \
  --add-dir <worktree-parent> --add-dir <run-dir>
```

The init event must report the pinned cwd, zero MCP servers, no Task tool, and
identical tools across arms. Claude's built-in `run`, `verify`, and `debug`
skills cannot currently be removed and are a standing symmetric deviation.
Their use is recorded. The Stim arm additionally receives only the copied Stim
skill. Subagent use invalidates a run.

`stim`, `agent-device`, and their skills are quarantined for control. Both arms
use coordinator source/process proof, so `agent-device` is unavailable to both.
Preflight requires `command -v stim` to fail in control and resolve to the
hash-pinned shim in Stim. That shim is tested with the run's `STIM_HOME` and
must report the expected configuration path; this guards against the historic
`.stim`/`.stim-cli` split-state failure. Every transcript is audited for access
to another arm, another run, coordinator source, or a quarantined binary.

Before timing a runner block, one untimed smoke per profile proves worktree
creation/removal and a simulator query. A permission or isolation failure
blocks the timed block rather than becoming a benchmark result.

## Tokens and notional cost

Time is primary. Dollar values are secondary, notional list-price observations;
these runs use subscription plans, so neither vendor figure is the operator's
actual payment. Raw token vectors are published beside every dollar figure.
Vendor cache-write/read policies differ, so notional cost embeds pricing policy
as well as agent efficiency.

For Codex, the final usage vector is:

```text
uncached_input = input_tokens - cached_input_tokens
cached_input = cached_input_tokens
output = output_tokens
reasoning_output = reasoning_output_tokens
```

For Claude, `modelUsage` is keyed by model. Every primary and auxiliary model
entry is retained and included in the run total:

```text
uncached_input = inputTokens + cacheCreationInputTokens
cached_input = cacheReadInputTokens
output = outputTokens
thinking_output = usage.output_tokens_details.thinking_tokens
```

Claude's per-model fields also include `webSearchRequests`, `costUSD`,
`contextWindow`, `maxOutputTokens`, `canonicalModel`, `provider`, and
`costBasis`; there is no `thinkingTokens` field in `modelUsage`. Tool-call and
shell-command counts replace runner-specific turn counts.

The Codex priority price table is pinned on 2026-09-03 from the direct official
model pages: [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol),
[Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), and
[Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna). The
requested tier is retained. Codex CLI 0.145 does not expose the returned tier
in its JSON event stream; if the rollout also omits it, notional cost is marked
`tier-unverified` instead of silently assuming that the request was honored.
The official
[Responses reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
defines the `priority` tier. Prices per million tokens are:

| Model           | Input | Cached input | Output |
| --------------- | ----: | -----------: | -----: |
| `gpt-5.6-sol`   | $4.00 |        $0.40 | $20.00 |
| `gpt-5.6-terra` | $2.00 |        $0.20 | $12.00 |
| `gpt-5.6-luna`  | $0.20 |        $0.02 |  $1.20 |

Claude's result-provided per-model list cost is retained along with the raw
vector and its reported `costBasis`. The report never compares the two
vendors' bare `inputTokens` fields because their inclusion rules differ.

## Order, records, and validity

Confirmatory order uses repeated balanced four-run blocks:

1. Stim/Sol, control/Sol, control/Opus, Stim/Opus.
2. Control/Opus, Stim/Opus, Stim/Sol, control/Sol.
3. Control/Sol, Stim/Sol, Stim/Opus, control/Opus.
4. Stim/Opus, control/Opus, control/Sol, Stim/Sol.

Thus each arm, vendor, and predecessor position is balanced. Calibration uses
the first three Sol arm pairs in alternating order. Screening uses a
pre-generated seeded order recorded before dispatch and reports all cells
individually.

One directory per run contains:

```text
<results>/<block>/<run-id>/
  meta.json
  prompt.txt
  runner-stream.jsonl
  events.jsonl
  rollout.jsonl | claude-session.jsonl
  commands.log
  run.json
  proof/
  raw/
```

`dispatch` writes `meta.json`, the exact prompt, and stamped streams. `collect`
alone produces `commands.log` and `run.json`; `report` consumes only immutable
run directories. The pilot `run.json` stores the runner, model, requested and
returned service-tier evidence, arm, variant, validity reasons, app-alive and
proof times, simulator/worktree evidence, proof record, raw token vector,
command count, and an empty reserved `retrySecondsByClass` object. The later
calibration driver must version and add cache-state, phase, struggle-offset,
deviation, and cleanup fields before those stages begin.

A run is invalid if it changes the main checkout; violates skill, binary, MCP,
subagent, cwd, or directory isolation; overlaps another timed run; starts from
the wrong cache or simulator state; encounters thermal throttling or permission
failure; lacks event or command evidence; uses an unpinned service tier; or
boots an app without the requested proof. An invalid run is preserved under
its original id with `valid: false`, then the same pre-registered cell is
rescheduled under a new id. Its time and tokens are reported separately but
never replace or silently disappear from the planned sample.

## Report

The report leads with all valid `dispatchToAppAliveSeconds` observations and
the confirmatory arm difference with its pre-registered precision statement.
It then reports:

1. Every run's phase breakdown, without selecting noisy extremes.
2. Stim fingerprint/artifact/cache evidence and control compile/link/cache
   evidence.
3. Struggle occurrences per run; no population totals are inferred from the
   one-shot screening stage.
4. Raw tokens and secondary notional list costs per run.
5. Native confirmatory estimates, medians, ranges, order plot, and deviations.
6. JavaScript screening cells clearly labelled `n = 1, descriptive`.
7. Cleanup evidence and every invalid attempt.

The 61.2-83.8 second spread cited during design came from the separate
2026-09-02 cache-hit investigation across fresh worktrees and fresh simulators,
not from v2 repetitions. Recomputed v2 app-alive times were about 358 seconds
for control and 147 seconds for Stim, but the asymmetric MCP configuration and
different measurement setup make the 2.4x ratio historical context only.

## Pilot driver

A machine-local Codex pilot helper lives outside this repository under
`stim-bench-coordinator/v3-20260902/`. It implements `prepare`, `preflight`,
profile and runner smokes, one-run `dispatch`, idempotent `collect`, explicit
one-run `cleanup`, and `report`. It does not yet dispatch Claude, schedule
calibration or confirmatory blocks, compute the pre-registered sample size, or
implement the final manifest allowlist. Those stages must not start until those
capabilities exist and are version-pinned. The current cleanup command accepts
one explicit run directory, derives only that run's benchmark branch,
worktree, simulator, Metro process, and scoped `STIM_HOME`, and records its
actions. Parser/report changes reuse preserved run evidence and do not require
a timed rerun.
