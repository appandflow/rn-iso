# Lint Cleanup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove every Oxlint finding and make new warnings fail CI while adding high-signal Node.js, import, Promise, Vitest, and performance checks.

**Architecture:** Keep the base configuration useful for all Node.js and TypeScript files. Enable Vitest at the root because Oxlint does not expand category rules for plugins introduced in overrides. Keep local test helpers local by disabling the function-scoping performance rule in tests, and use narrow name allowances for external underscore APIs.

**Tech Stack:** Oxlint 1.80, TypeScript 7, Vitest 4, pnpm workspaces

---

### Task 1: Make the lint policy blocking

**Files:**

- Modify: `.oxlintrc.json`

**Step 1: Record the current failure count**

Run: `pnpm lint`

Expected: PASS with 126 warnings. The main rules are `consistent-function-scoping`, `no-array-sort`, `no-underscore-dangle`, and `no-shadow`.

**Step 2: Add the approved policy**

Update the base plugins to include `import`, `node`, `promise`, and `vitest`. Add root options that deny warnings and reject unused disable comments:

```json
"plugins": ["typescript", "unicorn", "oxc", "import", "node", "promise", "vitest"],
"options": {
  "denyWarnings": true,
  "reportUnusedDisableDirectives": "error"
}
```

Add these targeted rules:

```json
"no-underscore-dangle": [
  "warn",
  { "allow": ["_load", "_resolveFilename", "_root", "__path"] }
],
"oxc/no-map-spread": "warn",
"unicorn/prefer-array-find": "warn"
```

Enable these high-signal rules from the added plugins:

```json
"import/export": "error",
"import/named": "error",
"import/no-cycle": "error",
"import/no-duplicates": "error",
"node/no-exports-assign": "error",
"node/no-new-require": "error",
"node/no-path-concat": "error",
"promise/no-return-in-finally": "error",
"promise/no-return-wrap": "error"
```

Disable `vitest/no-commented-out-tests`. The rule scans non-test source comments when the plugin is active at the root.

Add an override for `**/*.test.ts`. Disable `unicorn/consistent-function-scoping` in this override. Configure `vitest/no-standalone-expect` with `test.skipIf` and `withDir` as additional test block functions.

Add a second override for `test/**/*.js` and `test/**/*.mjs`. Disable `unicorn/consistent-function-scoping` in this override.

**Step 3: Verify the new policy blocks existing findings**

Run: `pnpm lint`

Expected: FAIL because warnings are denied. The output must also include the new Promise, Vitest, and selected performance findings.

**Step 4: Check the configuration diff**

Run: `git diff --check && git diff -- .oxlintrc.json`

Expected: PASS with only the approved policy changes.

### Task 2: Replace mutating array helpers and inefficient searches

**Files:**

- Modify: `packages/rn-iso/src/__tests__/collector-parsers.test.ts`
- Modify: `packages/rn-iso/src/__tests__/collector-run.test.ts`
- Modify: `packages/rn-iso/src/__tests__/config.test.ts`
- Modify: `packages/rn-iso/src/__tests__/engine-gradle.test.ts`
- Modify: `packages/rn-iso/src/__tests__/engine-xcode.test.ts`
- Modify: `packages/rn-iso/src/__tests__/gc.test.ts`
- Modify: `packages/rn-iso/src/__tests__/guide.test.ts`
- Modify: `packages/rn-iso/src/__tests__/sim-android.test.ts`
- Modify: `packages/rn-iso/src/__tests__/sim-ios.test.ts`
- Modify: `packages/rn-iso/src/__tests__/worktree.test.ts`
- Modify: `packages/rn-iso/src/commands/doctor.ts`
- Modify: `packages/rn-iso/src/commands/ios.ts`
- Modify: `packages/rn-iso/src/engine/asset-manifest.ts`
- Modify: `packages/rn-iso/src/engine/gradle.ts`
- Modify: `packages/rn-iso/src/engine/xcode.ts`
- Modify: `packages/rn-iso/src/logs-query.ts`
- Modify: `packages/rn-iso/src/sim/android.ts`
- Modify: `packages/rn-iso/src/sim/ios.ts`
- Modify: `test/e2e/fixtures/fingerprint-stub.mjs`
- Modify: `test/e2e/native/run-native-e2e.mjs`
- Modify: `website/scripts/gen-changelog.mjs`

**Step 1: Apply the non-mutating array replacements**

Replace each reported `array.sort(compare)` with `array.toSorted(compare)`. Replace the reported `array.reverse()` with `array.toReversed()`. Do not change a call unless Oxlint reports it.

Replace each reported `array.filter(predicate)[0]` pattern with `array.find(predicate)`.

**Step 2: Verify the targeted rules**

Run: `pnpm exec oxlint . -D unicorn/no-array-sort -D unicorn/no-array-reverse -D unicorn/prefer-array-find`

Expected: no findings from these three rules.

**Step 3: Run affected tests**

Run: `pnpm test -- packages/rn-iso/src/__tests__/collector-parsers.test.ts packages/rn-iso/src/__tests__/engine-gradle.test.ts packages/rn-iso/src/__tests__/engine-xcode.test.ts`

Expected: PASS.

### Task 3: Remove shadowed and unused names

**Files:**

- Modify: `packages/rn-iso/src/__tests__/engine-remote-cache.test.ts`
- Modify: `packages/rn-iso/src/__tests__/gc.test.ts`
- Modify: `packages/rn-iso/src/__tests__/ios-command.test.ts`
- Modify: `packages/rn-iso/src/__tests__/ports.test.ts`
- Modify: `packages/rn-iso/src/__tests__/project.test.ts`
- Modify: `packages/rn-iso/src/__tests__/sim-ios.test.ts`
- Modify: `packages/rn-iso/src/engine/prebuild.ts`
- Modify: `packages/rn-iso/src/build-cache.ts`
- Modify: `packages/rn-iso/src/engine/remote-cache.ts`
- Modify: `packages/rn-iso/src/supervisor/server-bare.ts`
- Modify: `packages/rn-iso/src/__tests__/supervisor-bare.test.ts`
- Modify: `test/e2e/native/run-native-e2e.mjs`

**Step 1: Rename shadowed bindings**

Give each reported local binding a name that describes its role. Keep imported names unchanged. Examples include `pluginModule`, `fsExistsSync`, `projectOptions`, `projectLookup`, and `candidateRefusal`.

**Step 2: Rename avoidable underscore suffixes**

Rename local `require_` bindings to `localRequire`. Rename local `log_` bindings to `log`. Keep `_load`, `_resolveFilename`, `_root`, and `__path` unchanged because they are external or internal object contracts allowed by the configuration.

**Step 3: Remove the unused assignment**

Remove the unused `mainCheckout` assignment in `test/e2e/native/run-native-e2e.mjs`. Preserve any required side effect from its initializer.

**Step 4: Verify the naming rules**

Run: `pnpm exec oxlint . -D no-shadow -D no-unused-vars -D no-underscore-dangle`

Expected: no findings from these three rules.

### Task 4: Fix production helper scope and map allocation findings

**Files:**

- Modify: `packages/rn-iso/src/collector/run.ts`
- Modify: `packages/rn-iso/src/commands/gc.ts`
- Modify: `packages/rn-iso/src/commands/ios.ts`
- Modify: `packages/rn-iso/src/commands/logs.ts`
- Modify: `packages/rn-iso/src/commands/start.ts`
- Modify: `packages/rn-iso/src/commands/status.ts`
- Modify: `packages/rn-iso/src/metro.ts`
- Modify: `packages/rn-iso/src/supervisor/server-expo.ts`
- Modify: `packages/rn-iso/src/caches.ts`

**Step 1: Move stateless helpers to module scope**

Move only the reported production helpers to module scope. Pass required values as parameters. Preserve the current return types and call order.

**Step 2: Remove object spread inside map callbacks**

Replace the reported map spreads with direct object construction that lists the existing fields. Do not mutate the source values.

**Step 3: Verify the targeted rules**

Run: `pnpm exec oxlint packages/rn-iso/src -D unicorn/consistent-function-scoping -D oxc/no-map-spread`

Expected: no findings from these two rules.

**Step 4: Run affected tests**

Run: `pnpm test -- packages/rn-iso/src/__tests__/caches.test.ts packages/rn-iso/src/__tests__/collector-run.test.ts packages/rn-iso/src/__tests__/logs-command.test.ts packages/rn-iso/src/__tests__/start.test.ts`

Expected: PASS.

### Task 5: Fix Promise and Vitest findings

**Files:**

- Modify: `packages/rn-iso/src/__tests__/config.test.ts`
- Modify: `packages/rn-iso/src/__tests__/engine-app-install.test.ts`
- Modify: `packages/rn-iso/src/__tests__/gc.test.ts`
- Modify: `packages/rn-iso/src/__tests__/logs-command.test.ts`
- Modify: `packages/rn-iso/src/__tests__/start.test.ts`
- Modify: `packages/rn-iso/src/__tests__/worktree-remove.test.ts`
- Modify: `packages/rn-iso/src/__tests__/worktree.test.ts`

**Step 1: Make conditional assertions unconditional**

In `logs-command.test.ts`, assert the expected exit code and error output after cleanup. In `worktree-remove.test.ts`, record the state observed inside the command callback and assert that state after the action finishes.

**Step 2: Add throw expectations**

Give each reported `toThrow()` call an error type, message, or regular expression that matches the tested behavior.

**Step 3: Return from Promise callbacks**

Return `undefined` from the two reported `then` callbacks in `start.test.ts` after they update test state.

**Step 4: Verify the plugin rules**

Run: `pnpm exec oxlint . --promise-plugin --vitest-plugin -D promise/always-return -D vitest/no-conditional-expect -D vitest/no-standalone-expect -D vitest/require-to-throw-message`

Expected: no findings from these rules.

**Step 5: Run affected tests**

Run: `pnpm test -- packages/rn-iso/src/__tests__/config.test.ts packages/rn-iso/src/__tests__/engine-app-install.test.ts packages/rn-iso/src/__tests__/logs-command.test.ts packages/rn-iso/src/__tests__/start.test.ts packages/rn-iso/src/__tests__/worktree-remove.test.ts`

Expected: PASS.

### Task 6: Make the full lint and format gates clean

**Files:**

- Modify only files that the full lint or format commands identify.

**Step 1: Run the formatter**

Run: `pnpm format`

Expected: files are formatted with the repository configuration.

**Step 2: Run the blocking lint command**

Run: `pnpm lint`

Expected: PASS with zero warnings and zero errors.

**Step 3: Check the diff**

Run: `git diff --check && git status --short && git diff --stat`

Expected: no whitespace errors and no unrelated files.

### Task 7: Run every repository gate

**Files:**

- No source changes unless a gate identifies a lint-cleanup regression.

**Step 1: Run fast static gates**

Run: `pnpm format:check && pnpm lint && pnpm build && pnpm typecheck && pnpm knip`

Expected: PASS.

**Step 2: Run unit tests**

Run: `pnpm test`

Expected: all tests pass.

**Step 3: Run cross-platform end-to-end tests**

Run: `pnpm test:e2e`

Expected: all end-to-end tests pass.

**Step 4: Review the final diff**

Run: `git diff --check && git diff --stat && git status --short`

Expected: only the lint policy and finding fixes remain.

### Task 8: Commit the implementation

**Files:**

- Stage all reviewed lint policy and cleanup files.

**Step 1: Stage the implementation**

Run: `git add .oxlintrc.json packages test website docs/plans/2026-08-28-lint-cleanup.md`

**Step 2: Inspect the staged diff**

Run: `git diff --cached --check && git diff --cached --stat`

Expected: no whitespace errors and only planned files.

**Step 3: Commit**

Run: `git commit -m "chore: enforce clean lint output"`

Expected: one implementation commit after the design commit.
