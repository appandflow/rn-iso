export default {
  summary:
    'The --json payloads: `start`, `ios`, `android`, `reload`, `stop`, `status`, `doctor`, `device lock`/`unlock`, and the error contract',
  body: () => `FACTS CONTRACT

\`start\`, \`ios\`, \`android\`, \`reload\`, \`stop\`, \`status\`, \`stats\`, \`doctor\`,
and \`device lock\`/\`device unlock\` each print exactly ONE line of JSON on
stdout for \`--json\`. Every other line goes to stderr, so it is always safe
to pipe. \`logs --json\` is the one exception: it is NDJSON, one record per
line by design (see \`guide logs\`), not this single-payload contract.

  stim start --json

  port            the Metro port RESERVED for this workspace
  supervisorPid   the detached supervisor's pid, or NULL when a dev server was
                  already answering that Stim did not start
  mode            "bare-inproc" | "expo-child" | null (see \`guide metro\`)
  logsDir         where the NDJSON timeline is written
  alreadyRunning  true when nothing needed starting

  stim ios --json

  platform        "ios"
  udid            the owned simulator this workspace installed onto, or the
                  phone's UDID on \`--device\`. A physical device gets no
                  owned-device registry entry; its ID is stored in a temporary
                  lease. \`stop\` releases workspace leases and \`gc --delete\`
                  removes expired lease files
  deviceName      its name, or null
  deviceType      the owned simulator's MODEL, as
                  \`xcrun simctl list devicetypes\` names it ("iPad Pro 13-inch
                  (M4)"). Read from the simulator itself, so a run driven by
                  the ios.deviceType setting reports it too, not only a
                  \`--device-type\` run. Null on \`--device\` and on a
                  simulator Stim does not own
  runtime         that simulator's iOS runtime version ("18.5"), from the same
                  record. Null on the same paths as deviceType
  fingerprint     the @expo/fingerprint hash of the native inputs, AS STORED.
                  A run that had to \`expo prebuild\` or \`pod install\`
                  rewrote fingerprinted files while it worked (the generated
                  native directory, package.json's scripts, the app config,
                  Podfile.lock), so the hash it looked up is not the hash the
                  tree has afterwards. The artifact is stored under the hash
                  computed AFTER those steps -- the one the next run in this
                  tree computes -- and this field reports that one. The shift
                  is printed on stderr as one dim line naming both short
                  hashes. A prebuild shift is RE-LOOKED-UP before anything
                  compiles (\`cache
                  hit 6564e2.. (post-prebuild key)\`), so a cold tree -- a
                  fresh worktree or clone of a CNG app -- installs an entry
                  another workspace already built instead of compiling
                  beside it. Android also fingerprints after Gradle because
                  Gradle plugins can rewrite native inputs while they build;
                  its artifact is stored only under that post-build hash. A
                  stable second fingerprint prints no shift line. If the iOS
                  fingerprint after prebuild or pod install, or the Android
                  fingerprint after Gradle, cannot be computed, the build is
                  installed but not cached, and fingerprint and cacheKey are null
  configuration   the Xcode configuration that was built ("Release" from
                  --configuration or the ios.configuration setting); null for
                  the default Debug
  cacheKey        the shared-build-cache key derived from it (the
                  configuration is part of it: -release-sim vs -debug-sim)
  cacheHit        WHICH LEVEL answered, not a boolean:
                    "local"   this machine's shared cache (free, instant)
                    "remote"  the project's own Expo buildCacheProvider (a
                              download; it is copied into the local cache on
                              the way past, so the next workspace is "local")
                    false     nothing answered, so it was compiled
  webPreviewUrl   only on a remote device that has one (an EAS Simulator
                  session): a browser URL showing that device's screen. Absent
                  on a local device. Hand it to the human -- it is the only way
                  to see a device that is not on this machine. Never open it ON
                  the device; it is a page, not a deep link.
  cacheSkipped    true only when --no-build-cache was passed: "nothing was
                  looked up", which is a different fact from "nothing was found"
  compilationCache
                  Xcode compilation-cache activity for a compiled iOS app:
                    { status: "reported", hits, cacheableTasks, hitRatePercent }
                  status is "not-run" when the artifact cache supplied the app.
                  status is "unavailable" when Xcode did not print reliable
                  statistics. This field is separate from cacheHit
  waitedForBuild  { pid, ms } when ANOTHER workspace was already compiling this
                  exact fingerprint and this run waited for its artifact instead
                  of compiling a second copy
                  (see \`guide lifecycle concurrency\`); null when nothing was
                  waited for.
                  cacheHit is "local" either way -- the artifact did come from
                  the local cache -- so this is what separates "it was already
                  there" (free) from "it was there twelve minutes later" (still
                  cheaper than a second build). Both commands carry it
  appPath         the .app that was installed
  bundleId        the iOS bundle id that was launched
  installSkipped  true when the artifact was ALREADY on the device byte for
                  byte, so nothing was installed and the run went straight to
                  launch (see \`guide lifecycle builds\`). false means an
                  install ran.
                  Always false on \`--device\`: proving a phone already holds
                  the bundle would cost more than installing it
  launched        true, "bundling", or "unverified". THE THREE ARE DIFFERENT
                  FACTS and only the last one is a problem.
                    true         Metro finished the bundle, then the app stayed
                                 alive through a three-second stability window.
                                 The command checks process liveness when the
                                 platform exposes it. Errors from that window
                                 are printed even when the app stays alive,
                                 EXCEPT the device log's, which is COUNTED into
                                 one \`launch\` line instead (see
                                 \`guide logs\`). The agent decides whether a
                                 nonfatal error matters.
                                 IT IS NOT A PAINTED SCREEN. Stim observes the
                                 bundle and the process, never a frame, and a
                                 cold app can keep rendering for a minute or
                                 more after this, which is why the stderr line
                                 reads \`bundle loaded, process alive, stable
                                 for 3s -- the first screen may still be
                                 rendering\`. Poll the UI before you trust a
                                 screenshot
                    "bundling"   the request DID arrive and Metro was still
                                 building when the bundle timeout closed.
                                 The wiring is proven; the JS has simply not
                                 run yet (a cold bundle of ~10k modules takes
                                 longer than the window). Nothing to do --
                                 no remedy list is printed for it -- and
                                 \`logs --source metro\` shows the build
                                 finishing
                    "unverified" nothing was observed at all: usually a
                                 dev-client server picker awaiting a tap
                  EVERY DEV-CLIENT DEEP LINK CARRIES disableOnboarding=1
                  INSIDE ITS PROJECT URL
                  (\`...?url=http%3A%2F%2Fhost%3Aport%2F%3FdisableOnboarding%3D1&disableFab=1\`),
                  and expo-dev-launcher finishes its own dev-menu ONBOARDING
                  when it reads it. That is all the flag does: it sets
                  EXDevMenuIsOnboardingFinished. ON iOS it has to sit on the
                  PROJECT url -- the value of the \`url\` parameter -- because
                  that is the URL the launcher hands to the check; on the
                  outer deep link it does nothing there. Android reads it on
                  either.
                  ON A SIMULATOR, before a local dev-client openurl, Stim
                  preapproves CoreSimulatorBridge for exactly the installed
                  bundle id and discovered scheme on its owned simulator. That
                  suppresses iOS's first-launch confirmation;
                  unrelated schemes remain unapproved. It also writes
                  EXDevMenuShowsAtLaunch=false and
                  EXDevMenuShowFloatingActionButton=false, which the flag does
                  NOT cover, and those together are what keep the menu and its
                  button off a simulator entirely, so device automation opens
                  on the app. The
                  unverified warning therefore leads with the picker, then
                  prints the openurl
                  retry. ON LOCAL ANDROID the same deep link also carries the
                  \`EXDevMenuDisableAutoLaunch\` boolean intent extra, which
                  the launcher reads to set EXDevMenuShowsAtLaunch=false and
                  EXDevMenuIsOnboardingFinished=true. It stops the menu
                  opening automatically, but does NOT set expo-dev-menu's
                  showFab preference, so its floating Tools button can remain.
                  Remote Android opens only the URL, so that intent-extra
                  suppression does not apply there.
                  Every Stim deep link also carries an outer \`disableFab=1\`
                  query parameter. Versions with expo/expo#49651 use that as a
                  session-only override; earlier versions ignore it. Stim does
                  not rewrite expo-dev-menu's private SharedPreferences XML:
                  that internal file is not a supported API, and changing it
                  would persist over the user's own Tools-button setting. The
                  list leads with the supported launch command (\`am start -a
                  android.intent.action.VIEW -d '<devClientUrl>'
                  --ez EXDevMenuDisableAutoLaunch true\`).
                  ON A PHONE NONE OF THAT PREAPPROVAL APPLIES. The
                  preapproval and that write both go
                  through \`simctl spawn defaults write\`, and devicectl has
                  no defaults command; the one file route,
                  \`devicectl device copy to --domain-type appDataContainer\`
                  onto Library/Preferences/<bundleId>.plist with the app
                  terminated, copies successfully and then loses the seeded
                  keys, because cfprefsd serves its cached domain and rewrites
                  the file. THE FLAG ALONE DOES NOT COVER A PHONE:
                  EXDevMenuShowsAtLaunch defaults to TRUE on iOS
                  (DevMenuPreferences.setup), and DevMenuManager arms its
                  auto-launch observer when \`showsAtLaunch ||
                  shouldShowOnboarding()\`, so finishing onboarding clears
                  only the second half. THE LAUNCH ARGUMENTS COVER THE REST.
                  The device launch ends in
                  \`<bundleId> -- -EXDevMenuShowsAtLaunch 0
                  -EXDevMenuShowFloatingActionButton 0\`: devicectl passes
                  everything after \`--\` to the app, and NSUserDefaults reads
                  the argument domain AHEAD of the persisted one, so the menu
                  and its floating button are off for that launch and nothing
                  is written to the phone. So a fresh install comes up on the
                  app, not on the menu, and with no floating button.
                  THE FAB IS REAL ON A PHONE, and a screenshot is the only
                  way to see it: about four seconds after launch a blue gear
                  labelled Tools appears top-right over the app, the label
                  fades after roughly ten seconds, and the gear stays as a
                  translucent grey circle for the life of the app. It carries
                  no accessibility label after the fade, so
                  \`agent-device snapshot -i\` stops listing it. Measured
                  with the argument on: the corner is clean at 4s and at 12s.
                  Stim's own launch is the only one that
                  carries these: an app started ANOTHER way -- a home-screen
                  tap, a relaunch without the arguments -- still gets the
                  stored value, and on a fresh install that is the menu
                  (runtime version, Close, Reload, Go home) and the button.
                  \`agent-device press 'label="Close"'\` dismisses it -- or
                  \`snapshot -i\` and the ref. The onboarding key the flag
                  writes and the Local Network grant both survive an
                  UPGRADE install. Android's intent extra prevents the menu's
                  automatic launch; versions with expo/expo#49651 also honor
                  the session-only FAB flag in Stim's deep link.
                  The phone's unverified remedy is also ROUTED, not a fixed
                  list. When this launch's device records carry the Local
                  Network path reason, the remedy leads with that evidence and
                  with \`agent-device alert get\`, \`alert accept\`, then
                  \`snapshot -i\` and \`press 'label="Reload"'\` -- the grant
                  alone does not reload the dev client. Otherwise the network
                  list stays. Routing changes no record's level, so nothing new
                  reaches \`logs --errors\`. The OTHER first-launch tap,
                  developer trust, has no API at all and is always the user's.
                  \`guide errors\` has the signature and the full commands.
  metroPort       the port the app was wired to; NULL on a non-Debug
                  configuration, whose JS is embedded and which is launched
                  with no dev server at all. There, \`launched\` is verified
                  by the app process staying alive after launch (a bad
                  embedded bundle crashes within seconds), not by a bundle
                  request. A process that exits fails the command. An iOS
                  launch with no process id is "unverified", and
                  \`stim logs --errors\` has the device log that says why
  logs            { dir }
  durationMs      wall time for the whole run

  stim android --json

  platform        "android"
  serial          the owned emulator (always "emulator-<consolePort>")
  avdName         the AVD's NAME (stim-<label>). The serial is a slot --
                  emulator-5554 is whatever booted into that console port
                  first -- so this is what addresses the emulator in
                  \`emulator -avd\`, avdmanager, or a device tool. The console
                  port is CHOSEN AND RECORDED under the global config lock
                  BEFORE the emulator starts, then passed to it as \`-port\`,
                  so two workspaces booting at the same moment cannot land on
                  one serial. A boot that fails releases the port again and
                  keeps the AVD recorded for \`gc\`
  deviceName      the same name, matching the iOS payload's field
  systemImage     the sdkmanager package id the owned AVD was created from
                  ("system-images;android-36;google_apis;arm64-v8a"), read from
                  the AVD's own config.ini, so a run driven by the
                  android.systemImage setting reports it too, not only a
                  \`--system-image\` run. Null on \`--device\` and on an
                  emulator Stim does not own
  fingerprint / cacheKey / cacheHit / cacheSkipped / waitedForBuild /
  appPath / installSkipped / launched
                  as above -- cacheKey keys on the VARIANT here
                  (<fingerprint>-productionrelease-sim). A Debug artifact for
                  a proven target ABI also ends in that ABI
                  (<fingerprint>-debug-sim-arm64-v8a)
  variant         the gradle variant that was built ("productionDebug" from
                  --variant or the android.variant setting); null for the
                  default assembleDebug. A variant whose name ENDS IN Release
                  is a release build: its JS is embedded and no dev server is
                  used
  metroPort       the port the app was wired to; NULL on a release-shaped
                  variant, exactly as on a non-Debug iOS configuration.
                  There, \`launched\` is verified by the app PROCESS being
                  alive on the device a moment after launch (\`pidof\`, then
                  \`ps -A\`), not by a bundle request -- "unverified" means
                  no process was found fails the command, and
                  \`stim logs --errors\` has the device log that says why
  bundleId        the ANDROID PACKAGE NAME the launch, the port wiring and
                  the remedies all target -- read from the BUILT APK's
                  manifest, which on a flavored project is the flavor's
                  applicationId, not what the project files say
  debugHttpHost   "10.0.2.2:<port>" on an emulator, "localhost:<port>" on a
                  physical device, when the app's SharedPreferences were
                  pointed at this workspace's Metro; null when they were not.
                  A healthy run reverses only <port> -> <port>, which is what
                  that host resolves to. Only when the write fails does Stim
                  also reverse 8081 -> <port>, so the app's compiled-in
                  default still finds this workspace's Metro
  debugHttpHostNote
                  why the write did not land, when it did not. A launch
                  survives it -- this is the difference between the two
  devClientUrl    the expo-dev-client deep link that was opened, or null for
                  a plain launcher start. This is the command that puts the
                  app back on THIS workspace's bundle
  ccache          the Android C++ compilation cache, the counterpart of the
                  iOS compilationCache field:
                    { status: "reported", hits, misses, hitRatePercent }
                  status is "not-run" when the artifact cache supplied the
                  APK. status is "unavailable" when no C++ compile went
                  through ccache -- ccache absent from PATH, a project that
                  sets its own CMake compiler launcher, or a Gradle run whose
                  native work was all up to date. None of the three is an
                  error, and this field is separate from cacheHit
  logs            the workspace log directory
  durationMs      wall time for the whole run

  stim reload [ios|android] --json

  platform        "ios" | "android"
  deviceId        the exact owned simulator UDID or emulator serial reloaded
  deviceName      the owned simulator or AVD name
  appId           the live bundle id or Android package
  metroPort       the workspace's verified Metro port
  strategy        "deep-link" for Expo/dev-client, "android-broadcast" for
                  bare Android, or "metro-websocket" for an identifiable bare iOS peer

  stim stats --json

  { "version": 1,
    "project": { "key": "<path>", "ios": <bucket|null>,
                 "android": <bucket|null> } | null,
    "machine": { "ios": <bucket|null>, "android": <bucket|null> } }

  \`project\` is null outside a project; a platform with no run yet is null.
  A bucket carries runs, failed, hits, misses, coldRuns, coldRunMs, hitRuns,
  hitRunMs, timeSavedMs, firstRunAt and lastRunAt, plus lastColdBuildMs and
  lastPodsMs once the project has compiled or installed pods. Milliseconds are
  integers.

HOW A RUN IS COUNTED (\`stats\`)
  Every \`ios\` or \`android\` invocation that got as far as computing a
  cache key is one run, in this project's bucket and in the machine-wide one.
  The project key is the app's path IN THE MAIN WORKING TREE, so every
  worktree of a repository pools into one bucket and two apps in a monorepo
  do not. A run that ends through an error or an uncaught exception counts
  only as \`failed\`; \`launched: "unverified"\` or \`"bundling"\` is a
  success. Otherwise the run's own \`cacheHit\` decides: "local" or "remote"
  is a HIT, false is a MISS -- including a release run on a phone and a swap
  that fell back to a full build. A miss adds its \`durationMs\` to the cold
  runs; a hit adds it to the hit runs and credits \`timeSavedMs\` with this
  project's mean cold run BEFORE it, minus its own duration, floored at zero.
  A hit that WAITED for another workspace's build (\`waitedForBuild\`) counts
  as a hit and is credited nothing: the compile it skipped was paid for in the
  wait, and with no cold run recorded for this project and platform there is
  nothing to compare against, so it credits nothing either. The saved figure
  is therefore an ESTIMATE and is printed as one. Nothing per run is stored;
  the file is $STIM_HOME/stats.json (see \`guide lifecycle\`).

  A run also keeps the duration of its own two long phases in that bucket:
  the build phase of a miss that compiled (lastColdBuildMs) and the last
  \`pod install\` (lastPodsMs). The last value only, not a series. THAT IS
  WHERE THE HEARTBEAT ESTIMATE COMES FROM. A later run reads this project's
  bucket before it compiles, and prints:

    build       still compiling (1m00s of ~3m10s)
    pods        still installing (1m30s of ~1m40s)

  The \`~\` value is THIS PROJECT'S LAST COLD BUILD, or its last
  \`pod install\`, and never a mean: a project's build time drifts with its
  size, so the most recent run is the best single guess. Past the estimate
  the line reads \`(4m00s, usually ~3m10s)\`, because a slower machine is not
  a hang. A project with no record yet gets \`(1m00s)\`, the elapsed alone,
  and a warm run has no long phase to size. That read takes no lock and
  ignores what it cannot read, so nothing about statistics can change a
  run's outcome.

ON FAILURE
  \`start\`, \`ios\` and \`android\` all print the error contract instead,
  still one line on stdout, and exit 1:

    { "code": "STIM_NO_METRO", "message": "...", "remedy": "..." }

  Branch on \`code\`, never on the message text. \`guide errors\` enumerates
  every code.

RULES
  - Never hardcode or guess a udid/serial/port. Read them from the payload.
  - Pass them EXPLICITLY to every device tool you drive yourself
    (agent-device, xcrun simctl, adb -s, idb).
  - Never assume "booted" is your simulator. Other agents have theirs booted
    too.
  - Every device Stim creates or boots is one Stim created, named
    stim-<label> (<model> <runtime>) on iOS. The exceptions are
    \`android --device\` and
    \`ios --device\`, which use a connected physical device Stim never
    creates, boots, or deletes.`,
};
