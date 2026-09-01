# Stim — iOS builds on a physical device

Date: 2026-09-01
Status: draft — design review only, no code
Scope: `ios --device [udid]` on a Mac with a cabled iPhone, in Debug and in
Release. Store signing, archives, `.ipa` production and distribution stay out
of scope and are named where they touch a decision. Maintainer rulings of
2026-09-01 are recorded under "Decisions"; the largest reversed an earlier
draft that deferred Debug on a device.

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
the effort — and, after the 2026-09-01 review, spends it on Debug as well as
Release, because a phone is worth having in the loop long before a release
build is what you want to look at.

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

A fourth question turns out to belong to Debug alone, and an earlier draft got
it wrong by deferring rather than answering it: **how does the phone find
Metro**, when `adb reverse` has no USB counterpart. That is "Metro on a phone",
below.

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

`stim ios --device [udid]` builds for, installs on, and launches on a connected
iPhone, in **any** configuration.

Four deliberate boundaries.

**Debug and Release both, decided 2026-09-01.** An earlier draft of this spec
deferred Debug on the grounds that a phone cannot reach Metro. The maintainer
overruled that, correctly: Debug on a device is ordinary React Native practice.
The narrow true finding underneath the wrong conclusion is only that **there is
no USB analogue of `adb reverse`** — `usbmuxd` forwards host-to-device, not
device-to-host, so the phone cannot dial the Mac's loopback down the cable. It
can dial the Mac's LAN address, and that is what v1 does. "Metro on a phone"
below is the whole mechanism. `--device` therefore constrains the configuration
not at all; `--configuration` behaves exactly as it does on the simulator, and
the existing rule that a non-Debug configuration skips Metro entirely is
untouched.

**Signing applies to both, which is the part that surprises.** A Debug build
for the simulator needs no signature at all — that is why none of this existed
before. A Debug build for a phone needs a complete one: identity, profile,
entitlements. `--device` is the trigger for everything in "The signing model";
`--configuration` is not, and never was.

**No archives, no `.ipa`, no distribution.** `devicectl device install app`
takes a `.app` bundle. Stim never runs `xcodebuild archive`, never runs
`-exportArchive`, never needs an `ExportOptions.plist`, and never uploads
anything anywhere. The artifact never leaves the machine that built it.

**Used, never owned.** Stim will not create, boot, unpair, erase, enable
Developer Mode on, or delete a phone. It installs, launches, and observes. The
UDID never enters the project registry.

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

**Existing keys do not move.** Every key minted so far ends `-sim`, and the
simulator path keeps passing `isSimulator: true`, which `buildTarget` maps to
the same `'sim'` it produces today from an absent option. No cache entry is
orphaned and no rebuild is forced by this change; the device slice is purely
additive.

**Pass `isSimulator`, never `device`.** `buildTarget`
(`packages/core/index.ts:200`) reads `isSimulator` first, but falls through to
`options.device` — and a string that is neither a simulator UUID
(`SIMULATOR_UDID`, the 8-4-4-4-12 form, line 185) nor an `emulator-N` serial
returns `on-<slug>`. A physical iPhone UDID is `00008030-001A2B3C4D5E802E` or a
40-character hex string, so it matches neither regex, so passing
`{device: udid}` would silently mint a **per-phone** key — the exact fork
Decision 6 rules out, arriving through a plausible-looking parameter. The
device path passes `{configuration, isSimulator: false}` and nothing else.

**No port segment, and that is a decision, not an omission.** The Metro port
never enters a compiled input, because Stim declines to set `RCT_METRO_PORT`
and puts the port in `ip.txt` instead — the reasoning is in "The port, which is
the subtle part". Had it gone into the binary, the key would have had to carry
it, which forks the device-Debug cache per workspace and kills the sharing that
makes the slice worth caching at all. The port stays out of the build so that
it can stay out of the key.

**The device slice is not uploaded to a remote or provider cache in v1.**
Every consumer on another machine would fail the signing gate — a Release
entry at the swap, a Debug entry at the `ip.txt` re-seal — and fall back to a
full build, so the upload buys a download and a refusal. Local tiers only.

## The signing model

### Building

Nothing. The project's Xcode settings decide, per Rock.

### Debug: the same gate, and a re-seal after all

An earlier draft said a Debug device install needs no re-signing, on the
reasoning that a Debug build embeds no JS to swap. That was right about the JS
and wrong about the bundle: Stim writes `ip.txt` into every bare Debug device
install (see "Metro on a phone"), `ip.txt` is a sealed resource, so the
signature has to be re-made.

So the two configurations converge:

|             | Debug                     | Release                         |
| ----------- | ------------------------- | ------------------------------- |
| fresh build | rewrite `ip.txt`, re-seal | nothing; `xcodebuild` signed it |
| cache hit   | rewrite `ip.txt`, re-seal | JS swap, then re-seal           |

The gate below therefore applies in full to both — including the
identity-in-keychain check, since both end in a `codesign`. An expo-dev-client
app is the one case that needs no rewrite, because its URL arrives in the deep
link; it can skip straight to install, and the gate degrades to the
profile-only pre-install check that turns an opaque `devicectl install`
rejection into `STIM_PROFILE_MISMATCH` with the phone and the profile named.

The cost is one `codesign` per Debug device install that the simulator path
does not pay. It is seconds on a large app, against a build that is minutes,
and it is unavoidable: there is no way to change a sealed resource and keep the
seal.

### Re-signing after a JS swap — the crux, and release only

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

   **A gate failure on a freshly built app is terminal.** The fallback for a
   refused cache hit is "build fresh", which is only an answer when the
   artifact came from the cache. On an app `xcodebuild` produced thirty seconds
   ago, building again produces the same app and refuses again, so the run must
   exit on the gate's own `STIM_*` code — `STIM_NO_PROFILE`,
   `STIM_PROFILE_MISMATCH` or `STIM_NO_SIGNING_IDENTITY` — and never re-enter
   the build. The distinction is one boolean at the call site and it is the
   difference between a clear refusal and a loop that burns a build each pass.

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
developer wants to override, a machine with two certificates sharing a CN, or a
multi-NIC Mac whose `en0` is not the interface the phone shares. Following the
`android.keystore` / `ios.configuration` precedent in `settings.ts`, three new
`KNOWN_SETTINGS` keys:

```json
{
  "ios": {
    "signingIdentity": "Apple Development: Jane (TEAMID5678)",
    "signingIdentitySha1": "ABCDEF…",
    "lanHost": "192.168.1.42"
  }
}
```

`ios.signingIdentity` names the identity for the re-seal, overriding the one
derived from the profile. `ios.signingIdentitySha1` disambiguates two
certificates with the same common name by SHA-1 hash — the field
`parseSigningIdentities` already captures and Rock throws away. `ios.lanHost`
pins the address written into `ip.txt` and the dev-client deep link, for the
multi-NIC case that interface ordering cannot solve and the host-side gate
cannot detect; it takes an address only, never a URL, for the reason given
under "`metro.publicUrl` does not participate". All three take the
`iosConfigurationSetting` shape: a reader, a paired `…Error` reporter, an entry
in `KNOWN_SETTINGS`, and a line in the `settings` guide topic (which a contract
test enforces).

Deliberately **not** added: `ios.developmentTeam`, `ios.provisioningProfile`,
`ios.allowProvisioningUpdates`. The first two belong in the Xcode project,
which is where every other tool looks for them; the third is an account
mutation (see above).

## Metro on a phone: Debug over the LAN

A Debug app looks for a dev server. On a simulator that is `localhost:<port>`,
because the simulator shares the host's network stack. On an emulator it is
`10.0.2.2`, or `localhost` once `adb reverse` has run (#141). A phone on a
cable has neither: `usbmuxd`, the daemon behind `devicectl` and Xcode, forwards
**host-to-device** connections, and offers no device-to-host reverse. So the
phone has to reach the Mac the ordinary way, over the network they share.

### What already exists, and what does not

Stim built most of this for `--remote`, and it is worth being exact about which
parts transfer, because the parts that do not are the work.

| Piece                                                  | State                                                                                                                                                                                              |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A named non-loopback origin for Metro                  | `metro.publicUrl` / `STIM_METRO_PUBLIC_URL`, read by `publicUrlSetting` (`settings.ts:496`) and injected into the supervisor's env (`commands/start.ts:397`).                                      |
| Proving an origin is _this_ workspace's Metro          | `gateMetroOrigin` (`engine/metro-gate.ts:43`): fetch `<origin>/index.bundle?platform=ios&dev=true`, then wait for that request to surface in this workspace's own Metro NDJSON. Reusable verbatim. |
| A per-run hook to establish reachability before launch | `ensureMetroReachable`, called at `commands/ios.ts:1550` — today only when `remoteDevice` is set.                                                                                                  |
| The dev-client deep link taking a non-loopback host    | `devClientUrl(scheme, port, host = 'localhost')` (`app-install.ts:136`) already takes the parameter #141 added for Android.                                                                        |
| **Discovering the host's LAN address**                 | **Does not exist.** There is no `lanUrl` anywhere in the tree. This is new.                                                                                                                        |

So the new pure function is small: `os.networkInterfaces()` filtered to
`family === 'IPv4' && !internal`, with link-local `169.254/16` and the
`utun`/`bridge`/`awdl` interfaces excluded, preferring `en0`. It returns a list,
not a value, because a Mac on Wi-Fi and Ethernet has two and there is no way to
know from the host which one the phone shares.

**Selection is ordering, not gating, and that is worth saying plainly because
the obvious design does not work.** The tempting idea is to gate each candidate
and keep the first that answers. It discriminates nothing: as "the gate proves
less than it looks like it proves" explains below, macOS routes a host's
connection to any of its own addresses over loopback, so **every** local
candidate answers, including one on an interface the phone cannot see. A
per-candidate gate would return the first entry of the list and present that as
a measurement.

So the list order is the decision. Prefer `en0`, then the remaining `en*` by
index — deliberately RN's own heuristic from `react-native-xcode.sh`, so that
Stim and a plain Xcode run pick the same interface and a developer comparing
the two is not chasing a difference Stim invented. If exactly one candidate
survives filtering, use it; if none, refuse.

The gate still runs, once, on the chosen address — it is worth keeping for what
it does prove, that the origin is this workspace's Metro on the reserved port
rather than a stale server. It is not worth pretending it proves reachability.
A multi-NIC Mac whose `en0` is not the shared interface is the case ordering
cannot solve, and it gets a settings escape hatch (`ios.lanHost`) rather than a
heuristic. The real discriminator is downstream and always was: the phone's own
fetch, reported by `verifyLaunch`.

### Does Metro actually listen on that address?

It has to, or none of this works, and the answer differs by mode:

- **Expo.** `supervisor/server-expo.ts:284` runs `expo start --port <n>`, which
  binds to all interfaces — that is how the QR code's `exp://192.168.x.x` link
  has always worked.
- **Bare.** `supervisor/server-bare.ts:329` calls `metro.runServer(config, …)`
  and never sets `config.server.host`, so Metro's own default applies, which
  binds all interfaces. But line 308 hardcodes `const hostname = 'localhost'`
  and feeds it to `serverBaseUrl` and `createDevServerMiddleware`. That should
  affect only URLs the dev middleware _generates_ (the debugger front end), not
  what the socket accepts.

"Should" is doing work in that second bullet, and it is not a claim a unit test
can settle. Phase 2 verifies it with one real check — `lsof -nP -iTCP:<port>`
against a live bare supervisor, expecting `*:<port>` and not `127.0.0.1:<port>`
— and if bare Metro turns out to bind loopback only, the fix is to set
`config.server.host = '0.0.0.0'` in `server-bare.ts`, which is a one-line
change to a file Stim owns.

### The wiring

Debug on a device is otherwise the same sequence the simulator runs, with the
host substituted:

1. Resolve the LAN origin `http://<addr>:<port>`.
2. `gateMetroOrigin({origin, metroPort, platform: 'ios'})` — unchanged code.
3. For a bare app, write `<addr>:<port>` into `ip.txt` inside the copy and
   re-seal it (below). For an expo-dev-client app, nothing — the deep link
   carries the URL.
4. Launch with `devicectl device process launch --device <udid> …`, passing the
   dev-client deep link built as `devClientUrl(scheme, port, <addr>)` when there
   is one, and the bundle id otherwise.
5. `verifyLaunch` as today.

### How a bare app finds Metro: `ip.txt`, which RN already builds for this

React Native has solved this for physical devices since long before Stim
existed, and the first draft of this section missed it. Two files:

**The producer.** `packages/react-native/scripts/react-native-xcode.sh:16-28`,
the Xcode build phase every bare app runs:

```bash
# Enables iOS devices to get the IP address of the machine running Metro
if [[ ! "$SKIP_BUNDLING_METRO_IP" && "$CONFIGURATION" = *Debug* && ! "$PLATFORM_NAME" == *simulator ]]; then
  for num in 0 1 2 3 4 5 6 7 8; do
    IP=$(ipconfig getifaddr en${num} || echo "")
    if [ ! -z "$IP" ]; then break; fi
  done
  …
  echo "$IP" > "$DEST/ip.txt"
fi
```

Debug and not-simulator: exactly the slice this spec adds. It writes the host's
LAN address into `ip.txt` in the app bundle.

**The consumer.** `React/Base/RCTBundleURLProvider.mm:206 guessPackagerHost`
reads that resource, falls back to `localhost`, and probes:

```objc
NSString *ipPath = [[NSBundle mainBundle] pathForResource:@"ip" ofType:@"txt"];
ipGuess = [[NSString stringWithContentsOfFile:ipPath …] stringByTrimmingCharactersInSet:…];
NSString *host = ipGuess ?: @"localhost";
if ([RCTBundleURLProvider isPackagerRunning:host]) { return host; }
return nil;
```

`packagerServerHostPort` (line 259) tries the `RCT_jsLocation` default first,
then falls through to `guessPackagerHost` under `#if RCT_DEV`.

So **bare Debug on a device is in for v1, through RN's own mechanism**, and no
dev-client is required. The constraint it carries is the same one this section
already had, because it is the same constraint by construction: the value baked
in is a LAN address, so the phone and the Mac must share a network.

`RCT_jsLocation` stays hardware-unreachable, exactly as the earlier draft had
it — `jsLocationValue` (`app-install.ts:132`) is written through
`simctl spawn defaults write`, which has no `devicectl` counterpart. It is
simply no longer the only channel, so the refusal it implied is gone. The
shake-menu "Configure Bundler" screen survives only as the remedy of last
resort, for a phone Stim cannot reach at all.

### The port, which is the subtle part

`ip.txt` holds a host. The port comes from `kRCTBundleURLProviderDefaultPort`
(`RCTBundleURLProvider.mm:20`), which is `RCT_METRO_PORT`, which is a
**compile-time define**, defaulting to 8081 in `RCTDefines.h:111-121`. Stim
reserves a port that is deliberately not 8081. That looks like a serious
problem, and tracing where the define comes from makes it look worse before it
gets better.

`React-Core.podspec:61` sets

```ruby
"GCC_PREPROCESSOR_DEFINITIONS" => "RCT_METRO_PORT=${RCT_METRO_PORT}",
```

`${…}` is not Ruby interpolation — Ruby's is `#{…}` — so that is a literal
string written into the pod's generated `.xcconfig`, where `${RCT_METRO_PORT}`
is an **xcconfig build-setting reference resolved by Xcode at build time**, not
by CocoaPods at install time. `RCTDefines.h:114-121` confirms it from the other
end: the `RCT_METRO_PORT_DO_EXPAND(VAL) VAL##1` trick exists precisely to detect
`RCT_METRO_PORT=` — the empty expansion you get when the build setting was
never set — and fall back to 8081.

Which means Stim _could_ pass `RCT_METRO_PORT=<port>` as a build setting on the
`xcodebuild` argv, and `xcodebuildArgs` already appends a `buildSettings` array
after `build` for exactly that kind of thing. **It should not, and the reason is
the cache.**

The define changes `RCTBundleURLProvider.o`, so it changes the binary, so a
device-Debug `.app` built for port 8082 is not the same artifact as one built
for 8083 — while the port appears in no fingerprinted input, so both would land
on the same cache key. Making the key honest means adding a port segment, which
**forks the device-Debug cache per workspace**: every worktree has a different
reserved port by design, so no two would ever share an artifact, and the
single-flight build and cross-workspace sharing that are the reason Stim is fast
would be dead exactly on the slowest slice. This is invariant-10-shaped
reasoning — a value that mutates a compiled input has to be in the key or out of
the build — and here the answer is to keep it out of the build.

**The way out is that `ip.txt` can carry the port too.**
`serverRootWithHostPort` (`RCTBundleURLProvider.mm:70`) is the single funnel
every packager URL goes through:

```objc
if ([hostPort rangeOfString:@":"].location != NSNotFound) {
  return [NSURL URLWithString:[NSString stringWithFormat:@"%@://%@/", scheme, hostPort]];
}
return [NSURL URLWithString:[NSString stringWithFormat:@"%@://%@:%lu/", scheme, hostPort,
                             (unsigned long)kRCTBundleURLProviderDefaultPort]];
```

A value containing a colon is used verbatim and
`kRCTBundleURLProviderDefaultPort` is never consulted. `guessPackagerHost`
returns the trimmed contents of `ip.txt` unaltered, and `isPackagerRunning:`
funnels through the same helper — so `192.168.1.5:8085` in `ip.txt` is probed at
`http://192.168.1.5:8085/status` and loaded from
`http://192.168.1.5:8085/index.bundle?…`.

**So: Stim never sets `RCT_METRO_PORT`, never passes a build setting, and writes
`<addr>:<port>` into `ip.txt`.** The port stays out of every compiled input, the
`xcodebuild` argv stays fixed as invariant 3 requires, and the device-Debug
artifact is port-agnostic and shareable across workspaces like every other
slice.

### Stim owns `ip.txt`, on every device install

RN bakes an address at build time. That value is wrong more often than it looks:

- On a **cache hit** it is the _building_ machine's address at _build_ time.
  Move to a different Wi-Fi, or take a colleague's artifact, and it names a host
  that no longer exists.
- On a **multi-NIC Mac** it is `ipconfig getifaddr en0`, or the first `en`
  interface that answers — which on a machine with Ethernet, Wi-Fi and a
  Thunderbolt bridge is a coin flip, and not necessarily the interface the phone
  shares.
- It never carries the port, per above.

**The file's contents are exact.** `guessPackagerHost` trims
`[NSCharacterSet newlineCharacterSet]` and nothing else — not spaces, not tabs
— and hands the result to `serverRootWithHostPort`, which interpolates it into
a URL string verbatim. So the file holds precisely `<addr>:<port>`, ASCII, with
an optional trailing newline and no other whitespace, no scheme, no path, no
trailing slash. A stray space produces `http://192.168.1.5:8085 /` and a
silent fall-through to the embedded bundle, which is the stale-JS failure below
wearing a different hat. Worth a unit test on the writer rather than a comment.

Stim knows the right answer: its LAN discovery picked an address and
`gateMetroOrigin` proved Metro answers on it. So **Stim writes `ip.txt` itself
on every bare Debug device install — cached or freshly built — and re-seals**,
which makes whatever RN baked irrelevant and removes both hazards at once. No
`SKIP_BUNDLING_METRO_IP`, no build-setting divergence; the build stays exactly
what the project's own tooling produces, and the fix is applied to the artifact
afterwards.

`ip.txt` is a bundle resource, so it is covered by
`_CodeSignature/CodeResources` and rewriting it invalidates the seal — which is
the neat part: **it needs precisely the re-seal step the Release swap already
needs.** Debug and Release device installs converge on one code path, and the
signing gate applies in full to both.

**A fresh build therefore gains a copy-aside step it does not have today, and
the ordering is not free to choose.** The simulator path installs the build
output directly out of derived data. A bare Debug device run cannot: mutating
`ip.txt` in place would mean either mutating the artifact before it is stored —
putting a machine-specific, workspace-specific address into the shared cache
entry, which every later consumer would then have to overwrite anyway — or
mutating the cache entry after storing it, which this spec's cache-copy rule
("the cache entry itself is never modified, exactly as on Android") forbids outright.

So the order is **store, then copy, then mutate**: the pristine artifact is
stored under the post-mutation cache key exactly as it is today, then copied to
a `mkdtemp` directory, and only the copy gets the new `ip.txt` and the re-seal.
That is the same shape the Release swap already uses (`js-swap.ts` copies with
`cp -c -R` before touching anything), so it is an existing step moved onto a
new path rather than a new mechanism. The cached entry stays generic and
shareable; the per-run address lives only in the copy that gets installed and
deleted.

### The stale-fallback trap, and why `'unverified'` earns its keep

One consequence has to be said out loud, because it is quiet and it is the
opposite of what a simulator does. `react-native-xcode.sh` **does** bundle for a
physical device in Debug — the script's own line is _"Bundling for physical
device"_, and only the simulator branch skips it. So a device-Debug `.app`
carries an embedded `main.jsbundle`, and `jsBundleURLForBundleRoot:` falls back
to it whenever `packagerServerHostPort` comes back nil.

An unreachable Metro therefore does not error. The app launches, looks fine, and
runs **the JS that was baked when the artifact was built** — which on a cache hit
is another workspace's JS. That is the exact scenario invariant 3's "must never
install stale JS" exists to prevent, arriving through a door that rule was not
written for.

Stim's existing machinery already catches it: no bundle request reaches this
workspace's Metro, so `verifyLaunch` returns `'unverified'`. What this design
adds is that the `'unverified'` remedy for a bare device Debug run must **say
what the app is probably doing** — running JS embedded at build time, not this
workspace's — rather than only listing network causes. An `'unverified'` that
reads as "we could not confirm" underplays "the screen you are looking at may be
someone else's build".

Two alternatives were considered and rejected. Passing `SKIP_BUNDLING=1` would
leave no fallback, turning an unreachable Metro into a visible failure — but it
diverges the build from what the project's own tooling produces, and makes the
cached artifact useless without a network. Running the full JS swap on every
Debug cache hit would make the fallback correct, but it pays a Metro bundle on
every Debug run, which is most of what `--device` Debug is trying to avoid.
Loud reporting is the cheaper honest answer.

### The gate proves less than it looks like it proves

`gateMetroOrigin` fetches the LAN URL **from the host**. macOS routes a host's
connection to its own LAN address over loopback, and the macOS application
firewall filters inbound connections from _other_ machines. So the gate passing
means "this origin is this workspace's Metro on the right port" — genuinely
useful, it catches a stale tunnel or a port collision — but it does **not** mean
the phone can reach it. A firewall block passes the gate and then fails at the
phone.

The proof that the phone reached Metro already exists and is unchanged:
`verifyLaunch`'s bundle-request evidence, which is a record in _this_
workspace's Metro NDJSON produced by the app's own fetch. This is the same
guarantee #141 leaned on. What changes is the **remedy attached to
`'unverified'`**: on `ios --device` in Debug it must name the two causes the
gate cannot distinguish — the phone is on a different network (cellular, a guest
SSID, a VPN), or the macOS firewall is blocking inbound — with the concrete
checks for each.

### `metro.publicUrl` does not participate, and that needs saying

The reach table above lists `metro.publicUrl` as existing machinery, which
invites the assumption that a tunnel is the fallback when there is no LAN
address. It is not, in v1, and the reason is mechanical: **neither channel to
the phone can carry a URL.** Both carry a `host:port`.

- `devClientUrl` (`app-install.ts:136`) composes
  `http://${host}:${metroPort}` — scheme hardcoded, port appended.
- `ip.txt` is fed to `serverRootWithHostPort`
  (`RCTBundleURLProvider.mm:70`), which prefixes the scheme itself. Handing it
  `https://foo.ngrok.app` yields `http://https://foo.ngrok.app/`; stripping the
  scheme to `foo.ngrok.app` leaves no colon, so the compiled
  `kRCTBundleURLProviderDefaultPort` — 8081, since Stim does not set it — gets
  appended instead. The scheme override that would fix the first case,
  `RCT_packager_scheme`, is another `NSUserDefaults` key and is as
  hardware-unreachable as `RCT_jsLocation`.

So an `https` tunnel cannot be expressed to a phone through either channel
without changing RN or writing device-side defaults, and a remedy that
suggested one would send a user somewhere that cannot work. **`--device`
ignores `metro.publicUrl`, `metro.tunnel` and `metro.ngrokUrl` entirely, and
says so when any of them is set alongside `--device` in Debug** — a note, not a
refusal, because those settings are there for `--remote` and a workspace may
legitimately carry both.

Tunnelled device Debug is therefore a deferred item, not a fallback that
happens to be untested. It would need `devClientUrl` to accept a full origin
and RN to learn a scheme it can read from a bundled resource.

### The residual constraint, stated plainly

**The phone and the Mac must be on the same network, and that network must not
isolate clients.** Client isolation on guest Wi-Fi, a corporate network that
segments wireless from wired, and a VPN that captures the phone's default route
all break this, and none of them can be detected from the host. USB-only Debug
is the deferred piece, and `usbmuxd`'s directionality is why: closing it means
either running a device-side listener that Stim does not have, or a
`devicectl`-tunneled forward whose availability is question 2 below.

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

**Launch**, branching on the configuration exactly as the simulator path does:

- _Debug, expo-dev-client:_ `xcrun devicectl device process launch --device
<udid> --terminate-existing --json-output <tmp> <devClientUrl(scheme, port, lanAddr)>`
  — the deep link built with the LAN host, per the section above.
- _Debug, bare:_ the same launch with the bundle id. The URL travelled in
  `ip.txt` instead, written and re-sealed before the install. No
  `RCT_jsLocation` write, because `simctl spawn defaults write` has no hardware
  equivalent — it is no longer needed.
- _Release:_ the same launch with the bundle id and no URL. Metro is skipped
  entirely, `metroPort` is `null`, and none of the LAN machinery runs.

Either way `process.processIdentifier` is read out of the JSON.

**Amendment, 2026-09-01 (#179).** Two details of that sketch are wrong, found
while interrogating `devicectl` 518.33 for phase 7, and phase 3 should follow
this paragraph rather than the bullets above.

1. **The deep link is not the positional argument.** `devicectl device process
launch` documents its positional as "the bundle identifier of or path to the
   remote application"; a URL for the app to open on launch travels in
   `--payload-url`. The dev-client launch is therefore
   `... --device <udid> --terminate-existing --payload-url <devClientUrl(...)>
<bundleId>`.
2. **`--json-output` cannot supply the pid when the console is attached.**
   Phase 7 needs `--console` on the same launch, and `--console` "waits for the
   app to terminate", so its JSON is written at exit rather than at launch. The
   device-side process probe this section already specifies —
   `devicectl device info processes` — becomes the only source of a device pid,
   for Debug as well as Release. It is no longer release-only plumbing.

Phase 7 also inverts who launches: because `devicectl` connects an app's
standard streams only when it is the process that starts the app, the log
collector runs this launch itself rather than attaching after it. Phase 3 wires
the collector as the launch step; see #179.

**Proof of launch — this is an invariant 11 change, and only for release.**
`verifyReleaseLaunch` (`app-install.ts:567`) sleeps 3 s then calls
`process.kill(pid, 0)` on the **host**. That works on a simulator because a
simulated app is a host process. A device pid is meaningless on the host, and
`process.kill` would either throw ESRCH or, far worse, silently confirm an
unrelated host process. The device branch must instead re-probe:
`xcrun devicectl device info processes --device <udid> --json-output <tmp>`,
filtered for the app's executable path — the structural analogue of Android's
`pidof` → `ps -A` ladder in `verifyAndroidReleaseLaunch`. The parser is pure
and unit-testable; the probe is one injected call.

Debug needs none of that: its proof is the bundle request, and `verifyLaunch`
is unchanged. Statuses keep their meanings — `true` on a proven bundle request
or a live release process, `'unverified'` with the new firewall/network remedy,
`STIM_LAUNCH_FAILED` on a release process that exits inside the window.

**Signer change on reinstall.** `devicectl install` refuses to overwrite an
app whose existing signature does not match (team or `application-identifier`
mismatch). That is the same class of failure as Android's
`INSTALL_FAILED_UPDATE_INCOMPATIBLE`, and it gets the same treatment and the
same guard rails: a pure `iosInstallConflictKind(text)` classifier, one
`xcrun devicectl device uninstall app --device <udid> <bundleId>`, one retry,
and a warned note saying the app's data went with it. Android gates this on
release runs only, because that is where its re-signing happens. On iOS
**every** `--device` run is signed, Debug included, so the gate is `--device`
rather than the configuration — the same reasoning, applied to where the
signature actually changes.

## Logs — the honest gap, ruled on

`collector/ios.ts:145 logStreamArgs()` is
`simctl spawn <udid> log stream --style ndjson --predicate 'processImagePath CONTAINS[c] "<app>"'`.
`simctl spawn` does not exist for hardware, and the structured `--style ndjson`
that the whole parser and `NOISE_RULES` table depend on has no proven
equivalent through `devicectl`.

**Decided 2026-09-01: v1 ships without runtime device logs**, and a follow-up
issue explores a `devicectl`-based collector. The obligation that comes with
that ruling is that the gap is stated plainly rather than presented as a pass —
the precedent the remote-device spec set for the same situation, whose
reasoning applies verbatim: _"an empty device section reads as a pass, and
`empty is the pass condition` is the contract `logs --errors` sells. A silent
gap here would be a lie."_

The cost differs by configuration, and both halves must be said:

- **Debug on a device keeps most of what matters.** Metro is live, and
  `@stim-cli/metro`'s NDJSON reporter runs on the host regardless of what the
  client is. Redboxes, bundling failures and `console.*` all still land in
  `logs`. What is lost is the native half: crashes before JS starts, native
  module errors, `os_log` output.
- **Release on a device loses everything runtime.** No Metro either, so
  `logs --errors` covers **build errors only**. The run's own output must say
  so, and so must the `logs` and `cleanup` guide topics.

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

### Invariant 3 — five sentences, one of which is easy to miss

> ~~`android --device [serial]` selects a connected physical device; there is
> no iOS equivalent, because that needs code signing.~~
>
> `android --device [serial]` and `ios --device [udid]` select a connected
> physical device. A physical device does not share the host's loopback and has
> no reverse forward over USB, so a Debug run on one is wired to a gated LAN
> origin rather than to `localhost`: through the dev-client deep link, or by
> writing `<addr>:<port>` into the app bundle's `ip.txt` and re-sealing it.
> Never by setting `RCT_METRO_PORT`, which would put the reserved port into a
> compiled input and fork the cache per workspace.

**The sentence between them.** `Do not add install flows.` sits directly
between the two rewrites above and below, and it is the one an implementer will
read last and obey first. Taken literally it forbids this entire spec: install
onto a device is an install flow. It cannot be left standing unamended, and it
should not simply be deleted, because what it was written to prevent is real —
Stim reconstructing a project's own delivery pipeline. So it is narrowed to
what it meant:

> ~~Do not add install flows.~~
>
> Stim installs only onto a device it is driving in this run — an owned
> simulator or emulator, or a physical device named by `--device`. Do not add
> distribution flows: no store upload, no TestFlight, no over-the-air install
> page, no reconstruction of the project's own delivery pipeline.

> Android swaps require an emitted-asset manifest match, then `zipalign`
> before `apksigner`. **An iOS device build is always signed, Debug included,
> and an iOS device swap requires the copied bundle's own
> `embedded.mobileprovision` to be unexpired, to name the target UDID, and to
> resolve to an identity present in the keychain; then `codesign` re-seals the
> copy with that same identity.**

> ~~Store signing and distribution remain out of scope.~~
>
> Stim re-signs only artifacts it copies, only with the identity the artifact
> already carries, and never passes signing flags to `xcodebuild` — in
> particular never `-allowProvisioningUpdates`, because a build must not mutate
> an Apple Developer account. Archives, `.ipa` export, store signing, and
> distribution remain out of scope.

The sentence that does **not** change: _"Non-Debug iOS configurations and
Android variants ending in `Release` skip Metro."_ Release-shaped builds skip
Metro on hardware exactly as they do on a simulator; what the Debug ruling
changed is only that `--device` no longer implies a non-Debug configuration.

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
`guide errors` (six new codes, which the contract test _enforces_ — it
scrapes `/STIM_[A-Z_]+/g` out of `commands/ios.ts` and fails if any is
undocumented), `guide settings` (three new keys, likewise enforced), `guide
facts` (the payload gains a device field and `logs` gains a caveat). And
`guide.test.ts`'s flag-list assertion pins
`ios.ts: ['--json','--no-metro-check','--no-build-cache','--configuration','--remote']`,
so `--device` must be added there in the same commit. `SKILL.md` gets one
sentence and stays under 1,200 words.

## Failure taxonomy

Six new codes. All are raised from `commands/ios.ts`, so all six are
force-documented by the `guide errors` contract test.

Signing — four:

| code                       | when                                                                                                                     | remedy                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STIM_NO_SIGNING_IDENTITY` | `security find-identity -v -p codesigning` lists nothing, or the identity the artifact names is absent from the keychain | "Open Xcode > Settings > Accounts and download your certificates, or unlock the login keychain. `security find-identity -v -p codesigning` should list `Apple Development: …`."                                                                                                                                                                                                                                                               |
| `STIM_NO_PROFILE`          | the built or cached `.app` has no `embedded.mobileprovision`, or `security cms -D` cannot decode it                      | "The build produced an unsigned app. Set a team and profile under the target's `<configuration>` configuration in Xcode > Signing & Capabilities, then **build once from Xcode** to install the profile — Stim will not do it, because registering a device or minting a profile changes your Apple Developer account."                                                                                                                       |
| `STIM_PROFILE_MISMATCH`    | profile expired; or `ProvisionedDevices` does not contain the UDID; or the key is absent entirely                        | Names the profile type found and why it cannot be used: an App Store or Enterprise profile carries no device list, so Stim cannot prove `<device>` is admitted. "Local device runs need a **Development** profile. Select one under Signing & Capabilities and build once from Xcode." For a development profile that simply lacks the device: "Register `<udid>` at developer.apple.com, regenerate the profile, and build once from Xcode." |
| `STIM_CODESIGN_FAILED`     | `codesign --force --sign` or `codesign --verify --strict` exited non-zero on the swapped copy                            | verbatim `codesign` stderr, plus "Unlock the login keychain (`security unlock-keychain`) and confirm exactly one identity matches `<name>`."                                                                                                                                                                                                                                                                                                  |

Debug reachability — two:

| code                         | when                                                                                                              | remedy                                                                                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STIM_NO_LAN_ADDRESS`        | a Debug `--device` run found no non-internal IPv4 interface — the Mac is offline, or on nothing but `utun`/`awdl` | "The phone reaches Metro over the network you share. Join a Wi-Fi or Ethernet network, or connect the Mac by cable." Deliberately **not** "set `metro.publicUrl`" — see below. |
| `STIM_LAN_METRO_UNREACHABLE` | every LAN candidate failed `gateMetroOrigin`                                                                      | Reuses `describeMiss`'s three shapes (no answer / 5xx / wrong dev server) with the candidate address named, plus "`stim start` prints the port it reserved."                   |

Reused rather than invented:

- **`STIM_NO_DEVICE`** for zero connected devices and for an ambiguous
  selection, matching `android --device` exactly.
- **`STIM_BAD_ARG`** for `--device` with an empty UDID and for `--device` with
  `--remote`. There is no bare-project refusal: RN's own `ip.txt` mechanism
  covers bare Debug on hardware.
- **`STIM_INSTALL_FAILED`** for every `devicectl install` failure, with a
  pure `iosInstallFailureKind(text)` classifier — in the shape of
  `installConflictKind` — supplying a distinct remedy per cause: device
  locked, host not trusted, Developer Mode off, storage full, signer
  conflict.
- **`STIM_LAUNCH_FAILED`** for a release process that exits inside the 3 s
  window.

Not a code, but a changed message: **`launched: 'unverified'` on a Debug
`--device` run gets a new remedy**, because the two causes the LAN gate cannot
distinguish both land here. It names them — the phone is on a different network
(check it is on the same SSID, not cellular, not a VPN), or macOS is blocking
inbound connections (System Settings > Network > Firewall, or
`/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate`) — and, on a
bare project, it names the consequence: the app did not fall over, it fell back
to the JS bundle embedded when the artifact was built, which on a cache hit is
another workspace's. See "the stale-fallback trap".

Gate refusals are **not** codes. The guide's existing section heading —
_"FALLBACK NOTES THAT ARE NOT CODES (release cache hits)"_ — grows the iOS
signing-gate reasons alongside the Android asset-diff ones, because the run
recovers by building fresh and exits 0.

## doctor

One new check, `checkIosDevice`, pure and injectable in the manner of
`checkRemoteDevice` / `checkSimSlim`, reporting only when a device run is
plausible (a device is connected, or `ios.signingIdentity` is set):

Signing:

- no codesigning identities in the keychain → `cost`, with the Xcode Accounts
  fix;
- identities present but the login keychain is locked → `cost`;
- a device connected with `developerModeStatus` not enabled → `cost`, fix
  "Settings > Privacy & Security > Developer Mode on the device, then
  reconnect";
- `ios.signingIdentity` set to a name `security find-identity` does not list →
  `cost`, listing what it does report;
- an untrusted host pairing → `cost`, "unlock the phone and tap Trust".

Every one of these ends in **"then build once from Xcode"** rather than in a
flag Stim could pass, which is the doctor-visible consequence of the
`-allowProvisioningUpdates` ruling: the one-time account-touching step is the
human's, named explicitly, and Stim never does it silently.

Reachability, when a Debug device run is plausible:

- no non-internal IPv4 interface → `cost`, the `STIM_NO_LAN_ADDRESS` remedy;
- the macOS application firewall is on and set to block all incoming
  connections
  (`socketfilterfw --getglobalstate` / `--getblockall`) → `note`, because it is
  a legitimate configuration that will nonetheless make every Debug device run
  come back `'unverified'`. Naming it in `doctor` is much cheaper than
  discovering it from a failed launch.

Everything it needs is `security find-identity -v -p codesigning`, one
`devicectl list devices -j`, `os.networkInterfaces()`, and one
`socketfilterfw` read — all cheap and all injectable through `runDoctor`'s
options bag. `commands/doctor.ts`'s "Checked: …" sentence gains a clause.

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
- **`-allowProvisioningUpdates`, permanently.** Ruled out 2026-09-01, not
  postponed. A build must not register devices or mint profiles in an Apple
  Developer account as a side effect. The one-time manual Xcode step is named
  in the remedies and in `doctor` instead.
- **Ad-hoc distribution artifacts** — Rock's `manifest.plist` + `index.html`
  install pages. Out of scope with distribution.
- **Runtime device logs.** Follows from the 2026-09-01 ruling; its own issue.
- **USB-only Debug**, i.e. a device run that needs no shared network.
  `usbmuxd` forwards host-to-device only, so closing this means either a
  device-side listener Stim does not have or a `devicectl`-mediated tunnel
  whose availability is open question 2.
- **Wireless devices.** `devicectl` can reach a paired device over the
  network; v1 requires a cable for the install, because a flaky install over
  Wi-Fi is a confusing failure and the cable case has to work first. (The
  _Metro_ connection is over the network either way — that is a different
  link, and it is the one the LAN section is about.)
- **Uploading the device slice to a remote or provider cache.**
- **Multiple phones per machine.** One UDID per run; the "two workspaces, one
  bundle id, last install wins" limitation #141 documented for Android
  applies here unchanged and should be documented in the same words.

## Implementation plan

Seven phases. Each is independently reviewable, and the tree stays green
throughout.

**1 — The device slice.** `sdk: 'iphoneos'` and `destination: id=<udid>`
plumbed through `buildIos`; `isSimulator` passed at both `buildCacheKey` call
sites; `overwrite: !useBuildCache || swapFellBack` adopted from Android; the
`errors-xcode.ts` signing remedy rewritten to branch on the slice.
_Testable:_ `xcodebuildArgs` and `productsDir` are pure; the key change is
pure. _Invariant 9:_ one real `xcodebuild -sdk iphoneos … build` — this needs a
provisioned project but **not** a phone, since `generic/platform=iOS` compiles
and signs without one attached.

**2 — Discovery, selection, and the LAN address.** `devicectl list devices -j`
parsing; `resolveIosPhysicalDevice(requested, devices)` in the exact shape of
`resolvePhysicalDevice`; `lanCandidates(interfaces)` and its ordering; the
`--device` flag and the `STIM_BAD_ARG` guards; the `guide` flag-list update.
_Testable:_ entirely pure against recorded `devicectl` JSON and a synthetic
`os.networkInterfaces()` object. _Invariant 9:_ one real
`devicectl list devices`, **and** the `lsof -nP -iTCP:<port>` check against a
live bare supervisor that settles whether Metro binds all interfaces. That
check is cheap and it gates phase 5, so it happens here.

**3 — Install and launch.** The `devicectl` install / launch / uninstall calls,
`iosInstallFailureKind`, the signer-conflict uninstall-and-retry, and the
device-side process probe that replaces the host `process.kill` in
`verifyReleaseLaunch`. After this phase **Release works end to end** with the
cache-hit path disabled — a full build every run, which is correct if slow.
_Testable:_ the classifiers and the process-list parser are pure; the calls go
through the existing mock executor. _Invariant 9:_ a real install, a real
launch, and a real signer-conflict uninstall-and-retry — the first phase that
cannot be finished without a phone.

**4 — The re-seal primitive.** Deliberately ahead of the Release swap that used
to own it, because Debug needs it too: the `security cms -D` decode, the X509
CN extraction, the `find-identity` membership check, the `ProvisionedDevices`
and expiry checks, `codesign --force --sign … --preserve-metadata=…` with its
`--entitlements` fallback, `codesign --verify --strict`, the two signing
settings, the
four signing codes, `doctor`. Exposed as one function taking a bundle path and
returning sealed-or-refused, with no opinion about why the bundle was modified.
_Testable:_ the plist and certificate parsing are pure and get fixtures (a
decoded profile plist and a self-signed cert, as Rock does in
`sign/__tests__/__fixtures__/`). _Invariant 9:_ real `security cms -D`, real
`security find-identity`, real `codesign` in both forms — none of which needs a
phone.

**5 — Debug on the device.** `ensureLanReachable` reusing `gateMetroOrigin`;
`writeIpTxt(appCopy, addr, port)` plus the phase-4 re-seal on every bare Debug
install, cached or fresh — with the store-then-copy-then-mutate ordering a
fresh build now needs; `ios.lanHost`; the deep-link launch through
`devClientUrl(scheme, port, lanAddr)` for dev-client apps; the two reachability
codes; the `'unverified'` remedy naming the stale-fallback consequence. After
this phase **Debug works end to end**, bare and dev-client. _Testable:_ the
reach plan is pure, `gateMetroOrigin` already has tests, and `ip.txt` content is
one pure function. _Invariant 9:_ the thing to prove is that the phone fetched
from Metro rather than falling back to the embedded bundle — which is exactly
what `verifyLaunch` reports, so the evidence is the run's own `ready: bundle
loaded` line, as in #141's test plan.

**6 — The Release swap.** `js-swap.ts` gains its device branch: the gate runs
before the bundle work, the ad-hoc `--sign -` becomes the phase-4 re-seal, and
release cache hits turn on. Small, because phase 4 built the hard part.
_Invariant 9:_ a real install of a swapped app on the phone — the moment the
whole design is either true or not.

**7 — Device runtime logs.** Deferred to its own issue by the 2026-09-01
ruling. Until it lands, phases 1–6 ship with `logs` reporting the gap
explicitly.

Seven rather than the first draft's five, because the re-seal moved forward and
split from the swap that used to carry it. The ordering earns something: after
phase 3 Release runs (uncached), and after phase 5 Debug runs — two useful
halves that do not depend on each other, rather than one long march through the
signing work before anything installs.

### Which phases need hardware

Invariant 9 needs a real device somewhere in this work, and an earlier draft
said so with a blanket "from here on", which is both imprecise and
discouraging: it reads as though four phases are blocked on borrowing a phone.
Three are not, and they are the three worth starting.

| phase                         | hardware  | what specifically needs it                                                                                                                |
| ----------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — device slice              | **none**  | `generic/platform=iOS` compiles and signs with nothing attached                                                                           |
| 2 — discovery, selection, LAN | **none**  | `devicectl list devices` runs and returns an empty list; `os.networkInterfaces()` is local; the `lsof` bind check needs only a supervisor |
| 3 — install and launch        | **phone** | `devicectl install` / `process launch` / `uninstall`, the signer-conflict retry, the device-side process probe                            |
| 4 — re-seal primitive         | **none**  | `security cms -D`, `security find-identity`, `codesign` in both forms, `codesign --verify --strict` all run on a bundle sitting on disk   |
| 5 — Debug on the device       | **phone** | the only proof that matters is the phone fetching from Metro rather than falling back to the embedded bundle                              |
| 6 — Release swap              | **phone** | installing and launching a swapped, re-sealed app                                                                                         |
| 7 — device logs               | **phone** | deferred anyway (#179-shaped)                                                                                                             |

So **phases 1, 2 and 4 are fully hardware-free and should be built first.**
They are also the majority of the pure, unit-testable surface: argv and key
composition, `devicectl` JSON parsing, LAN candidate ordering, profile plist and
X509 parsing, and the whole codesign ladder.

**The first hardware experiment is not phase 3 in full.** It is the re-seal
acceptance test, and it should run the moment phase 4 compiles, before any of
phase 5 or 6 is wired:

```
take any signed device .app  ->  mutate ip.txt  ->  re-seal
  ->  codesign --verify --strict  ->  devicectl install  ->  launch
```

That five-step run is the riskiest unverified assumption in this document.
Everything downstream assumes a bundle whose sealed resources were rewritten
and re-signed with its own identity is accepted by a phone; every design choice
here — Debug and Release converging, `ip.txt` ownership, the JS swap — collapses
back to a different shape if it is not. It costs one afternoon with a phone and
it should be spent before the code that depends on it exists.

**The first host-testable unknown is smaller and comes even earlier:** phase 2's
`lsof -nP -iTCP:<port>` check on a live bare supervisor, settling whether Metro
binds all interfaces or only loopback (see "Does Metro actually listen on that
address?"). It needs no phone, it takes minutes, and a negative result adds a
one-line change to `server-bare.ts` that is much cheaper to make before phase 5
than during it.

## Decisions

Six questions went to the maintainer with the first draft; all were answered on
2026-09-01, and two further corrections came back the same day after those
rulings were applied. They are recorded here rather than silently absorbed,
because several close off alternatives a later reader would otherwise
re-litigate — and because two of them are places this doc was simply wrong,
where saying so is cheaper than leaving the reasoning that produced the error
in circulation.

| #   | Question                                                                                               | Ruling (2026-09-01)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Device runtime logs, given `simctl spawn` has no hardware equivalent                                   | **v1 ships without them.** Build errors only; the run and the guide topics state it plainly; a follow-up issue explores a `devicectl`-based collector.                                                                                                                                                                                                                                                                                 |
| 2   | Is `--device` the right surface, given it appeared to require `--configuration`?                       | **Moot, and the premise was wrong** — see 3. `--device` constrains nothing.                                                                                                                                                                                                                                                                                                                                                            |
| 3   | Debug on a device: defer it?                                                                           | **Overruled: v1 supports it.** "Why is device debug not possible? I've done it before" — and that is right; it is standard RN practice over the LAN. The draft's error was generalising a true narrow finding (no USB reverse forward, because `usbmuxd` is host-to-device) into a false broad one (no reachability at all). Rewritten as "Metro on a phone".                                                                          |
| 4   | `-allowProvisioningUpdates`                                                                            | **Never.** A build must not mutate an Apple Developer account. `doctor` and the remedies name the one-time manual Xcode step instead.                                                                                                                                                                                                                                                                                                  |
| 5   | Enterprise / App Store profiles, which carry no `ProvisionedDevices`                                   | **The gate refuses them**, and the remedy names the profile type it found and why: development profiles are the local-dev case.                                                                                                                                                                                                                                                                                                        |
| 6   | Device slice shared across phones, or keyed per UDID?                                                  | **Shared** — `-device`, no per-UDID keys. The binary is identical; the profile is what constrains devices, and the gate re-checks the UDID on every hit.                                                                                                                                                                                                                                                                               |
| 7   | `--preserve-metadata` vs. explicit `--entitlements`                                                    | **`--preserve-metadata` is the primary path**, explicit extraction is the fallback. One primary, not two equals.                                                                                                                                                                                                                                                                                                                       |
| 8   | Bare (non-dev-client) Debug on a device, which the draft refused                                       | **Corrected: it is in.** RN has shipped the mechanism for years — `react-native-xcode.sh:16-28` bakes the host's LAN address into `ip.txt` for exactly the Debug-and-not-simulator slice, and `RCTBundleURLProvider.mm:206` reads it back. The draft looked only at `RCT_jsLocation`, found it hardware-unreachable, and stopped. `RCT_jsLocation` really is unreachable; it was never the only channel.                               |
| 9   | The port, once bare Debug is in: `RCT_METRO_PORT` is a compile-time define and Stim's port is not 8081 | **Do not set it.** `serverRootWithHostPort` (`RCTBundleURLProvider.mm:70`) uses a colon-bearing value verbatim and never consults the define, so `<addr>:<port>` in `ip.txt` carries both. Setting the define would put the port into a compiled input, which would force it into the cache key, which would fork the device-Debug cache per workspace. Stim writes `ip.txt` on every bare Debug device install instead, and re-seals. |

## Open questions

Two remain, and neither blocks phases 1–6.

1. **Is there a `devicectl` invocation that yields the `subsystem` /
   `category` / `messageType` / `processImagePath` fields `collector/ios.ts`
   parses?** If yes, phase 7 is a port of the existing collector. If no, the
   choice is between a second, lossier parser over an unstructured console
   stream and leaving the gap permanent. This is the follow-up issue.

2. **Can `devicectl` forward a host port onto the device, closing the USB-only
   case?** If some form of device-side forward exists, a cabled phone could
   reach `localhost:<port>` the way an emulator does after `adb reverse`, and
   the same-network constraint disappears. If not, the constraint is
   structural and should be documented as permanent rather than as a gap.
