# Command Orchestrator Refactor Implementation Plan

**Goal:** Split three large command orchestrators into named, testable phases.

**Architecture:** Keep each platform independent. Add small helpers in the
existing command files. Pass explicit typed arguments between helpers. Preserve
public entry points and output order.

**Tech Stack:** TypeScript, Commander, Vitest, tsdown, oxlint, oxfmt.

---

### Task 1: Establish the behavior baseline

**Files:**

- Test: `packages/stim-cli/src/__tests__/worktree-remove.test.ts`
- Test: `packages/stim-cli/src/__tests__/ios-command.test.ts`
- Test: `packages/stim-cli/src/__tests__/android-command.test.ts`

**Step 1:** Run the three suites.

Run: `npx vitest run packages/stim-cli/src/__tests__/worktree-remove.test.ts packages/stim-cli/src/__tests__/ios-command.test.ts packages/stim-cli/src/__tests__/android-command.test.ts`

Expected: all tests pass.

### Task 2: Extract worktree removal phases

**Files:**

- Modify: `packages/stim-cli/src/commands/worktree.ts`
- Test: `packages/stim-cli/src/__tests__/worktree-remove.test.ts`

**Step 1:** Extract removal path resolution, blocker inspection and output,
pod-churn restoration, and cleanup result output.

**Step 2:** Add `runRemove(target, options)` and make `registerRemove` only wire
Commander to it.

**Step 3:** Run the worktree removal suite.

Expected: all tests pass with unchanged output assertions.

### Task 3: Extract iOS phases

**Files:**

- Modify: `packages/stim-cli/src/commands/ios.ts`
- Test: `packages/stim-cli/src/__tests__/ios-command.test.ts`

**Step 1:** Extract deployment, upload completion, launch verification, and
final output helpers.

**Step 2:** Keep cache and build orchestration in `runIos`.

**Step 3:** Run the iOS command suite.

Expected: all tests pass with unchanged facts and output.

### Task 4: Extract Android phases

**Files:**

- Modify: `packages/stim-cli/src/commands/android.ts`
- Test: `packages/stim-cli/src/__tests__/android-command.test.ts`

**Step 1:** Extract deployment, upload completion, launch verification, and
final output helpers.

**Step 2:** Keep cache and build orchestration in `runAndroid`.

**Step 3:** Run the Android command suite.

Expected: all tests pass with unchanged facts and output.

### Task 5: Verify and integrate

**Files:**

- Modify only files listed above and this plan.

**Step 1:** Run `npm run format:check`, `npm run lint`, `npm run typecheck`,
`npm test`, and `npm run build`.

**Step 2:** Review `git diff --check` and the final diff.

**Step 3:** Commit and push the behavior-preserving refactor.
