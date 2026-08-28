# stim-cli — hand Metro back to the agent, keep the port

Date: 2026-08-20
Status: draft
Amends: `2026-08-16-spawn-and-reap-broker-design.md`. That spec made stim-cli a
pure environment broker for _devices_ while leaving Metro managed. This
finishes the job by applying the same rule to Metro.

## Purpose

The broker principle from the spawn-and-reap spec has one carve-out: stim-cli
still spawns Metro, picks its command line, captures its logs, and tracks its
PID. That carve-out is hard to justify on its own terms.

The reason build dispatch was deleted was that _how to invoke a project's
tooling_ is project-specific judgment an agent already has from repo context,
and encoding it centrally means perpetually chasing idiosyncrasies. Choosing a
Metro command is the same problem one layer down, and it fails the same way.
Observed on `member-app` during the 0.7.0 live smoke: the project's own start
script is `react-native start --client-logs`, and stim-cli spawned
`react-native start --port 8082`, silently dropping the project's flag. The
`detectIsExpo` heuristic got the hard part right by reading the project's own
`ios` script, but a reconstruction is still a reconstruction.

A second argument, weaker but worth recording because it was initially
believed and is wrong: managed Metro does **not** enforce correct port usage.
The agent must still pass `--port <port>` to its own build. If it forgets,
the build CLI spawns its own bundler on 8081 and the app connects there,
while stim-cli's managed Metro sits idle. The failure mode managed Metro
appears to prevent already exists; managing Metro only adds a wasted process
to it.

What does _not_ collapse is port allocation. A port is a contended,
cross-project resource: an agent in worktree A cannot know worktree B holds
8082, and two agents probing "is 8082 free?" concurrently both get yes. That
needs an arbiter, for exactly the reason device ownership does.

## The principle, stated without exception

> stim-cli brokers contended resources — the device and the Metro port. It
> allocates them, records them, and reaps them. It never invokes the
> project's tooling: not the build, not the bundler.

## What changes

### Deleted

- `src/metro.js` spawn machinery: `ensureMetro`, `buildMetroSpawnArgs`,
  `waitForMetroReady`, `logFileFor`, `logFileExists`.
- `src/commands/start.js` (its only purpose is spawning Metro).
- `src/commands/logs.js` and per-project Metro log files (nothing writes
  them once stim-cli does not own the process's stdio).
- `metroPid` and `metroLog` from the config record and from every facts
  payload.
- The use of `isExpo` to construct a Metro command line.

`detectIsExpo` itself stays: `status` prints it and `config` records it.

### Kept

- `src/ports.js` allocation and reclamation, unchanged. This is the whole
  reason stim-cli still touches Metro at all.
- `metroPort` in the facts contract.
- `metroHealthy`, redefined as a pure live `/status` probe with no spawning.
- `findPidListeningOnPort`.

### New: `resolveProjectMetro(port, projectPath)`

Teardown must not trust a port as identity. This is not hypothetical: the
final 0.7.0 review's one Critical finding was that Android teardown trusted
the emulator console _port_ as identity, so a foreign emulator occupying our
recorded port would have been killed by `shutdown`/`release`/`remove`. The
fix was `resolveOwnedAvdSerial`, verifying identity before any destructive
command. Port-based Metro teardown reintroduces that exact anti-pattern
unless guarded the same way.

Today the recorded PID _is_ proof of provenance, because stim-cli spawned the
process. Removing the spawn removes the proof, so the proof must be
reconstructed at teardown time.

The resolver mirrors `resolveOwnedIosSim`'s three-outcome shape:

```
{ metro: { pid, leader } }  identified as this project's Metro; safe to kill
{ missing: true }           nothing listening; already gone, not an error
{ notOurs: <description> }  something listening, not identifiable; report only
```

Identity requires **both** signals:

1. `/status` on the port answers `packager-status:running` — it is Metro and
   not some unrelated server that took the port.
2. The listening process's tree resolves to a working directory inside
   `projectPath` — it is _this project's_ Metro and not another worktree's.

Either signal alone is insufficient. Failing to get a definite answer routes
to `notOurs`, never to a kill: the same fail-closed direction as the
unmounted-volume guard.

### Process-tree handling

`lsof -t` returns the process holding the socket, which is frequently not the
process a caller would think of as "Metro". Observed during the 0.7.0 smoke:

```
59806  npm exec react-native start --port 8082     <- wrapper
59914  node .../react-native start --port 8082     <- holds the port
```

Under the current design `stop` kills the recorded parent and the child dies
with it. Under port-based teardown the resolver finds the child and can
orphan the wrapper. So the resolver must walk from the listening pid to the
process-group / session leader and signal the group, not the single pid.
`killMetroByPid`'s plain `process.kill(pid, 'SIGTERM')` changes accordingly.

Note that an agent-spawned Metro carries no guarantee of being a group leader
— that depends on how the agent backgrounded it — which is why SKILL.md must
prescribe a backgrounding convention rather than leave it to taste.

### Teardown sites

Four, all reusing the resolver, all failing closed on `notOurs`, each with
try/catch containment so one bad record cannot abort a batch:

- `release`
- `shutdown`
- `worktree remove` (via `reclaim.js`)
- `gc`

This is a net _improvement_ in coverage: port-based teardown also reaps
Metros that stim-cli never started, which today leak entirely.

### `stop`

Survives, repurposed as the manual entry point for the same guard: kill this
project's identified Metro, leave the device alone. This preserves the
`release` (device) / `stop` (Metro) symmetry and gives an agent a clean way
to restart Metro with different flags.

`stop --force` kills the listener without identity verification, for the case
where something holds the port and cannot be identified. It joins
`gc --delete`, `worktree remove --force`, and `release --force` under the
destructive-command rule that agents must ask the user first.

### `up`

Allocates and records the port; does not spawn. `metroHealthy` therefore
reports `false` on a fresh `up` in the normal case, which inverts the current
SKILL.md guidance that `false` right after `up` indicates a problem.

## Agent-facing changes (SKILL.md)

- A new "Starting Metro" section with a per-project-shape table, mirroring
  the existing "Common setups" build table.
- A backgrounding convention that keeps the process tree killable and the log
  path predictable, so the identity check can succeed and so a later session
  can find the output.
- `metroHealthy` guidance inverted: `false` on first `up` is expected; start
  Metro, then poll until healthy before building.
- "Metro is always managed by stim-cli ... never start your own Metro" replaced
  with "start it yourself, on the port stim-cli assigned."
- The lifecycle example gains an explicit Metro step between `up` and the
  build.

## Testing

Per the live-verification convention, mocked-executor tests cannot establish
that a shell command is correct, and this change is almost entirely shell
commands.

- Unit: the three resolver outcomes; parsing of `lsof` / `ps` output; the
  group-leader walk.
- **Live**: a real backgrounded Metro on a real port, positively identified
  and killed for real, including the `npm exec` wrapper shape above. Mocked
  `lsof` output would prove nothing here.
- Regression: teardown refuses to kill a foreign (non-project) listener on
  the port — the direct analogue of the Critical C1 finding.
- Action-level: `up` no longer spawns anything; `up --json` still emits
  exactly one JSON line with all status text on stderr.

## Risks

**The identity check is too strict.** If it cannot confirm a legitimately
ours Metro, teardown declines and agents leak processes and ports. `--force`
plus explicit reporting is the escape hatch. The live test is the real
mitigation — this risk lives entirely in the accuracy of real `lsof`/`ps`
output, which mocks cannot exercise.

**Agents ignore the assigned port.** Unchanged from today: the port was
always convention-enforced at the build step, and managed Metro never fixed
it.

**Cross-session log discovery is lost.** A session inheriting a Metro started
by an earlier one no longer has `stim-cli logs` to find its output. Mitigated,
not solved, by prescribing a predictable log path in SKILL.md.

## Versioning

Ships as **0.8.0**.

This section originally called for folding the change into an unpublished
0.7.0, so that npm would never see the managed-Metro model at all. That option
expired: 0.7.0 was published on 2026-08-20, before this work started, on the
explicit call that the library has no users yet and the churn is acceptable.

The consequence is real and should be stated rather than discovered: 0.7.0's
SKILL.md tells agents "Metro is always managed by stim-cli ... never start your
own Metro", and 0.8.0 reverses that. SKILL.md is distributed via
`npx skills add`, so cached copies carry the stale rule until re-added. The
0.8.0 release notes must therefore lead with the reversal under
"Removed (breaking)" and say plainly that agents now start Metro themselves.
