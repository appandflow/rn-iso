# stim-cli agent guide

Use this guide when you change this repository. User documentation lives in
[`packages/stim-cli/README.md`](./packages/stim-cli/README.md).

## Project

stim-cli gives each React Native or Expo workspace an isolated Metro port and an
owned simulator or emulator. It caches native builds and captures structured
logs.

The normal flow is:

```text
worktree create -> start -> ios|android -> logs --errors -> stop -> worktree remove
```

The command surface is `doctor`, `worktree create|remove`, `start`, `stop`,
`ios`, `android`, `logs`, `status`, `gc`, and `guide`. Do not add commands or
flags without an explicit product decision. Projects can wrap stim-cli when they
need custom behavior.

Runtime state belongs under `$STIM_CLI_HOME/workspaces/`, not in the project
tree. Do not restore `init`, project setup mutations, or the deleted
`stim-cli-init` skill. `doctor` reports setup that requires project judgment.

## Development

The repository is an npm workspace. Published packages live under `packages/`.
The packages are ESM-only. They require Node.js 20.19.4 or later on Node 20,
or Node.js 22.12.0 or later. Repository development requires Node.js 22.18.0
or later because tsdown uses that floor.

```bash
npm install
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Use only the checks that apply while iterating. Run all defined checks before a
commit. Run `npm run test:e2e` when a change affects an end-to-end workflow.

## Architecture rules

- **Single exec wrapper.** Route all child processes through
  `packages/stim-cli/src/exec.ts`. Use `runFile` for user-controlled paths.
- **Pure parsing and decision logic.** Keep parsers and selectors separate from
  thin I/O wrappers. Unit-test the pure functions.
- **Locked state.** Lock every read-modify-write to global config or workspace
  state. Use atomic writes. Long-lived build locks use PID liveness, not mtime.
- **Cache contracts.** The cache packages must work without `stim-cli` installed.
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
pedantic, or style-only rule. If the rule protects correctness or safety, remove
the suppression and report the exact symbol as `MUST KILL` for a later refactor.
For a surprising behavior in this codebase, delete the explanation and report
the exact symbol as `MUST KILL`. Do not add `MUST KILL` markers to source files.

## Required invariants

### 1. Keep agent guidance current

Treat `packages/stim-cli/skill/SKILL.md` as a compact entry point, not a manual.
Keep it under 1,200 words. Include only the normal local workflow, permanent
ownership and deletion rules, and routing to `guide` topics. Put exact flags,
payload schemas, uncommon backends, release builds, cache mechanics, settings,
capacity details, cleanup internals, and remedies in `guide`. Do not duplicate
that reference text in the skill.

Update `guide` output and its contract tests when commands, flags, defaults, or
remedies change. Update the skill only when the normal workflow, a permanent
safety rule, or topic routing changes. Only one skill ships; do not restore
`stim-cli-init`.

### 2. Use only owned devices

stim-cli can use only devices it created, named `stim-cli-<label>` and recorded with
`owned: true`. Never operate on physical or user-created devices. Keep a device
record when teardown fails so `gc` can find the device later.

### 3. Reimplement; do not reconstruct

Do not infer and rebuild commands from project scripts. Bare React Native hosts
Metro from the project's dependencies. Expo runs its fixed start command. iOS
and Android use fixed `xcodebuild` and Gradle arguments. Do not add install or
physical-device flows.

The supported build selectors are `ios --configuration <name>` and
`android --variant <name>`. Non-Debug iOS configurations and Android variants
ending in `Release` skip Metro. A release cache hit must inject the current JS
into a copy of the artifact. A swap failure must run a full build; it must never
install stale JS. Android swaps require an emitted-asset manifest match, then
`zipalign` before `apksigner`. Store signing and distribution remain out of
scope.

### 4. Centralize device teardown

All shutdown and deletion flows must use `src/teardown.ts`. Re-resolve ownership
before each destructive command. Contain per-device failures so batch cleanup
can continue. `stop` shuts down devices; it never deletes them.

### 5. Redirect test state

Set `STIM_CLI_HOME` to a temporary directory in every test that reads or writes
global state. Delete the directory and environment variable after each test.

### 6. Compare canonical paths

Use `realpath` when project identity or containment depends on a path. A
symlinked worktree must resolve to the same config key as its target.

### 7. Preserve stdout contracts

`worktree create` prints only the created absolute path to stdout. JSON commands
print exactly one parseable payload. Send status, warnings, and progress to
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
