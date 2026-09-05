import type { GuideTopic } from './types.ts';

const errors: GuideTopic = {
  summary: 'Every refusal Stim can print: an index of codes, and one section for each',
  sectionHint: '<CODE>',
  preamble: () => `WHAT STIM REFUSES, AND WHY

Every refusal from \`ios\` / \`android\` carries a stable CODE. Branch on the
code, never on the message.`,
  sections: {
    STIM_WORKSPACE_STATE: {
      summary: '$STIM_HOME/workspaces could not be prepared, or the digest directory belongs to another project',
      aliases: ['STIM_WORKSPACE_COLLISION'],
      separator: '--- BUILD-PATH CODES (`stim ios` / `stim android`) ---',
      body: () => `STIM_WORKSPACE_STATE / STIM_WORKSPACE_COLLISION
  Stim could not prepare this project's global workspace directory under
  $STIM_HOME/workspaces. Check that STIM_HOME is writable and has free
  space. An EPERM on a directory the user CAN write is a sandbox, not a
  permission bit -- see \`stim guide errors sandbox\`. COLLISION means the
  readable-name-plus-digest directory already has a workspace.json for a
  different canonical project path; do not overwrite it until you identify
  which workspace owns it.`,
    },
    STIM_NO_METRO: {
      summary: "nothing provably this workspace's dev server holds the reserved port (ios, android, reload)",
      body: () => `STIM_NO_METRO
  Nothing that could be proven to be THIS workspace's dev server holds the
  reserved port -- or no port is reserved at all. The gate fires in about a
  second, before the device is even booted, rather than after four minutes of
  compiling an app that could not load a bundle. Run \`stim start\` first.
  \`--no-metro-check\` overrides it and wires the app to the reservation (or to
  8081 when there is none). A non-Debug \`ios --configuration\` never emits
  this: a release-shaped build embeds its JS, so the gate does not run at all.
  A port held by SOMETHING ELSE reports what: usually a bundler started from
  the wrong directory (the repo root instead of the app dir in a monorepo), or
  another repo's Metro. Restart it from inside the project, or free the port
  and run \`stim start\` to get a fresh reservation.

  Reload requires the recorded launch's port to be this workspace's live
  Metro. It refuses a missing, changed, unresponsive, or foreign port.`,
    },
    STIM_NO_FINGERPRINT: {
      summary: '@expo/fingerprint produced no hash, so the shared cache cannot be addressed',
      body: () => `STIM_NO_FINGERPRINT
  \`@expo/fingerprint\` produced no hash, so the shared build cache cannot be
  addressed. Stim uses its declared @expo/fingerprint dependency directly,
  independently of the target project's package graph. This is a refusal
  rather than a silent full build because an unaddressable cache means every
  workspace on the commit compiles from scratch, forever.`,
    },
    STIM_PREBUILD_FAILED: {
      summary: 'expo prebuild could not generate the native directory',
      body: () => `STIM_PREBUILD_FAILED
  \`expo prebuild\` could not generate the missing native directory. The
  extracted output is above the code; the transcript is in
  the global workspace logs/build-<platform>.ndjson file.`,
    },
    STIM_DEPS_FAILED: {
      summary: 'pod install or gradle sync failed; the bundler ladder and BUNDLE_FROZEN',
      body: () => `STIM_DEPS_FAILED
  \`pod install\` (iOS) or the gradle dependency sync (Android) failed. On iOS
  this runs only when Podfile.lock and Pods/Manifest.lock disagree, or Pods is
  absent -- which is exactly what a carried worktree produces.
  WHICH POD COMMAND: when the project root has a Gemfile and a Gemfile.lock
  that resolves cocoapods, pods go through bundler -- \`bundle check --dry-run\`,
  then \`bundle install\` only when that reports missing gems, then \`bundle exec
  pod install\` -- so the CocoaPods the lockfile pins is the one that writes
  Podfile.lock. Everything else gets plain \`pod install\`: no Gemfile, a Gemfile
  with no Gemfile.lock (\`bundle install\` would CREATE that tracked file in
  your checkout, which Stim will not do), and a Gemfile.lock that
  pins something other than pods, such as a fastlane-only bundle. When
  \`bundle\` is not on PATH the run prints one dim \`pods\` note and uses plain
  \`pod install\`. The \`pods\` phase line always names the command that ran, and
  the gem steps heartbeat under the \`gems\` label.
  Bundler runs with BUNDLE_FROZEN, so a Gemfile that no longer matches its
  Gemfile.lock FAILS the build rather than quietly falling back to unpinned
  pods -- silently using a different CocoaPods than the lockfile pins is the
  bug this path exists to kill. Run \`bundle install\` yourself and keep the
  result. Gems themselves are installed wherever BUNDLE_PATH points -- the
  project's own \`.bundle/config\` (vendor/bundle in the React Native template),
  or the environment. When that lands inside the project, Stim says so in a dim
  note naming which of the two set it; Gemfile.lock is never edited either way.`,
    },
    STIM_BUILD_FAILED: {
      summary: 'xcodebuild or gradle failed; the two Android APK refusals; a damaged compilation-cache object',
      body: () => `STIM_BUILD_FAILED
  xcodebuild or gradle failed. The EXTRACTED diagnostics are printed (capped),
  not the transcript. Read the log path on the next line for the rest.
  Two Android refusals share this code without gradle itself failing:
  - MORE THAN ONE debug APK under android/app/build/outputs/apk and nothing
    configured to pick one (a project with product flavors, several flavors
    already built). Stim will not guess which flavor to install: the
    refusal lists the candidates -- pass \`--variant <name>\` or set the
    android.variant setting (e.g. "productionDebug") to the one you want.
    Flavors declared plainly in android/app/build.gradle are caught before
    the build instead (STIM_BAD_ARG); this one remains for the declarations
    that parse cannot read.
  - NO APK for the configured variant: the android.variant / --variant value
    does not name a real variant (\`./gradlew :app:tasks\` in android/ lists
    the assemble tasks).
  AN APK OLDER THAN THE BUILD IS NOT A REFUSAL. \`assembleDebug\` packages every
  flavor, so a later \`--variant previewDebug\` finds a current APK that gradle
  reports UP-TO-DATE and repackages nothing. Stim installs it. Gradle owns task
  freshness and the fingerprint owns cache freshness; Stim does not second-guess
  either from the file's mtime.

"failed to scan dependencies for source ..." on pods you did not touch  (ios)
  The compilation cache holds a damaged object. Xcode reports it per source
  file, so it names whichever targets reach the object first -- often pods such
  as sqlite3, nanopb or libwebp -- and the list changes between runs. The
  transcript carries the cause:
    error: CAS-based dependency scan failed: not a IncludeTreeRoot node kind
  A cache write that a full disk or a killed build cut short leaves such an
  object, and upgrading the CLI does not clear it. Empty that one cache with
  \`gc --delete --cache "compilation cache"\`, then build again. The next
  build is a cold one.`,
    },
    fallbacks: {
      summary: 'release cache-hit notes that are not codes: swap failure, asset gate, uninstall, device fallbacks',
      body: () => `FALLBACK NOTES THAT ARE NOT CODES (release cache hits)
  On a release cache hit Stim regenerates this workspace's JS bundle into a
  COPY of the cached artifact before installing it -- \`ios --configuration
  Release\` into a copy of the .app, \`android --variant ...Release\` into a
  copy of the APK. When any step of that swap fails (the bundle command,
  hermesc, the re-sign, zipalign, apksigner), the run does NOT install the
  cached artifact -- its baked-in JS is the builder's, not yours -- and does
  NOT fail: it prints a \`swap        failed at <step>: ... --
  building fresh instead\` note on stderr and falls back to a full build. If
  the run then fails, the code is the build's own (STIM_BUILD_FAILED etc.);
  the swap note above it says why the cache hit was not used. A swap that
  merely finds no hermesc notes it and embeds the plain JS bundle instead --
  that is a note, not a fallback.

  ANDROID'S ASSET GATE is the second, and it is not a failure at all. Before
  re-packing, Stim compares this workspace's freshly emitted asset tree
  against the assets the cached APK carries. Any added, removed or changed
  asset prints

    swap        this workspace's asset set differs from the cached APK's
                (1 added, 0 changed, 0 removed; e.g. added
                res/drawable-mdpi/new_logo.png) -- building fresh instead

  and the run does a full gradle build. There is nothing to fix: a drawable
  has a row in resources.arsc that only AAPT can write, so an APK cannot be
  made to carry an asset it was not built with, and installing one whose JS
  references a missing asset would 404 at runtime. Add an image, pay for one
  full build; the APK it produces becomes the new cache entry.

  THE UNINSTALL NOTE is the third, and it COSTS THE APP'S DATA. A re-packed
  APK is signed with this machine's debug keystore, so the moment it meets a
  copy signed by CI the install is refused with
  INSTALL_FAILED_UPDATE_INCOMPATIBLE (or INSTALL_FAILED_VERSION_DOWNGRADE) and
  nothing but removing the package resolves it. A RELEASE run therefore
  uninstalls the package once, retries the install once, and prints

    install     com.example.app was already installed with a different signer,
                so it was uninstalled (its data went with it) before this APK
                could be installed

  Debug runs never do this. A debug run meets the conflict on a physical
  device that already carries a store build, and there the colliding package is
  the user's real app: losing its data to a silent uninstall would be a worse
  bug than the one it fixes. A debug run fails with STIM_INSTALL_FAILED and
  hands you the uninstall to run yourself.

  ON A PHONE the same uninstall costs one thing more: iOS drops the Settings >
  General > VPN & Device Management trust entry when the last app from that
  developer goes, and it clears the app's Local Network permission with it. The
  note says so, because the reinstall succeeds and then the LAUNCH is refused
  until someone taps Trust again. The retry is one uninstall and one install --
  it is not a way around a tap that has no API.

  THE DEVICE FALLBACKS are the fourth, and both print a \`cache\` note and
  build fresh rather than failing:

    cache       a cached Release device app carries its builder's JS, and the
                device JS swap lands with phase 6 of appandflow/stim#178 --
                building fresh instead, which bakes in this workspace's JS

  and a signing-gate refusal on a CACHED artifact -- an expired or foreign
  profile, a phone the profile does not name, an identity this keychain does not
  hold -- which prints the gate's own reason with \`-- building fresh instead\`.
  The same refusal on a FRESHLY BUILT app is a code (STIM_NO_PROFILE,
  STIM_PROFILE_MISMATCH, STIM_NO_SIGNING_IDENTITY), not a note: building again
  would produce the same app and refuse again.`,
    },
    STIM_BUILD_WAIT_TIMEOUT: {
      summary: "waited ~90 minutes for another workspace's build of the same fingerprint",
      body: () => `STIM_BUILD_WAIT_TIMEOUT
  This run was waiting for ANOTHER workspace's build of the same fingerprint
  (see \`guide lifecycle concurrency\`), and no artifact arrived within ~90
  minutes.
  Replacement builders share that deadline, including time spent acquiring
  the lock between waits. A live builder may be wedged, or successive builders
  may have failed. The message names the current pid and lock directory:
  check the pid, and if it is not really building, remove that directory and
  run the command again.`,
    },
    STIM_INSTALL_FAILED: {
      summary: 'simctl, adb, or devicectl refused the artifact; the one signer-conflict retry',
      body: () => `STIM_INSTALL_FAILED
  The artifact built or came from cache, but \`simctl install\` / \`adb install\` /
  \`devicectl device install app\` refused it. A signature or architecture
  mismatch, or a full device.
  On a PHONE (\`ios --device\`) the message carries devicectl's own text and the
  remedy names the cause it recognises: the phone is locked, the host is not
  trusted, Developer Mode is off, storage is full, or the app already on the
  phone was signed by a different team. Only that last one is retried -- one
  \`devicectl device uninstall app\`, one reinstall, and a warning that the
  app's data went with it -- along with the phone's developer trust and its
  Local Network permission, which iOS clears on an uninstall, so the launch
  after it may need the trust tap again. This is gated on \`--device\` rather
  than on the configuration, because every device run is signed, Debug
  included.
  On Android a signature or downgrade conflict names the package that is really
  installed -- the built APK's applicationId, which on a flavored project is
  the flavor's id and not the gradle namespace -- and gives you the
  \`adb -s <serial> uninstall <applicationId>\` that clears it. Re-running after
  that is a cache hit: one install, no build.`,
    },
    STIM_LAUNCH_FAILED: {
      summary: 'installed but would not start; the developer-trust tap on a phone',
      body: () => `STIM_LAUNCH_FAILED
  Installed, but the app would not start. On Android this usually means no
  launchable activity resolved.
  On a PHONE it means the app never appeared in the device's own process list
  after \`devicectl device process launch\`, and the devicectl lines that
  explain it are quoted under the message. The refusal a first launch usually
  hits is the DEVELOPER TRUST one -- SpringBoard reports
  FBSOpenApplicationErrorDomain 3 with the reason Security -- and its remedy is
  the only one a human has to perform on the phone: Settings > General >
  VPN & Device Management, tap the developer profile under DEVELOPER APP, tap
  Trust, then run the command again. It is a per-developer-certificate tap, not
  a per-build one -- but an uninstall clears it, including the one Stim's own
  signer-conflict retry performs.`,
    },
    STIM_NO_SCHEME: {
      summary: 'no shared buildable Xcode scheme in ios/',
      body: () => `STIM_NO_SCHEME
  No buildable Xcode scheme was found in ios/. A scheme has to be shared to be
  visible to xcodebuild.`,
    },
    STIM_NO_PROFILE: {
      summary: 'no or undecodable embedded.mobileprovision; build once from Xcode',
      separator: '--- iOS SIGNING CODES (`ios --device`, and only there) ---',
      context: `A simulator build needs no signature, which is why none of these can fire on
the normal path. A device build carries one, and Stim re-seals any bundle it
modifies with the identity the bundle already names -- so it checks, before
spending a build or a bundle, that the check can succeed.`,
      body: () => `STIM_NO_PROFILE
  The built or cached .app has no embedded.mobileprovision, or
  \`security cms -D\` could not decode the one it has. The first means the build
  produced an unsigned app -- almost always a simulator-sliced artifact.
  Set a team and a Development profile for the target's configuration in
  Xcode > Signing & Capabilities, then BUILD ONCE FROM XCODE to install the
  profile. Stim will not do that step: registering a device or minting a
  profile changes your Apple Developer account, so Stim never passes
  -allowProvisioningUpdates.`,
    },
    STIM_PROFILE_MISMATCH: {
      summary: 'the profile is expired, has no ProvisionedDevices, or does not name this UDID',
      context: `A simulator build needs no signature, which is why none of these can fire on
the normal path. A device build carries one, and Stim re-seals any bundle it
modifies with the identity the bundle already names -- so it checks, before
spending a build or a bundle, that the check can succeed.`,
      body: () => `STIM_PROFILE_MISMATCH
  The profile inside the app cannot admit this phone. Three shapes, and the
  message names which one and the profile type it found:
    - it expired, or carries no ExpirationDate at all;
    - it is an App Store or enterprise profile, which carries no
      ProvisionedDevices list -- so Stim cannot PROVE the phone is admitted and
      refuses rather than guessing. Local device runs need a development
      profile;
    - it is a development or ad hoc profile whose device list does not name
      this UDID. Register the UDID at developer.apple.com, regenerate the
      profile, and build once from Xcode.`,
    },
    STIM_NO_SIGNING_IDENTITY: {
      summary: 'no single keychain identity resolves; ios.signingIdentitySha1 for two certificates',
      context: `A simulator build needs no signature, which is why none of these can fire on
the normal path. A device build carries one, and Stim re-seals any bundle it
modifies with the identity the bundle already names -- so it checks, before
spending a build or a bundle, that the check can succeed.`,
      body: () => `STIM_NO_SIGNING_IDENTITY
  No single keychain identity could be resolved to re-seal with. Either
  \`security find-identity -v -p codesigning\` lists nothing, or the identity
  the artifact's own profile names is absent, or two certificates share that
  common name and Stim -- being non-interactive -- will not pick one.
  Open Xcode > Settings > Accounts and download your certificates, or unlock
  the login keychain with \`security unlock-keychain\`. For the two-certificate
  case, set ios.signingIdentitySha1 to the SHA-1 hash beside the one you want.`,
    },
    STIM_CODESIGN_FAILED: {
      summary: 'codesign failed on the modified copy; the cache entry is untouched and the run builds fresh',
      context: `A simulator build needs no signature, which is why none of these can fire on
the normal path. A device build carries one, and Stim re-seals any bundle it
modifies with the identity the bundle already names -- so it checks, before
spending a build or a bundle, that the check can succeed.`,
      body: () => `STIM_CODESIGN_FAILED
  \`codesign --force --sign\` or \`codesign --verify --strict\` exited non-zero
  on the modified copy. The verbatim codesign stderr is quoted, because it is
  the answer: a locked login keychain reports errSecInternalComponent, an
  ambiguous identity reports that it matched more than one. Unlock the keychain
  and confirm exactly one identity matches the name. The cache entry itself is
  never modified -- the failure is on a temporary copy, and the run builds
  fresh.`,
    },
    STIM_NO_LAN_ADDRESS: {
      summary: 'the Mac has no non-internal IPv4 interface; a tunnel cannot help a phone',
      separator: '--- iOS DEVICE DEBUG REACHABILITY CODES (`ios --device` in Debug) ---',
      context: `A phone does not share the host's loopback and USB carries no reverse forward,
so a Debug run on one is wired to a LAN origin instead of localhost. Both codes
fire BEFORE the build, because a refusal that costs a build is a bad refusal.`,
      body: () => `STIM_NO_LAN_ADDRESS
  This Mac reports no non-internal IPv4 interface, so there is no address to
  give the phone: it is offline, or on nothing but utun/awdl/bridge. Join a
  Wi-Fi or Ethernet network, or connect this Mac by cable, and run again.
  Deliberately NOT "set metro.publicUrl": neither channel to a phone carries a
  URL. The dev-client deep link composes http://<host>:<port> itself, and
  ip.txt is read by RCTBundleURLProvider, which prefixes the scheme. A tunnel
  cannot be expressed to a phone, so --device ignores metro.publicUrl,
  metro.tunnel and metro.ngrokUrl and says so when one is set.`,
    },
    STIM_LAN_METRO_UNREACHABLE: {
      summary: "the LAN origin did not answer as this workspace's Metro; ios.lanHost on a multi-NIC Mac",
      context: `A phone does not share the host's loopback and USB carries no reverse forward,
so a Debug run on one is wired to a LAN origin instead of localhost. Both codes
fire BEFORE the build, because a refusal that costs a build is a bad refusal.`,
      body: () => `STIM_LAN_METRO_UNREACHABLE
  The chosen LAN origin did not answer as THIS workspace's Metro: no answer, a
  5xx, or a dev server that is not this one -- the message says which.
  \`stim start\` prints the port it reserved. On a Mac with several interfaces
  the first en* is not necessarily the one the phone shares: set ios.lanHost to
  the address it can reach (see \`guide settings\`).
  What this gate CANNOT prove is that the phone can reach the origin: macOS
  routes a host connection to its own address over loopback, so the gate passes
  through a firewall that will block the phone. That evidence only ever arrives
  from the phone's own bundle request, which is what \`launched\` reports.`,
    },
    unverified: {
      summary: 'launched: "unverified" with the Local Network path reason, and the routed recovery',
      context: `A phone does not share the host's loopback and USB carries no reverse forward,
so a Debug run on one is wired to a LAN origin instead of localhost. Both codes
fire BEFORE the build, because a refusal that costs a build is a bad refusal.`,
      body: () => `LAUNCH UNVERIFIED, LOCAL NETWORK NOT GRANTED (not a code -- a routed remedy)
  An app that has not been granted Local Network reaches nothing on the LAN,
  and CFNetwork reports each attempt as NSURLErrorDomain -1009 "The Internet
  connection appears to be offline." with the path reason

    _NSURLErrorNWPathKey=unsatisfied (Local network prohibited)

  THAT REASON IS THE WHOLE MATCH. The rest of the block -- POSIX error 50
  (ENETDOWN), \`failed to connect 1:50\`, \`error code: -1009 [1:50]\` -- is
  generic and says nothing about the permission: Wi-Fi turned off gives the
  identical errno with the reason \`unsatisfied (No network route)\`, and a
  cellular-only route gives \`unsatisfied (Denied over cellular interface)\`.
  Matching those would print this remedy at a phone that simply is not on the
  network, and would drop the same-SSID check that is the actual fix, so they
  are not matched.
  THE PROMPT AND A PRIOR DENIAL READ THE SAME. iOS emits this reason while the
  prompt is unanswered and after a Don't Allow, which persists across upgrade
  installs. The remedy covers both: if the first \`alert get\` finds no alert,
  it was denied earlier and the only fix is the switch under Settings > Privacy
  & Security > Local Network, which has no API.
  The reason is read out of THIS launch's device records -- since the launch,
  and from the app's pid when it is known. It is NOT origin-scoped: the record
  that carries the reason carries no URL (the failing URL lands in a
  continuation line with no process prefix, which the pid filter drops), so
  scoping to this workspace's Metro origin would never fire. That is sound
  anyway, because the permission gates every LAN connection the app makes, so
  even a third-party SDK's prohibited connection proves the app cannot reach
  this workspace's Metro either. Matching only picks the remedy: no record's
  level changes, so the device source stays out of \`logs --errors\`
  (\`guide logs\`: severity is never guessed on a phone).
  When it matches, \`launched: "unverified"\` leads with that evidence and with
  the recovery, in this order:

    agent-device alert get --platform ios --udid <udid>
    agent-device alert accept --platform ios --udid <udid>
    agent-device snapshot -i --platform ios --udid <udid>
    agent-device press 'label="Reload"' --platform ios --udid <udid>

  \`alert get\` reads the alert without opening anything, so it works while the
  app sits behind it. THE GRANT ALONE IS NOT ENOUGH: the dev client does not
  retry, and stays on "Failed to load app ... The Internet connection appears
  to be offline." with a Reload button, which is why the last two lines are
  there. The text form of the press target is \`label="Reload"\` (or
  \`text="Reload"\`); a bare \`press "Reload"\` is rejected. Stim's own launch
  ends in \`-- -EXDevMenuShowsAtLaunch 0 -EXDevMenuShowFloatingActionButton 0\`,
  so the Expo dev menu is not over the app, fresh install or not. An app started
  ANOTHER way does not carry those arguments and \`snapshot -i\` can show the
  menu instead: \`agent-device press 'label="Close"'\` dismisses it, then press
  Reload. See \`guide facts devmenu\`.

  A BARE APP (no expo-dev-client) gets the same first two commands and a
  different third. The prompt fires the same way, because it is fired by any
  LAN connection to the Metro host, and the path reason is CFNetwork's either
  way -- the classifier reads that reason alone and knows nothing about dev
  clients. What differs is the screen: a bare app is expected to show React
  Native's RedBox, "Could not connect to development server". Read the screen
  with \`agent-device snapshot -i\` and press Reload by the ref or label it
  reports; neither that text nor the button's accessibility label has been read
  off hardware.

  \`agent-device metro reload\` does NOT recover either screen. It only reaches
  an app already connected to Metro's websocket, and an app stopped by this
  permission never connected.

  Without agent-device,
  \`xcrun devicectl device process launch --device <udid> --terminate-existing
  [--payload-url '<devClientUrl>'] <bundleId>
  [-- -EXDevMenuShowsAtLaunch 0 -EXDevMenuShowFloatingActionButton 0]\`
  also recovers, and it costs the device log:
  it replaces the process the collector follows, so
  \`stim logs --source device\` stops for the rest of that run. For a dev
  client, pressing Reload is cheaper and keeps the collector alive. For a bare
  app the relaunch is the cleanest recovery, because it re-reads ip.txt. By
  hand it is two taps either way: Allow, then Reload.

  WHAT HAS ACTUALLY RUN: the dev-client path above was performed on a phone --
  the alert, the accept, the unchanged error screen, the Reload press, and the
  bundle that followed. The bare path has NOT been exercised on hardware; there
  is no provisioned bare project to run it on. Its signature and its remedy are
  reasoned from the same CFNetwork evidence and from React Native's own
  RedBox, not observed.

  THE OTHER ONE-TIME TAP HAS NO API. The developer-trust tap (Settings >
  General > VPN & Device Management) is refused to automation by the same gate
  that refuses the app, agent-device's own runner included, so its remedy is
  "ask the user" and nothing else. An uninstall clears both.`,
    },
    STIM_NO_DEVICE: {
      summary: 'no usable phone, or the owned simulator or emulator could not be created or booted',
      separator: '--- DEVICE AND CAPACITY CODES ---',
      body: () => `STIM_NO_DEVICE
  With \`--device\`, no physical device answered the selection: none connected,
  a named serial/UDID that is not connected, several connected with none named
  (the refusal lists them), or one that is connected but unusable -- an
  unauthorized Android device, or an iPhone that is unpaired or has Developer
  Mode off. Hardware is never created or booted, so there is nothing to retry
  into existence: fix the cable, the trust prompt, or Developer Mode.
  Otherwise the owned simulator/emulator could not be created or could not
  reach a booted state. \`stim doctor\` checks the toolchain; \`stim status\` says what
  Stim thinks it owns. Re-running the command creates a fresh owned device
  when the recorded one is gone.
  On iOS a slow first boot is waited out for up to ten minutes while the
  simulator still reports Booting -- a long silent wait on a loaded machine
  is patience, not a hang. The failure names the udid and the wait.
  On Android the emulator's own stdio is captured to
  the global workspace logs/emulator.log (truncated per boot), and when it printed a
  \`FATAL |\` / \`ERROR |\` / \`PANIC:\` line THAT is the message and the remedy
  you get -- the disk-space refusal ("Not enough space to create userdata
  partition") is the case this exists for. The generic toolchain remedy above
  is only what you see when neither the log nor the failure itself identifies
  the cause. An ENOSPC failure points at disk space instead: owned Android AVDs
  normally live under ~/.android/avd, and a booted AVD can use several GB. A
  boot whose emulator process exited is also reported at once rather than after
  the full cold-boot timeout.

"this project's sim is X, but --device-type asked for Y"
  The project already owns a simulator of a different model, and Stim will
  not silently boot a different one. Reap it (\`worktree remove\`, or
  \`gc --delete\`) and run \`stim ios\` again to create the requested model.
  That loses the old sim's app state.`,
    },
    STIM_DEVICE_BUSY: {
      summary: 'another workspace holds the lease on that phone and the wait ran out',
      body: () => `STIM_DEVICE_BUSY
  Only on a \`--device\` run. Another workspace holds the lease on that phone,
  and the wait ran out: the message names the holder root, the device, and the
  expiry as a clock time and a remaining duration, and \`--json\` adds
  \`lease: { platform, id, deviceName, holder, expiresAt }\`. In order, the
  remedies are: wait longer with \`--wait <seconds>\`, pick another device by
  id, or \`--no-wait\`, which installs with NO lease -- and when both
  workspaces build the same app id, that install terminates the app the holder
  is running. Two other cases refuse with this code and no wait at all: a lease
  file that does not parse (\`lease\` fields null, the file named -- nothing may
  take that device until it is dealt with), and this workspace's OWN lease with
  no token left in its \`state.json\` (its workspace directory was recreated).
  The remedy for that last one is \`stim device unlock\`, which releases by
  holder rather than by token.`,
    },
    STIM_DEVICE_LOST: {
      summary: 'the lease was gone or re-held at the pre-install check; rerun',
      body: () => `STIM_DEVICE_LOST
  Only on a \`--device\` run. The run held a lease, and the raise before the
  install found it gone or held under another token -- another workspace took
  the device in that window. The message names the new holder and its expiry.
  Run the command again; it waits for that lease under \`--wait <seconds>\`.
  AFTER the install has started this is not a failure: the app is already on
  the phone, so the run prints one warning, continues, and reports
  \`lease: null\` in \`--json\`.`,
    },
    STIM_AT_CAPACITY: {
      summary: 'concurrency.maxDevices reached; a refusal, not a queue',
      body: () => `STIM_AT_CAPACITY
  Only when concurrency.maxDevices is set (it is UNSET by default, so this never
  fires unless you opted in). Booting a NEW owned device would exceed the cap:
  the machine already has that many Stim-owned devices booted. It is a refusal, not
  a queue -- \`ios\`/\`android\` are interactive-shaped, so Stim does not make
  you wait at a prompt. The remedy is fixed: stop an environment
  (\`stim stop\`) to free a device, or raise concurrency.maxDevices. A
  workspace whose OWN device is already booted is never refused -- re-running
  \`ios\` on an environment you already have is idempotent. (The build cap
  behaves differently: a compile WAITS for a free slot rather than refusing.
  See \`guide lifecycle concurrency\`.)`,
    },
    STIM_BUILD_SLOT_TIMEOUT: {
      summary: 'the maxBuilds wait gave up with every slot held by a live pid',
      body: () => `STIM_BUILD_SLOT_TIMEOUT
  Only when concurrency.maxBuilds is set. The build cap does not refuse, it
  WAITS -- this code is that wait giving up: ~90 minutes elapsed and every one
  of the N slots was still held by a process that is still alive. A dead
  builder's slot is reclaimed within a poll, so this is never a slot leaked by
  a crash; it is either that many genuinely long compiles, or a slot directory
  whose owner is not really building. Slots live under ~/.stim/build-slots and
  the message names the directory: remove the slot of a builder that is not
  building, or raise concurrency.maxBuilds
  (\`guide lifecycle concurrency\`).`,
    },
    STIM_NO_REMOTE_SESSION: {
      summary: 'the backend could not use agent-device, or metro.tunnel names an unusable provider',
      separator: '--- REMOTE-DEVICE CODES (`ios --remote <proxy|eas>` / `android --remote <proxy|eas>`) ---',
      body: () => `STIM_NO_REMOTE_SESSION
  The selected backend could not use agent-device, or metro.tunnel names a
  provider or mode this workspace cannot use (e.g. "expo" on a bare RN
  project). The remedy line says which. Nothing was created yet.`,
    },
    STIM_REMOTE_PROXY_CONFIG: {
      summary: '--remote proxy needs AGENT_DEVICE_DAEMON_BASE_URL and AGENT_DEVICE_DAEMON_AUTH_TOKEN',
      body: () => `STIM_REMOTE_PROXY_CONFIG
  \`--remote proxy\` requires AGENT_DEVICE_DAEMON_BASE_URL and
  AGENT_DEVICE_DAEMON_AUTH_TOKEN. These variables provide credentials after
  proxy is selected. They never select the backend.`,
    },
    STIM_REMOTE_EAS_UNAVAILABLE: {
      summary: '--remote eas needs eas-cli',
      body: () => `STIM_REMOTE_EAS_UNAVAILABLE
  \`--remote eas\` requires eas-cli. Proxy environment variables do not change
  this selection and are not passed to EAS.`,
    },
    STIM_REMOTE_PLATFORM_MISMATCH: {
      summary: 'the recorded remote session belongs to the other platform; stop, then rerun',
      body: () => `STIM_REMOTE_PLATFORM_MISMATCH
  This workspace already has a recorded remote session, and it belongs to the
  OTHER platform ("Session <id> belongs to android, not ios"). A workspace
  holds one remote session, and Stim will not end the recorded one to make
  room -- it may be mid-run for whoever started it. Run \`stim stop\` for this
  workspace, then re-run with the platform you want. Nothing was created here.`,
    },
    STIM_REMOTE_SESSION_STATE: {
      summary: 'the EAS session was created but its state could not be recorded, so Stim stopped it',
      body: () => `STIM_REMOTE_SESSION_STATE
  The EAS session was created and is healthy, but recording it in this
  workspace's state failed (an unwritable STIM_HOME, a full disk). A session
  nothing references is a session nothing will ever stop, so Stim stopped the
  one it had just created and removed its ownership claim before reporting:
  this code means nothing is running and nothing is still billing. Repair the
  state storage the message names, then run the remote command again.`,
    },
    STIM_REMOTE_SESSION_CLEANUP: {
      summary: 'Stim could not prove an EAS session ended; eas simulator:stop --id',
      body: () => `STIM_REMOTE_SESSION_CLEANUP
  Stim tried to end an EAS session and could not PROVE it ended: \`eas
  simulator:stop\` failed, or its output did not confirm the stop, or the
  session stopped but its claim in the machine ledger could not be removed.
  This is a refusal rather than a note because a session that did not stop
  BILLS until its duration cap. The remedy names the exact command --
  \`eas simulator:stop --id <id>\` -- and for a ledger that outlived its
  session, the ledger path to repair. The same code covers a recorded session
  that could not be verified before replacement: inspect it, then \`stim stop\`.`,
    },
    STIM_REMOTE_METRO_WRONG: {
      summary: "the tunnel reaches a Metro that is not this workspace's",
      body: () => `STIM_REMOTE_METRO_WRONG
  The gate that proves a tunnel still reaches THIS workspace's Metro failed --
  before a session or a build, whether the tunnel is Expo's own, one Stim
  started (metro.tunnel: cloudflared/ngrok/auto), or a named metro.publicUrl.
  The usual cause: the tunnel was built for a port this workspace no longer
  holds (a stale one survived a \`stop\`/\`start\` that reserved a different
  port), and it now serves ANOTHER workspace's dev server -- healthy, and
  wrong. Re-run \`stim start\` (it prints the port it reserved) and, for a
  manual tunnel, rebuild it against that port.`,
    },
    STIM_REMOTE_METRO_UNREACHABLE: {
      summary: 'a remote start could not create its managed tunnel or tell the device where Metro is',
      body: () => `STIM_REMOTE_METRO_UNREACHABLE
  A remote start could not create its selected managed tunnel, or the device
  could not be told where Metro is. Follows the same remedy as
  STIM_NO_REMOTE_SESSION's tunnel guidance -- set metro.tunnel, or use
  metro.publicUrl for an existing endpoint.`,
    },
    STIM_RELOAD_AMBIGUOUS: {
      summary: 'both owned apps are live; name the platform',
      separator: '--- RELOAD CODES (`stim reload [ios|android]`) ---',
      body: () => `STIM_RELOAD_AMBIGUOUS
  Both owned apps are live. Name ios or android; Stim never guesses.`,
    },
    STIM_RELOAD_RELEASE: {
      summary: 'the live app has embedded JS; run a Debug build first',
      body: () => `STIM_RELOAD_RELEASE
  The live app was launched with embedded JavaScript. Run the platform command
  with a Debug configuration or variant first.`,
    },
    STIM_RELOAD_STOPPED: {
      summary: 'the recorded app is gone, its device is not live and owned, or the process could not be proven',
      aliases: ['STIM_RELOAD_UNOWNED', 'STIM_RELOAD_PROBE_FAILED'],
      body: () => `STIM_RELOAD_STOPPED / STIM_RELOAD_UNOWNED / STIM_RELOAD_PROBE_FAILED
  The recorded app is gone, its exact device is not live and owned by this
  workspace, or simctl/adb could not prove the process exists. No launch or
  device lifecycle action is taken; follow the printed platform-command or
  process-probe remedy.`,
    },
    STIM_RELOAD_FAILED: {
      summary: 'the deep link, broadcast, or Metro websocket reload failed; press Reload yourself',
      body: () => `STIM_RELOAD_FAILED
  The exact deep link, Android reload broadcast, or targeted Metro websocket
  failed. If bare iOS has not connected or Metro cannot identify one iOS peer,
  the remedy tells the agent to continue in its existing automation session on
  this workspace's exact simulator and press the Reload control. Stim does not
  take over automation sessions.`,
    },
    STIM_WORKTREE_REMOVAL_IN_PROGRESS: {
      summary: 'a managed remote start found worktree remove holding the lock; wait, then rerun',
      separator: '--- DEV-SERVER CODES (`stim start`) ---',
      body: () => `STIM_WORKTREE_REMOVAL_IN_PROGRESS
  A managed remote start found that \`stim worktree remove\` owns the
  worktree lock. The start did not register the project or create a tunnel.
  Wait for removal to finish, then run \`stim start --remote\` again.`,
    },
    STIM_REMOTE_START_REQUIRED: {
      summary: 'a running server cannot gain a remote tunnel; stop, then start --remote, or metro.publicUrl',
      body: () => `STIM_REMOTE_START_REQUIRED
  A healthy bare or Expo server was started without its required remote
  tunnel. A running server cannot gain that option. For a Stim supervisor,
  run \`stim stop\`, then \`stim start --remote\`. For an external server,
  configure metro.publicUrl or let Stim supervise the server.`,
    },
    STIM_BARE_DEPS: {
      summary: "the supervisor cannot host Metro from the project's node_modules; the @stim-cli/metro capture note",
      aliases: ['STIM_BARE_LOAD', 'STIM_BARE_API'],
      body: () => `STIM_BARE_DEPS / STIM_BARE_LOAD / STIM_BARE_API  (bare RN)
  The supervisor hosts Metro out of the PROJECT's node_modules, so metro,
  @react-native/dev-middleware and @react-native-community/cli-server-api must
  be installed there and must match the project's React Native. DEPS = not
  resolvable (install them), LOAD = installed but threw while loading,
  API = loaded but is not the API Stim expects (mismatched versions).

"@stim-cli/metro is not installed ... so bundler and client logs will not be
captured"  (in metro.ndjson, bare RN)
  The dev server is serving; only capture is missing, so \`logs\` would report
  a quiet timeline for a broken build. Install \`@stim-cli/metro\` as a
  devDependency of the project.`,
    },
    STIM_EXPO_BIN: {
      summary: 'node_modules/.bin/expo is missing; install dependencies',
      body: () => `STIM_EXPO_BIN  (Expo)
  node_modules/.bin/expo does not exist. Install the project's dependencies.`,
    },
    STIM_METRO_TIMEOUT: {
      summary: 'the supervisor is alive but Metro or the tunnel was not ready within the wait; --wait 180',
      body: () => `STIM_METRO_TIMEOUT
  "The dev server did not answer on port <n> within <s>s."
  The supervisor is alive, but Metro or its requested Expo tunnel is not ready.
  \`start\` has already
  printed the last lines of the global workspace logs/supervisor.log above this -- read
  them. A cold Metro on a large graph can genuinely need more than the default
  60s: re-run with \`--wait 180\`. Otherwise \`stim stop\`, then \`start\`.`,
    },
    STIM_SUPERVISOR_EXITED: {
      summary: 'the dev server failed outright; the quoted supervisor.log tail is the real error',
      body: () => `STIM_SUPERVISOR_EXITED
  "The supervisor exited (<code|signal>) before the dev server came up"
  The dev server failed outright, and the quoted evidence is the real error:
  the supervisor.log tail if it wrote one, plus this attempt's error records
  from the timeline (an expo child's config error -- a PluginError, a bad app
  config -- lands THERE, not in supervisor.log). \`stim logs --errors\` has
  the full records. Fix that and run \`start\` again; nothing is left running.`,
    },
    STIM_BAD_ARG: {
      summary: 'an argument, setting, directory, flavor, or device name refused before anything starts',
      aliases: ['STIM_NO_PROJECT'],
      body: () => `STIM_BAD_ARG / STIM_NO_PROJECT
  The command refused before doing anything: an unusable --wait value, a known
  setting with the wrong type ("Invalid <key> setting <value>. Expected <shape>."
  -- \`guide settings\` names the type each key takes), an invalid
  Metro tunnel setting, an invalid android.dataPartitionSizeGb value, an unsafe
  android.avdConfig key or fragment, a malformed ios.signingIdentity,
  ios.signingIdentitySha1 or ios.lanHost value, \`--device\` with an empty
  serial or UDID, \`--device\` together with \`--remote\`, a working directory
  with no package.json above it, or one whose nearest package.json does not
  parse or depends on neither react-native nor expo, so the directory is not
  an app (the refusal names that package.json and says which of the two it
  is; \`doctor\` reports the same directory as a finding), an
  android/app/build.gradle that declares product flavors with
  no variant selected (the refusal names the debug variants), or a
  \`--device-type\`, \`--runtime\` or \`--system-image\` name that is BLANK or
  is not installed on this machine. For the unknown-name case the installed
  names are printed in the message -- the versions \`xcrun simctl list
  runtimes\` reports, the models those runtimes can actually CREATE (not the
  whole \`simctl list devicetypes\` table, which also names watchOS, tvOS and
  visionOS models no iOS runtime offers), or the system images the SDK has --
  so the remedy is to re-run with one of them. An ios.deviceType, ios.runtime
  or android.systemImage setting is checked the same way, and the check applies
  even when this workspace ALREADY owns a device, so a name that could never
  create anything is caught rather than left to a later run.
  These errors are caught before the port is reserved and before any build or
  device work, so nothing was started. The one listing they need
  (\`simctl list runtimes\`, the SDK's system-images directory) runs only when
  a name was actually given, and a listing that fails is reported as
  STIM_NO_DEVICE naming the tool, never as a crash.`,
    },
    STIM_LOCK_REFUSED: {
      summary: 'a directory lock is held by a removal, which is never waited out',
      separator: '--- COORDINATION CODES (any command that shares a resource) ---',
      body: () => `STIM_LOCK_REFUSED
  A directory lock that serialises two commands over the same thing -- this
  workspace's managed tunnel, its managed remote worktree, the machine's EAS
  project ledger -- is held by a REMOVAL, and a removal is never waited out:
  what it protects will not exist when the lock frees. Nothing was created.
  The message names the lock and the purpose holding it (\`worktree removal\`,
  \`workspace removal\` -- both are \`stim worktree remove\`). Let it finish,
  then run the command again. \`start --remote\` reports this same case as
  STIM_WORKTREE_REMOVAL_IN_PROGRESS instead.`,
    },
    STIM_LOCK_TIMEOUT: {
      summary: 'a lock held by a live command past the wait; the config-lock timeout',
      body: () => `STIM_LOCK_TIMEOUT
  The same locks, held by an ordinary command that is still running, for
  longer than the wait -- 60s by default, 4 minutes for the remote-session and
  EAS project locks. A lock whose owner died is taken over automatically (pid
  liveness is checked every poll), so this means another Stim command really
  is working on this workspace: wait for it and retry. If nothing is running,
  the message names the lock directory and removing it is safe. This is not
  the config lock, which reports the message below.

"Timed out waiting for the Stim config lock at <path>"
  Every config write is serialised so parallel commands cannot lose each
  other's records. A lock older than 10s is taken over automatically, so this
  means a command really is holding it. If none is running, remove that
  directory.`,
    },
    teardown: {
      summary: 'stop refusing to kill a port or signal a supervisor, and a failed device teardown',
      separator: '--- TEARDOWN AND WORKSPACE REFUSALS ---',
      body: () => `"metro       refusing to kill port <n>: ... runs from <dir>, outside
<project>"  (stop)
  Stim will not kill a process it cannot attribute to you.
  \`stim stop --force\` kills it without proving whose it is -- ask the user
  first. That flag is reachable only when no supervisor is recorded for this
  workspace, and it never deletes anything.

"stop        refusing to signal supervisor pid <n>: ..."  (stop)
  The two records describing that supervisor disagree, or it records a port
  this project did not reserve. A pid is a number the OS reuses, so it is not
  signalled. The port reservation is KEPT -- it is the only handle a retry
  has. Check \`ps -p <n>\` and \`stim status\` before signalling by hand.

"supervisor pid <n> did not exit within 10s of SIGTERM"  (stop)
  Deliberately not escalated to SIGKILL: the supervisor may be mid-write on the
  very log files \`logs\` reads. The device is left alone and the port stays
  reserved. Re-run \`stop\`, or signal it yourself: kill -9 -<n> (note the
  minus -- it is a process group).

"Could not tear down the <platform> device: ..."
  The delete failed, so the ASSIGNMENT was kept and the command exited 1. That
  is deliberate: dropping the record would leave a device on the machine that
  nothing references and nothing will ever reap. Fix the cause and re-run.`,
    },
    remove: {
      summary: 'worktree remove refused a dirty tree: what it restores itself and what --force discards',
      body: () => `"Refusing to remove <path>: uncommitted changes / untracked files / commits
not on any remote"  (worktree remove)
  A native build rewrites tracked files, and Stim now RESTORES the one class
  it can prove is not work: when the only dirt left is \`pod install\` churn
  (\`<app>/ios/Podfile.lock\`, \`<app>/ios/*.xcodeproj/project.pbxproj\`,
  tracked and unstaged), \`worktree remove\` runs the checkout itself and says
  so per file -- those files die with the worktree either way, and a lockfile
  change anyone meant would have been committed. ONE other dirty path and the
  whole set is refused, churn included, so this never eats real work.
  When it does refuse, the refusal PRINTS THE DIRTY PATHS, and the restore
  command under it carries those same paths: run it as printed rather than
  reaching for --force.
  It is built from what git reported, so in a monorepo it names
  \`apps/<app>/ios/Podfile.lock\` rather than an \`ios/...\` example that would
  fail with "did not match any file(s) known to git".
  A setup script that rewrites tracked assets (brand icons, generated config)
  produces the same refusal, with the same treatment: restore the paths the
  refusal actually named.
  Use --force only when you genuinely intend to discard work; it deletes
  uncommitted and untracked files permanently.`,
    },
    STIM_WORKTREE_BRANCH_EXISTS: {
      summary: '--base with an existing worktree-<name> branch; which branches create keeps or rolls back',
      body: () => `STIM_WORKTREE_BRANCH_EXISTS  (worktree create)
  "Refusing to create <name>: the branch worktree-<name> already exists at
  <sha>, but --base <ref> resolves to <sha>" -- or, when the two agree,
  "which is where --base <ref> resolves right now".
  \`git worktree add\` attaches to an existing branch and ignores the base, so
  the worktree would not be based on what you asked for. --base IS THE
  REFUSAL'S TRIGGER: it is a correctness flag, so Stim refuses whenever it is
  passed and the branch already exists, INCLUDING the case where the branch
  happens to sit on the requested base -- that agreement is luck, not the
  guarantee asked for. Stim keeps branches it did not create and branches with
  unique commits. Either pick another name, or \`git branch -D
  worktree-<name>\` and retry. Without --base, attaching is still the
  behaviour: nothing was promised about the tip.
  A leftover branch is no longer the usual cause. When \`git worktree add -b\`
  fails AFTER git created the branch (a locked .git/config, a read-only
  parent), Stim deletes the branch it just made, so the retry branches from
  --base instead of attaching. It rolls back only a branch that create made,
  and it decides that from whether THIS run passed -b, not from re-reading the
  refs afterwards. So a branch that appears between the check and the add is
  KEPT: git answers "a branch named ... already exists", and that answer is
  proof this create did not make it. A branch that no longer matches the base
  sha captured before the add, or that is checked out anywhere, is KEPT too.
  Every keep names \`git branch -D\`.`,
    },
    carry: {
      summary: 'every carry line worktree create prints, and what each means',
      body: () => `"carry       carried <dir>/Pods does not match the <dir>/Podfile.lock on
disk here"  (worktree create)
  \`ios/Pods\` is gitignored, so --carry-ignored clones it; \`ios/Podfile.lock\`
  is tracked. The check compares the cloned
  \`Pods/Manifest.lock\` with the \`Podfile.lock\` that is on disk in the new
  worktree AFTER the uncommitted changes are carried -- the same file
  \`pod install\` and \`xcodebuild\` read -- so an uncommitted lockfile the
  clone was installed against does not trigger it. \`stim ios\` detects a real
  mismatch and runs \`pod install\` for you; the note is there so a build you
  run yourself does not fail in its LAST phase with
    error: The sandbox is not in sync with the Podfile.lock
  A patch that does not apply reports itself first ("Could not carry the
  source's uncommitted changes"); the branch lockfile then stands, and this
  note is about that lockfile.

"carry       warm source not carried: ... For the next worktree, use: stim
worktree create <name> --carry-ignored"  (worktree create)
  A plain create found installed dependencies, CocoaPods, or native build output
  in the source. The new worktree stays clean. Use the printed command for the
  next worktree to clone that warm state.

"carry       node_modules (APFS clone); no Pods; no native build output"
  One line names every useful warm category, carried or not, and the copy mode
  APFS gave the carried ones: a copy-on-write clone, or a full byte copy when
  the clone was unavailable.

"carry       no dependencies carried. Run ... before building."
  There was no node_modules to clone, or --carry-ignored was not passed. Run
  the printed package-manager command in the new worktree.

"carry       carried dependencies may be stale: they do not match ..."
  The lockfile that came with the cloned node_modules is not the lockfile this
  BRANCH has. Nothing else prints this: a carry whose lockfile matches is
  silent, so the line always means a real difference. Run the printed command.

"carry       carried 2 uncommitted changes from the source (...) --
uncommitted here too; commit deliberately"  (worktree create --carry-ignored)
  The source tree had uncommitted tracked changes, and the cloned artifacts
  were installed against that working tree -- so the same changes were applied
  to the new worktree as a patch, still uncommitted. Whether they belong in a
  commit is your call; the tool never commits for you.

"carry       could not carry the source's uncommitted changes (...)"
(worktree create --carry-ignored)
  The worktree's --base diverges from the source HEAD, so that patch does not
  apply and NOTHING was changed here. Until those changes are reconciled, this
  worktree fingerprints differently from the source and misses the cache
  entries the source fills.`,
    },
    environment: {
      summary: 'npx registry E401/E404, the Node floor, no free Metro port, the reservation race',
      separator: '--- ENVIRONMENT ---',
      body: () => `"npm error code E401 / E404" while \`npx\` resolves the stim-cli package
  The repo probably pins a private registry in \`.npmrc\`, so \`npx\` looked for
  the package there instead of on npm. Use the public registry for this command:

    npx --registry=https://registry.npmjs.org stim-cli <command>

  A line such as \`npm warn exec ... will be installed\` is normal when using
  the no-install form.

"Unsupported engine" or a syntax error before Stim starts
  Stim requires Node 20.19.4 or later on Node 20, or Node 22.12.0 or later.
  Switch Node versions, then run the command again.


"Found no free Metro port between ..."
  200 consecutive ports are claimed or occupied. \`stim status\` shows what
  Stim knows about; the rest is other software.

"Could not reserve a Metro port after 5 attempts"
  Several commands raced for the same ports and each one lost. Nothing is
  wrong; retry.`,
    },
    sandbox: {
      summary: 'running under a sandboxing harness: EPERM under STIM_HOME, CoreSimulatorService, adb',
      body: () => `RUNNING UNDER A SANDBOX

  An agent harness that sandboxes shell commands typically permits writes
  inside the project and blocks the rest. Three things Stim needs sit outside
  that boundary, and none of the failures names the sandbox:

    EPERM: operation not permitted, mkdir '<STIM_HOME>/workspaces/...'
      writes to STIM_HOME (~/.stim unless set)

    CoreSimulatorService connection became invalid   (macOS)
    Unable to locate device set: ... Code=61 "Connection refused"
      the simulator service simctl talks to over XPC

    ADB server didn't ACK
    could not install *smartsocket* listener: Operation not permitted
      the adb server socket on tcp:5037

  Measured on Claude Code and on Codex: the three fail the same way in both,
  so this is the shape of the problem, not one harness's quirk. Codex also
  blocks network egress by default, which breaks a cache lookup and a fetch.

  \`stim doctor\` names this when a write to STIM_HOME actually fails, not
  merely when a harness that can sandbox is present, and
  \`stim doctor --fix\` writes the three keys into .claude/settings.local.json,
  the per-user file, merging with what is there. It refuses under Codex, which
  has no per-path allowance to add, and refuses any settings file it cannot
  parse rather than replace it: comments make one unparseable here even though
  Claude Code accepts them. Claude Code reads project settings from the
  directory a session starts in, so in a monorepo the file has to sit at that
  root to count, and a file written inside a worktree goes when the worktree
  does.

  Two ways out, and choosing at the start of a session beats discovering it
  three failures in. Either run Stim with the harness's sandbox disabled, or
  allow the three. In Claude Code that is settings.json:

    sandbox.filesystem.allowWrite     ["~/.stim"]
    sandbox.network.allowMachLookup   ["com.apple.coresimulator.*"]
    sandbox.network.allowLocalBinding true

  In Codex the sandbox is one flag, \`codex -s\`, with no per-path allowance:
  workspace-write still refuses STIM_HOME.

  A git credential helper is often blocked too. It prints \`failed to store\`
  on a fetch that otherwise succeeded, and is safe to ignore.`,
    },
    STIM_CONFIG_CORRUPT: {
      summary: '~/.stim/config.json is not valid JSON and Stim never resets it',
      body: () => `STIM_CONFIG_CORRUPT  ("Stim config at <path> is not valid JSON")
  Any command can raise it: every command reads ~/.stim/config.json first.
  The file holding every owned-device record will not parse, and Stim never
  resets it for you -- a silent reset would orphan every simulator it names.
  Repair the file, or move it aside (\`mv <path> <path>.broken\`) and accept
  that the devices it recorded become orphans you delete by hand.`,
    },
  },
};

export default errors;
