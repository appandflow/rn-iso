# Stim — iOS release builds on a physical device

Date: 2026-09-01
Status: draft — design review only, no code
Scope: `ios --device [udid]` on a Mac with a cabled iPhone. Store signing,
archives, `.ipa` production and distribution stay out of scope and are named
where they touch a decision.

## Purpose

`ios --configuration Release` today builds a Release app **for the simulator**.
That is genuinely useful — it answers "does this repro under Hermes bytecode
with the JS embedded" — but it does not answer the question a Release build
usually gets asked, which is "does it work on a phone". Everything the
simulator cannot model lives on the other side of that line: real arm64
codegen, the real GPU and memory budget, camera, secure enclave, push,
background modes, thermals.

Android already crossed this line. `android --device [serial]` (#141) builds
as usual and installs onto a connected phone, and #141 rewrote invariants 2
and 3 to say precisely what that means: Stim **uses** hardware it does not
**own**. The sentence it left behind is the one this spec is about:

> `android --device [serial]` selects a connected physical device; there is
> no iOS equivalent, because that needs code signing.

That clause is a statement about effort, not about principle. This spec spends
the effort.

## The shape of the problem, in one paragraph

An Android APK is device-agnostic: one artifact installs on any phone, and
Stim re-signs it after a JS swap with a keystore it can always find
(`android/app/debug.keystore`, password `android`). An iOS `.app` is not.
It is compiled for a different SDK than the simulator slice, it carries an
`embedded.mobileprovision` that names which devices may run it, its binary
carries a code signature over every file in the bundle, and the private key
that can re-create that signature lives in a keychain that may or may not be
on this machine. So the iOS device story has to answer three questions the
Android one did not: **which slice**, **which identity**, and **what happens
when the cached artifact was signed by somebody else**.

## Prior art: how Rock does it

Rock (Callstack, `github.com/callstackincubator/rock`, verified canonical and
unarchived, `rockjs.dev`) is the only comparable tool with a remote build
cache _and_ signed device builds, so it is the right thing to read. Everything
below is from the source at `dce336d`.

### It passes no signing flags to `xcodebuild`

`packages/platform-apple-helpers/src/lib/commands/build/buildProject.ts:35`
composes the whole argv:

```
-workspace|-project <name> [-derivedDataPath <dir>] -configuration <c>
-scheme <s> (-destination <d>)* [-archivePath <p> archive] [...extraParams]
```

There is no `CODE_SIGN_IDENTITY`, no `DEVELOPMENT_TEAM`, no
`PROVISIONING_PROFILE_SPECIFIER`, no `-allowProvisioningUpdates`. The Xcode
project's own Signing & Capabilities settings decide, and Rock's docs
(`website/src/docs/remote-cache/ios.md`) tell teams to configure **manual**
signing there — `CODE_SIGN_STYLE = Manual`, `DEVELOPMENT_TEAM[sdk=iphoneos*]`,
`CODE_SIGN_IDENTITY[sdk=iphoneos*]`, `PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]`
— and to commit an `ExportOptions.plist`. Escape hatches are two opaque
passthroughs, `--extra-params` and `--export-extra-params`
(`build/buildOptions.ts:94,99`), with `-allowProvisioningUpdates` given as the
worked example of something the user may choose to pass.

**Reading: the build needs no discovery at all.** Discovery is a re-signing
problem, not a building problem.

### Identity discovery is `security find-identity`, and it is a prompt

`packages/platform-apple-helpers/src/lib/utils/signingIdentities.ts`:
`getValidSigningIdentities()` runs `security find-identity -v -p codesigning`
and `parseSigningIdentities()` scrapes `/^\s*(\d+)\)\s+([A-F0-9]+)\s+"(.+)"$/`
into `{hash, name}`. `promptSigningIdentity(current)` puts the list in front of
a human, with the profile-derived identity floated to the top.

### Profile discovery is "read the one already inside the artifact"

This is the load-bearing idea and it is much better than searching
`~/Library/MobileDevice/Provisioning Profiles`.
`commands/sign/utils.ts:32 getAppPaths()` declares three paths inside a
`.app`: `assets/`, `main.jsbundle`, and **`embedded.mobileprovision`**. The
artifact carries its own signing metadata, so:

- `provisioningProfile.ts:37 decodeProvisioningProfileToPlist()` →
  `security cms -D -i <profile> -o <plist>`
- `provisioningProfile.ts:95 getIdentityFromProvisioningPlist()` reads
  `DeveloperCertificates:0` as a buffer, feeds it to
  `new crypto.X509Certificate(cert)`, and `extractCertificateName()` pulls
  `CN=` out of the subject — which _is_ the signing-identity name.

So the identity to re-sign with is derivable from the artifact with zero
configuration and zero filesystem search.

### Entitlements: extract, and optionally merge fastlane-style

`generateEntitlementsPlist()` writes the profile's `Entitlements` dict
straight out. Under `--use-app-entitlements` it instead calls
`generateMergedEntitlementsPlist()`, which runs
`codesign -d --entitlements - --xml <appPath>` (`provisioningProfile.ts:145`)
to get the app's real entitlements and copies a hardcoded allow-list of 15 keys
(`entitlementsToTransfer`, line 14: iCloud containers, app groups,
keychain-access-groups, associated-domains, HealthKit, HomeKit, SiriKit,
NFC formats, network extensions…) from the app onto the profile's dict. Both
merge helpers are commented "Based on fastlane's ... logic" — **and that is the
only trace of fastlane in the repository. Rock has no fastlane dependency.**

### The codesign invocation

`commands/sign/modifyIpa.ts:97`:

```js
const codeSignArgs = ['--force', '--sign', identity, '--entitlements', tempPaths.entitlementsPlist, appPath];
await spawn('codesign', codeSignArgs, { cwd: tempPaths.content });
```

Note what is **absent**: no `--deep`, no `--preserve-metadata`, no
`--timestamp`, no separate pass over `Frameworks/` or `PlugIns/`. Only the
outer bundle is re-sealed.

### It re-signs `.ipa` and explicitly refuses to re-sign `.app`

`platform-ios/src/lib/commands/signIos.ts` registers `sign:ios`, whose `--app`
flag is documented as _"Modify APP file (directory) instead of IPA file. **No
signing is done.**"_ `commands/sign/modifyApp.ts` copies, rebuilds the JS
bundle, and stops. The `.app` path is understood to be the simulator path.

### The cache does NOT re-sign. A separate command does.

This is the answer to "how does it handle an artifact built by someone else's
cert", and it is worth being exact, because the obvious guess is wrong.

`tools/src/lib/build-cache/getBinaryPath.ts` is the whole cache-hit path:
`--binary-path` flag, then `getLocalBuildCacheBinaryPath(artifactName)`, then
`fetchCachedBuild()`. `fetchCachedBuild.ts` downloads, unzips, un-tars
(`app.tar.gz`, to preserve the exec bit that `actions/upload-artifact` drops),
and returns a path. **No codesign anywhere.** `createRun.ts:194` hands that
path to `buildApp()`, which short-circuits at line 66 (`if (binaryPath)`),
reads `Info.plist` for the bundle id, and returns. `runOnDevice.ts` then runs
`xcrun devicectl device install app --device <udid> <binaryPath>` and
`xcrun devicectl device process launch --device <udid> <bundleId>`.

So on a local cache hit, Rock installs the downloaded artifact **exactly as
CI signed it**. That works only because the profile is an Ad-Hoc or
Distribution profile that already names the tester's device. Re-signing is a
_CI_ step: the `callstackincubator/ios` action has a `re-sign` input,
documented as _"Re-sign the IPA with latest JS bytecode bundle with
`rock sign:ios`. Necessary for tester device builds"_, which produces a new
artifact per PR commit keyed
`rock-ios-device-Release-<fingerprint>-<PR number>`.

### Its cache key already carries a device/simulator segment

`tools/src/lib/build-cache/common.ts:103 formatArtifactName()` →
`rock-${platform}-${traits.join('-')}-${hash}`, and both `createRun.ts:80` and
`createBuild.ts:48` pass `traits: [deviceOrSimulator, configuration ?? 'Debug']`,
where `deviceOrSimulator` is derived from whether `--destination[0]` matches
`/simulator/i`. Documented shapes: `rock-ios-simulator-debug-<hash>`,
`rock-ios-device-debug-<hash>`.

`utils/buildApp.ts:118` also re-derives the artifact name after
`pod install` changes the fingerprint — Rock's version of invariant 10 — and
guards it with `args.local`, because a remote lookup must happen on the
pre-mutation key.

### What Rock deliberately does not do

- **No certificate management.** It never imports a `.p12`, never creates a
  keychain, never talks to the Apple Developer portal. The GitHub Action does
  that with `security create-keychain` in YAML; the CLI assumes the keychain
  is already correct.
- **No profile search or matching.** It never lists
  `~/Library/MobileDevice/Provisioning Profiles`, never compares a bundle id
  to a profile's `application-identifier`, never checks `ProvisionedDevices`.
  The only profile it will ever use is the one already embedded in the
  artifact.
- **No fastlane, no `match`, no managed certs.** It reimplements the two
  entitlement helpers it wanted and stops.
- **No re-signing on the local cache-hit path**, as shown above.
- **No `.app` signing at all.**
- **No non-interactive default identity.** `modifyIpa.ts:131` hard-fails when
  `--identity` is absent and `isInteractive()` is false.

## What Stim takes, and where it must go further

| Rock's answer                                               | Stim's answer                                                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build passes no signing flags                               | Same. Invariant 3's "fixed `xcodebuild` arguments" already says this.                                                                                   |
| Identity from the artifact's own `embedded.mobileprovision` | Same, and it is the whole zero-config story.                                                                                                            |
| Prompt when the identity is ambiguous                       | **Cannot.** Stim is a non-interactive agent CLI. It must _decide_ or _refuse with a remedy_.                                                            |
| Cache hit installs as-is                                    | **Cannot.** Invariant 3: a release cache hit must inject the current JS. Injecting invalidates the signature, so Stim must re-sign where Rock does not. |
| Re-sign happens in CI                                       | Happens locally, on every release cache hit, exactly as `apk-swap.ts` already does for Android.                                                         |
| Never validates the profile                                 | **Must**, because Stim re-signs unattended and a failed `devicectl install` is a worse error than a refusal.                                            |
| `.ipa`, `archive`, `ExportOptions.plist`                    | Out of scope. Stim installs a `.app` with `devicectl`, which accepts one.                                                                               |

## Scope

`stim ios --device [udid]` builds for, installs on, and launches on a
connected iPhone, and requires a non-Debug configuration.

Three deliberate boundaries.

**Device implies release, in v1.** A Debug build on hardware needs Metro
reachable _from the phone_. Android gets that for free from `adb reverse`;
iOS has no equivalent, so the phone would have to reach the Mac over the LAN
or a tunnel. Stim already owns that machinery — `metro.publicUrl`,
`metro.tunnel`, `metro.ngrokUrl`, `engine/tunnel.ts`, and the origin gate in
`engine/metro-gate.ts` that proves a public origin reaches _this_ workspace's
Metro — so Debug-on-device is a later composition of parts that already exist,
not a missing capability. It is deferred, not refused forever. In v1,
`ios --device` without a non-Debug configuration fails `STIM_BAD_ARG` with a
remedy naming `--configuration Release`.

**No archives, no `.ipa`, no distribution.** `devicectl device install app`
takes a `.app` bundle. Stim never runs `xcodebuild archive`, never runs
`-exportArchive`, never needs an `ExportOptions.plist`, and never uploads
anything anywhere. The artifact never leaves the machine that built it.

**Used, never owned.** Stim will not create, boot, unpair, erase, enable
Developer Mode on, or delete a phone. It installs, launches, and (see Logs)
observes. The UDID never enters the project registry.

## The build: one new slice

`xcodebuildArgs()` in `engine/xcode.ts:265` already takes `sdk` and
`destination`; nothing has ever overridden `sdk`, which defaults to
`iphonesimulator`, and `productsDir()` at line 305 already keys the products
directory on `${configuration}-${sdk}`. The device slice is therefore:

```
-sdk iphoneos  -destination id=<device udid>
```

and `productsDir` finds `Release-iphoneos/`. Two lines of real change.

No signing flags are added, per Rock and per invariant 3. If the project's
Release configuration is not set up to sign, `xcodebuild` fails and
`engine/errors-xcode.ts` already has the matcher — its remedy today reads
_"Stim builds Debug for the simulator, which needs no signing"_, which becomes
wrong the moment this ships and must be rewritten to branch on the slice.

`-allowProvisioningUpdates` is **not** passed. It mutates the team's Apple
Developer account (registering devices, minting profiles) as a side effect of
a build, which is not a thing an agent should do unattended. When the build
fails for a missing profile, the remedy points at Xcode.

## The cache: one new segment, which already exists

`buildCacheKey()` in `packages/core/index.ts:211` is
`${fingerprintHash}-${buildVariant}-${buildTarget}`, and `buildTarget()` at
line 200 already returns `'device'` when `options.isSimulator === false`. But
neither command passes it — `commands/ios.ts:1621` passes only
`configuration ? { configuration } : {}` — so every key ever minted ends
`-sim`.

For Android that is correct: an APK is the same artifact whether it goes to
an emulator or a phone, which is why `android --device` needed no key change.
For iOS it is a **latent correctness bug the moment a device slice exists**:
`Release-iphoneos/App.app` and `Release-iphonesimulator/App.app` have the same
fingerprint, the same configuration, and would collide on
`<fingerprint>-release-sim`. Installing the wrong one produces
`simctl install` failing on an arm64-only binary, or `devicectl` failing on a
simulator binary — both far from their cause.

So `commands/ios.ts` passes `isSimulator: !physical` at **both** call sites:

- line 1621, the pre-mutation lookup key
- line 1902, the post-mutation `storeKey` (invariant 10)

giving `<fingerprint>-release-device`. The segment is per-slice, not
per-phone: `on-<serial>` is deliberately not used, because an
`iphoneos` build is identical for every device its profile admits. Which
devices those are is a property of the signature, and the gate below is where
that gets checked.

**The device slice is not uploaded to a remote or provider cache in v1.**
Every consumer on another machine would fail the signing gate and fall back
to a full build, so the upload buys a download and a refusal. Local tiers
only.

## The signing model

### Building

Nothing. The project's Xcode settings decide, per Rock.

### Re-signing after a JS swap — the crux

A release cache hit must inject this workspace's JS
(invariant 3). `engine/js-swap.ts` does that today and **already ends in a
codesign** — line 273:

```js
e.runFile('codesign', ['--force', '--sign', '-', appCopy]);
```

`--sign -` is an _ad-hoc_ signature. A simulator accepts it. A phone will not:
it needs a real identity, a valid `embedded.mobileprovision`, and entitlements
that the profile permits. So the swap grows a device branch.

The full sequence, in order, with the failure mode of each step:

1. **Copy aside.** Unchanged: `cp -c -R` then `cp -R`. `cp -R` preserves
   symlinks and the exec bit, both of which a code signature seals over.
   _Fails if:_ disk full, path unreadable → `step: 'copy'`, full build.

2. **The signing gate — new, and it runs BEFORE the bundle is built.**
   This is the iOS analogue of Android's asset-manifest gate, and it is placed
   before the expensive work for the same reason: a refusal that costs 40
   seconds of Metro bundling is a bad refusal. Against the _copy_:
   - `embedded.mobileprovision` must exist in the bundle root. Absent means
     the artifact is unsigned or simulator-sliced → refuse.
   - `security cms -D -i <profile> -o <plist>` decodes it. A decode failure
     means a corrupt entry → refuse.
   - `ExpirationDate` must be in the future.
   - `ProvisionedDevices` must contain the target UDID. (An Enterprise or App
     Store profile has no such key; treat a missing key as "cannot prove"
     and refuse, rather than guessing.)
   - `DeveloperCertificates:0` → `crypto.X509Certificate` → subject `CN=`
     gives the identity name (Rock's method, `provisioningProfile.ts:95`).
     That name must appear in `security find-identity -v -p codesigning`.

   Each failure is a **refusal**, not an error: the same
   `{assetMismatch: true, reason}` shape `apk-swap.ts` uses, renamed. The run
   prints why and does a full build. This is the answer to "what about an
   artifact built with someone else's cert": Stim detects it in about 50 ms of
   `security` calls and never gets as far as a confusing `codesign` error.

3. **Bundle + Hermes + replace.** Unchanged from today.

4. **Re-seal.** Preferred form:

   ```
   codesign --force --sign <identity>
            --preserve-metadata=identifier,entitlements,flags,runtime <appCopy>
   ```

   `--preserve-metadata=entitlements` is the direct answer to "do entitlements
   survive": yes, by construction — the existing signature's entitlement blob
   is carried over verbatim, so app groups, keychain-access-groups,
   associated-domains, `aps-environment` and `get-task-allow` are all
   preserved without Stim having to know what they are. Rock's 15-key
   allow-list exists because Rock changes the profile; Stim does not.

   Fallback, if `--preserve-metadata` is rejected (it has been deprecated and
   un-deprecated across Xcode versions):
   `codesign -d --entitlements - --xml <appCopy>` to a temp plist, then
   `codesign --force --sign <identity> --entitlements <plist> <appCopy>`.
   An empty extraction means "no entitlements", and the re-sign runs without
   the flag. Both forms must be exercised against the real `codesign`
   (invariant 9).

   **No `--deep`.** Apple discourages it, and it is unnecessary: the swap
   writes only `main.jsbundle` and `assets/` at the bundle root, so the only
   invalidated seal is the outer bundle's `_CodeSignature/CodeResources`.
   `Frameworks/*.framework` and `PlugIns/*.appex` keep their own valid
   signatures, and re-signing with the _same_ identity the artifact already
   carries keeps their team identifier consistent with the outer bundle's.
   That last clause is why the gate insists on the artifact's own identity
   rather than "any identity in the keychain": a cross-team re-seal of the
   outer bundle only would produce nested code signed by a different team,
   which the device rejects at launch with an error nobody enjoys reading.

   _Fails if:_ keychain locked (`errSecInternalComponent`), identity
   ambiguous (two certs, same CN — `codesign` refuses), bundle unreadable →
   `step: 'codesign'` → `STIM_CODESIGN_FAILED` handling below, then full build.

5. **Verify — new, cheap, worth it.**
   `codesign --verify --strict <appCopy>` catches a bundle that signed but
   did not seal correctly, on the host, before the phone gets a chance to
   produce `ApplicationVerificationFailed`.

**The cache entry itself is never modified**, exactly as on Android. The swap
operates on a `mkdtemp` copy which `finishIosRun` deletes after install.

### One asymmetry to fix while here

Android stores a fresh build with `overwrite: !useBuildCache || swapFellBack`;
iOS uses only `overwrite: !useBuildCache` (`commands/ios.ts:1961`). Android's
form is right and iOS should adopt it: an entry that just failed the gate
should be _replaced_ by the build that follows, or it refuses every run
forever. This matters much more once a gate exists that can refuse.

### The escape hatch

Discovery is zero-config, so the settings exist only for the case discovery
cannot cover: a project whose Release configuration signs with an identity the
developer wants to override, or a machine with two certificates sharing a CN.
Following the `android.keystore` / `ios.configuration` precedent in
`settings.ts`, two new `KNOWN_SETTINGS` keys:

```json
{ "ios": { "signingIdentity": "Apple Development: Jane (TEAMID5678)", "signingIdentitySha1": "ABCDEF…" } }
```

`ios.signingIdentity` names the identity for the re-seal, overriding the one
derived from the profile. `ios.signingIdentitySha1` disambiguates two
certificates with the same common name by SHA-1 hash — the field
`parseSigningIdentities` already captures and Rock throws away. Both take the
`iosConfigurationSetting` shape: a reader, a paired `…Error` reporter, an entry
in `KNOWN_SETTINGS`, and a line in the `settings` guide topic (which a contract
test enforces).

Deliberately **not** added: `ios.developmentTeam`, `ios.provisioningProfile`,
`ios.allowProvisioningUpdates`. The first two belong in the Xcode project,
which is where every other tool looks for them; the third is an account
mutation (see above).

## Install, launch, and proof

`engine/app-install.ts` gains a physical branch, mirroring the `physical`
parameter #141 threaded through `writeDebugHttpHost` / `androidDevClientUrl` /
`launchAndroidApp`.

**Discovery** — Rock's `listDevices.ts` shape:
`xcrun devicectl list devices -j <tmp>`, then read
`result.devices[].hardwareProperties.udid`, `.deviceProperties.name`,
`.deviceProperties.bootState`, and — which Rock parses but ignores —
`.deviceProperties.developerModeStatus`. Selection follows
`resolvePhysicalDevice` in `sim/android.ts:330` exactly: a named UDID must be
present and healthy; with no UDID, exactly one connected device is used and
several is a refusal listing the candidates.

**Install:** `xcrun devicectl device install app --device <udid> <appPath>`.

**Launch:** `xcrun devicectl device process launch --device <udid>
--terminate-existing --json-output <tmp> <bundleId>`, from which
`process.processIdentifier` is read. No `RCT_jsLocation`, no `openurl`, no
dev-client deep link — release already skips all three
(`app-install.ts:173`, `metroPort === null`).

**Proof of launch — this is an invariant 11 change.**
`verifyReleaseLaunch` (`app-install.ts:567`) sleeps 3 s then calls
`process.kill(pid, 0)` on the **host**. That works on a simulator because a
simulated app is a host process. A device pid is meaningless on the host, and
`process.kill` would either throw ESRCH or, far worse, silently confirm an
unrelated host process. The device branch must instead re-probe:
`xcrun devicectl device info processes --device <udid> --json-output <tmp>`,
filtered for the app's executable path — the structural analogue of Android's
`pidof` → `ps -A` ladder in `verifyAndroidReleaseLaunch`. The parser is pure
and unit-testable; the probe is one injected call.

Statuses are unchanged: `true` on a live process, `'unverified'` on
`reason: 'no-pid'`, `STIM_LAUNCH_FAILED` on `'exited'`.

**Signer change on reinstall.** `devicectl install` refuses to overwrite an
app whose existing signature does not match (team or `application-identifier`
mismatch). That is the same class of failure as Android's
`INSTALL_FAILED_UPDATE_INCOMPATIBLE`, and it gets the same treatment and the
same guard rails: a pure `iosInstallConflictKind(text)` classifier, one
`xcrun devicectl device uninstall app --device <udid> <bundleId>`, one retry,
a warned note saying the app's data went with it, and — critically — only on
a release run, which on iOS `--device` is every run, and only when the caller
passed `allowUninstall`. Same wording, same `event:
'install_uninstalled_first'`.

## Logs — the honest gap

`collector/ios.ts:145 logStreamArgs()` is
`simctl spawn <udid> log stream --style ndjson --predicate 'processImagePath CONTAINS[c] "<app>"'`.
`simctl spawn` does not exist for hardware, and the structured `--style ndjson`
that the whole parser and `NOISE_RULES` table depend on has no proven
equivalent through `devicectl`.

**v1 collects no device logs on `ios --device`, and `logs` must say so.**
This is the precedent the remote-device spec set for the same situation, and
its reasoning applies verbatim: _"an empty device section reads as a pass, and
`empty is the pass condition` is the contract `logs --errors` sells. A silent
gap here would be a lie."_

It is a bigger gap here than it was there, because a release run has no Metro
either — so on `ios --device`, `logs --errors` covers **build errors only**.
That must be stated in the `logs` and `cleanup` guide topics and in the phase
output of the run itself, not buried. Closing it is the first open question
below.

## Invariant deltas

Exact sentences, in the manner of #141.

### Invariant 2 — second paragraph, generalized

> ~~A physical Android device reached through `android --device` is the one
> device Stim uses but does not own. Hardware cannot be created or booted, so
> that path installs, launches, and reads logs, and nothing more. It records
> no device, so `stop`, `gc`, and `teardown.ts` never see it. Keep it that
> way: a physical serial must never enter the project registry.~~
>
> A physical device reached through `android --device` or `ios --device` is
> used but not owned. Hardware cannot be created or booted, so those paths
> install, launch, and read what logs they can, and nothing more. They record
> no device, so `stop`, `gc`, and `teardown.ts` never see them. Keep it that
> way: a physical serial or UDID must never enter the project registry.

### Invariant 3 — three sentences

> ~~`android --device [serial]` selects a connected physical device; there is
> no iOS equivalent, because that needs code signing.~~
>
> `android --device [serial]` and `ios --device [udid]` select a connected
> physical device. `ios --device` requires a non-Debug configuration, because
> Metro is not reachable from a phone.

> Android swaps require an emitted-asset manifest match, then `zipalign`
> before `apksigner`. **An iOS device swap requires the copied bundle's own
> `embedded.mobileprovision` to be unexpired, to name the target UDID, and to
> resolve to an identity present in the keychain; then `codesign` re-seals the
> copy with that same identity.**

> ~~Store signing and distribution remain out of scope.~~
>
> Stim re-signs only artifacts it copies, only with the identity the artifact
> already carries, and never passes signing flags to `xcodebuild`. Archives,
> `.ipa` export, store signing, and distribution remain out of scope.

### Invariant 9 — the tool list and the hardware clause

> ~~Mocks do not prove that `git`, `simctl`, `adb`, `avdmanager`,
> `xcodebuild`, or Gradle accepts an argument list. Exercise changed tool
> calls against the real tool at least once. Use a timeout around `simctl`.~~
>
> Mocks do not prove that `git`, `simctl`, `devicectl`, `adb`, `avdmanager`,
> `xcodebuild`, `codesign`, `security`, or Gradle accepts an argument list.
> Exercise changed tool calls against the real tool at least once. Use a
> timeout around `simctl`. A `devicectl` install or launch is proven only
> against a real, unlocked iPhone with Developer Mode on; a mock and a
> parsed fixture are not that.

### Invariant 11 — one sentence appended

> On a physical device the proof of a live release process is a device-side
> process observed through `devicectl` or `adb`, never a host pid.

### Invariant 1 — no text change, but four obligations

`guide cleanup` (the iOS release paragraph and the physical-device paragraph),
`guide errors` (four new codes, which the contract test _enforces_ — it
scrapes `/STIM_[A-Z_]+/g` out of `commands/ios.ts` and fails if any is
undocumented), `guide settings` (two new keys, likewise enforced), `guide
facts` (the payload gains a device field and `logs` gains a caveat). And
`guide.test.ts`'s flag-list assertion pins
`ios.ts: ['--json','--no-metro-check','--no-build-cache','--configuration','--remote']`,
so `--device` must be added there in the same commit. `SKILL.md` gets one
sentence and stays under 1,200 words.

## Failure taxonomy

Four new codes. All are raised from `commands/ios.ts`, so all four are
force-documented by the `guide errors` contract test.

| code                       | when                                                                                                                     | remedy                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STIM_NO_SIGNING_IDENTITY` | `security find-identity -v -p codesigning` lists nothing, or the identity the artifact names is absent from the keychain | "Open Xcode > Settings > Accounts and download your certificates, or unlock the login keychain. `security find-identity -v -p codesigning` should list `Apple Development: …`."                     |
| `STIM_NO_PROFILE`          | the built or cached `.app` has no `embedded.mobileprovision`, or `security cms -D` cannot decode it                      | "The build produced an unsigned app. Set a team and profile under the target's `<configuration>` configuration in Xcode > Signing & Capabilities, then run once from Xcode to install the profile." |
| `STIM_PROFILE_MISMATCH`    | profile expired, or `ProvisionedDevices` does not contain the UDID, or the key is absent                                 | "`<device>` (`<udid>`) is not in the profile `<name>`. Register it at developer.apple.com, regenerate the profile, and build once from Xcode."                                                      |
| `STIM_CODESIGN_FAILED`     | `codesign --force --sign` or `codesign --verify --strict` exited non-zero on the swapped copy                            | verbatim `codesign` stderr, plus "Unlock the login keychain (`security unlock-keychain`) and confirm exactly one identity matches `<name>`."                                                        |

Reused rather than invented:

- **`STIM_NO_DEVICE`** for zero connected devices and for an ambiguous
  selection, matching `android --device` exactly.
- **`STIM_BAD_ARG`** for `--device` with an empty UDID, for `--device` with
  `--remote`, and for `--device` on a Debug configuration.
- **`STIM_INSTALL_FAILED`** for every `devicectl install` failure, with a
  pure `iosInstallFailureKind(text)` classifier — in the shape of
  `installConflictKind` — supplying a distinct remedy per cause: device
  locked, host not trusted, Developer Mode off, storage full, signer
  conflict.
- **`STIM_LAUNCH_FAILED`** for a process that exits inside the 3 s window.

Gate refusals are **not** codes. The guide's existing section heading —
_"FALLBACK NOTES THAT ARE NOT CODES (release cache hits)"_ — grows the iOS
signing-gate reasons alongside the Android asset-diff ones, because the run
recovers by building fresh and exits 0.

## doctor

One new check, `checkIosSigning`, pure and injectable in the manner of
`checkRemoteDevice` / `checkSimSlim`, reporting only when a device release is
plausible (a non-Debug `ios.configuration` is set, or a device is connected):

- no codesigning identities in the keychain → `cost`, with the Xcode Accounts
  fix;
- identities present but the login keychain is locked → `cost`;
- a device connected with `developerModeStatus` not enabled → `cost`, fix
  "Settings > Privacy & Security > Developer Mode on the device, then
  reconnect";
- `ios.signingIdentity` set to a name `security find-identity` does not list →
  `cost`, listing what it does report;
- an untrusted host pairing → `cost`, "unlock the phone and tap Trust".

Everything it needs is `security find-identity -v -p codesigning` and one
`devicectl list devices -j`, both cheap and both already injectable through
`runDoctor`'s options bag. `commands/doctor.ts`'s "Checked: …" sentence gains
a clause.

## Deliberately deferred

- **Store signing, App Store Connect, TestFlight, `eas submit`.** Not a
  gap — a different product. Stim brokers a device and a port for an agent
  loop; shipping to users is the repo's own job, which is what invariant 3's
  "projects can wrap Stim" clause is for.
- **`xcodebuild archive` / `-exportArchive` / `.ipa` / `ExportOptions.plist`.**
  Not needed to put an app on a cabled phone.
- **Managed and cloud-signing certificates**, fastlane `match`, `.p12` import,
  keychain creation. Rock does none of this in its CLI either; it belongs to
  CI, and CI is not what Stim is.
- **Ad-hoc distribution artifacts** — Rock's `manifest.plist` + `index.html`
  install pages. Out of scope with distribution.
- **Debug on device.** Deferred with its mechanism named above
  (`metro.publicUrl` + `metro-gate.ts`); this is the most likely next spec.
- **Wireless devices.** `devicectl` can reach a paired device over the
  network; v1 requires a cable, because a flaky install over Wi-Fi is a
  confusing failure and the cable case has to work first.
- **Uploading the device slice to a remote or provider cache.**
- **Multiple phones per machine.** One UDID per run; the "two workspaces, one
  bundle id, last install wins" limitation #141 documented for Android
  applies here unchanged and should be documented in the same words.

## Implementation plan

Five phases. Each is independently reviewable, and the first four are
individually shippable in the sense that the tree is green and no behavior
regresses.

**1 — The device slice.** `sdk: 'iphoneos'` and `destination: id=<udid>`
plumbed through `buildIos`; `isSimulator` passed at both `buildCacheKey` call
sites; `overwrite: !useBuildCache || swapFellBack` adopted from Android; the
`errors-xcode.ts` signing remedy rewritten to branch on the slice.
_Testable:_ `xcodebuildArgs` and `productsDir` are pure; the key change is
pure. _Invariant 9:_ one real `xcodebuild -sdk iphoneos ... build` against a
real project — this needs a provisioned project but **not** a phone, since
`generic/platform=iOS` will compile and sign without one attached.

**2 — Discovery and selection.** `devicectl list devices -j` parsing,
`resolveIosPhysicalDevice(requested, devices)` in the exact shape of
`resolvePhysicalDevice`, the `--device` flag, the `STIM_BAD_ARG` guards, the
`guide` flag-list update. _Testable:_ entirely pure against recorded
`devicectl` JSON. _Invariant 9:_ one real `devicectl list devices` — a phone
must be attached to produce a non-empty fixture, but nothing is installed.

**3 — Install, launch, proof.** The `devicectl` install/launch/uninstall
calls, `iosInstallFailureKind`, the device-side process probe replacing the
host `process.kill`. After this phase the loop works end to end with the
cache hit path disabled, i.e. a full build every run. _Testable:_ the
classifiers and the process-list parser are pure; the calls go through the
existing mock executor. **Invariant 9 requires a real iPhone here, and there
is no way around it** — an unlocked, trusted, Developer-Mode device, on a
cable, running a build that actually launches. `docs/field-test-protocol.md`
is where that goes, and the PR test plan must carry its transcript the way
#141 carried the Samsung SM-G996W run.

**4 — The signing gate and the re-seal.** The `security cms -D` decode, the
X509 CN extraction, the `find-identity` membership check, the
`ProvisionedDevices` and expiry checks, the `--preserve-metadata` re-seal with
its `--entitlements` fallback, `codesign --verify --strict`, the two settings,
the four codes, `doctor`. This is where cache hits turn on. _Testable:_ the
plist and certificate parsing are pure and get fixtures (a decoded profile
plist and a self-signed cert, as Rock does in
`sign/__tests__/__fixtures__/`). _Invariant 9:_ real `security cms -D`, real
`security find-identity`, real `codesign` in both forms, then a real install
of a swapped app on the phone — which is the moment the whole design is
either true or not.

**5 — Device logs.** Gated on the open question below. Until it lands,
phases 1–4 ship with `logs` explicitly reporting the gap.

## Open questions for the maintainer

1. **Device logs.** Is there a `devicectl` (or `log stream --device`)
   invocation that yields the `subsystem` / `category` / `messageType` /
   `processImagePath` fields `collector/ios.ts` parses? If not, is
   `ios --device` acceptable with build-time errors only — meaningfully
   weaker than both `ios` and `android --device` — or does the collector need
   a second, lossier parser for an unstructured console stream? This is the
   largest unresolved risk in the spec and it does not block phases 1–4.

2. **Is `--device` the right surface at all?** The command surface is closed
   by policy and this adds the sixth flag to `ios`. Symmetry with
   `android --device` is the argument for; "one flag that silently requires
   another flag (`--configuration`)" is the argument against. The alternative
   — inferring the device from a connected phone when the configuration is
   non-Debug — is worse, because it makes a cable change the meaning of an
   unchanged command.

3. **`-allowProvisioningUpdates`.** Never, or behind a setting? The spec says
   never, because it mutates an Apple Developer account as a side effect of a
   build. If a maintainer wants the "it just works on a fresh clone"
   experience, this is the only lever, and it needs an explicit decision
   rather than a default.

4. **Enterprise and App Store profiles**, which carry no `ProvisionedDevices`
   key. The gate refuses them, on the principle that it cannot prove the
   device is admitted. That is safe and possibly annoying for an enterprise
   shop. Refuse, or attempt and let `devicectl` be the judge?

5. **Should a device-slice cache entry be reused across phones?** The spec
   says yes — the key is `-device`, not `-on-<udid>` — because the binary is
   identical and only the profile constrains devices, and the gate re-checks
   the UDID on every hit. Confirm that is the intended trade.

6. **`--preserve-metadata` vs. explicit `--entitlements`.** The spec prefers
   the former for correctness-by-construction and keeps the latter as a
   fallback. If the maintainer would rather carry one code path, extracting
   entitlements explicitly is the more portable of the two and the more
   verbose.
