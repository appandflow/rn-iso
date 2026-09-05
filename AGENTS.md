# Stim agent guide

Use this guide when you change this repository. State rules here in the
present tense: a rule's history lives in issues and commits, not here. User documentation lives in
[`packages/stim-cli/README.md`](./packages/stim-cli/README.md).

## Project

Stim gives each React Native or Expo workspace an isolated Metro port and an
owned simulator or emulator. It caches native builds and captures structured
logs.

The normal flow is:

```text
git worktree add -> cd -> worktree warm -> start -> ios|android -> logs --errors -> stop -> worktree remove
```

The command surface is `doctor`, `worktree warm|remove`, `start`, `stop`,
`ios`, `android`, `reload`, `device lock|unlock`, `logs`, `status`, `stats`, `gc`, and
`guide`. Do not add commands or flags without an explicit product decision.
Projects can wrap Stim when they need custom behavior.

Runtime state belongs under `$STIM_HOME/workspaces/`, not in the project
tree. Stim has no init step; do not add one. `doctor` reports setup that
requires project judgment.

## Development

The repository is a pnpm workspace. Published packages live under `packages/`.
The packages are ESM-only. They require Node.js 20.19.4 or later on Node 20,
or Node.js 22.12.0 or later. Repository development requires Node.js 22.18.0
or later because tsdown uses that floor.

```bash
pnpm install
pnpm run format:check
pnpm run lint
pnpm run build
pnpm run typecheck
pnpm test
```

Use only the checks that apply while iterating. Run all defined checks before a
commit. The only exception is the candidate version commit in the explicitly
authorized expedited RC lane documented in [`RELEASE.md`](./RELEASE.md); that
commit follows the lane's short preflight, tarball inspection, and exact-commit
CI requirements. Run `pnpm run test:e2e` when a change affects an end-to-end
workflow.

## Tests and abstractions

Before adding a test, name the concrete failure it catches. Assert observable
results at the narrowest useful boundary: parser output, state transitions,
ownership decisions, emitted payloads, or real command behavior. Check existing
coverage first; extend a relevant case instead of repeating it in another suite.

Do not add tests that only check a constant, a pass-through call, import spelling,
or implementation source text. A mock returning the expected result does not
prove the operation works. Use mocks for external boundaries and assert the
behavior Stim adds. Keep regression tests for real failure modes even when the
implementation is short.

Guide tests protect rendering, routing, safety instructions, and agreement with
code-defined contracts such as error codes and settings. Keep assertions to the
contract being protected. Do not copy explanatory paragraphs, website prose, or
examples into regex assertions; documentation edits do not need matching tests
unless they change one of those contracts. Narrow source scans for documented
identifiers are allowed; they do not replace tests of the behavior behind them.

Use a direct call or re-export when a wrapper only forwards the same arguments
and result. Keep helpers that own policy, coordinate effects, or remove meaningful
duplication. Do not extract a helper or export an internal function solely to
give it a unit test.

## Issue and pull request workflow

When you find a bug or improvement, search the open GitHub issues first. If no
issue already describes it, create one before implementation, following the
shape in `.github/ISSUE_TEMPLATE/report.md`. Refresh the remote refs, then
confirm that an existing issue still applies to current
`origin/main`; close stale issues with the fixing commit and verification
evidence instead of creating duplicate work.

Claim an issue before you implement it. Every agent works as the same GitHub
user, so assignees mean nothing; the claim is a comment plus a branch. Before
starting, check the issue for an open pull request or a `Claimed: <branch>`
comment newer than one day (by its `createdAt`) with no later `Released:`
comment and that branch on `origin`. When either is present the issue is taken;
pick another. To claim, comment `Claimed: <branch>`, then push the branch to
`origin` before implementing anything. The open pull request replaces the
claim. If you stop without one, comment `Released:` and delete the branch.

Implement each valid issue in its own git worktree and branch created from the
refreshed `origin/main`. Independent issues may run in parallel worktrees. Keep
the branch limited to that issue, run the required checks, and open a pull
request that links the issue, with a description following
`.github/PULL_REQUEST_TEMPLATE.md`.

A change that depends on an unmerged pull request branches from that pull
request's branch and links the two as a GitHub stack with `gh stack link
<lower> <upper>` (bottom to top), so the diff shown is against the parent, not
`main`. The pull request body names the dependency, and every member still gets
its own review and CI. Merge the stack bottom-up with `gh stack merge` once
every member is clear and green. Independent issues stay separate pull
requests; do not stack to skip a review.

As soon as the pull request is open, assign a fresh agent that did not implement
the change to review the issue, diff, tests, and user-facing guidance. Address
every actionable finding and rerun the affected checks. Mark the pull request
ready only after that fresh review is clear. Merge only after all required CI
checks pass; if CI fails, fix the branch, repeat the review when behavior
changes, and wait for the new checks.

## Architecture rules

- **Single exec wrapper.** Route all child processes through
  `packages/stim-cli/src/exec.ts`. Use `runFile` for user-controlled paths.
- **Pure parsing and decision logic.** Keep parsers and selectors separate from
  thin I/O wrappers. Unit-test the pure functions.
- **Locked state.** Lock every read-modify-write to global config or workspace
  state. Use atomic writes. Long-lived build locks use PID liveness, not mtime.
  Device leases use a declared expiry because the holder can be an agent with no
  process.
- **Cache contracts.** The cache packages must work without `Stim` installed.
  Keep their config path, cache root, cache key, and registration behavior
  aligned with the CLI. Resolution order is environment, machine config, then
  default. Update `cache-packages.test.ts` when those rules change.
- **Source format.** Keep files under `src/`, `bin/`, and `test/` ASCII-only.
  Markdown can use Unicode.
- **Concurrency limits.** Build and device caps are opt-in through config or
  environment variables. Do not add a config command.

## Comment policy

Treat every code comment as removable. Keep a comment only when it is one of
these exceptions:

- A legal or license header.
- A non-obvious constraint from an external dependency, platform, vendor, or
  protocol. Name the external source and the concrete constraint.
- A required formatter directive such as `prettier-ignore`.
- A doc comment that defines a public API contract.
- A direct issue or RFC link for a constraint that code cannot express.

Delete narration, banners, commented-out code, workaround essays, and comments
that restate the code. Words such as `IMPORTANT`, `do not remove`, and `fine for
now` do not make a comment valid. Read the nearby code before judging a comment.
When no keep rule clearly applies, delete the comment.

Treat suppressions such as `eslint-disable`, `@ts-ignore`, and
`@ts-expect-error` as code problems. Keep a suppression only for a faulty,
pedantic, or style-only rule.

## Required invariants

### 1. Keep agent guidance current

Treat `packages/stim-cli/skill/SKILL.md` as a tiny discovery router. Its body
only tells the agent to run `stim guide agent` and follow the version-matched
instructions. Keep every operational detail in that guide topic, including the
normal workflow, ownership and deletion rules, command notation, topic routing,
flags, payloads, settings, backends, caches, cleanup, and remedies. Do not add a
version check, compatibility branch, migration path, or failure fallback to the
static skill. Only one skill ships.

Update `guide agent`, the relevant detailed guide topics, and their contract
tests when commands, defaults, safety rules, or remedies change. The static
skill changes only when its activation description or single routing command
changes.

Document command invocation once in each human-facing installation entry
point. Show the no-install form, `npx stim-cli <command>`, and the global
install, `npm install --global stim-cli`. The static skill is only a router and
does not repeat installation instructions. Use `stim` alone in later examples.
In a document that does not explain installation, add one short note that tells
readers to replace `stim` with `npx stim-cli` when it is not installed globally.
On the website, use synchronized Global and npx tabs with Global as the default.
Keep the full `npx` form in runnable hooks, release checks, and registry
remedies, which cannot assume a global install.

### 2. Create, boot, and delete only owned devices

Stim can create, boot, shut down, or delete only devices it created. Owned iOS
simulators are named `stim-<label> (<model> <runtime>)`; owned Android AVDs
remain `stim-<label>`. Both are recorded with `owned: true`. Never do any of
those actions to a user-created emulator or simulator. Keep a device record
when teardown fails so `gc` can find the device later.

Stim parks an owned simulator it no longer needs instead of deleting it, up to a
configured maximum, and adopts a parked one before creating. Parked simulators
are Stim-owned and listed in the pool record. Delete them only by eviction,
adoption-time reconciliation of a listed unavailable simulator, or `gc
--delete`; every route uses centralized teardown and ownership revalidation.

A physical device reached through `android --device` or `ios --device` is
used but not owned. Hardware cannot be created or booted, so those paths
install, launch, and read what logs they can, and nothing more. The only
state a physical device leaves is its lease: the file under
`$STIM_HOME/device-locks/` and the holder's token in that workspace's
`state.json`. A serial or UDID never enters the project registry, and
`teardown.ts` never sees a physical device. `stop` and `worktree remove`
release the workspace's leases; `gc --delete` deletes only expired lease
files.

### 3. Fixed invocations; never derive commands from project scripts

Do not infer and rebuild commands from project scripts. Bare React Native hosts
Metro from the project's dependencies. Expo runs its fixed start command. iOS
and Android use fixed `xcodebuild` and Gradle arguments.

The supported build selectors are `ios --configuration <name>` and
`android --variant <name>`. `ios --device-type <name>`, `ios --runtime
<version>`, and `android --system-image <id>` select the model and version of
the owned simulator or emulator for one invocation, overriding
`ios.deviceType`, `ios.runtime`, and `android.systemImage`; a name that is not
installed refuses with `STIM_BAD_ARG` and prints the installed names.
`android --device [serial]` and
`ios --device [udid]` select a connected physical device, and take
`--wait <seconds>` or `--no-wait` for the lease on it. Non-Debug iOS
configurations and Android variants ending in `Release` skip Metro. A release
cache hit must inject the current JS into a copy of the artifact. A swap
failure must run a full build; it must never install stale JS. Android swaps
require an emitted-asset manifest match, then `zipalign` before `apksigner`.

An iOS device build is always signed, Debug included. Before Stim installs or
re-seals a device app, the signing gate reads the bundle's own
`embedded.mobileprovision` and refuses one that is missing, expired, carries
no `ProvisionedDevices` list (App Store and enterprise profiles), or does not
name the target UDID. Stim re-signs only copies it makes, with an identity
present in the keychain: the one the profile's certificate names, or the one
`ios.signingIdentity` pins. It never passes signing flags to `xcodebuild`, in
particular never `-allowProvisioningUpdates`, because a build must not mutate
an Apple Developer account. Stim installs only onto a device it drives in this
run: an owned simulator or emulator, a physical device named by `--device`, or
the remote device `--remote` targets. Do not add distribution flows: no store
upload, no TestFlight, no over-the-air install page, no reconstruction of the
project's own delivery pipeline. Archives, `.ipa` export, store signing, and
distribution remain out of scope.

### 4. Centralize device teardown

All shutdown and deletion flows must use `src/teardown.ts`, and so does park,
which is the flow that gives a simulator up without deleting it. Re-resolve
ownership before each destructive command. Contain per-device failures so batch cleanup
can continue. `stop` shuts down devices; it never deletes them.

### 5. Redirect test state

Set `STIM_HOME` to a temporary directory in every test that reads or writes
global state. Delete the directory and environment variable after each test.

### 6. Compare canonical paths

Use `realpath` when project identity or containment depends on a path. A
symlinked worktree must resolve to the same config key as its target.

### 7. Preserve stdout contracts

`worktree warm` and `worktree remove` keep stdout empty. JSON commands print
exactly one parseable payload. Send status, warnings, and progress to
stderr.

### 8. Fail closed during cleanup

An absent path can belong to an unmounted volume or unresolved symlink. When the
project registry cannot prove that an entry is stale, keep the entry and its
device claim.

### 9. Verify real tool calls

Mocks do not prove that `git`, `simctl`, `adb`, `avdmanager`, `xcodebuild`, or
Gradle accepts an argument list. Exercise changed tool calls against the real
tool at least once. Use a timeout around `simctl`.

### 10. Store under the post-mutation cache key

`expo prebuild` and `pod install` can change fingerprinted inputs. Keep the
initial lookup and single-flight lock on the pre-mutation key. After a mutation,
fingerprint again and resolve once under the new key before compiling. Store
the artifact, `lastBuild`, and remote upload only under the post-mutation key.
Do not store the same artifact under both keys.

### 11. Preserve launch status semantics

`launched` can be `true`, `'bundling'`, `'unverified'`, or `false`. Use `true`
only for a proven bundle request or a live release process. Use `'bundling'`
only for positive, non-error evidence from this workspace's Metro port. Use
`'unverified'` when there is no evidence. Only `'unverified'` gets launch
remedies. `false` is reserved and is not produced today.

## Releases and commits

Follow [`RELEASE.md`](./RELEASE.md) for releases. Keep one logical change per
commit. Use conventional prefixes such as `feat:`, `fix:`, `docs:`, and
`chore:`. Keep commit titles short. Do not force GPG signing.
