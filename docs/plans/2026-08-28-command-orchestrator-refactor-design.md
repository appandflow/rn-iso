# Command Orchestrator Refactor Design

## Goal

Reduce the responsibilities of `registerRemove`, `runIos`, and `runAndroid`
without changing command order, output, error handling, or dependency injection.

## Constraints

- Keep the public command functions and their signatures.
- Keep phase order and stdout/stderr contracts.
- Keep current tests as behavior contracts.
- Do not create a shared iOS/Android pipeline.
- Do not change user-facing behavior.

## Design

`registerRemove` will only configure Commander and invoke a removal action. The
action will call helpers for target resolution, blocker inspection and output,
pod-churn restoration, and cleanup result output.

`runIos` will remain the public orchestration entry. It will delegate the stable
deployment, launch verification, cache upload completion, and result output
phases. The cache and build sequence will stay in `runIos` because its lock and
mutation state is tightly ordered.

`runAndroid` will use the same boundary. It will keep Android types and behavior
in `android.ts`. The two platforms will not share a new abstraction.

## Verification

Run the existing worktree removal, iOS command, and Android command suites after
each extraction. Run formatting, lint, type checks, the full test suite, and the
build before integration.
