# Shared Utilities and Cache Manifest Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove duplicated output and process helpers, make iOS and Android output consistent, and serialize cache manifest updates without adding dependencies.

**Architecture:** Keep presentation helpers and process helpers inside the CLI. Put the filesystem lock and cache manifest transaction in `@rn-iso/core`, because cache packages must work without `rn-iso` installed. Keep command, Metro, build-engine, and CLI cache validation behavior in their current domains.

**Tech Stack:** TypeScript, Node.js 22 built-ins, Vitest, pnpm workspaces, tsdown

---

### Task 1: Shared command output

**Files:**
- Create: `packages/rn-iso/src/command-output.ts`
- Create: `packages/rn-iso/src/__tests__/command-output.test.ts`
- Modify: `packages/rn-iso/src/commands/ios.ts`
- Modify: `packages/rn-iso/src/commands/android.ts`
- Modify: `packages/rn-iso/src/__tests__/ios-command.test.ts`
- Modify: `packages/rn-iso/src/__tests__/android-command.test.ts`

**Step 1: Write the failing shared output tests**

Create tests for the approved contract:

```ts
import { formatDuration, phaseLine, shortHash } from '../command-output.ts';

test('formatDuration uses one format for every command', () => {
  expect(formatDuration(0)).toBe('0ms');
  expect(formatDuration(410)).toBe('410ms');
  expect(formatDuration(1000)).toBe('1s');
  expect(formatDuration(3100)).toBe('3.1s');
  expect(formatDuration(18000)).toBe('18s');
  expect(formatDuration(119600)).toBe('2m00s');
  expect(formatDuration(161000)).toBe('2m41s');
  expect(formatDuration(605000)).toBe('10m05s');
  expect(formatDuration(undefined)).toBe('unknown');
  expect(formatDuration(-1)).toBe('unknown');
});

test('phaseLine uses one indented column', () => {
  expect(phaseLine('device', 'x')).toBe('  device      x');
  expect(phaseLine('fingerprint', 'x')).toBe('  fingerprint x');
});

test('shortHash keeps short values and abbreviates long values', () => {
  expect(shortHash('12345678')).toBe('12345678');
  expect(shortHash('123456789')).toBe('123456..');
  expect(shortHash(null)).toBe('');
});
```

**Step 2: Run the new test and verify RED**

Run: `pnpm vitest run packages/rn-iso/src/__tests__/command-output.test.ts`

Expected: FAIL because `command-output.ts` does not exist.

**Step 3: Add the minimal shared implementation**

Implement `formatDuration`, `phaseLine`, and `shortHash`. Round to the nearest millisecond below one second. Use one decimal place for non-integral seconds and remove `.0`. Round minute output to the nearest second and pad seconds to two digits.

**Step 4: Run the shared output test and verify GREEN**

Run: `pnpm vitest run packages/rn-iso/src/__tests__/command-output.test.ts`

Expected: PASS.

**Step 5: Replace command-local helpers**

Import the shared helpers in both commands. Re-export them from each command module to preserve current internal imports. Remove only the local implementations. Update the existing command tests to the approved results.

**Step 6: Run command tests**

Run: `pnpm vitest run packages/rn-iso/src/__tests__/command-output.test.ts packages/rn-iso/src/__tests__/ios-command.test.ts packages/rn-iso/src/__tests__/android-command.test.ts`

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/rn-iso/src/command-output.ts packages/rn-iso/src/__tests__/command-output.test.ts packages/rn-iso/src/commands/ios.ts packages/rn-iso/src/commands/android.ts packages/rn-iso/src/__tests__/ios-command.test.ts packages/rn-iso/src/__tests__/android-command.test.ts
git -c commit.gpgsign=false commit -m "refactor: share command output helpers"
```

### Task 2: Shared process output

**Files:**
- Create: `packages/rn-iso/src/process-output.ts`
- Create: `packages/rn-iso/src/__tests__/process-output.test.ts`
- Modify: `packages/rn-iso/src/supervisor/server-expo.ts`
- Modify: `packages/rn-iso/src/engine/deps.ts`
- Modify: `packages/rn-iso/src/engine/prebuild.ts`
- Modify: `packages/rn-iso/src/engine/gradle.ts`
- Modify: `packages/rn-iso/src/engine/xcode.ts`
- Modify: `packages/rn-iso/src/engine/js-swap.ts`
- Modify: `packages/rn-iso/src/engine/apk-swap.ts`
- Modify: `packages/rn-iso/src/engine/remote-cache.ts`
- Modify: `packages/rn-iso/src/collector/run.ts`
- Modify: `packages/rn-iso/src/__tests__/supervisor-expo.test.ts`

**Step 1: Write the failing process helper tests**

Test Node ANSI and OSC removal, split line reconstruction, final line flushing, child exit resolution, and child spawn error resolution. Use `makeChildProcess` for the child result tests.

**Step 2: Run the new test and verify RED**

Run: `pnpm vitest run packages/rn-iso/src/__tests__/process-output.test.ts`

Expected: FAIL because `process-output.ts` does not exist.

**Step 3: Add the minimal shared implementation**

Use `stripVTControlCharacters(String(text ?? ''))` for ANSI removal. Move the current line reader without changing its buffering behavior. Move `ChildResult` and `waitForChild` from `engine/deps.ts` without changing exit or error semantics.

**Step 4: Run the new test and verify GREEN**

Run: `pnpm vitest run packages/rn-iso/src/__tests__/process-output.test.ts`

Expected: PASS.

**Step 5: Update consumers**

Import neutral helpers from `process-output.ts`. Keep `cleanLine` in `server-expo.ts`, but make it use the shared `stripAnsi`. Remove the private ANSI function from `remote-cache.ts`. Re-export helpers from their old modules only where an existing test or internal API requires compatibility.

**Step 6: Run affected tests**

Run: `pnpm vitest run packages/rn-iso/src/__tests__/process-output.test.ts packages/rn-iso/src/__tests__/supervisor-expo.test.ts packages/rn-iso/src/__tests__/engine-deps.test.ts packages/rn-iso/src/__tests__/engine-prebuild.test.ts packages/rn-iso/src/__tests__/engine-gradle.test.ts packages/rn-iso/src/__tests__/engine-xcode.test.ts packages/rn-iso/src/__tests__/engine-js-swap.test.ts packages/rn-iso/src/__tests__/engine-apk-swap.test.ts packages/rn-iso/src/__tests__/engine-remote-cache.test.ts packages/rn-iso/src/__tests__/collector-run.test.ts`

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/rn-iso/src/process-output.ts packages/rn-iso/src/__tests__/process-output.test.ts packages/rn-iso/src/supervisor/server-expo.ts packages/rn-iso/src/engine packages/rn-iso/src/collector/run.ts packages/rn-iso/src/__tests__/supervisor-expo.test.ts
git -c commit.gpgsign=false commit -m "refactor: share process output helpers"
```

### Task 3: Locked core manifest transaction

**Files:**
- Modify: `packages/core/index.ts`
- Create: `packages/core/__tests__/cache-manifest.test.ts`
- Modify: `packages/rn-iso/src/dir-lock.ts`

**Step 1: Write the failing lock regression test**

Add a test that creates the manifest lock directory, starts a child process which calls `registerCache`, and verifies that `caches.json` does not appear until the parent removes the lock. Use a short polling helper instead of a fixed long sleep.

Add a second test which starts several child processes with distinct cache directories. Verify that every directory remains in the final manifest.

**Step 2: Run the core test and verify RED**

Run: `pnpm vitest run packages/core/__tests__/cache-manifest.test.ts`

Expected: FAIL because cache registration does not honor the manifest lock.

**Step 3: Move the directory lock into core**

Move the current synchronous, reentrant `withDirLock` implementation from `packages/rn-iso/src/dir-lock.ts` into `packages/core/index.ts`. Keep the same timeout error code and stale lock behavior. Change the CLI module to re-export the core function so current CLI imports remain stable.

**Step 4: Add the manifest transaction**

Export these core primitives:

```ts
export interface CacheManifest {
  version: number;
  caches: Array<Record<string, unknown>>;
}

export function cacheManifestLockPath(file: string): string;
export function readCacheManifest(file: string): CacheManifest;
export function updateCacheManifest(
  file: string,
  mutate: (caches: Array<Record<string, unknown>>) => Array<Record<string, unknown>>,
): CacheManifest;
```

`updateCacheManifest` must create the parent directory, take the lock, read inside the lock, call the mutation once, write a process-specific temporary file, rename it over the manifest, and remove the temporary file after an error.

Change `registerCache` to call this transaction inside its existing non-throwing boundary.

**Step 5: Run the core test and verify GREEN**

Run: `pnpm vitest run packages/core/__tests__/cache-manifest.test.ts packages/expo-build-cache/__tests__/register.test.ts`

Expected: PASS.

**Step 6: Run existing lock consumers**

Run: `pnpm vitest run packages/rn-iso/src/__tests__/config.test.ts packages/rn-iso/src/__tests__/paths.test.ts packages/rn-iso/src/__tests__/supervisor-run.test.ts`

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/core/index.ts packages/core/__tests__/cache-manifest.test.ts packages/rn-iso/src/dir-lock.ts
git -c commit.gpgsign=false commit -m "fix: serialize cache manifest updates"
```

### Task 4: Use the core transaction in the CLI

**Files:**
- Modify: `packages/rn-iso/src/cache-manifest.ts`
- Modify: `packages/rn-iso/src/__tests__/cache-manifest.test.ts`
- Modify: `packages/rn-iso/src/__tests__/cache-packages.test.ts`

**Step 1: Write a failing CLI concurrency test**

Add a test that starts one core cache registration and one CLI registration against the same temporary `RN_ISO_HOME`. Verify that both distinct entries remain. The test must execute real child processes.

**Step 2: Run the CLI manifest test and verify RED**

Run: `pnpm vitest run packages/rn-iso/src/__tests__/cache-manifest.test.ts`

Expected: FAIL because the CLI writer does not use the core manifest lock.

**Step 3: Replace the CLI writer**

Import `readCacheManifest` and `updateCacheManifest` from `@rn-iso/core`. Preserve `CacheEntry`, tilde expansion, prune normalization, depth normalization, corrupt-file handling, and thrown validation errors. Remove the duplicate temporary-file writer.

**Step 4: Run cache tests and verify GREEN**

Run: `pnpm build && pnpm vitest run packages/core/__tests__/cache-manifest.test.ts packages/expo-build-cache/__tests__/register.test.ts packages/rn-iso/src/__tests__/cache-manifest.test.ts packages/rn-iso/src/__tests__/cache-packages.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/rn-iso/src/cache-manifest.ts packages/rn-iso/src/__tests__/cache-manifest.test.ts packages/rn-iso/src/__tests__/cache-packages.test.ts
git -c commit.gpgsign=false commit -m "refactor: share cache manifest transaction"
```

### Task 5: Documentation and full verification

**Files:**
- Modify: `packages/rn-iso/skill/SKILL.md`

**Step 1: Update user guidance**

In the command output description, state that iOS and Android use the same indented phase layout and compact duration format. Keep the text brief.

**Step 2: Run all required checks**

Run these commands in order:

```bash
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false pnpm test
pnpm build
```

Expected: Every command exits zero. The test run reports no failures.

**Step 3: Inspect the final diff**

Run: `git diff main...HEAD --stat && git diff main...HEAD --check && git status --short`

Expected: No whitespace errors. Only planned files are changed. Generated `dist` files remain untracked or ignored.

**Step 4: Commit documentation and formatting**

```bash
git add packages/rn-iso/skill/SKILL.md
git -c commit.gpgsign=false commit -m "docs: describe consistent command output"
```
