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
stim guide agent
stim guide lifecycle
stim guide settings
```

The candidate path is absolute so the function still uses that build after you
change into an app or worktree.

For a standalone field pass of the published release:

```bash
published_version=$(npm view stim-cli version)
stim() { npx "stim-cli@$published_version" "$@"; }
test "$(stim --version)" = "$published_version"
npx skills add appandflow/stim
stim guide agent
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
   probe repeated, not `process.kill`. **PASSED 2026-09-01** for Debug;
   `verifyIosDeviceReleaseLaunch` itself has not run on hardware.
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
7. **The app dies with its collector.** `stop` (or `gc --delete`, or pulling the
   cable) ends the collector, and because the collector is the launch, the app
   closes on the phone. Confirm the app is still INSTALLED, that `status` and
   `gc` report no device, and that the next `ios --device` starts it again.
   **OBSERVED 2026-09-01**: SIGTERM to the collector alone terminates the app.
8. **An uninstall costs the developer trust.** After any uninstall -- including
   the signer-conflict retry -- the next launch is refused until the trust is
   granted again, and the Local Network permission has to be re-tapped.
   **OBSERVED 2026-09-01** (issue #178).
9. **The pending Local Network permission, detected and recovered.**
   **OBSERVED 2026-09-01** (issue #198), on the phone above with Metro on 8082.
   `stim ios --device --json` returned `"launched":"unverified"` with pid 909
   while the prompt was up, and the device log carried the signature for the
   whole time: at 23:12:53, `Connection 1: failed to connect 1:50`,
   `error code: -1009 [1:50]`, and `Code=-1009 ... _kCFStreamErrorCodeKey=50`
   with `_NSURLErrorNWPathKey=unsatisfied (Local network prohibited)`. Only that
   last path reason is matched: the errno-50 lines are generic and Wi-Fi being
   off produces them with `unsatisfied (No network route)`. Sixteen lines of the
   capture are the classifier's fixture. Recovery, in order:
   `agent-device alert get` read
   `Allow "Trailhead" to find devices on local networks?` before any `open`;
   `alert accept` returned `accepted` and a second
   `alert get` found none; no bundle request followed within 20 s, because the
   dev client stayed on its error screen; `snapshot -i` showed
   `[button] "Reload"` and `agent-device press 'label="Reload"'` produced Metro
   `iOS Bundled 75ms` at 23:15:20 with the app running. The devicectl
   `--terminate-existing --payload-url` relaunch also recovers (twice), at the
   cost of the collector's process. `agent-device metro reload` does not: it
   needs `--metro-host`/`--metro-port` on a phone and still does nothing to an
   app that never connected. NOT YET RUN ON HARDWARE: the same detection and
   recovery on a BARE app, which needs a provisioned bare project, and the
   DENIED case -- a prior Don't Allow logs the identical path reason, so the
   remedy covers it, but nobody has provoked it on hardware.

### The staged device-lease checklist

Every item needs a phone and a second workspace on the same machine. Design
and reasoning: `docs/specs/2026-09-02-device-lease-design.md`. Set up two
workspaces of one project sharing the phone: the checkout as A with its own
Metro, and `stim worktree create <name> --carry-ignored` from it as B (the
carry brings the signing settings, so B needs no Xcode run).

**D. Device leases.**

1. **A declared lease blocks a run and names itself.** In A, `stim device
lock ios --for 5m`; in B, `stim ios --device --wait 10`. B prints a waiting
   line naming A, the device, and A's expiry, then refuses `STIM_DEVICE_BUSY`
   with the same facts and the three remedies, and installs nothing.
   **PASSED 2026-09-02** on an iPhone 12 Pro (iPhone13,3, cabled): the wait ran
   10 s (the countdown went 4m56s to 4m46s between the waiting line and the
   refusal); the busy `--json` carried the `lease` object.
2. **`--no-wait` bypasses and says what it costs.** With A's lease still held,
   B runs `stim ios --device --no-wait`. A warning (two `lease` lines) names A
   and its expiry and, when the app ids match, says the install terminates
   A's app; the run installs, launches, reports `lease: null`, and A's lease
   file is untouched.
   **PASSED 2026-09-02**: cache hit, `launched: true`, 8.4 s; A still had a
   lease to `unlock` afterwards; the same-app-id sentence printed because both
   workspaces build `com.appandflow.trailhead`. Whether A's app closed on the
   phone was not checked; A had no run of its own in flight.
3. **A run leases for itself and lets go.** After `stim device unlock` in A,
   B runs `stim ios --device`. While the run holds the device (install through
   verification), `stim status` from A lists a lease held by B with
   `mine: false`; after the run the file is gone and the run's `--json`
   carries `lease: { kind: "run", expiresAt }`.
   **PASSED 2026-09-02**: `lease: { kind: "run", expiresAt:
"2026-09-02T06:54:18.461Z" }`, 7.8 s; the mid-run status listing
   (`mine: false`) and the empty lock directory afterwards were OBSERVED from
   A and not saved.
4. **Expiry frees the device.** In A, `stim device lock ios --for 10s`; in B,
   `stim ios --device --wait 30`. B waits out the eight or so seconds and
   proceeds. **PASSED 2026-09-02** (16 s total, `launched: true`).
5. **The pool with one phone.** With A holding a lease, `stim device lock ios
--wait 5` in B (no id) waits, then refuses `STIM_DEVICE_BUSY` naming every
   holder ("Every connected device is leased by another workspace"). After A
   unlocks, the same command grants B the phone by pool selection, and B's
   id-less `stim ios --device` rides that declared lease: the run raises it
   per step and leaves it, so `status` still lists B's lease after the run and
   the run's `--json` says `kind: "declared"`. **PASSED 2026-09-02**: the
   refusal read "Every connected device is leased by another workspace, and
   this run waited 5s for one"; the id-less run then printed "declared lease
   on 00008101-000A10913C89001E until 2026-09-02T07:01:24.449Z" (five minutes
   from the install step, so the raise happened) and launched. The
   `kind: "declared"` payload and the lingering status entry were read in the
   session, not saved.
6. **Two-device ordering.** NOT YET RUN ON HARDWARE: it needs two connected
   phones. Expected: an id-less run takes the lower case-folded UDID, and a
   workspace holding a lease on the higher one lands there instead. The
   selection is unit-tested; only the real listing order is unproven.
7. **A held phone, unplugged.** NOT YET RUN ON HARDWARE, and one phone is
   enough: with B holding a lease, pull the cable, then B's id-less
   `stim ios --device` must refuse `STIM_NO_DEVICE` naming the leased UDID
   rather than the generic no-device message; `stim device unlock` in B clears
   it.
8. **A lease stolen mid-run.** NOT YET RUN ON HARDWARE: nothing takes a live
   lease without deleting its file, so this is a deliberate provocation. From
   A, wait for B's `lease   run lease on ...` line, then remove
   `$STIM_HOME/device-locks/ios-<udid>.json` and run `stim device lock ios` at
   once. If A lands before B's install raise, B refuses `STIM_DEVICE_LOST`
   and installs nothing; if A lands during the install or launch, B prints one
   `lease` warning that the app is already installed and continues, and its
   `--json` says `lease: null`. The two-process protocol test covers both
   paths; neither has been seen on a phone.
9. **A corrupt lease file on a real listing.** NOT YET RUN ON HARDWARE: write
   garbage into the phone's lease file, then an id-less run must refuse
   `STIM_DEVICE_BUSY` naming the file rather than treat the phone as free, and
   `stim gc` must report the file without deleting it.

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
