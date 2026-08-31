# Shared Utilities and Cache Manifest Design

## Goal

Remove duplicated utility code without adding dependencies. Make iOS and Android command output consistent. Prevent concurrent cache registrations from overwriting each other.

## Command output

Add `packages/stim-cli/src/command-output.ts` for helpers shared by command implementations.

- `formatDuration` prints milliseconds below one second. It prints compact seconds below one minute. It prints zero-padded seconds with minutes. Invalid or negative values print `unknown`.
- `phaseLine` uses the same two-space indentation and label width for iOS and Android.
- `shortHash` keeps values with eight or fewer characters. It abbreviates longer values to six characters and two dots.

The iOS and Android commands import these helpers. Existing helper exports remain available from the command modules if tests or internal callers need them.

## Process output

Add `packages/stim-cli/src/process-output.ts` for process helpers shared by supervisors, collectors, and build engines.

- `stripAnsi` wraps Node's `stripVTControlCharacters`.
- `createLineReader` buffers partial lines and flushes the final line.
- `waitForChild` resolves with the child exit code, signal, or spawn error.

Metro-specific parsing stays in `supervisor/server-expo.ts`. Dependency-specific behavior stays in `engine/deps.ts`.

## Cache manifest concurrency

The cache manifest has two read-modify-write implementations. Neither locks the complete update. Atomic rename prevents partial files, but it does not prevent one process from replacing another process's update.

Add a synchronous cache manifest update primitive to `@stim-cli/core`. The primitive takes a directory lock, reads the current manifest, applies one mutation, and writes through a temporary file and atomic rename. The lock path is derived from the manifest path.

`@stim-cli/core` cache registration uses the primitive and keeps its non-throwing contract. The Stim cache manifest API uses the same primitive and keeps its current validation and error behavior.

## Tests

Use test-driven development for each behavior.

- Add command output tests for the unified format.
- Move process helper tests to a neutral test file and preserve the current edge cases.
- Add a regression test that holds the cache manifest lock and proves registration waits.
- Add a multi-process test that proves concurrent registrations remain in the manifest.
- Run formatting, linting, type checking, unit tests, and the build.

## Scope

Do not add dependencies. Do not change device, build, cache-key, or launch behavior. Do not modify the command orchestration refactor beyond the imports and helper removals required by this change.
