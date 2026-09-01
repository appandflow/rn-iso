# Stim field-test protocol

A handoff document for an AI agent testing Stim end to end on a real
repository. The deliverable is equal parts "does it work" and a **friction
log** — every rough edge, confusing output, wrong default, or extra step you
needed, however small. You are the target user: an agent doing a dev loop.
Be adversarial. **A PASS you did not actually observe is worse than a FAIL.**

## Setup

Choose exactly one CLI under test and use the `stim` function for every command
in this protocol.

For a pre-tag release gate, run from the Stim repository root after the
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

If this machine ran an earlier build of Stim: BEFORE anything else, run
`stim status` and `stim gc` (report-only) and read both skeptically — compatibility
against state an earlier build wrote is not guaranteed. Old cache dirs
(`~/.stim-build-cache`, `~/.<name>-metro-cache`) are dead and ignored;
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
- NEVER run `gc --delete`, `gc --delete --cache all`, or
  `gc --delete --cache <name>` without the user's explicit approval in this
  session. Bare `gc` (report) is always fine.
- Touch no simulator/emulator except `stim-*` ones YOUR runs created.
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
   `~/.stim/workspaces/<project>--<digest>/`, second
   `start` a no-op, `status` shows the supervisor healthy.
4. **Build.** `stim ios` (and/or `android`). Cold: watch the phase
   lines; on failure judge the extracted diagnostic against the raw log in
   `~/.stim/workspaces/<project>--<digest>/logs/build-*.ndjson` — was it enough to act on? Assert the
   `--json` payload against the launch-status table below. `"unverified"` is
   not automatically a failure, but it requires following Stim's own
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
   - `xcrun simctl list devices | grep Stim` → none of yours remain
     (`emulator -list-avds` likewise on Android)
   - `ps aux | grep -E 'Stim|supervisor'` → no supervisors or collectors
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
| Physical iPhone               | `ios --device` build, signing, install, launch, or device logging changed | A cabled, unlocked iPhone with Developer Mode on and a provisioning profile that names it. Run the staged checklist below; a step you did not run is a skip, never a pass.                                                                                             |

For a cached release, use a unique JS sentinel. On iOS, confirm the copied and
re-signed `.app` contains the regenerated bundle. On Android, confirm the APK
bundle remains stored rather than deflated, is zipaligned and signed, and that
a changed asset set refuses the swap and falls back to a full build.

### The staged physical-iPhone checklist

Everything on this list needs a phone and nothing else does, so it is staged
rather than run every release. Design and reasoning:
`docs/specs/2026-09-01-ios-device-release-design.md`.

**A. The re-seal acceptance test** (the spec's riskiest unverified assumption;
run it first, before anything downstream is trusted). Take any signed device
`.app`, mutate its `ip.txt`, re-seal it with Stim's ladder, then:

```
codesign --verify --strict <app>   ->   devicectl device install   ->   launch
```

Record the verify output, the install result, and whether the app ran. A
failure here invalidates `ip.txt` ownership, the Debug path, and the Release
JS swap together, so report it as CRITICAL and stop.

**PASSED 2026-09-01** on an iPhone 12 Pro (iPhone13,3, cabled, iOS Developer
Mode on), against the real `stim ios --device` artifact: the mutation broke the
seal, `codesign --force --sign <sha1>
--preserve-metadata=identifier,entitlements,flags,runtime` re-made it,
`--verify --strict` passed, and both install and launch were accepted. A
pristine control behaved identically. Rerun it only when the re-seal ladder
itself changes.

**B. Device log capture** (appandflow/stim#179). The collector's parser is
tested against a real `os_log` stderr mirror captured on macOS, not on a
phone. What a phone has to settle:

1. **Fields observed live vs. the fixtures.** Run the collector against the
   app and quote real lines from `device.ndjson`. Confirm each claim the
   `guide logs` table makes: `ts` is the device's own clock and not the
   host's; `proc` is `name(pid)`; `category` is present for React Native's
   `javascript` / `native` calls and absent for `NSLog`; `subsystem` is
   absent; and an `os_log` call made at the error level is **still recorded
   at info**, which is the loss the guide claims. A field that survives on
   hardware but is documented as lost is a HIGH finding, not a bonus.
2. **The os_log mirror actually mirrors.** Without `OS_ACTIVITY_DT_MODE` the
   stream carries plain `stdout`/`stderr` writes only. Prove the variable is
   doing work: a `console.log` from JS must appear. If it does not, the
   collector is capturing almost nothing and the gap is still open.
3. **Timeline integration.** `logs --source device` shows the records in one
   timeline with `metro` and `build`, ordered by `ts` across sources.
   `logs --errors` with no `--source` still excludes them. A native crash
   before JS starts appears with level `fatal`.
4. **Launch coupling.** On hardware the collector performs the launch, so
   confirm exactly one app instance starts, that `--terminate-existing`
   replaced a running one, and that a dev-client deep link passed as
   `--payload-url` opened the right URL.
5. **Cleanup on unplug.** Pull the cable with the collector running. It must
   remove its own `collectors.ios` registration and exit; `status` must stop
   reporting it and `gc` must find nothing, because a phone is never recorded
   as a device. Then reconnect and run `ios --device` again: the replacement
   must start cleanly. **Which closing record does it write?** A non-zero
   devicectl exit becomes `collector_failed`, a zero exit becomes
   `collector_stopped`, and nobody has observed which one a cable-pull
   produces. Record the exit code and the record. If unplugging reports a
   failure, that is a wrong error on a normal action and the classification
   needs to change.
6. **Replacement and ownership.** With a collector live, run `ios --device`
   again and confirm the previous pid was proven this workspace's and
   signalled, and that `stop` reaps the survivor.

**C. Install, launch and Debug over the LAN** (#178 phases 3 and 5). What a
phone has to settle, and what is already settled:

1. **The dev-client Debug loop, end to end.** `stim ios --device` on a
   provisioned expo-dev-client project: cache HIT on the `-device` key, install,
   launch through the collector with the deep link on `--payload-url`, a bundle
   request from the phone in `logs --source metro`, and `launched: true`.
   **PASSED 2026-09-01** on the phone above.
2. **The device pid, never a host pid.** The run's `launch` line names a pid read
   from `devicectl device info processes`, and a Release run's proof is that
   probe repeated, not `process.kill`. **PASSED 2026-09-01** (Debug; the Release
   variant is exercised by the same probe).
3. **The two human, one-time steps.** A first launch of a build whose developer
   the phone has not trusted is refused with `FBSOpenApplicationErrorDomain 3`
   and reason `Security`; the remedy must name Settings > General > VPN & Device
   Management first. The Local Network permission prompt must be tapped before
   the phone can reach Metro at all; it cannot be pre-granted from the host and
   it survives an upgrade install. **Both OBSERVED 2026-09-01**; the refusal
   classifier is unit-tested against the recorded text rather than re-provoked.
4. **The bare `ip.txt` path.** NOT YET RUN ON HARDWARE: it needs a bare RN
   project with a development profile that names the phone, and the available
   one is a dev-client app. On-disk verification (the copy carries
   `<addr>:<port>`, the cache entry does not, the copy re-seals and verifies)
   plus RN's own producer/consumer (`react-native-xcode.sh:16-28`,
   `RCTBundleURLProvider.mm:70,206`) is what stands behind it today. A phone run
   is the outstanding evidence.
5. **The signer-conflict uninstall-and-retry.** NOT YET RUN ON HARDWARE: a
   genuine `MismatchedApplicationIdentifierEntitlement` needs a second signing
   team. The classifier and the one-uninstall-one-retry ladder are unit-tested
   against Apple's documented text.
6. **The Release device run.** Builds fresh every time until the device JS swap
   lands (phase 6), because a cached Release app carries its builder's JS.
   Prove `metroPort` is null, no LAN machinery runs, and the process is alive on
   the phone three seconds after launch.

## Launch-status contract

| Value          | Meaning                                                                                        | Field-test verdict                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `true`         | A bundle request from this workspace was proven, or a release process was observed alive.      | Pass.                                                                                              |
| `"bundling"`   | This workspace's Metro port has positive, non-error evidence and the bundle is still building. | Pass for wiring; record that JS completion was not observed.                                       |
| `"unverified"` | No positive launch evidence was observed.                                                      | Follow the emitted remedy and inspect the owned device; report both the value and the observed UI. |
| `false`        | Reserved; Stim does not produce it today.                                                      | Treat its appearance as a contract regression.                                                     |

## The friction log (the primary deliverable)

Number every finding. For each: **severity** (critical / high / med / low),
the **verbatim evidence** (the exact output line, not a paraphrase), and a
**one-line suggested fix**. Classify honestly:

- CRITICAL: the documented loop cannot complete unassisted, or Stim
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
