# Command module plan

The large command files mix orchestration with responsibilities that can be
reviewed independently. Extract those responsibilities without changing command
behavior or imposing file-size limits. This continues the boundaries in the
[command orchestrator design](./2026-08-28-command-orchestrator-refactor-design.md).

## Separate changes

1. [GC modules, #371](https://github.com/appandflow/stim/issues/371): keep
   registration, report collection, and cleanup order in `commands/gc.ts`. Move
   rendering, local-device helpers, EAS session ownership/locking/deletion, and
   cache policies into `commands/gc/`. Keep resource types and dependencies with
   their owners and preserve the existing entry exports.
2. [Native command modules, #372](https://github.com/appandflow/stim/issues/372):
   extract platform-specific helpers and install/launch/report boundaries from
   `commands/ios.ts` and `commands/android.ts`. Keep the ordered fingerprint,
   cache, lock, mutation, and build sequence in each command. Do not introduce a
   shared iOS/Android pipeline or a generic context object.
3. [Guide topics, #373](https://github.com/appandflow/stim/issues/373): move topic
   bodies out of `commands/guide.ts`, retaining registration, routing, and exact
   rendered text. Stack this change on the documentation correction for
   [#367](https://github.com/appandflow/stim/issues/367) so that it moves the
   corrected guidance. Keep the static skill as the existing discovery router.

Each issue has its own worktree, commit, review, and PR. Before editing, check for
an existing claim or PR, comment `Claimed: <branch>`, push the branch, and apply
the existing `in progress` label. Keep the label during implementation and
review; remove it when releasing or stopping the work. GC and native extraction
are independent. The guide PR targets its documentation parent and merges after
it. These changes do not absorb the bug fixes in #364–#366 or the reload work in
#361/#363.

## Invariants and verification

Preserve function contracts and dependency injection, exact text and serialized
output, dry-run behavior, ownership checks, and lock scope. Cleanup continues
to fail closed when ownership or state cannot be verified, and all device
teardown stays centralized. New modules import directly from their dependencies
and do not import their command entry point.

Run the existing affected suites before extraction and after each move. Capture
representative exact output before moving it; compare afterwards. Record command
line counts to show what moved, without treating size as a correctness check.
Run formatting, lint, build, typecheck, unit tests, knip, runtime checks, and fast
end-to-end tests before committing. Exercise any changed external-tool argument
list against the real tool. Independent review checks the moved logic and the
remaining orchestration before a PR is ready.
