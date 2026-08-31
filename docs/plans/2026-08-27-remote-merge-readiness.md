# Remote Merge Readiness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make PR #19 safe to merge while keeping plain local starts local and making every owned remote resource recoverable.

**Architecture:** `start --remote` carries Metro intent and prepares the selected public tunnel. Managed ngrok supports a stable configured URL, while `auto` falls back to cloudflared when ngrok cannot start. `ios|android --remote proxy` connects to an existing agent-device daemon, while `ios|android --remote eas` creates an owned EAS Simulator session. Destructive paths re-read live identity before they stop a session or signal a tunnel process.

**Tech Stack:** TypeScript, Commander, Vitest, Expo CLI, EAS CLI, agent-device

---

### Task 1: Integrate current main

**Files:**

- Resolve: `packages/stim-cli/src/__tests__/ios-command.test.ts`
- Resolve: `packages/stim-cli/src/__tests__/supervisor-expo.test.ts`
- Resolve: `packages/stim-cli/src/commands/ios.ts`
- Resolve: `packages/stim-cli/src/engine/app-install.ts`
- Resolve: `packages/stim-cli/src/supervisor/server-expo.ts`

**Step 1: Merge the current base**

Run: `git merge origin/main`

Expected: Git reports the five known content conflicts and leaves all other files merged.

**Step 2: Resolve each conflict**

Keep the remote-device behavior from this branch and the current cache, launch-proof, and Expo supervisor behavior from `main`. Remove every conflict marker.

**Step 3: Verify the integrated baseline**

Run: `pnpm format && pnpm typecheck && pnpm test`

Expected: formatting exits 0, typecheck exits 0, and every test passes.

**Step 4: Finish the merge commit**

Run: `git add <resolved files> && git commit`

Expected: one merge commit with no unrelated edits.

### Task 2: Make tunnel setup require remote intent

**Files:**

- Modify: `packages/stim-cli/src/commands/start.ts`
- Modify: `packages/stim-cli/src/__tests__/start.test.ts`
- Modify: `packages/stim-cli/src/commands/guide.ts`
- Modify: `packages/stim-cli/src/__tests__/guide.test.ts`

**Step 1: Write failing tests**

Add tests that prove:

- `wantsExpoOwnTunnel({ remote: false, mode: 'auto' })` is false;
- `remote: true` with Expo plus `auto` or `expo` is true;
- `start --remote` passes `--tunnel` to the Expo supervisor;
- plain `start` does not pass `--tunnel`;
- an `ios.remote` or `android.remote` backend setting gives `start` remote intent;
- `start --remote` refuses when a healthy local Expo supervisor cannot gain a tunnel.

Run: `pnpm vitest run packages/stim-cli/src/__tests__/start.test.ts packages/stim-cli/src/__tests__/guide.test.ts`

Expected: the new tests fail because `start` has no remote option and `auto` tunnels local starts.

**Step 2: Implement the minimum behavior**

Add the Commander `--remote` option. Derive remote intent from the flag or either platform remote setting. Pass that intent to `wantsExpoOwnTunnel`. Refuse a remote request when a healthy Expo server has no recorded Expo tunnel.

**Step 3: Update generated guide text**

Document `start --remote` and the local default. Keep `metro.tunnel` as provider selection, not remote intent.

**Step 4: Run focused tests**

Run the focused command from Step 1.

Expected: all focused tests pass.

**Step 5: Commit**

Run: `git commit -am "fix(start): tunnel only for remote devices"`

### Task 3: Configure managed tunnel providers

**Files:**

- Modify: `packages/stim-cli/src/settings.ts`
- Modify: `packages/stim-cli/src/commands/start.ts`
- Modify: `packages/stim-cli/src/engine/metro-reach.ts`
- Modify: `packages/stim-cli/src/engine/tunnel.ts`
- Modify: `packages/stim-cli/src/engine/device-remote.ts`
- Modify: `packages/stim-cli/src/__tests__/settings.test.ts`
- Modify: `packages/stim-cli/src/__tests__/start.test.ts`
- Modify: `packages/stim-cli/src/__tests__/metro-reach.test.ts`
- Modify: `packages/stim-cli/src/__tests__/tunnel.test.ts`
- Modify: `packages/stim-cli/src/__tests__/device-remote.test.ts`

**Step 1: Write failing provider and URL tests**

Prove `metro.tunnel` accepts `auto`, `expo`, `ngrok`, `cloudflared`, and `off`. Prove `metro.ngrokUrl` requires explicit ngrok mode and a valid HTTPS URL. Prove the ngrok argv contains `--url <url>` only when configured.

Run: `pnpm vitest run packages/stim-cli/src/__tests__/settings.test.ts packages/stim-cli/src/__tests__/metro-reach.test.ts packages/stim-cli/src/__tests__/tunnel.test.ts`

Expected: the URL setting and argv assertions fail because the setting does not exist.

**Step 2: Write failing lifecycle and fallback tests**

Prove `start --remote` starts and records a managed provider before the dev server. Prove the device command reuses that record. Under `auto`, make ngrok exit before it returns a URL and prove cloudflared starts next. Prove explicit ngrok returns its error without fallback.

Run: `pnpm vitest run packages/stim-cli/src/__tests__/start.test.ts packages/stim-cli/src/__tests__/device-remote.test.ts packages/stim-cli/src/__tests__/tunnel.test.ts`

Expected: managed providers start only during the device command, and auto stops after the ngrok failure.

**Step 3: Implement the minimum behavior**

Read and validate `metro.ngrokUrl`. Pass it to `ngrok http` as `--url`. Start managed tunnels during remote `start`, record them immediately, and give Expo the known public origin. Make auto attempt each available provider in order until one returns a URL. Clean up every failed child. Keep explicit provider selection fail-closed.

**Step 4: Run focused tests and commit**

Run both focused commands, then commit with `feat(tunnel): configure managed providers`.

### Task 4: Make remote backend selection explicit

**Files:**

- Modify: `packages/stim-cli/src/types.ts`
- Modify: `packages/stim-cli/src/settings.ts`
- Modify: `packages/stim-cli/src/commands/ios.ts`
- Modify: `packages/stim-cli/src/commands/android.ts`
- Modify: `packages/stim-cli/src/engine/device-remote.ts`
- Modify: `packages/stim-cli/src/__tests__/settings.test.ts`
- Modify: `packages/stim-cli/src/__tests__/device-remote.test.ts`
- Modify: `packages/stim-cli/src/__tests__/ios-command.test.ts`
- Modify: `packages/stim-cli/src/__tests__/android-command.test.ts`

**Step 1: Write failing interface tests**

Add tests that prove `--remote proxy` and `--remote eas` parse for both device commands. Add refusal tests for a missing or unknown backend. Prove settings accept only `"proxy"` or `"eas"`.

Run: `pnpm vitest run packages/stim-cli/src/__tests__/ios-command.test.ts packages/stim-cli/src/__tests__/android-command.test.ts packages/stim-cli/src/__tests__/settings.test.ts packages/stim-cli/src/__tests__/device-remote.test.ts`

Expected: the parser and settings tests fail because remote is boolean and backend selection reads environment state.

**Step 2: Write failing backend behavior tests**

Prove `proxy` requires both daemon variables and never calls EAS. Prove `eas` requires EAS CLI, creates a session, and ignores daemon variables for backend selection.

**Step 3: Implement the minimum behavior**

Replace the boolean device option with a required `proxy|eas` value. Pass the selected backend into `resolveRemoteContext`. Keep `start --remote` boolean because it selects Metro exposure, not a device provider.

**Step 4: Run focused tests and commit**

Run the focused command, then commit with `feat(remote): require an explicit backend`.

### Task 5: Repair the Android remote lifecycle

**Files:**

- Modify: `packages/stim-cli/src/commands/android.ts`
- Modify: `packages/stim-cli/src/engine/device-remote.ts`
- Modify: `packages/stim-cli/src/__tests__/android-command.test.ts`
- Modify: `packages/stim-cli/src/__tests__/device-remote.test.ts`

**Step 1: Write failing command tests**

Add tests that prove a debug remote run gates its public Metro origin before session creation, records the created session immediately after boot, and keeps that record when a later build fails. Add a release test that proves launch uses the remote adapter and requires no Metro origin.

Run: `pnpm vitest run packages/stim-cli/src/__tests__/android-command.test.ts packages/stim-cli/src/__tests__/device-remote.test.ts`

Expected: the gate and state assertions fail, and release launch calls the local launcher.

**Step 2: Implement the same ordering as iOS**

Inject `ensureMetroReachable` and workspace state writing into the Android command. Gate debug Metro before `ensureDeviceBooted`. After boot, persist `createdSessionId()` before any build return path. Add a remote release launcher that calls the platform-neutral remote `open` operation without Metro data.

**Step 3: Run focused tests**

Run the command from Step 1.

Expected: all focused tests pass.

**Step 4: Commit**

Run: `git commit -am "fix(remote): preserve Android session ownership"`

### Task 6: Verify EAS session ownership before teardown

**Files:**

- Modify: `packages/stim-cli/src/engine/eas-simulator.ts`
- Modify: `packages/stim-cli/src/engine/device-remote.ts`
- Modify: `packages/stim-cli/src/__tests__/eas-simulator.test.ts`
- Modify: `packages/stim-cli/src/__tests__/device-remote.test.ts`
- Modify: `packages/stim-cli/src/__tests__/stop.test.ts`
- Modify: `packages/stim-cli/src/__tests__/reclaim.test.ts`

**Step 1: Write failing ownership tests**

Cover an owned live session, an unowned live session, a stopped session, malformed output, and a failed lookup. Assert that only the verified `stim-` session receives `simulator:stop`.

Run: `pnpm vitest run packages/stim-cli/src/__tests__/eas-simulator.test.ts packages/stim-cli/src/__tests__/device-remote.test.ts packages/stim-cli/src/__tests__/stop.test.ts packages/stim-cli/src/__tests__/reclaim.test.ts`

Expected: the unowned and failed-lookup cases currently call stop or report success.

**Step 2: Add fail-closed live verification**

Read the session with `simulator:get --id`. Require an `stim-` name before stop. Treat a confirmed terminal session as already stopped. Keep the state record after every unverifiable result.

**Step 3: Run focused tests and commit**

Run the focused command, then commit with `fix(remote): verify EAS session ownership`.

### Task 7: Verify managed tunnel process identity

**Files:**

- Modify: `packages/stim-cli/src/engine/tunnel.ts`
- Modify: `packages/stim-cli/src/__tests__/tunnel.test.ts`
- Modify: `packages/stim-cli/src/commands/stop.ts`
- Modify: `packages/stim-cli/src/reclaim.ts`

**Step 1: Write failing PID-reuse tests**

Add cases where the PID is alive but its command does not match the recorded provider or port. Assert that no signal is sent and that the state remains. Keep owned, missing, and timeout cases.

Run: `pnpm vitest run packages/stim-cli/src/__tests__/tunnel.test.ts packages/stim-cli/src/__tests__/stop.test.ts packages/stim-cli/src/__tests__/reclaim.test.ts`

Expected: the PID-reuse test fails because `stopTunnel` signals every live recorded PID.

**Step 2: Implement process verification**

Read `/proc/<pid>/cmdline` on Linux and `ps -o command= -p <pid>` elsewhere. Require the provider executable plus the recorded port or local URL. Return `failed` on mismatch so callers retain the record.

**Step 3: Run focused tests and commit**

Run the focused command, then commit with `fix(tunnel): verify process identity before stop`.

### Task 8: Sweep orphaned EAS sessions in gc

**Files:**

- Modify: `packages/stim-cli/src/engine/eas-simulator.ts`
- Modify: `packages/stim-cli/src/commands/gc.ts`
- Modify: `packages/stim-cli/src/__tests__/eas-simulator.test.ts`
- Modify: `packages/stim-cli/src/__tests__/gc.test.ts`

**Step 1: Write failing report and deletion tests**

Test the pure comparison between listed owned sessions and recorded workspace IDs. Test dry-run output, verified orphan deletion, lookup notices, and an individual stop failure.

Run: `pnpm vitest run packages/stim-cli/src/__tests__/eas-simulator.test.ts packages/stim-cli/src/__tests__/gc.test.ts`

Expected: no remote session rows or stop calls exist.

**Step 2: Implement project-scoped collection**

Call the owned live-session list from the current EAS project. Compare IDs with readable state records. Report unmatched sessions. Under `--delete`, stop only those verified list results. Contain EAS errors as notices so local cleanup continues.

**Step 3: Run focused tests and commit**

Run the focused command, then commit with `feat(gc): reclaim orphaned EAS sessions`.

### Task 9: Update and behavior-test the shipped skill

**Files:**

- Modify: `packages/stim-cli/skill/SKILL.md`
- Modify: `packages/stim-cli/src/commands/guide.ts`

**Step 1: Run a baseline skill scenario**

Give a fresh agent a request for one local run and one remote run without the updated branch skill. Record whether it tunnels the local start and whether it explains daemon-versus-EAS selection.

Expected: the existing skill does not teach `start --remote` or explicit backend selection.

**Step 2: Update the minimum guidance**

Document the local command sequence, `--remote proxy`, `--remote eas`, proxy credentials, EAS ownership, teardown, and billing warning. Do not duplicate the full generated guide.

**Step 3: Run the same scenario with the updated skill**

Expected: the agent uses plain `start` locally, `start --remote` remotely, and names the chosen backend on the device command.

**Step 4: Commit**

Run: `git commit -am "docs(skill): explain remote device selection"`

### Task 10: Complete verification and PR handoff

**Files:**

- Update if needed: PR #19 body

**Step 1: Run all repository checks**

Run: `pnpm format`, `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm knip`, `pnpm format:check`, and `git diff --check`.

Expected: every command exits 0. Existing lint warnings are allowed only when the changed files add none.

**Step 2: Run local Expo field proof**

Start the scratch Expo app with plain `stim start --json`. Verify no tunnel is requested or recorded. Stop it.

**Step 3: Run remote iOS field proof**

Confirm EAS Simulator access. Run `stim start --remote --json`, then `stim ios --remote eas --json`. Verify one session, a bundle request through the public origin, and an empty `logs --errors` result. Stop the workspace and confirm no live `stim-` session remains.

**Step 4: Request full-diff review**

Review `origin/main...HEAD` for correctness, ownership, billing leaks, and local-path regressions. Fix every confirmed Critical or Important issue with a new red-green cycle.

**Step 5: Push and update PR #19**

Push the branch. Refetch the PR body before editing it. Replace stale claims about live verification and test counts. Wait for CI, then report the final merge state.
