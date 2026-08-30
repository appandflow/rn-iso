# stim-cli field-test protocol

A handoff document for an AI agent testing stim-cli end to end on a real
repository. The deliverable is equal parts "does it work" and a **friction
log** — every rough edge, confusing output, wrong default, or extra step you
needed, however small. You are the target user: an agent doing a dev loop.
Be adversarial. **A PASS you did not actually observe is worse than a FAIL.**

## Setup

Choose exactly one CLI under test and use the `stim` function for every command
in this protocol.

For a pre-tag release gate, run from the stim-cli repository root after the
build step:

```bash
candidate_cli="$PWD/packages/stim-cli/dist/cli.mjs"
stim() { node "$candidate_cli" "$@"; }
stim --version
stim guide lifecycle
stim guide settings
```

Read the candidate's local `packages/stim-cli/skill/SKILL.md` before starting.
The candidate path is absolute so the function still uses that build after you
change into an app or worktree.

For a standalone field pass of the published release:

```bash
published_version=$(npm view stim-cli version)
stim() { npx "stim-cli@$published_version" "$@"; }
test "$(stim --version)" = "$published_version"
npx skills add appandflow/stim # then READ the installed skill before starting
stim guide lifecycle
stim guide settings
```

If this machine ran an earlier build of stim-cli: BEFORE anything else, run
`stim status` and `stim gc` (report-only) and read both skeptically — compatibility
against state an earlier build wrote is not guaranteed. Old cache dirs
(`~/.stim-cli-build-cache`, `~/.<name>-metro-cache`) are dead and ignored;
stale device records should surface in `gc`, not crash anything. Anything
odd here is a HIGH-severity finding.

## Use a fixture that looks like a real repo

A fresh `create-expo-app` has never been prebuilt, so its `app.json` carries no
`ios.bundleIdentifier` / `android.package` and its `package.json` still has the
`expo start` scripts. The first prebuild writes all three -- TRACKED files --
which moves the fingerprint and makes a cold worktree miss a cache entry it
would otherwise hit. A real CNG repo has those values committed (Expo
recommends setting them explicitly), so prebuild writes nothing tracked and a
cold worktree hits on its first lookup; a bare repo commits `ios/` and
`android/` outright and never prebuilds at all.

Before testing caching across worktrees, choose a commit that already contains
the representative identifiers and native inputs. For a throwaway fixture,
prepare and commit those inputs before declaring the baseline. Never prebuild
or commit in a user's main checkout. Otherwise the fixture manufactures a
transition that few users see, and the result reads as a product bug. Test the
cold/warm split deliberately only when it is the behavior under test.

## Safety rules (non-negotiable)

- NEVER modify the target repo's main checkout. Worktrees only.
- NEVER run `gc --delete` or `gc --delete --all` without the user's explicit
  approval in this session. Bare `gc` (report) is always fine.
- Touch no simulator/emulator except `stim-cli-*` ones YOUR runs created.
- No raw `simctl recordVideo` (it can wedge a machine with a global lock);
  record only through your device tool's own mechanism, prefer screenshots.
- No commits or pushes in the user's repos. Clean up everything you create.

## The test script

Deviate when reality demands it — and log why as a friction.

1. **Orient.** `status` (what is already on this machine), `doctor` in the
   app dir (report findings; judge whether each is true of this repo).
2. **Workspace.** `cd "$(stim worktree create <name> --carry-ignored)"`.
   Note whether `--base <ref>` works if you need a specific commit, whether
   the stderr said what it branched from, and what `--carry-ignored`
   reported. Install deps with the repo's OWN tooling (read its docs;
   monorepos: work from the app directory, but install per the repo's rules).
3. **Dev server.** `stim start --json`. Assert: correct mode
   (`expo-child` for Expo apps, `bare-inproc` for bare RN — a wrong detection
   here is CRITICAL), the global readable workspace directory created under
   `~/.stim-cli/workspaces/<project>--<digest>/`, second
   `start` a no-op, `status` shows the supervisor healthy.
4. **Build.** `stim ios` (and/or `android`). Cold: watch the phase
   lines; on failure judge the extracted diagnostic against the raw log in
   `~/.stim-cli/workspaces/<project>--<digest>/logs/build-*.ndjson` — was it enough to act on? Assert the
   `--json` payload against the launch-status table below. `"unverified"` is
   not automatically a failure, but it requires following stim-cli's own
   remedy and recording what the device actually did.
5. **Interact.** Drive the app with your device tool (snapshot, screenshot,
   a few taps), targeting YOUR sim by udid, never "booted". No real logins.
6. **Logs.** `logs --errors` on the healthy app (near-empty, exit 0, no OS
   syslog noise). Then break the bundle on purpose (rename an imported
   file), reload, and assert the failure SURFACES in `--errors`; fix it and
   assert it stops being reported after the next bundle. `status`'s error
   count must stay sane throughout.
7. **Cache proof.** Run the applicable native cache suite from
   `docs/e2e-and-ci.md` and attach its machine-readable summary. It separately
   proves ENGAGED, STORES, and REUSED for every cache. On a real repository,
   still verify the second worktree installs without compiling; do not repeat
   the suite's directory-counting script by hand.
8. **Teardown.** `stop` in each, then `worktree remove` each — with NO
   `--force` and NO manual `rm`. A refusal you cannot resolve by following
   the message's own remedy is a HIGH finding.
9. **Verify cleanup**, all five:
   - `xcrun simctl list devices | grep stim-cli` → none of yours remain
     (`emulator -list-avds` likewise on Android)
   - `ps aux | grep -E 'stim-cli|supervisor'` → no supervisors or collectors
   - `stim status` → your workspaces gone from the registry
   - `git -C <repo> status --porcelain` and `git worktree list` → main
     checkout byte-identical to before you started (capture a baseline!)
   - bare `stim gc` → nothing orphaned that you created

## Manual gaps beyond the native suites

The automated `loop` and `caches` suites own fresh bare/Expo fixtures, cache
growth and reuse, Pods reuse, single-flight, and `gc` visibility. Manual work
is only for shapes the release actually changes and automation cannot model.

| Row                           | Run when                                                                  | Required evidence                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real repository               | Project discovery, prebuild, Pods, path, or monorepo behavior changed     | A representative committed CNG or bare repository; record its package manager, monorepo shape, framework/SDK, clean-tree baseline, and whether prebuild changed tracked inputs.                                                                                        |
| Authenticated remote provider | Remote device, tunnel, or remote cache behavior changed                   | Use the affected provider and account. Record the selected backend, public Metro reachability, session ownership/teardown, and remote cache result. To force remote cache resolution, use a fresh local cache root; `--no-build-cache` skips both cache lookup levels. |
| Logs                          | Log collection, error queries, or timeline behavior changed               | On each affected platform, record a healthy `logs --errors`, induce a bundle error and prove it appears, repair it and prove it stops recurring, and verify `status` keeps a sane error count.                                                                         |
| Release build                 | Release selection, bundling, signing, or cached-artifact swapping changed | iOS `--configuration Release` and/or Android `--variant <name>Release`; prove Metro is skipped, `metroPort` is null, the process stays alive, and the installed artifact contains this workspace's JS.                                                                 |
| Android flavor                | Variant or APK discovery changed                                          | A repository with real product flavors; prove `assemble<Variant>`, APK selection, application id from the built APK, and a distinct cache key per variant. Do not manufacture a flavor and call it field evidence.                                                     |
| Launch evidence               | Launch/status/remedy UX changed                                           | Exercise first launch and warm launch on the affected platform, record the JSON value, follow any remedy, and confirm the foreground app and bundle request with the owned device.                                                                                     |

For a cached release, use a unique JS sentinel. On iOS, confirm the copied and
re-signed `.app` contains the regenerated bundle. On Android, confirm the APK
bundle remains stored rather than deflated, is zipaligned and signed, and that
a changed asset set refuses the swap and falls back to a full build.

## Launch-status contract

| Value          | Meaning                                                                                        | Field-test verdict                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `true`         | A bundle request from this workspace was proven, or a release process was observed alive.      | Pass.                                                                                              |
| `"bundling"`   | This workspace's Metro port has positive, non-error evidence and the bundle is still building. | Pass for wiring; record that JS completion was not observed.                                       |
| `"unverified"` | No positive launch evidence was observed.                                                      | Follow the emitted remedy and inspect the owned device; report both the value and the observed UI. |
| `false`        | Reserved; stim-cli does not produce it today.                                                  | Treat its appearance as a contract regression.                                                     |

## The friction log (the primary deliverable)

Number every finding. For each: **severity** (critical / high / med / low),
the **verbatim evidence** (the exact output line, not a paraphrase), and a
**one-line suggested fix**. Classify honestly:

- CRITICAL: the documented loop cannot complete unassisted, or stim-cli
  reported success for something that failed, or wrong-workspace
  cross-contamination of any kind.
- HIGH: a wrong or unactionable error message; a query that hides real
  signal; destructive-path surprises.
- MED: false positives/negatives in doctor/setup checks; misleading
  defaults.
- LOW: noise, cosmetics, missing progress output.

## Report structure

(a) matrix rows run and omitted, with reasons; (b) friction log; (c) what
worked cleanly; (d) timings table; (e) attached loop results/logs and cache JSON
summaries; (f) manual-row evidence; (g) device-interaction evidence; (h) the five cleanup
checks with output; (i) bugs with minimal repros; (j) the repo shape (Expo or
bare, SDK, package manager, mono or single, flavored or not). A skip is never
a pass, and every claimed pass includes a quoted line, measured value, or
artifact inspection.
