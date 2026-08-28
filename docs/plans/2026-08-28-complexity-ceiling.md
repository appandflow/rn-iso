# Complexity Ceiling Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enforce a cyclomatic complexity maximum of 80 and simplify the two
current violations without changing command behavior.

**Architecture:** Add the global Oxlint rule used by Hunk PR 861. Keep the
existing module-level deployment helpers. Move the remaining cache and build
branches into local phase functions inside each runner so they can share run
state without large parameter objects.

**Tech Stack:** TypeScript, Oxlint 1.80.0, Vitest, oxfmt, tsdown.

---

### Task 1: Enable the complexity ceiling

**Files:**

- Modify: `.oxlintrc.json`

**Step 1: Add the rule**

Add the first rule entry:

```json
"complexity": ["error", { "max": 80 }],
```

Do not add overrides or disable directives.

**Step 2: Run lint and verify the two failures**

Run: `npm run lint`

Expected:

- `runIos` reports complexity 148.
- `runAndroid` reports complexity 185.
- No other complexity error appears.

### Task 2: Split the remaining iOS orchestration

**Files:**

- Modify: `packages/rn-iso/src/commands/ios.ts:1122`
- Test: `packages/rn-iso/src/__tests__/ios-command.test.ts`

**Step 1: Run the iOS behavior suite**

Run: `npx vitest run packages/rn-iso/src/__tests__/ios-command.test.ts`

Expected: all tests pass before the refactor.

**Step 2: Extract local phase functions**

Keep the existing statements and their order. Move them into these local
functions inside `runIos`:

```ts
async function resolveMetroPort(): Promise<boolean>;
async function resolveInitialFingerprint(): Promise<boolean>;
async function resolveRemoteArtifact(): Promise<void>;
async function waitForSharedBuild(): Promise<boolean>;
async function prepareCachedArtifact(): Promise<void>;
async function buildArtifact(): Promise<boolean>;
```

The functions capture the existing local state. A function returns `false`
only after it calls `fail`. The caller returns `null` immediately for that
result.

Use this phase order:

```ts
if (!(await resolveMetroPort())) return null;
if (!(await resolveInitialFingerprint())) return null;
await resolveRemoteArtifact();
if (!(await waitForSharedBuild())) return null;
await prepareCachedArtifact();
if (!(await buildArtifact())) return null;
return finishIosRun(...);
```

Do not change the existing deployment helper contracts. Do not add comments or
new error handling.

**Step 3: Verify the iOS behavior and complexity**

Run: `npx vitest run packages/rn-iso/src/__tests__/ios-command.test.ts`

Expected: all tests pass.

Run: `npm run lint`

Expected: `runIos` no longer fails. `runAndroid` remains the only complexity
error.

### Task 3: Split the remaining Android orchestration

**Files:**

- Modify: `packages/rn-iso/src/commands/android.ts:1064`
- Test: `packages/rn-iso/src/__tests__/android-command.test.ts`

**Step 1: Run the Android behavior suite**

Run: `npx vitest run packages/rn-iso/src/__tests__/android-command.test.ts`

Expected: all tests pass before the refactor.

**Step 2: Extract local phase functions**

Keep the existing statements and their order. Move them into these local
functions inside `runAndroid`:

```ts
async function resolveMetroPort(): Promise<boolean>;
async function resolveInitialFingerprint(): Promise<boolean>;
async function resolveRemoteArtifact(): Promise<void>;
async function waitForSharedBuild(): Promise<boolean>;
async function prepareCachedArtifact(): Promise<void>;
async function buildArtifact(): Promise<boolean>;
```

The functions capture the existing local state. A function returns `false`
only after it calls `fail`. The caller returns the same failure result
immediately.

Use this phase order:

```ts
if (!(await resolveMetroPort())) return failedResult;
if (!(await resolveInitialFingerprint())) return failedResult;
await resolveRemoteArtifact();
if (!(await waitForSharedBuild())) return failedResult;
await prepareCachedArtifact();
if (!(await buildArtifact())) return failedResult;
return finishAndroidRun(...);
```

Preserve `AndroidRecord` updates and lock release order. Do not change the
existing deployment helper contracts. Do not add comments or suppressions.

**Step 3: Verify the Android behavior and complexity**

Run: `npx vitest run packages/rn-iso/src/__tests__/android-command.test.ts`

Expected: all tests pass.

Run: `npm run lint`

Expected: no complexity errors and no other lint errors.

### Task 4: Verify the repository

**Files:**

- Verify: all changed files

**Step 1: Run formatting**

Run: `npm run format:check`

Expected: pass.

**Step 2: Run lint and type checks**

Run: `npm run lint && npm run typecheck`

Expected: pass.

**Step 3: Run unit and integration tests**

Run: `npm test`

Expected: 57 test files and 1,752 tests pass.

Run: `npm run test:e2e`

Expected: pass.

**Step 4: Run the build**

Run: `npm run build`

Expected: pass.

**Step 5: Review the diff**

Run: `git diff --check`

Expected: no output.

Run: `git diff --unified=0 -- '*.ts' | rg '^\+\s*(//|/\*|\*)'`

Expected: no added comments.

### Task 5: Commit the implementation

**Files:**

- Commit: `.oxlintrc.json`
- Commit: `packages/rn-iso/src/commands/ios.ts`
- Commit: `packages/rn-iso/src/commands/android.ts`
- Commit: both complexity plan documents

**Step 1: Stage the exact files**

```bash
git add .oxlintrc.json \
  packages/rn-iso/src/commands/ios.ts \
  packages/rn-iso/src/commands/android.ts \
  docs/plans/2026-08-28-complexity-ceiling-design.md \
  docs/plans/2026-08-28-complexity-ceiling.md
```

**Step 2: Commit**

```bash
git -c commit.gpgsign=false commit -m "refactor: enforce complexity ceiling"
```
