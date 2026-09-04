import chalk from 'chalk';
import type { Command } from 'commander';
import { ANDROID_AVD_CONFIG_HELP } from '../settings.ts';

interface GuideTopic {
  summary: string;
  body: () => string;
}

const TOPICS: Record<string, GuideTopic> = {
  agent: {
    summary: 'The normal coding-agent workflow, safety rules, and topic routing',
    body: () => `AGENT WORKFLOW

Use Stim to run React Native and Expo apps without sharing a Metro port or
device with another workspace. Prefer plain output: it streams each phase and
ends with the facts the next step needs. Use --json only when a script must
parse a stable payload.

NORMAL WORKFLOW

Work in the current checkout by default. When the task needs another branch or
an isolated environment, create a worktree and carry its dependencies and
native outputs.

Before native worktree work, run doctor for the platform in scope. It checks
the main checkout from a linked worktree. Fix relevant findings and inspect the
upstream gap.

  stim doctor --platform ios          # or: --platform android

  # In the main checkout, seed the shared build caches when more native
  # worktrees are coming. Skip this for one-off or JavaScript-only work.
  stim start
  stim ios                             # or: stim android
  stim stop

  # Branches from HEAD. --carry-ignored carries installed dependencies and
  # native output. Pass it on the first creation, never on a retry. The command
  # prints the new absolute path.
  stim worktree create <name> --carry-ignored
  cd <printed-path>

  stim start
  stim ios                             # or: stim android
  stim logs --errors

  # JavaScript and TypeScript edits use Fast Refresh. If an error screen stays
  # after the edit, reload the running app through its reported Metro port.
  agent-device metro reload --metro-port <reported-port>
  stim logs --since 30s --level error

  stim stop
  stim worktree remove

RULES DURING THE LOOP

- Run start before a debug ios or android build. If it returns STIM_NO_METRO,
  run stim start and retry.
- Run ios or android again after a native input changes. A JavaScript-only
  change does not need one.
- If launch reports an app error but also says the native process is alive,
  the app did not crash. Fix JavaScript or TypeScript and use Fast Refresh; if
  the error screen remains, reload through the reported Metro port. Do not run
  ios or android again. If launch says FATAL because the app process exited,
  fix the crash and run the platform command again; Metro cannot restart it.
- A cold native build can outlive a shell timeout. Run the same command again:
  the second call joins the active build or returns its result.
- ios and android install the app, launch it, and check readiness. Trust the
  exact device, app, Metro, and launch facts in the final summary. Use the full
  reported device ID. Never assume a simulator named booted belongs to this
  workspace.
- After each ios or android run, give the user one compact result: exact device,
  app id, launch state, cache result, total duration, and whether stim logs
  --errors passed. Include a remedy only when action remains. Do not repeat the
  phase transcript.
- An OK summary with no launch qualifier proves the launch. "bundle requested,
  still building" means Metro has not finished; wait and query the logs. For
  launch UNVERIFIED, follow the printed remedy before claiming success. JSON
  reports these as true, "bundling", and "unverified" in launched.
- A clean logs --errors check requires exit code 0 AND no matching errors in
  captured logs. Exit code 0 alone means the query succeeded, even when errors
  were printed. Human output shows "No matching log records" on stderr for
  zero matches; JSON mode prints zero bytes. This does not prove launch or log
  capture succeeded. Do not read the NDJSON files directly.
- Use stim status when resuming a workspace or recovering missing device,
  port, server, or build facts. A normal start and platform run already print
  them. Use stim doctor when a build is unexpectedly slow or the environment
  looks incomplete.

OWNERSHIP AND DELETION

Stim creates, boots, and deletes only devices it created. Owned simulators use
the stim-<label> (<model> <runtime>) name. Never point Stim at a user-created
emulator or simulator.

worktree remove parks the workspace's simulator for later adoption. A parked
simulator is Stim-owned: never delete one by hand. gc --delete clears verified
entries and keeps failures; see guide lifecycle. First launch on a physical
iPhone can need the one-time taps named by the remedy.

stim android --device [serial] and stim ios --device [udid] install on a
connected physical device. Stim never creates, boots, or deletes hardware and
records nothing about it, so stop and gc leave it alone.

A --device run leases that device for the run. stim device lock ios --for 10m
holds it across runs; stim device unlock gives it back. Never delete another
workspace's lease file under ~/.stim/device-locks; gc --delete removes expired
ones.

Treat a refusal as an ownership or state mismatch: read its code and remedy.
Never reach for --force first.

Ask the user before these actions:

- worktree remove, because it deletes the worktree, its Stim-created branch
  when it has no unique commits, and gives up its owned device.
- worktree remove --force, because it also discards uncommitted and untracked
  files.
- gc --delete, because it deletes orphaned resources. gc --delete --cache all
  empties the shared build caches instead; it inspects nothing else.
- stop when the workspace owns an EAS session, because it irreversibly ends
  that remote session. For a local device, stop shuts it down but does not
  delete it. An explicit stop shuts down a Stim-owned simulator even when
  another process uses it. It never shuts down an unowned simulator.

SANDBOXES

An agent harness that sandboxes shell commands usually permits writes inside
the project and little else. Stim also needs writes to STIM_HOME (~/.stim by
default), simulator service access, and local access to the adb server. When
those sit outside the harness allowlist, the failure looks like an unwritable
directory or unavailable device service rather than a broken machine. Decide
at the start of a session whether to run Stim outside the sandbox or ask the
user to allow those operations. guide errors lists the exact requirements.

LOAD ADVANCED GUIDANCE WHEN NEEDED

  stim guide             # list topics
  stim guide lifecycle   # full flow, flags, worktrees, builds, and capacity
  stim guide facts       # JSON payload fields
  stim guide metro       # supervisor, custom Metro, tunnels, and remote devices
  stim guide logs        # filters, record shape, and capture limits
  stim guide errors      # error codes and remedies
  stim guide cleanup     # destructive behavior and disk cleanup
  stim guide settings    # configuration files and supported keys

Read the relevant topic before release configurations or Android variants;
remote devices; custom Metro processes or tunnels; cache misses, bypasses, or
concurrent builds; capacity limits; cache statistics from stim stats; worktree
carry-over; fingerprint exclusions; gc; --force; cleanup failures; or
unfamiliar states and error codes. Ordinary stim stop and an authorized clean
stim worktree remove do not need the cleanup guide.`,
  },
  facts: {
    summary:
      'The --json payloads: `start`, `ios`, `android`, `stop`, `status`, `doctor`, `device lock`/`unlock`, and the error contract',
    body: () => `FACTS CONTRACT

\`start\`, \`ios\`, \`android\`, \`stop\`, \`status\`, \`stats\`, \`doctor\`,
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
                  phone's UDID on \`--device\` -- reported, never recorded: a
                  physical device gets no config entry, so \`stop\` and \`gc\`
                  never see it
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
                  stable second fingerprint prints no shift line. If that
                  fingerprint cannot be computed, the build is installed but
                  not cached, and fingerprint and cacheKey are null
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
                  of compiling a second copy (see \`guide lifecycle\`, "one
                  compile per fingerprint"); null when nothing was waited for.
                  cacheHit is "local" either way -- the artifact did come from
                  the local cache -- so this is what separates "it was already
                  there" (free) from "it was there twelve minutes later" (still
                  cheaper than a second build). Both commands carry it
  appPath         the .app that was installed
  bundleId        the iOS bundle id that was launched
  installSkipped  true when the artifact was ALREADY on the device byte for
                  byte, so nothing was installed and the run went straight to
                  launch (see \`guide lifecycle\`). false means an install ran.
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
                  (<fingerprint>-productionrelease-sim) the way the iOS one
                  keys on the configuration
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
  logs            the workspace log directory
  durationMs      wall time for the whole run

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
  },

  metro: {
    summary: 'The dev server: `stim start`, the supervisor, and starting your own',
    body: () => `THE DEV SERVER

  stim start
  stim start --remote   # prepare Metro for a remote device

Reserves (or reuses) this workspace's Metro port, starts the dev server under a
detached SUPERVISOR, and waits until it both answers AND verifies as this
project's before exiting. You get your shell back with a bundler running: no
backgrounding idiom, no sleep, no poll loop, and no chance of building against
another worktree's bundler.

  --json            one line of facts on stdout, everything else on stderr:
                      { port, supervisorPid, mode, logsDir, alreadyRunning }
  --wait <seconds>  how long to wait for server and remote tunnel readiness
                    (default 60 for each)
  --remote          expose Metro for a remote device

Plain \`stim start\` is local and does not create a public tunnel. Remote intent
comes from \`start --remote\`, \`ios.remote\`, or \`android.remote\`. The
\`metro.tunnel\` setting selects the provider after remote intent exists.

REMOTE DEVICE BACKENDS
  Metro exposure and device selection are separate:

    stim start --remote          prepare public Metro
    stim ios --remote proxy      use an agent-device daemon
    stim android --remote eas    create an EAS Simulator session

  The command or the matching ios.remote/android.remote setting selects the
  backend. Environment variables never select the backend.

  The proxy backend connects to an agent-device daemon on another machine. It
  requires AGENT_DEVICE_DAEMON_BASE_URL and
  AGENT_DEVICE_DAEMON_AUTH_TOKEN. Stim creates no remote session for it.

  The EAS backend needs eas-cli and an account with EAS Simulator access. An
  EAS session is billable. EAS does not inherit the proxy credentials. Always
  tear the session down: \`stop\`, \`worktree remove\`, and \`gc --delete\`
  can end sessions that Stim proves it owns.

IDEMPOTENT
  A healthy dev server on the reserved port is a no-op: \`start\` prints the
  facts with alreadyRunning: true and starts nothing. A foreign process holding
  the reserved port moves the RESERVATION instead, so the project is never
  stranded on a port it can never use.

WHAT THE SUPERVISOR IS
  One detached process per workspace. There is no machine-wide daemon, nothing
  to install, and no cross-project state. It hosts the dev server, writes its
  output as NDJSON into the global workspace logs directory
  ($STIM_HOME/workspaces/<project>--<digest>/logs; see \`guide logs\`), and
  records itself in that workspace's state.json before it starts serving. Two modes,
  chosen by ecosystem detection:

    bare-inproc  bare React Native: Metro is hosted INSIDE the supervisor,
                 from the project's own node_modules, with Stim's reporter
                 attached. Bundler events, in-app console logs and redboxes
                 all arrive structured.
    expo-child   Expo: the project's own \`expo start --port <port>\` runs as
                 a child and its stdout is parsed into records. Levels are
                 INFERRED from each line, so those records carry raw: true.

  In expo-child mode, remote intent plus metro.tunnel "expo" makes \`start\` pass
  \`--tunnel\` and EXPO_UNSTABLE_TUNNEL_V2=1 (the legacy ws-tunnel path is
  locked to port 8081, which every reserved port but the first collides with)
  and records the URL Expo reports under state.json's metroTunnel. This has to
  happen here: \`ios --remote <proxy|eas>\` / \`android --remote <proxy|eas>\`
  cannot add \`--tunnel\` to
  an already-running dev server. A later \`start --remote\` refuses with a
  stop-and-restart remedy when a healthy local Expo supervisor has no recorded
  Expo tunnel. See \`guide settings\` for metro.tunnel.

  \`stim status\` reports the pid, the mode, and whether it is answering.
  \`stim stop\` is the inverse of \`start\`: it halts the supervisor, reaps
  the device-log collectors, shuts the owned device down (never deletes it)
  and frees the port.

  ENVIRONMENT: the supervisor -- and through it the dev server, including a
  metro.config.js evaluated inside the expo child -- inherits the environment
  of the \`start\` call that SPAWNED it. A later \`start\` that finds a healthy
  supervisor is a no-op and cannot change a running supervisor's env: to apply
  a new env var, \`stop\` first, then \`start\` with it set.

  The supervisor's own stdio goes to the global workspace logs/supervisor.log, which is NOT
  part of the NDJSON timeline. It is what a supervisor that died before it
  could write a structured record leaves behind. In expo-child mode the child's
  output is parsed into the TIMELINE instead, so a dev server that dies on a
  config error leaves supervisor.log empty and its death cry in metro.ndjson.
  A failed \`start\` quotes both for you: the supervisor.log tail when it has
  one, and this attempt's error records from the timeline.

STARTING YOUR OWN BUNDLER STILL WORKS
  A dev server YOU started is detected and left alone: \`start\` reports it
  with supervisorPid: null and mode: null, exits 0, and starts nothing over it.
  Starting a second bundler on a working one is the actual failure. For
  \`start --remote\`, an external Expo server also needs metro.publicUrl because
  Stim cannot add Expo tunnel mode to a process it does not supervise.

  Start it from INSIDE the project directory, on the reserved port, or nothing
  can attribute it to you:

    Expo                      npx expo start --port <port>
    Bare React Native         npx react-native start --port <port>
    Has its own start script  run it and append --port <port>; it may carry
                              flags that matter (e.g. --client-logs)
    Monorepo                  run from the APP directory, not the repo root

  The reserved port comes from \`stim status\` or from a previous
  \`start --json\`. Then \`stim ios\` accepts it: its Metro gate checks that
  the process on the port answers /status AND runs from inside this project,
  and yours does.

  The cost is logs. Stim captures only a dev server it hosted, so
  \`stim logs\` stays empty -- which is indistinguishable from a clean run --
  and finding output is back to redirecting it to a file yourself. Prefer
  \`start\`.

  The same identity check governs teardown: started elsewhere, \`stop\` refuses
  to kill it without \`--force\`.`,
  },

  logs: {
    summary: 'Querying the merged NDJSON timeline, and what --errors means',
    body: () => `LOGS

  stim logs [filters]

Reads every *.ndjson file in the global workspace logs directory, merges them into one timeline
ordered by timestamp, prints what matches, and EXITS. The file set is
discovered, not enumerated.

EXIT 0 MEANS THE QUERY SUCCEEDED, whether or not records matched. A clean
\`stim logs --errors\` check requires exit code 0 AND no matching errors in
captured logs. An empty result does not prove launch or log capture succeeded;
a workspace with no log directory also returns an empty result.

For zero matches: STDOUT IS EMPTY, exit code 0, and
one dim note on STDERR reading \`No matching log records in <logs dir>\`
(human mode only -- \`--json\` prints nothing at all, on either stream).
The only exit-1 paths are a malformed query and no project.

FLAGS
  --source <s...>  metro, client, device, build (one or more), or all. An
                   unknown value is REJECTED rather than quietly matching
                   nothing.
  --level <l>      minimum level: debug, info, warn, error, fatal
  --since <d>      only records newer than this: 30s, 5m, 2h
  --grep <re>      only records whose msg matches this regular expression
  --tail <n>       only the last n MATCHING records (applied after filtering,
                   so --level error --tail 5 is the last five ERRORS)
  --errors         errors and fatals since the last marker, from metro, client
                   and build -- the agent query. Capped at 20 printed records.
  --follow         keep streaming until interrupted (Ctrl+C is exit 0)
  --json           the raw records, one per line, so stdout is valid NDJSON.
                   ZERO matches is ZERO bytes on stdout (an empty NDJSON
                   stream), exit 0 -- parse stdout line by line, never as one
                   JSON document. The "No matching log records" note is human
                   mode only, on stderr.

--ERRORS, PRECISELY
  Level error or fatal, from metro, client and build, timestamped after the
  marker that closes their window. Three rules, and a field test
  caught all three wrong at once -- it returned 3,004 iOS syslog lines on a
  healthy app while hiding a real startup crash.

  SCOPE. device is NOT in the default scope. A device log is the OS talking:
  \`simctl log stream\` is predicated on the app's PROCESS, and inside that
  process Apple's frameworks log thousands of Error-typed lines (nw_socket,
  SecTrust, WebKit, CoreUI) that have nothing to do with your app. The proven
  ones are demoted to info by the collector; the scope rule covers the rest.
  The metro stream carries exactly one demotion of its own, and it is Stim's
  doing: the dev-client deep link \`ios\`/\`android\` open to wire the app to
  your port arrives inside the app as a link, and React Navigation logs at
  error that no navigator handled a NAVIGATE to \`expo-development-client\`.
  There is no such screen and there is not meant to be, so that one record is
  recorded at info -- it made every healthy cold launch report 1 error. A real
  unhandled NAVIGATE names a route your app has, and is still an error.
  The app's own crashes reach client and metro either way. Opt back in with
  \`--source device\` or \`--source all\`; a plain \`logs\` with no --errors
  has always shown everything. ON A PHYSICAL IPHONE opting back in buys less
  than it does on a simulator: the device console carries no severity, so
  \`--source device --errors\` there reports crash and refusal lines only,
  never a level. Read a phone's device records with a plain \`logs
  --source device\`.

  THE WINDOW. A marker closes the window for the sources it can speak for:
    a BUNDLE marker (src metro: bundle_build_done / bundle_build_failed, or
      Expo's "Bundled" / "Bundling failed" lines) is written when a bundle
      attempt FINISHES, success or failure. It resets METRO errors from
      before the attempt -- a resolve failure you fixed and rebuilt is
      history, and when bundles fail back to back only the newest attempt's
      errors are reported -- and nothing else. A failed attempt's own summary
      and details land at or after its marker, so they stay reported.
    a LAUNCH marker (src build, written by \`ios\` / \`android\`) resets
      EVERYTHING: a new run of the app starts there.
  A finished bundle is not evidence that the app which loaded it is fine.
  In the field case the app threw at 16:03:54 and Metro wrote its marker at
  16:03:55, one second later, because the bundler finishes accounting for a
  build after the client has already evaluated it. Under one marker for all
  sources that crash was reported as nothing at all. The cost of the rule is
  the safe direction: a client redbox that Fast Refresh already fixed keeps
  being reported until the next launch.

  OUTPUT. --errors prints at most 20 error records, plus any stack context, and
  then a "... and N more" line. N is exactly what \`--tail N\` prints, because
  what was held back IS the tail. In non-follow human output, an Expo error includes its immediately
  following code frame and Call Stack lines. Bare React Native symbolication is
  shown as separate context because Metro does not provide an error correlation
  identifier. Context does not change the error count or the raw error records
  returned by --json. --json is never capped, and neither is an explicit --tail.

  In --follow mode the marker window is dropped -- every error arriving from
  then on is by definition after the last marker seen.

  \`stim status\` reports the same count per workspace, as
  logs.errorsSinceMarker: the same query, the same scope, so the two can never
  disagree about whether this workspace is failing.

THE RECORD
  { ts, src, level, msg } always. ts is epoch milliseconds; src is one of
  metro / client / device / build; level is one of the five above.
  Optional fields:
    event    the producer's own event name (bundle_build_done, client_log, ...)
    stack    frames of { file, line, column, fn }, passed through as reported
    marker   true on the records that close an error window
    raw      true when the level was inferred from a line of text rather than
             reported by the producer (every expo-child record)

WHAT WRITES WHAT
  metro.ndjson         the bundler, in both supervisor modes
  client.ndjson        in-app console logs and redboxes -- BARE PROJECTS ONLY.
                       In expo-child mode everything Expo prints lands in
                       metro.ndjson with raw: true, so \`--source client\`
                       returns nothing there.
  device.ndjson        the device-log collector \`ios\` / \`android\` attaches
                       after launch: \`simctl log stream\` predicated on the
                       app, or \`adb logcat\` filtered to the app's pid. This
                       is where a native crash that never reached JS shows up
                       -- and, on iOS, where every Apple framework running in
                       the app's process also logs. The proven noise sources
                       are recorded at info rather than error; the rest is why
                       --errors leaves this source out unless asked. A VERIFIED
                       LAUNCH prints NONE of these records one by one. It counts
                       them and prints one line instead:

                         launch      9 error-level records in the device log
                                     during launch
                                     (logs --errors --source device)

                       THE COUNT IS NOT ATTRIBUTED TO ANYTHING, and that is the
                       point. Both collectors already narrow the stream to the
                       app: the simulator's \`log stream\` runs under a
                       processImagePath predicate, and \`adb logcat\` is filtered
                       to the app's pid. So every record left is MEANT to be
                       inside the app's own process, and the error-level ones
                       are the Apple frameworks running there -- "Failed to send
                       CA Event for app launch measurements", "NSBundle (null)
                       initWithPath failed", the TCP refusal. Nothing about the
                       record says which of them wrote it, so the run does not
                       guess; a count plus the command that shows the records is
                       the honest report. The iOS predicate matches on a
                       substring of the process path today, which a short app
                       name can widen past the app -- appandflow/stim#264
                       anchors it. Until it lands, read the records rather than
                       trusting the count to be the app's alone. The app's OWN errors are not in this
                       number: a redbox or a console.error arrives on the client
                       or metro source and still prints line by line.

                       The connection refusal \`TCP Conn ... Failed :
                       error 0:61 [61]\` (61 is ECONNREFUSED) is not even
                       counted. The app got its bundle over this workspace's
                       Metro and outlived the stability window, so it
                       recovered. A refusal before the
                       launch verifies still prints, as does every record on a
                       launch that does not verify, and the record stays an
                       error in device.ndjson either way; read it with
                       \`logs --errors --source device\`.

  ON A PHYSICAL IPHONE THE SAME FILE CARRIES LESS, and the difference is not
  cosmetic. \`simctl spawn\` is simulator-only and there is no devicectl
  console subcommand, so a device run reads
  \`devicectl device process launch --console\`, which connects the app's own
  stdout and stderr and nothing else. Stim launches it with
  OS_ACTIVITY_DT_MODE, which makes os_log mirror itself onto that stderr --
  without it React Native's own logging, which goes through os_log, would not
  appear at all. What the mirror carries, and what it drops:

    ts        KEPT   the device's own timestamp, off the mirrored line
    proc      KEPT   as name(pid), from the mirrored line, not a path
    category  KEPT   only when the logger has a subsystem; \`javascript\` and
                     \`native\` for React Native's own log calls
    msg       KEPT   a multi-line message arrives as separate records
    subsystem LOST   the mirror never prints it
    level     LOST   Default, Error and Fault all render identically, and
                     Debug is not mirrored at all

  So every device record from a phone is \`raw: true\` and \`info\`, except
  the lines that OPEN with a marker the runtime itself prints: an uncaught
  ObjC exception, a libc++abi termination, an assertion failure, or a Swift
  fatal error. The match is anchored, so an app logging ABOUT a crash stays
  info. devicectl's own \`ERROR:\` is read only on a line with no mirror
  prefix, because that is the only kind devicectl writes. Severity cannot be
  recovered, so it is not guessed. The NOISE_RULES that demote Apple's framework chatter key on
  subsystem and cannot fire either -- but they have less to do, because
  --console carries only the app's streams rather than every framework
  logging inside its process.

  \`log collect --device-udid\` WOULD carry all six fields, in the same NDJSON
  the simulator path parses. It is not used because it requires root
  (\`log: Must be root to collect logs from attached device\`) and produces an
  archive rather than a stream. Streaming with full fidelity needs
  libimobiledevice or pymobiledevice3, which are third-party installs Stim
  does not require. See appandflow/stim#179.
  build-ios.ndjson     the xcodebuild / gradle transcript at level debug, the
  build-android.ndjson extracted diagnostics at level error, and the launch as
                       a marker record. One RUN's worth: each build starts the
                       file over, so the first error in it always belongs to
                       the run that pointed you at it.

  Only a dev server Stim hosted is captured. If you started the bundler
  yourself, the metro and client sources stay empty -- which is not a sign of a
  clean build. The device and build sources are written either way, because
  \`ios\` / \`android\` produce them.

  A collector is killed and replaced on the next \`ios\` / \`android\` run for
  that platform, and reaped by \`stop\`.`,
  },

  errors: {
    summary: 'Every refusal Stim can print, and what to do about it',
    body: () => `WHAT STIM REFUSES, AND WHY

Every refusal from \`ios\` / \`android\` carries a stable CODE. Branch on the
code, never on the message.

--- BUILD-PATH CODES (\`stim ios\` / \`stim android\`) ---

STIM_WORKSPACE_STATE / STIM_WORKSPACE_COLLISION
  Stim could not prepare this project's global workspace directory under
  $STIM_HOME/workspaces. Check that STIM_HOME is writable and has free
  space. An EPERM on a directory the user CAN write is a sandbox, not a
  permission bit -- see RUNNING UNDER A SANDBOX below. COLLISION means the
  readable-name-plus-digest directory already has a workspace.json for a
  different canonical project path; do not overwrite it until you identify
  which workspace owns it.

STIM_NO_METRO
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

STIM_NO_FINGERPRINT
  \`@expo/fingerprint\` produced no hash, so the shared build cache cannot be
  addressed. Stim uses its declared @expo/fingerprint dependency directly,
  independently of the target project's package graph. This is a refusal
  rather than a silent full build because an unaddressable cache means every
  workspace on the commit compiles from scratch, forever.

STIM_PREBUILD_FAILED
  \`expo prebuild\` could not generate the missing native directory. The
  extracted output is above the code; the transcript is in
  the global workspace logs/build-<platform>.ndjson file.

STIM_DEPS_FAILED
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
  note naming which of the two set it; Gemfile.lock is never edited either way.

STIM_BUILD_FAILED
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

FALLBACK NOTES THAT ARE NOT CODES (release cache hits)
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
  would produce the same app and refuse again.

STIM_BUILD_WAIT_TIMEOUT
  This run was waiting for ANOTHER workspace's build of the same fingerprint
  (see \`guide lifecycle\`), and after ~90 minutes that process was still alive
  and had still produced nothing. A wait is normally bounded by the builder
  being alive at all -- a crash or a kill frees it within a second -- so this
  means a genuinely wedged xcodebuild/gradle, not a slow one. The message names
  the pid and the lock directory: check the pid, and if it is not really
  building, remove that directory and run the command again.

STIM_INSTALL_FAILED
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
  that is a cache hit: one install, no build.

STIM_LAUNCH_FAILED
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
  signer-conflict retry performs.

STIM_NO_SCHEME
  No buildable Xcode scheme was found in ios/. A scheme has to be shared to be
  visible to xcodebuild.

--- iOS SIGNING CODES (\`ios --device\`, and only there) ---

A simulator build needs no signature, which is why none of these can fire on
the normal path. A device build carries one, and Stim re-seals any bundle it
modifies with the identity the bundle already names -- so it checks, before
spending a build or a bundle, that the check can succeed.

STIM_NO_PROFILE
  The built or cached .app has no embedded.mobileprovision, or
  \`security cms -D\` could not decode the one it has. The first means the build
  produced an unsigned app -- almost always a simulator-sliced artifact.
  Set a team and a Development profile for the target's configuration in
  Xcode > Signing & Capabilities, then BUILD ONCE FROM XCODE to install the
  profile. Stim will not do that step: registering a device or minting a
  profile changes your Apple Developer account, so Stim never passes
  -allowProvisioningUpdates.

STIM_PROFILE_MISMATCH
  The profile inside the app cannot admit this phone. Three shapes, and the
  message names which one and the profile type it found:
    - it expired, or carries no ExpirationDate at all;
    - it is an App Store or enterprise profile, which carries no
      ProvisionedDevices list -- so Stim cannot PROVE the phone is admitted and
      refuses rather than guessing. Local device runs need a development
      profile;
    - it is a development or ad hoc profile whose device list does not name
      this UDID. Register the UDID at developer.apple.com, regenerate the
      profile, and build once from Xcode.

STIM_NO_SIGNING_IDENTITY
  No single keychain identity could be resolved to re-seal with. Either
  \`security find-identity -v -p codesigning\` lists nothing, or the identity
  the artifact's own profile names is absent, or two certificates share that
  common name and Stim -- being non-interactive -- will not pick one.
  Open Xcode > Settings > Accounts and download your certificates, or unlock
  the login keychain with \`security unlock-keychain\`. For the two-certificate
  case, set ios.signingIdentitySha1 to the SHA-1 hash beside the one you want.

STIM_CODESIGN_FAILED
  \`codesign --force --sign\` or \`codesign --verify --strict\` exited non-zero
  on the modified copy. The verbatim codesign stderr is quoted, because it is
  the answer: a locked login keychain reports errSecInternalComponent, an
  ambiguous identity reports that it matched more than one. Unlock the keychain
  and confirm exactly one identity matches the name. The cache entry itself is
  never modified -- the failure is on a temporary copy, and the run builds
  fresh.

--- iOS DEVICE DEBUG REACHABILITY CODES (\`ios --device\` in Debug) ---

A phone does not share the host's loopback and USB carries no reverse forward,
so a Debug run on one is wired to a LAN origin instead of localhost. Both codes
fire BEFORE the build, because a refusal that costs a build is a bad refusal.

STIM_NO_LAN_ADDRESS
  This Mac reports no non-internal IPv4 interface, so there is no address to
  give the phone: it is offline, or on nothing but utun/awdl/bridge. Join a
  Wi-Fi or Ethernet network, or connect this Mac by cable, and run again.
  Deliberately NOT "set metro.publicUrl": neither channel to a phone carries a
  URL. The dev-client deep link composes http://<host>:<port> itself, and
  ip.txt is read by RCTBundleURLProvider, which prefixes the scheme. A tunnel
  cannot be expressed to a phone, so --device ignores metro.publicUrl,
  metro.tunnel and metro.ngrokUrl and says so when one is set.

STIM_LAN_METRO_UNREACHABLE
  The chosen LAN origin did not answer as THIS workspace's Metro: no answer, a
  5xx, or a dev server that is not this one -- the message says which.
  \`stim start\` prints the port it reserved. On a Mac with several interfaces
  the first en* is not necessarily the one the phone shares: set ios.lanHost to
  the address it can reach (see \`guide settings\`).
  What this gate CANNOT prove is that the phone can reach the origin: macOS
  routes a host connection to its own address over loopback, so the gate passes
  through a firewall that will block the phone. That evidence only ever arrives
  from the phone's own bundle request, which is what \`launched\` reports.

LAUNCH UNVERIFIED, LOCAL NETWORK NOT GRANTED (not a code -- a routed remedy)
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
  Reload. See \`guide facts\`, under \`launched\`.

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
  "ask the user" and nothing else. An uninstall clears both.

STIM_NO_DEVICE
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

STIM_DEVICE_BUSY
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
  holder rather than by token.

STIM_DEVICE_LOST
  Only on a \`--device\` run. The run held a lease, and the raise before the
  install found it gone or held under another token -- another workspace took
  the device in that window. The message names the new holder and its expiry.
  Run the command again; it waits for that lease under \`--wait <seconds>\`.
  AFTER the install has started this is not a failure: the app is already on
  the phone, so the run prints one warning, continues, and reports
  \`lease: null\` in \`--json\`.

STIM_AT_CAPACITY
  Only when concurrency.maxDevices is set (it is UNSET by default, so this never
  fires unless you opted in). Booting a NEW owned device would exceed the cap:
  the machine already has that many Stim-owned devices booted. It is a refusal, not
  a queue -- \`ios\`/\`android\` are interactive-shaped, so Stim does not make
  you wait at a prompt. The remedy is fixed: stop an environment
  (\`stim stop\`) to free a device, or raise concurrency.maxDevices. A
  workspace whose OWN device is already booted is never refused -- re-running
  \`ios\` on an environment you already have is idempotent. (The build cap
  behaves differently: a compile WAITS for a free slot rather than refusing.
  See \`guide lifecycle\`, "opt-in concurrency limits".)

STIM_BUILD_SLOT_TIMEOUT
  Only when concurrency.maxBuilds is set. The build cap does not refuse, it
  WAITS -- this code is that wait giving up: ~90 minutes elapsed and every one
  of the N slots was still held by a process that is still alive. A dead
  builder's slot is reclaimed within a poll, so this is never a slot leaked by
  a crash; it is either that many genuinely long compiles, or a slot directory
  whose owner is not really building. Slots live under ~/.stim/build-slots and
  the message names the directory: remove the slot of a builder that is not
  building, or raise concurrency.maxBuilds (\`guide lifecycle\`, "opt-in
  concurrency limits").

--- REMOTE-DEVICE CODES (\`ios --remote <proxy|eas>\` / \`android --remote <proxy|eas>\`) ---

STIM_NO_REMOTE_SESSION
  The selected backend could not use agent-device, or metro.tunnel names a
  provider or mode this workspace cannot use (e.g. "expo" on a bare RN
  project). The remedy line says which. Nothing was created yet.

STIM_REMOTE_PROXY_CONFIG
  \`--remote proxy\` requires AGENT_DEVICE_DAEMON_BASE_URL and
  AGENT_DEVICE_DAEMON_AUTH_TOKEN. These variables provide credentials after
  proxy is selected. They never select the backend.

STIM_REMOTE_EAS_UNAVAILABLE
  \`--remote eas\` requires eas-cli. Proxy environment variables do not change
  this selection and are not passed to EAS.

STIM_REMOTE_PLATFORM_MISMATCH
  This workspace already has a recorded remote session, and it belongs to the
  OTHER platform ("Session <id> belongs to android, not ios"). A workspace
  holds one remote session, and Stim will not end the recorded one to make
  room -- it may be mid-run for whoever started it. Run \`stim stop\` for this
  workspace, then re-run with the platform you want. Nothing was created here.

STIM_REMOTE_SESSION_STATE
  The EAS session was created and is healthy, but recording it in this
  workspace's state failed (an unwritable STIM_HOME, a full disk). A session
  nothing references is a session nothing will ever stop, so Stim stopped the
  one it had just created and removed its ownership claim before reporting:
  this code means nothing is running and nothing is still billing. Repair the
  state storage the message names, then run the remote command again.

STIM_REMOTE_SESSION_CLEANUP
  Stim tried to end an EAS session and could not PROVE it ended: \`eas
  simulator:stop\` failed, or its output did not confirm the stop, or the
  session stopped but its claim in the machine ledger could not be removed.
  This is a refusal rather than a note because a session that did not stop
  BILLS until its duration cap. The remedy names the exact command --
  \`eas simulator:stop --id <id>\` -- and for a ledger that outlived its
  session, the ledger path to repair. The same code covers a recorded session
  that could not be verified before replacement: inspect it, then \`stim stop\`.

STIM_REMOTE_METRO_WRONG
  The gate that proves a tunnel still reaches THIS workspace's Metro failed --
  before a session or a build, whether the tunnel is Expo's own, one Stim
  started (metro.tunnel: cloudflared/ngrok/auto), or a named metro.publicUrl.
  The usual cause: the tunnel was built for a port this workspace no longer
  holds (a stale one survived a \`stop\`/\`start\` that reserved a different
  port), and it now serves ANOTHER workspace's dev server -- healthy, and
  wrong. Re-run \`stim start\` (it prints the port it reserved) and, for a
  manual tunnel, rebuild it against that port.

STIM_REMOTE_METRO_UNREACHABLE
  A remote start could not create its selected managed tunnel, or the device
  could not be told where Metro is. Follows the same remedy as
  STIM_NO_REMOTE_SESSION's tunnel guidance -- set metro.tunnel, or use
  metro.publicUrl for an existing endpoint.

--- DEV-SERVER CODES (\`stim start\`) ---

STIM_WORKTREE_REMOVAL_IN_PROGRESS
  A managed remote start found that \`stim worktree remove\` owns the
  worktree lock. The start did not register the project or create a tunnel.
  Wait for removal to finish, then run \`stim start --remote\` again.

STIM_REMOTE_START_REQUIRED
  A healthy bare or Expo server was started without its required remote
  tunnel. A running server cannot gain that option. For a Stim supervisor,
  run \`stim stop\`, then \`stim start --remote\`. For an external server,
  configure metro.publicUrl or let Stim supervise the server.

STIM_BARE_DEPS / STIM_BARE_LOAD / STIM_BARE_API  (bare RN)
  The supervisor hosts Metro out of the PROJECT's node_modules, so metro,
  @react-native/dev-middleware and @react-native-community/cli-server-api must
  be installed there and must match the project's React Native. DEPS = not
  resolvable (install them), LOAD = installed but threw while loading,
  API = loaded but is not the API Stim expects (mismatched versions).

STIM_EXPO_BIN  (Expo)
  node_modules/.bin/expo does not exist. Install the project's dependencies.

STIM_METRO_TIMEOUT
  "The dev server did not answer on port <n> within <s>s."
  The supervisor is alive, but Metro or its requested Expo tunnel is not ready.
  \`start\` has already
  printed the last lines of the global workspace logs/supervisor.log above this -- read
  them. A cold Metro on a large graph can genuinely need more than the default
  60s: re-run with \`--wait 180\`. Otherwise \`stim stop\`, then \`start\`.

STIM_SUPERVISOR_EXITED
  "The supervisor exited (<code|signal>) before the dev server came up"
  The dev server failed outright, and the quoted evidence is the real error:
  the supervisor.log tail if it wrote one, plus this attempt's error records
  from the timeline (an expo child's config error -- a PluginError, a bad app
  config -- lands THERE, not in supervisor.log). \`stim logs --errors\` has
  the full records. Fix that and run \`start\` again; nothing is left running.

STIM_BAD_ARG / STIM_NO_PROJECT
  The command refused before doing anything: an unusable --wait value, a known
  setting with the wrong type ("Invalid <key> setting <value>. Expected <shape>."
  -- \`guide settings\` names the type each key takes), an invalid
  Metro tunnel setting, an invalid android.dataPartitionSizeGb value, an unsafe
  android.avdConfig key or fragment, a malformed ios.signingIdentity,
  ios.signingIdentitySha1 or ios.lanHost value, \`--device\` with an empty
  serial or UDID, \`--device\` together with \`--remote\`, a working directory
  with no package.json above it, an android/app/build.gradle that
  declares product flavors with
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
  STIM_NO_DEVICE naming the tool, never as a crash.

"@stim-cli/metro is not installed ... so bundler and client logs will not be
captured"  (in metro.ndjson, bare RN)
  The dev server is serving; only capture is missing, so \`logs\` would report
  a quiet timeline for a broken build. Install \`@stim-cli/metro\` as a
  devDependency of the project.

--- COORDINATION CODES (any command that shares a resource) ---

STIM_LOCK_REFUSED
  A directory lock that serialises two commands over the same thing -- this
  workspace's managed tunnel, its managed remote worktree, the machine's EAS
  project ledger -- is held by a REMOVAL, and a removal is never waited out:
  what it protects will not exist when the lock frees. Nothing was created.
  The message names the lock and the purpose holding it (\`worktree removal\`,
  \`workspace removal\` -- both are \`stim worktree remove\`). Let it finish,
  then run the command again. \`start --remote\` reports this same case as
  STIM_WORKTREE_REMOVAL_IN_PROGRESS instead.

STIM_LOCK_TIMEOUT
  The same locks, held by an ordinary command that is still running, for
  longer than the wait -- 60s by default, 4 minutes for the remote-session and
  EAS project locks. A lock whose owner died is taken over automatically (pid
  liveness is checked every poll), so this means another Stim command really
  is working on this workspace: wait for it and retry. If nothing is running,
  the message names the lock directory and removing it is safe. This is not
  the config lock, which reports the message at the end of this topic.

--- TEARDOWN AND WORKSPACE REFUSALS ---

"metro       refusing to kill port <n>: ... runs from <dir>, outside
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

"this project's sim is X, but --device-type asked for Y"
  The project already owns a simulator of a different model, and Stim will
  not silently boot a different one. Reap it (\`worktree remove\`, or
  \`gc --delete\`) and run \`stim ios\` again to create the requested model.
  That loses the old sim's app state.

"Refusing to remove <path>: uncommitted changes / untracked files / commits
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
  uncommitted and untracked files permanently.
  Runtime state is outside the project tree, so Stim's own files never cause
  Other dirty paths still refuse as described above.

STIM_WORKTREE_BRANCH_EXISTS  (worktree create)
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
  Every keep names \`git branch -D\`.

"failed to scan dependencies for source ..." on pods you did not touch  (ios)
  The compilation cache holds a damaged object. Xcode reports it per source
  file, so it names whichever targets reach the object first -- often pods such
  as sqlite3, nanopb or libwebp -- and the list changes between runs. The
  transcript carries the cause:
    error: CAS-based dependency scan failed: not a IncludeTreeRoot node kind
  A cache write that a full disk or a killed build cut short leaves such an
  object, and upgrading the CLI does not clear it. Empty that one cache with
  \`gc --delete --cache "compilation cache"\`, then build again. The next
  build is a cold one.

"carry       carried <dir>/Pods does not match the <dir>/Podfile.lock on
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
  entries the source fills.

"Could not tear down the <platform> device: ..."
  The delete failed, so the ASSIGNMENT was kept and the command exited 1. That
  is deliberate: dropping the record would leave a device on the machine that
  nothing references and nothing will ever reap. Fix the cause and re-run.

--- ENVIRONMENT ---

"npm error code E401 / E404" while \`npx\` resolves the stim-cli package
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
  wrong; retry.

RUNNING UNDER A SANDBOX

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
  on a fetch that otherwise succeeded, and is safe to ignore.

STIM_CONFIG_CORRUPT  ("Stim config at <path> is not valid JSON")
  Any command can raise it: every command reads ~/.stim/config.json first.
  The file holding every owned-device record will not parse, and Stim never
  resets it for you -- a silent reset would orphan every simulator it names.
  Repair the file, or move it aside (\`mv <path> <path>.broken\`) and accept
  that the devices it recorded become orphans you delete by hand.

"Timed out waiting for the Stim config lock at <path>"
  Every config write is serialised so parallel commands cannot lose each
  other's records. A lock older than 10s is taken over automatically, so this
  means a command really is holding it. If none is running, remove that
  directory.`,
  },

  lifecycle: {
    summary: 'The full worktree -> start -> ios/android -> logs -> teardown flow',
    body: () => `ENVIRONMENT LIFECYCLE

  # 1. Isolated worktree (skip if you are already in one).
  #    It branches from the current HEAD. Use --base fresh for origin/HEAD.
  #    It does NOT install dependencies -- that is yours.
  cd "$(stim worktree create app/412 --carry-ignored)"

  # Slash-separated names create branches such as worktree-app/412 while the
  # checkout remains one flat + separated directory directly under worktreeDir.
  # Default device labels include a stable hash so flat names cannot collide.

  # 2. The dev server, under a detached supervisor. Blocks until it is
  #    verifiably THIS project's, then hands your shell back.
  stim start
    port       8082 (reserved)
    supervisor pid 41233

  # 3. Owned device booted, native inputs fingerprinted, cached build
  #    installed (or built), app launched wired to port 8082, device-log
  #    collector attached.
  stim ios          # or: stim android
    device      stim-app-412 (iPhone 17 26.5) (BF2A..) booted (9s)
    fingerprint a3f9b1.. hit (2s)
    install     from cache (3s)
    launch      com.example.app (1s)

  # 4. Check captured errors: require exit 0 AND no matching errors.
  #    Human mode prints "No matching log records" on stderr for zero matches.
  #    Exit 0 alone means the query succeeded, even when it printed errors.
  stim logs --errors

  # 5. Edit the JS. Fast Refresh applies it; no Stim command is involved.
  #    Then ask again.
  stim logs --since 30s --level error

  # 6. Pausing: supervisor halted, collectors reaped, owned device SHUT DOWN
  #    (never deleted), port freed. Coming back costs a boot, not a create.
  stim stop

  # 7. Done with the branch: the environment dies whole. A branch created by
  #    Stim is also deleted when it has no unique commits.
  stim worktree remove

Steps 2 and 3 are ordered, not interchangeable: \`ios\` and \`android\` never
start the bundler, and refuse with STIM_NO_METRO when nothing holds the
reserved port. That refusal costs a second; the alternative costs four minutes
and produces an app that cannot load a bundle.

Repeat step 3 whenever a NATIVE input changes. A JS-only edit needs nothing --
that is what Fast Refresh over the running dev server is for.

PROGRESS ON A LONG RUN
  The whole summary is stderr; stdout carries only the \`--json\` payload. Every
  progress line has the same shape -- two spaces, a label padded to eleven
  columns, the FACT, and the time the step cost:

    <label>     <fact> (<duration>)

  The labels are a closed set, and nothing else is ever printed in that
  column:

    branch      build       cache       caches      carry       device
    devices     error       failed      findings    fingerprint gems
    install     ip.txt      lan         launch      lease       log
    logs        meaning     metro       pods        port        prebuild
    project     ready       remedy      removed     result      services
    setting     settings    setup       state       stats       stop
    swap        verify      workspace

  \`app\` and \`compilation cache\` join them in the stdout block a successful
  run ends with, and nowhere else. A line states a fact; the reason a fact
  matters lives in this guide, not in the run output. Both platforms use the
  same words, so \`build       ok (51.8s)\` and
  \`launch      com.example.app (2s)\` read the same on iOS and Android; the
  artifact name is in the \`--json\` payload.

  A step that costs real time is named and timed, including the step that
  creates or reconciles the owned device:

    device      stim-app-412 (BF2A..) created (2m14s)

  On iOS that step does not wait the boot out. It creates the simulator, asks
  it to boot, and hands the wait back, so the run fingerprints the native
  inputs and resolves the build cache while \`simctl bootstatus\` is still
  running; it joins the boot before it installs anything. The
  \`device ... booted\` and \`fingerprint ...\` lines each report their own
  elapsed time, and those two overlap -- adding every line up overstates the
  run.

  A step that is still running heartbeats every 30 seconds, on the 30-second
  grid, so the values read 30s, 1m00s, 1m30s and never repeat. A heartbeat
  reuses its phase's label and column and names what the phase is doing, never
  the build tool's own last line -- that transcript is in the build log
  (\`logs --source build\`):

    build       still compiling (1m00s of ~3m10s)
    build       still compiling (4m00s, usually ~3m10s)
    build       still compiling (1m00s)
    pods        still installing (1m30s of ~1m40s)
    build       waiting on /w/app-411 (pid 41233, 1m30s elapsed)

  The \`~\` value is an estimate, never a countdown; the third line is a
  project with no record to estimate from yet. \`guide facts\` says where the
  number comes from.

  The lifecycle commands use the same column. \`worktree create\` keeps the
  created path alone on stdout and reports itself on stderr:

    branch      worktree-e2e-1 from HEAD (9d0ebc4)
    carry       node_modules (APFS clone); no Pods; no native build output
    ready       /w/worktree-e2e-1

  \`start\` names the port, the supervisor mode and its pid on one line
  (\`metro       starting on port 8083 (expo-child, supervisor pid 13724)\`),
  and \`stop\` reports what it released:

    stop        supervisor pid 34856
    stop        collector ios pid 45268
    device      shut down stim-e2e-2
    port        released 8084

  \`worktree remove\` reports itself the same way: the branch decision, the
  owned device, any released device lease, and this workspace's own state
  directory, each on its own line. Nothing prints on stdout; even the removed
  path is on stderr. \`worktree create\` prints its path on stdout because a
  caller needs it to \`cd\` into; a removed path has no such use:

    branch      deleted worktree-e2e-1
    device      parked stim-parked (iPhone 17 26.5) 9c1f (9C1F..)
    lease       released the ios lease on 00008101-000A10913C89001E (it ran until 14:32:10)
    workspace   removed /w/.stim/workspaces/3f9c2a
    removed     /w/worktree-e2e-1

  A branch \`worktree remove\` did not create, or one with unique commits, is
  kept and named instead: \`branch      kept worktree-e2e-1 (it has 2 unique
  commits)\`. On the main checkout, \`worktree remove\` reclaims only the
  environment -- the same \`device\`, \`lease\` and \`workspace\` lines, ending
  with a sentence instead of a \`removed\` line, because the checkout itself
  is never touched: \`Reclaimed the environment; the working tree stays (it
  is the main checkout).\`

  THE SIMULATOR POOL
  \`worktree remove\` PARKS this workspace's owned simulator instead of
  deleting it, and the next workspace that wants the same model and runtime
  ADOPTS it. A simulator that has booted before boots in about 9s; a freshly
  created one costs about 30s, and \`simctl erase\` puts most of that back, so
  a parked simulator keeps its app installed and is cleaned in pieces:

    at park       shut down, the app's data cleared on disk (Documents,
                  Library, tmp, SystemData: NSUserDefaults, AsyncStorage,
                  SQLite), renamed \`stim-parked (<model> <runtime>) <4 hex>\`
    at adoption   renamed for the adopting workspace, then, inside the boot
                  the run pays anyway, \`simctl privacy reset all\` and
                  \`simctl keychain reset\`; at install, every OTHER app the
                  previous workspace left is uninstalled

  A parked simulator KEEPS its system state: pasteboard, Safari data, photos,
  contacts, calendars, installed profiles, Simulator settings, app-group
  containers, and device-level defaults. Isolation covers the app's data, the
  privacy grants, the keychain and the installed apps -- not a clean system
  image. Set the bound to 0 when a project needs one.

  Adoption matches the device type AND the runtime EXACTLY: a ticket that asks
  for an iPad never gets an iPhone, and a request for iOS 18.5 never gets 26.5.
  No match creates a new simulator, as before. After a runtime upgrade the
  parked simulators on the old runtime are never adopted; they leave by
  eviction or \`gc --delete\`.

  The pool targets at most \`pool.iosParkedMax\` simulators (default 3, about
  2.5 GB each). Past that the oldest parked one is deleted:

    device      parked stim-parked (iPhone 17 26.5) 9c1f (9C1F..)
    device      deleted stim-parked (iPhone 17 26.5) 4b02 (pool over 3)

  A failed or unverifiable deletion keeps its ownership record so \`gc\` can
  retry it. The reported pool can temporarily exceed the bound rather than
  orphaning a simulator.

  and an adopting run says so where a plain boot would say \`booted\`:

    device      stim-app-412 (iPhone 17 26.5) (9C1F..) adopted (11s)

  That time includes the two resets, so it runs longer than a plain boot.
  \`stim status\` prints one line while the pool is not empty:

    pool: 2 parked iOS simulators (max 3)

  \`stim gc\` reports the pool, and \`stim gc --delete\` empties every entry
  it can re-verify:

    Parked simulators (2, 5.1 GB):
      ios stim-parked (iPhone 17 26.5) 9c1f (9C1F..) iPhone 17 26.5 parked 3d ago 2.6 GB
                  --delete attempts every parked simulator and keeps failures.

  If simulator listing or deletion fails, \`gc --delete\` reports the failure
  and keeps that entry. It never turns an unverified absence into a dropped
  ownership record.

  That deletion works even under a redirected \`STIM_HOME\`, where the sweep
  for unlisted \`stim-\` devices stays refused: a parked record in THIS config
  proves that simulator is Stim's and parked by this home. \`stop\` never
  parks -- it shuts the owned simulator down and keeps it assigned. Neither
  does \`gc --delete\`, which is deleting what it finds.

  A GAP BETWEEN HEARTBEATS IS NOT A HANG. Stim runs device tools
  synchronously, so a long \`simctl\`, \`adb\` or copy call holds the timer
  until it returns; the next heartbeat then lands on the grid, which is why an
  elapsed value can jump. Read the phase lines, not the wall clock, before
  killing a run.

AN ARTIFACT THE DEVICE ALREADY HOLDS IS NOT INSTALLED AGAIN
  Both platforms store the artifact verbatim, so its hash is its identity.
  Before installing, Stim hashes the artifact it is about to install and the
  one the device already has -- \`pm path\` then \`sha256sum\` on Android, the
  \`simctl get_app_container\` bundle on iOS. Byte-identical means the install
  is skipped. The phase still reports the cost of proving that identity, but
  avoids the ~43s a 400MB APK can cost to copy and install over USB.

    install     unchanged (emulator-5584 already has this build) (0.4s)

  On iOS the install line names the identity proof separately from the Expo
  dev-client preference writes, so a slow simulator command is never charged
  to an install that did not run:

    install     unchanged (stim-app already has this build) (0.4s)
    install     dev client prepared (0.9s)

  The skip needs PROOF. A package that is not installed, a split install, an
  image without \`sha256sum\`, and any adb or simctl failure all read as
  "cannot determine", and the run installs exactly as it always did. A release
  run swaps this workspace's JS into a COPY of the artifact, which is a
  different artifact and is therefore always installed.

  \`--json\` carries installSkipped so a caller can tell a skipped run from an
  installed one.

OPTIONAL SIMSLIM PROFILE
  Install SimSlim once on each Mac:

    brew install mobai-app/tap/simslim

  Then commit a profile and select it in .stim.json:

    { "ios": { "simslimProfile": ".simslim/dev.json" } }

  SimSlim requires an iOS 18 or newer simulator. On each local \`stim ios\`,
  Stim reconciles that profile on the owned simulator before the app build.
  The first change can update services and reboot the simulator. A matching
  profile is a fast no-op on later launches. The settings persist across normal
  shutdowns and reboots. Removing the setting restores stock services when
  Stim applied the profile. Stim never changes an unowned or remote simulator.

NOTHING ABOVE NEEDS A CHANGE TO THE REPO
Runtime state is stored outside the project tree under
$STIM_HOME/workspaces/<project>--<digest>/ (default ~/.stim/workspaces/).
The aggregate run counters \`stats\` prints live beside it in
$STIM_HOME/stats.json, one bucket per project and platform plus a machine-wide
one; nothing per run is kept there.
No .gitignore entry is created or required.
Stim runs on a clean checkout. Runtime state is stored outside the project tree.
runtime state lives under $STIM_HOME/workspaces/<project>--<digest>, and the performance caches ride on the command
lines Stim composes rather than on files the project owns:

  ios      xcodebuild carries COMPILATION_CACHE_ENABLE_CACHING, a shared
           COMPILATION_CACHE_CAS_PATH and a clang prefix mapping of this
           workspace's root, so compiled output crosses worktrees with no
           Podfile post_install block. Xcode 26+ only, and skipped entirely
           when the project configured ccache (the two defeat each other).
  android  gradlew carries --build-cache, so task outputs cross worktrees with
           no org.gradle.caching=true in gradle.properties.
  start    the dev server gets a shared Metro FileStore APPENDED to whatever
           the project configured -- in-process on a bare project, and through
           Expo's config override on SDK 54+. Expo SDK 53 and older use their
           normal Metro cache. Turn it off machine-wide with
           { "caches": { "injectMetroStore": false } } in
           ~/.stim/config.json; see \`guide settings\`. A project that calls
           \`sharedCacheStores()\` from @stim-cli/metro in its own metro
           config also gets the \`cache.provider\` tier behind that store.

Each says so in one dim line. There is nothing to install, wire or commit, and
no setup skill to run. \`stim doctor\` is the second opinion when
something IS blocked or slow: it reports only what Stim cannot handle itself
(a missing dev client, ccache, a fingerprint no fresh worktree reproduces, a
provider on a key this SDK ignores) plus the project-side settings that matter
solely for builds you make OUTSIDE Stim. A clean doctor means there is
nothing Stim needs from this repo.

THE BUILD CACHE HAS THREE LEVELS
  1. Stim's own, on this machine: a directory under ~/.stim shared by
     every worktree, keyed on the @expo/fingerprint hash of the native inputs.
     Free, instant, offline, and the only level a project without any
     provider has.
  2. The project's own cache provider, on ANY project including bare React
     Native: \`cache.provider\` in the settings, a module implementing the
     @stim-cli/cache contract (see \`guide settings\`). Consulted only when
     level one misses, and its hit is stored into level one before install.
     The same contract serves the Metro transform cache.
  3. On an EXPO project only, the provider the project ALREADY configured for
     Expo (\`expo.buildCacheProvider\` -- "eas", or a module of its own).
     Consulted only when levels one and two miss, bounded so a slow or expired
     remote cannot stall the loop, and a hit is copied into level one on the
     way past so the next workspace on this machine gets it for free. After a
     build, the result is stored locally AND handed to both providers, which
     run independently.

  Stim never configures a provider and never suggests changing one: a
  project without one is a perfectly ordinary local-only project (doctor does
  not ask for one either -- a provider only serves builds run OUTSIDE Stim).

  A provider that fails to load, times out, or errors produces ONE note per
  failure class and the run continues on the local cache. \`gc\` reports,
  trims, and clears local caches only: the provider contract has no delete
  operation, so no local command can remove data a team or CI system shares.

  A MISS explains itself when it can. When this workspace's previous build
  stored its fingerprint sources beside the cache entry, the fingerprint line
  gains " -- N sources changed: <up to three paths>", and the full list
  (capped at 20 names) lands in the build log as a fingerprint_diff record.

  THE KEY CAN MOVE MID-RUN, and the run says so in two facts rather than two
  explanations. \`expo prebuild\` and \`pod install\` rewrite fingerprinted
  files while they work, so the run fingerprints again afterwards:

    fingerprint dcbd8d.. -> 6564e2.. (after prebuild, pod install)
    cache       hit 6564e2.. (post-prebuild/pod install key)

  The first line means the artifact, the \`lastBuild\` record and any remote
  upload are stored under the SECOND hash -- the one the next run in this tree
  computes, and therefore the one it looks up. The second line only appears on
  a tree that was COLD: the first lookup ran on the pre-prebuild hash and
  could not find an entry another workspace had already stored under the
  post-prebuild one, so re-resolving under the moved key installs it instead
  of compiling beside it. No second line means nothing was found there and the
  run compiles.

WHAT MAKES THE CACHE ACTUALLY HIT: .FINGERPRINTIGNORE
  Every entry is keyed on what the tree hashes, so two workspaces share an
  entry only when they hash alike. A file that changes without changing the
  BUILD is what breaks that, and it fails silently -- a cache that never hits
  looks exactly like a cache that is not there.

  Stim ignores two paths a fresh checkout never has and no native build reads:
  android/local.properties and android/.idea. A project does not repeat those.
  Everything else is the project's call, including a lockfile whose checksums
  embed machine paths -- ignoring a path any project might read turns a slow
  build into a wrong one.

  \`.fingerprintignore\` at the project root (same syntax as .gitignore) is the
  answer. Put in it only what genuinely cannot change the native build: a
  generated report, a local env file, a lockfile whose checksums embed absolute
  machine paths (\`ios/Podfile.lock\` is the usual one -- pod checksums can bake
  in a machine path, and \`pod install\` rewrites it on a plain re-install).
  Never ignore a real native input -- a Podfile, a gradle file, the app config
  -- to force a hit: that trades a slow build for a wrong one.

  \`stim doctor\` measures this directly rather than reading the file: it
  fingerprints HEAD in a temporary clean worktree, compares, and reports a
  mismatch naming the differing sources. Untracked, non-gitignored files under
  ios/ or android/ count too -- they are hashed like any other source, so a
  stray file there moves the key on your machine and nowhere else.

ONE COMPILE PER FINGERPRINT, ACROSS EVERY WORKSPACE
  The cache makes the SECOND workspace on a commit free -- but only once the
  first has finished. Three agents starting within the same minute all miss it,
  and without this all three compile the same app at once, fighting for the
  same cores. So when both cache levels miss, the run takes a LOCK on
  <fingerprint, platform> (a directory under ~/.stim/build-locks). Exactly
  one workspace compiles; the others print

    build       /w/app-412 is already building a3f9b1.. (pid 41233) -- tail ...
    build       waiting on /w/app-412 (pid 41233, 4m elapsed) -- tail ...
    build       waited 12m41s for /w/app-412's build -> installed from cache

  and install the artifact the builder stored. They report cacheHit: "local"
  plus waitedForBuild: { pid, ms }.

  Nothing can deadlock on it. The lock is held by a PID, so a builder that
  crashes, is killed, or whose build simply fails frees it: the waiters see a
  released lock with no artifact, and one of them takes over and builds. A
  builder that is alive but wedged is the only case a wait can outlive, and
  that ends after ~90 minutes with STIM_BUILD_WAIT_TIMEOUT naming the lock.

  --no-build-cache looks nothing up -- not the local cache, not either
  provider -- and takes no lock and never waits, because it asked for a compile
  of its own. It still STORES the result, over the entry it was told not to
  trust, and still uploads it. Use it when a cached artifact is suspect; the
  --json payload reports cacheSkipped: true so a caller can tell that run apart
  from a plain miss.

OPT-IN CONCURRENCY LIMITS (UNLIMITED BY DEFAULT)
  Stim imposes NO limits of its own: unset is exactly the behaviour above --
  every build compiles, every device boots. When a machine cannot host as many
  parallel builds or booted simulators as there are agents, two MACHINE-level
  caps rein it in. They live under a top-level \`concurrency\` key in
  ~/.stim/config.json (not per-project -- the resource being shared is the
  machine's), and STIM_MAX_BUILDS / STIM_MAX_DEVICES override the file.
  Absent, 0, or any non-positive value means NO enforcement.

    concurrency.maxBuilds   how many builds COMPILE at once. It is a semaphore
                            of N slots (~/.stim/build-slots). A run takes a
                            slot AFTER the single-flight lock -- a workspace
                            waiting to install another's identical artifact
                            never burns a slot -- so it caps distinct compiles,
                            not waiters. A full slate WAITS (this is batch work),
                            printing the same kind of progress line the build
                            lock does, and a dead builder frees its slot within
                            a poll (pid-liveness, like the lock).

    concurrency.maxDevices  how many Stim-owned devices are BOOTED at once. Checked
                            at device time, before a sim is created or booted.
                            At the cap, a NEW device is REFUSED with
                            STIM_AT_CAPACITY (interactive-shaped: it does not
                            queue). A workspace whose own device is already
                            booted is never refused. See \`guide errors\`.

  \`stim doctor\` prints one note echoing the caps and the current live count,
  but ONLY when a cap is set. \`stim gc\` reports stale build slots the way it
  reports stale build locks, and \`gc --delete\` clears them. There is no
  \`stim config\` command: set these by editing ~/.stim/config.json or via
  the two env vars (see \`guide settings\`).

THE OPTION SURFACE, IN FULL
  start           --json --wait <seconds> --remote
  ios             --json --no-metro-check --no-build-cache --configuration <name> --device-type <name> --runtime <version> --device [udid] --wait <seconds> --no-wait --remote <proxy|eas>
  android         --json --no-metro-check --no-build-cache --variant <name> --system-image <id> --device [serial] --wait <seconds> --no-wait --remote <proxy|eas>
  device          lock <ios|android> [id] --for <duration> --wait <seconds> --json;
                  unlock [ios|android] --json
  logs            --source --level --since --grep --tail --follow --errors --json
  stop            --json --force
  status          --json          (already machine-wide)
  stats           --json          (this project and machine-wide)
  doctor          --json --fix --platform <ios|android>
                                  (--platform keeps shared checks and filters native findings)
  gc              --delete --older-than <days> --cache <name|all>
  worktree create <name> --carry-ignored --base <ref> --dir <path> --label <label>; remove [path] --force

  That is the whole surface today, and it is deliberately small. It can grow
  when a flag is genuinely the best answer -- but project-specific knowledge
  (release builds, variants, device targets) belongs in a script the repo owns,
  not in a flag here.

  \`android --variant <name>\` selects the gradle variant to assemble and
  install on a project with product flavors -- \`--variant productionDebug\`
  runs \`assembleProductionDebug\`, finds the APK in apk/production/debug/ and
  keys the build cache on the variant. It overrides the android.variant
  setting (see \`guide settings\`), which is the repo-level default; unset,
  the plain \`assembleDebug\` flow is unchanged. The --json payload's
  \`variant\` field reports what was built (null for the default).
  When neither is set and android/app/build.gradle declares more than one
  product flavor, \`android\` refuses BEFORE gradle runs and names the debug
  variants to choose from, because \`assembleDebug\` would build every flavor
  and leave nothing to pick from. That parse is best-effort: flavors built
  from a variable, a loop, or an applied script are not detected, and such a
  project builds as before.

  \`ios --device-type <name>\` and \`ios --runtime <version>\` choose the
  MODEL and the iOS version of the simulator this workspace owns --
  \`--device-type "iPad Pro 13-inch (M4)" --runtime 18.5\` is how a ticket that
  says "happens on iPad on iOS 18.5" gets reproduced without writing a
  \`.stim.json\`. \`android --system-image <id>\` is the Android half, taking
  the sdkmanager package id
  ("system-images;android-36;google_apis;arm64-v8a"). Each overrides its
  setting (ios.deviceType, ios.runtime, android.systemImage) for that one
  invocation, exactly as \`--configuration\` overrides ios.configuration.

  A name that is not INSTALLED on this machine refuses with STIM_BAD_ARG
  before anything is created, and the message lists the installed names, so a
  wrong guess is one command, not a created simulator. A blank value is the
  same refusal.

  What counts as installed for \`--device-type\` is what an installed RUNTIME
  can create, not what \`xcrun simctl list devicetypes\` prints: that table
  also names watchOS, tvOS and visionOS models, and older iPhones no current
  runtime supports, none of which \`simctl create\` would accept. So the
  refusal lists the models the installed runtimes offer -- narrowed to the one
  runtime when \`--runtime\` also resolved, which is what catches a pair like
  \`--device-type "iPhone 8" --runtime 26.5\` that each half would pass alone.
  \`--runtime\` takes a version (\`26.5\`) or a runtime's full name
  (\`iOS 26.5\`), exactly; no prefix or suffix matches.

  These flags describe a device that does not exist yet. When this workspace
  ALREADY owns a simulator and \`--device-type\` names a different model,
  Stim refuses rather than silently booting the wrong one: reap the current
  sim with \`stim worktree remove\` (or \`stim gc --delete\`), then run
  \`stim ios\` again to create the requested one. \`--runtime\` and
  \`--system-image\` apply at creation only, so an existing device keeps the
  version it was made with. The --json payload reports what was actually
  used: \`deviceType\` and \`runtime\` on iOS, \`systemImage\` on Android,
  read from the device itself, so a settings-driven run reports them too.

  \`android --device [serial]\` installs and launches on a physical device
  connected to this machine instead of this workspace's owned emulator. With
  no serial it takes the first device it can lease (THE POOL, below). It
  cannot be combined with --remote.

  A \`--device\` run LEASES the device from just after the build until it
  exits, so a second workspace cannot install over it mid-run (see THE DEVICE
  LEASE below).

  The build, the fingerprint, the build cache and the Metro port gate are
  unchanged. What is skipped is everything that manages an owned device:
  no capacity check, no AVD creation, no boot wait, and no device record --
  so \`stop\` and \`gc\` never touch the phone. The app is pointed at
  localhost:<port>, which the adb reverse serves, instead of the emulator's
  10.0.2.2. Stim never creates, boots, shuts down, or deletes hardware.

  \`ios --device [udid]\` selects a connected iPhone, the same way
  \`android --device\` selects a connected phone: with no UDID it takes the
  first device it can lease (THE POOL, below), and an iPhone
  that is unpaired or has Developer Mode off is refused with the fix. It
  cannot be combined with --remote, and it never creates, boots, or deletes
  hardware -- there is no capacity check, no simulator creation, no boot wait,
  and no device record, so \`stop\` and \`gc\` never see the phone. Like
  \`android --device\`, it leases the phone for the run (below).

THE DEVICE LEASE ON A \`--device\` RUN
  A physical device is shared, so a \`--device\` run takes a lease on it. The
  lease step sits AFTER the build (a build touches no device) and before the
  install, and the run releases what it took when the command exits: on
  success, on a failure, on an exception, and on a Ctrl-C or a SIGTERM, which
  it catches to give the device back before exiting 130/143. Only SIGKILL
  escapes that, and then the lease expires on its own. Before each device step
  -- install, launch, the log collector, verification -- the run raises the
  expiry to now plus the larger of 60 seconds and that step's own upper bound,
  because a child process is synchronous and no timer can tick during an
  install. A run killed with SIGKILL therefore leaves the device leased for at
  most the current step's bound, never less than 60 seconds.

  If nobody holds the device, the run takes a lease of its own and gives it
  back at exit. If another workspace holds it, the run WAITS: \`--wait
  <seconds>\` (default 60) polls every 2 seconds, prints a waiting line to
  stderr at once and then every 30 seconds with the holder, the device and the
  holder's expiry, and refuses with STIM_DEVICE_BUSY when it runs out. It
  keeps waiting past the holder's own expiry, because the holder can release
  early. \`--wait 0\` refuses at once. \`--no-wait\` changes only that case: the
  run proceeds with NO lease and prints one warning naming the holder and its
  expiry, plus what the install costs: the same app id means it TERMINATES the
  holder's running app, a different one means the launch only backgrounds it,
  and when Stim cannot read the holder's app id it says so rather than
  guessing. A free device is leased as usual under \`--no-wait\`. The two flags
  together are STIM_BAD_ARG, and so is either one without \`--device\`, because
  an owned simulator or emulator has no contention.

  A successful \`--device\` run reports \`lease: { kind, expiresAt }\` in its
  \`--json\`; a run that proceeded without one, or lost one after the install,
  reports \`lease: null\`. \`stim status\` lists every lease file on the
  machine, and \`stop\` releases the ones this workspace holds.

HOLDING A DEVICE ACROSS RUNS
  A run-scoped lease dies with the command, which is not enough for a
  device-tool session: the next workspace's \`ios --device\` would install over
  the app you are driving. \`stim device lock\` grants a DECLARED lease that
  outlives the run:

    stim device lock ios --for 10m     # or: android; add a UDID/serial to name one
    stim ios --device                  # builds, installs, launches; raises the lease
    ... device-tool work on the phone ...
    stim device unlock                 # give it back; or let it expire

  \`--for\` takes a whole number of seconds or minutes, 10s to 30m, and
  defaults to 5m; anything else is STIM_BAD_ARG. \`--wait <seconds>\`
  (default 60, \`0\` refuses at once) is the same wait a run does. Both
  commands need a project and refuse outside one with STIM_NO_PROJECT, and
  \`lock\` runs the same resolver \`--device\` does, so an unpaired phone or
  one with Developer Mode off is refused with that resolver's own remedy
  before any lease is written.

  Locking a device this workspace already holds SETS the expiry to now plus
  \`--for\`, which can shorten it. Locking a different device of the same
  platform releases the first one: a workspace holds at most one lease per
  platform. Nothing else moves an expiry -- not the app running afterwards, not
  device-tool work, not \`status\`. Only \`lock\` and a run's own steps do.

  \`stim device unlock\` releases every lease this workspace holds, or only
  the platform named. Releasing nothing is not an error: it says so on stderr,
  and \`--json\` prints an empty list. It releases by holder, so it still
  works when the workspace directory was recreated and the token is gone.

  With no id, \`lock\` and a \`--device\` run pick from the POOL of connected
  devices, so two phones on one machine no longer refuse.

THE POOL: WHICH DEVICE AN ID-LESS \`--device\` PICKS
  Candidates are the connected devices the resolver already accepts: on iOS,
  wired, paired, with Developer Mode on; on Android, every serial adb reports
  in the \`device\` state that is not an emulator, TCP serials included. Then,
  in order:

    1. the device this workspace already leases, when it is among them;
    2. otherwise the first one not leased -- or leased and EXPIRED -- in
       case-folded id order.

  Ids are sorted on, never names: adb has no name without one \`getprop\` per
  serial, and models repeat.

  A device this workspace leases that is NOT connected refuses with
  STIM_NO_DEVICE naming it, rather than quietly moving to another phone. Naming
  a different one with \`--device <id>\` refuses the same way, because a
  workspace holds at most one lease per platform: \`stim device unlock\` first.

  Candidates with none free is the wait: under \`--wait <seconds>\` the poll
  re-LISTS devices, so a phone plugged in mid-wait is picked up as well as one
  released mid-wait. When the wait runs out, STIM_DEVICE_BUSY names every
  holder and its expiry. No candidate at all is the existing STIM_NO_DEVICE,
  with the resolver's own message. \`--no-wait\` takes the first candidate
  anyway and proceeds with no lease, as it does for one named device.

  The chosen device is on the phase line and in \`--json\` (\`udid\` or
  \`serial\`, plus \`deviceName\`), so an agent can hand the same id to its
  device tool.

  A device build is LOCAL-TIER ONLY. Its cache key is
  \`<fingerprint>-<configuration>-device\`, so a device app can never collide
  with the simulator one, and neither the build-cache provider nor the Expo
  remote cache is read or written on a \`--device\` run: every entry they hold
  is keyed for the simulator, so consulting them would either install a
  simulator slice on a phone or publish an iphoneos app under a key simulator
  builds resolve.

  THE BUILD is the \`iphoneos\` slice for the selected phone -- \`-sdk
  iphoneos\`, the project's own signing settings, no signing flags on the argv.
  It is installed with \`devicectl device install app\` and launched with
  \`devicectl device process launch\`. Every device install is SIGNED, Debug
  included, so the signing gate runs before it: the app's own
  embedded.mobileprovision must be unexpired and must name this phone, and when
  Stim modifies the bundle the identity that profile names must be in this
  machine's keychain (see \`guide errors\`). A gate refusal on a CACHED app
  falls back to a full build; on a freshly built one it exits on its own code,
  because building again would produce the same app.

  DEBUG REACHES METRO OVER THE LAN, because a phone shares no loopback with
  the host and USB carries no reverse forward. Stim picks a non-internal IPv4
  address (en0 first, RN's own order from react-native-xcode.sh), gates it as
  this workspace's Metro, and then wires the app to it: an expo-dev-client app
  through the deep link, passed to devicectl as \`--payload-url\` and followed
  by \`-- -EXDevMenuShowsAtLaunch 0 -EXDevMenuShowFloatingActionButton 0\`,
  which is how a phone gets what a simulator gets from a defaults write, and a
  bare app by writing \`<addr>:<port>\` into the app bundle's ip.txt --
  RCTBundleURLProvider's own mechanism, which honours a colon-bearing value
  verbatim and never consults the compiled RCT_METRO_PORT. Stim never sets
  that define: it would put the reserved port into a compiled input and fork
  the device cache per workspace.
  ip.txt is a sealed resource, so Stim writes it on a COPY of the artifact and
  re-seals that copy with \`codesign\`. THE ORDER IS STORE, THEN COPY, THEN
  MUTATE: the cache entry stays the pristine, shareable artifact, and the
  per-run address lives only in the copy that is installed and then deleted.

  A RELEASE device run builds fresh every time for now. A cached Release app
  carries its BUILDER's JS, and the device JS swap (which has to re-seal what
  it injects) lands with phase 6 of appandflow/stim#178, so the cache hit is
  refused rather than installed with someone else's JavaScript.

  THE DEVICE LOG COLLECTOR IS THE LAUNCH. \`devicectl\` connects an app's
  streams only when it is the process that starts the app, so the collector
  runs \`devicectl device process launch --console --terminate-existing\`
  itself rather than attaching after the fact the way the simulator collector
  does. The run then reads the app's pid from the phone's own process list
  (\`devicectl device info processes\`), because \`--console\` blocks until
  the app exits and its \`--json-output\` is written only then. That device pid
  is also what proves a RELEASE launch: a device pid means nothing to the host,
  so nothing on the host is ever signalled with it. Otherwise the collector is
  the same process as every other collector -- one per platform per workspace,
  titled with its --root, killed and replaced on the next \`ios\` run whose pid
  still proves it is this workspace's, and reaped by \`stop\`. One difference in
  the ordering: a device run stops the PREVIOUS collector before it installs,
  not while starting its own, because an upgrade install terminates the running
  app -- which would end that collector's devicectl non-zero and record a
  failure for a normal reinstall. Unplugging the phone ends devicectl, which
  ends the collector: it removes its own registration and exits, leaving
  nothing for \`gc\` to find, because a phone is never recorded as a device. Whether it closes with collector_stopped or
  collector_failed follows devicectl's exit code, which no one has watched a
  cable-pull produce yet. See \`guide logs\` for what the device stream can
  and cannot carry, and appandflow/stim#179.

  THE APP RUNS FOR AS LONG AS THE COLLECTOR DOES. Because the collector is the
  launch, the app is attached to it: \`stop\` (and any other end of that
  collector -- a crash, the host sleeping, the cable coming out) closes the app
  on the phone. It stays INSTALLED and Stim still records nothing about the
  device; only the running process goes. See \`guide cleanup\`.

  THERE IS NO INSTALL SKIP ON A PHONE. The simulator path skips the install
  when the device already holds the same bundle byte for byte, which it proves
  by hashing the installed container; there is no cheap equivalent through
  devicectl, so a device run always installs. It is an upgrade install: the
  app's data, and the Local Network permission the phone granted it, survive.

  A VARIANT WHOSE NAME ENDS IN "Release" IS A RELEASE BUILD (\`release\`,
  \`productionRelease\`), and that is the whole opt-in -- there is no second
  flag. It is the Android half of \`ios --configuration Release\` and behaves
  the same way: AGP's bundle task embeds the JS, so Metro is skipped ENTIRELY
  (no gate, no \`adb reverse\`, no debug_http_host, no dev-client deep link --
  a plain \`am start\` of the launcher activity), the payload says
  \`metroPort: null\`, and \`launched\` is proven by the app PROCESS being
  alive on the device rather than by a bundle fetch. Device logs are still
  collected, so \`logs --errors\` answers "does it repro in release/Hermes
  bytecode".

  On a release CACHE HIT the cached APK carries its BUILDER's baked-in JS, so
  it is never installed as-is. Stim copies it aside, regenerates this
  workspace's bundle with the project's own tools (\`expo export:embed\` /
  \`react-native bundle\`, then the project's own hermesc when
  \`hermesEnabled\` is not false in android/gradle.properties), re-packs it
  into the copy with plain zip surgery (stored, not deflated -- the runtime
  mmaps it), then zipaligns and re-signs with apksigner. The keystore defaults
  to android/app/debug.keystore with the standard password; android.keystore /
  android.keystorePassword override it (see \`guide settings\`). The cache
  entry itself is never modified.

  Before re-packing, THE ASSET GATE compares CONTENT HASHES of the assets
  React Native emits: what this workspace just emitted under --assets-dest
  against a manifest of what the cached build emitted, recorded as
  assets-manifest.json inside the cache entry at build time. Same producer on
  both sides, so the comparison is exact -- an added, a removed OR A REPLACED
  asset (a different image under an unchanged filename) all mean NO SWAP, and
  the run falls back to a full gradle build with a note naming an example. An
  Android drawable is not just a file in the zip -- it has a row in
  resources.arsc only AAPT can write -- so an APK cannot be made to carry an
  asset it was not built with, and Stim will not install one whose JS
  references an asset it lacks. The APK's own res/ table is never read: a
  release build shortens every resource path (AGP's
  optimizeReleaseResources), so those entries are \`res/-B.png\`, not the names
  anything emitted.

  AN ENTRY WITH NO MANIFEST NEVER SWAPS. One stored before asset tracking, or
  downloaded from an Expo build-cache provider, has nothing to compare
  against, so the run says so and builds fresh -- and that build REPLACES the
  entry, manifest included, so the next run on the same fingerprint swaps
  normally. The same replacement happens after any gate refusal or swap
  failure, which is what stops a bad entry from refusing every run forever.

  Local re-signing also
  means an APK signed by CI cannot be updated over: on
  INSTALL_FAILED_UPDATE_INCOMPATIBLE (or a version downgrade) a release run
  uninstalls the package once and retries, printing a note -- the app's data
  goes with it, which is why only release runs do this.

  Local installs only, onto an owned emulator or, with
  \`android --device\`, a connected physical device. Store signing and
  distribution stay out of scope.

  \`ios --configuration <name>\` selects the Xcode configuration --
  \`--configuration Release\` builds a SIMULATOR Release app with the JS
  bundle embedded. It overrides the ios.configuration setting (the repo-level
  default); unset, the Debug flow is unchanged. A non-Debug configuration
  skips Metro ENTIRELY: no gate, no port wiring, no dev-client deep link (a
  plain \`simctl launch\`), and the payload says \`metroPort: null\` --
  \`launched\` is verified by the app PROCESS staying alive, not by a bundle
  fetch. The build cache keys on the configuration
  (\`<fingerprint>-release-sim\`), and because a cached Release .app carries
  its builder's baked-in JS, a cache hit regenerates THIS workspace's bundle
  (the project's own \`expo export:embed\` / \`react-native bundle\`, plus
  its own hermesc when Hermes is enabled) into a copy of the artifact,
  re-signs it and installs that; any swap failure falls back to a full build
  rather than ever installing stale JS. Device logs are still collected, so
  \`logs --errors\` answers "does it repro in release/Hermes bytecode".
  A run with no \`--device\` installs on the simulator only. \`ios --device\`
  builds the \`iphoneos\` slice for a cabled iPhone and keys its cache
  \`-device\` instead of \`-sim\`, but does not install it yet. Archives,
  \`.ipa\` export, store signing and distribution stay out of scope.

DESTRUCTIVE COMMANDS -- ask the user first
  gc --delete             deletes orphaned stim-* devices, tens of GB
  gc --delete --cache all empties the shared build caches every project uses
  gc --delete --cache <name>
                          empties only the caches that carry <name>
  worktree remove --force discards uncommitted and untracked work
  stop --force            kills a process Stim could not identify

Permanent local deletion lives in exactly TWO commands: \`worktree remove\`
(the workspace you name) and \`gc --delete\` (the machine). For a local device,
\`stop\` shuts it down and never deletes it. For a recorded EAS session,
\`stop\` irreversibly ends the session. \`stop --force\` can also kill an
unidentified process on the reserved port. There is no \`--delete\` flag on
\`stop\`.

CAPACITY
  A booted iOS sim is roughly 1-2 GB of RAM, an Android emulator 2-3 GB. On a
  16 GB machine plan for 2-3 live environments. Nothing enforces this;
  \`stim status\` is how you check -- it reports every workspace on the
  machine, not just this one.

TWO REPORTS, TWO QUESTIONS
  "What is running" is \`stim status\`: live state, right now. "How much the
  cache saved" is \`stim stats\`: aggregate counters for this project and for
  the machine, with a hit rate and an estimate of the time saved (see
  \`guide facts\`).`,
  },

  cleanup: {
    summary: 'Where simulators come from, and how they get reclaimed',
    body: () => `CLEANUP AND DISK

WHAT RECLAIMS AN OWNED DEVICE
  stim worktree remove    parks the owned simulator (\`guide lifecycle\`) and
                            deletes every other owned device under the worktree
  stim gc --delete        sweeps stim-* devices no project references, and
                            clears verified parked simulators
  stim gc --delete --older-than <days>
                            also reaps the device of a project nothing has
                            touched in that long, even though the project is
                            still on disk

Those are the only two commands that delete. \`stim stop\` shuts a device
DOWN and leaves it assigned, which is what makes returning to a branch cost a
boot rather than a create, a provision and a reinstall.

Neither touches $STIM_HOME/stats.json: \`gc\` never reports or trims the run
counters \`stats\` prints, and there is no reset flag. Delete that one file to
start the counters over. A file this version cannot read -- unparseable, or
written by a newer Stim -- costs one dim line on stderr and is otherwise left
alone; only the next \`ios\` or \`android\` run moves an unparseable one aside
to stats.json.corrupt-<unix ms> and starts a new one.

New owned Android AVDs use an 8 GiB data partition by default. This leaves room
for repeated app installs while capping userdata growth below the 10 GiB
setting measured on the selected API 36 profile. Set
\`android.dataPartitionSizeGb\` to a whole number from 6 through 16384 when a
project needs another size. Android userdata grows but does not shrink, so the
setting applies only to a newly created AVD; recreate the environment to adopt
a changed value.

ON THE MAIN CHECKOUT
  git cannot remove the main working tree, and deleting the source tree is not
  what anyone meant -- so there, and only there, \`worktree remove\` reclaims
  the ENVIRONMENT and nothing else: the owned devices are deleted, the Metro
  port freed, the registry entries (including nested monorepo app dirs)
  dropped, and the global workspace directory deleted. The tree itself is never touched, which
  is also why the dirty-tree and unpushed guards do not apply on that path.
  It ends with:
    Reclaimed the environment; the working tree stays (it is the main checkout).
  A registered project directory that is not a git repo at all gets the same
  environment reclaim -- there is nothing else remove could mean there.

The delete paths and \`stop\` do not check simulator occupancy. An explicit
\`stim stop\` shuts down this workspace's Stim-owned simulator, including a
simulator used by a UI-test runner. It never shuts down an unowned simulator.

If a delete fails, the device's config record is KEPT and the command reports
it. A record is what makes the device findable again, so it outlives a failed
teardown rather than turning it into an orphan.

WHAT ELSE STOP REAPS
  The device-log collectors (\`simctl log stream\` / \`adb logcat\`) that
  \`ios\` / \`android\` attach after launch. They are recorded in
  the global workspace state.json, and nothing outside this workspace can name them,
  so \`stop\` is what stands between a teardown and a log stream that outlives
  the device it was reading. A fresh \`ios\` / \`android\` run also kills the
  previous collector for that platform before starting its own.

  A PHYSICAL IPHONE'S COLLECTOR IS THE SAME PROCESS with one difference: on
  hardware the collector IS the launch. \`devicectl\` connects an app's
  streams only when it is the process that starts the app, so the collector
  runs \`devicectl device process launch --console\` itself rather than
  attaching after the fact. It registers under the same \`ios\` key, carries
  the same --root in its title, is proven and replaced by the same pid rules,
  and is reaped by the same \`stop\`.

  THE APP'S LIFETIME IS BOUND TO THAT COLLECTOR, and this is the one place a
  phone behaves worse than a simulator. \`devicectl device process launch
  --console\` keeps the app attached to the launching process, so anything that
  ends the collector ends the APP ON THE PHONE: \`stop\`, \`gc --delete\`,
  \`worktree remove\`, a fresh \`ios --device\` run stopping its predecessor,
  a crash, the host sleeping, or the cable coming out. Measured: SIGTERM to the
  collector alone terminates the app. \`stop\` therefore leaves no RECORD of the
  phone -- it never had one -- but it does close the app that was running on it.
  Nothing is uninstalled, and the next \`ios --device\` starts it again.

  Unplugging the phone ends devicectl, which ends the collector: it unregisters
  itself and exits either way, so \`gc\` has nothing to find, because a phone is
  never recorded as a device.
  WHICH record it writes on the way out depends on devicectl's exit code, and
  that code is unverified until someone pulls a cable: a zero exit is
  collector_stopped, a non-zero one is collector_failed, because on hardware
  a non-zero devicectl exit is the only evidence a launch or console failed.
  See \`guide logs\` for what it can and cannot carry.

  Before signalling a recorded collector pid, \`stop\`, \`gc --delete\`,
  \`worktree remove\`, and a fresh \`ios\` / \`android\` run each read that
  pid's live command and require it to be this workspace's collector for
  that platform. A pid that cannot be proven is reported and left alone: the
  kernel reuses pids, and an unreaped record is a smaller problem than a
  signal delivered to someone else's process. A fresh \`ios\` / \`android\`
  run starts its replacement anyway, leaving the unproven pid to clear on its
  own. A collector started by an older Stim states no root in its command, so
  it reports as unverified until its record clears -- which happens when its
  own device's log stream ends and it unregisters itself, or when the next
  \`ios\` / \`android\` run overwrites the record with its own, whichever
  comes first; the old process itself keeps running until it exits on its own.

  \`stop\`, \`gc --delete\`, and \`worktree remove\` weigh an unproven live
  pid against the record's own startedAt claim: a pid that started AFTER that
  claim is a newer process that recycled the number, so the record is
  genuinely stale and gets dropped, as before. A pid that started at or
  before that claim may still be the collector Stim registered, so the
  record is kept and reported for a retry, the same way a device teardown
  that could not be confirmed keeps its record.

BUILD LOCKS
  \`gc\` also reports the single-flight build locks (above): the ones whose
  builder is no longer running are debris a reboot or a kill left behind, and
  \`gc --delete\` clears them. A lock whose builder IS running is a build in
  progress -- it is named in the report and touched by nothing, because
  removing it would put a second workspace on the same compile.

DEVICE LEASES
  A workspace can hold a timed lease on a physical device. The lease is one
  file under ~/.stim/device-locks, and it expires on its own. \`gc\` reports
  the lease files whose expiry has passed; \`gc --delete\` removes those
  files, re-reading each one under its own lock first, so a lease renewed in
  the meantime survives. Two kinds are reported and KEPT: a file that does
  not parse, which no run may take the device around, and an unexpired lease
  whose holder directory is gone. \`stim status\` lists every lease file with
  its holder and expiry, including holders no config knows. \`stop\` and
  \`worktree remove\` release the leases of the workspace they act on, and
  nothing else deletes a lease file: never remove another workspace's.

A device leaks when a project is abandoned WITHOUT either delete path -- the
sim survives with nothing pointing at it. \`stim gc\` (no flag, writes
nothing, always safe) reports those; \`gc --delete\` reaps them, and in the same
run drops the dead config ENTRIES those projects left behind and frees their
Metro ports.

REMOTE EAS SESSIONS
  Plain \`stim gc\` is a dry run. \`gc --delete\` can stop active stim-* EAS
  sessions after workspace state is missing. The stop needs verified
  project, name, platform, and status ownership. The same run also cleans the
  local state that it can prove is stale.

  A fixed ownership record and lock live under ~/.stim/machine/eas,
  independent of STIM_HOME. Unclaimed sessions are never stopped.
  Missing config.json does not authorize cleanup.
  The exact recorded workspace state path must prove that the session ID is
  absent.
  If claim removal fails after a verified stop, the session is stopped, but the
  workspace record is kept for reconciliation.

  If a registered root is missing or unreadable, the EAS sweep fails closed and
  leaves the remote EAS session running. Independent local cleanup continues
  for entries it proves stale.

THE MIRROR IMAGE: A STALE DEVICE RECORD
  A device deleted out from under a LIVE project (by hand, or by Xcode) leaves
  the opposite problem: the record points at a sim that is not on the machine,
  and \`stim status\` warns about it on every run. \`gc\` reports these under
  "Stale device records", and \`gc --delete\` clears the RECORD -- only the
  record. There is no device left to shut down or delete, so nothing is issued
  at simctl or avdmanager, and the project keeps its entry, its label and its
  Metro port. The next \`ios\` / \`android\` creates a fresh owned device.

THE ONE CASE GC WILL NOT REAP
  If the config is gone entirely (deleted ~/.stim, or a throwaway
  STIM_HOME), gc cannot tell your stale devices from another config's LIVE
  ones, so it refuses to delete anything. It still NAMES the stim-* devices
  it found, so you can judge. Delete them yourself:
    xcrun simctl delete <udid>
    avdmanager delete avd -n <name>

DISK
  Logs, state, pidfiles and Xcode DerivedData are under the global workspace
  directory, and \`worktree remove\` reclaims them. Gradle retains its normal
  project build directories while sharing task outputs through its build cache.

  Android AVDs normally live under ~/.android/avd, and a booted owned AVD can
  use several GB. \`worktree remove\` deletes the workspace's owned AVD; plain
  \`stop\` only shuts it down for reuse. Stim neither loads nor saves Quick
  Boot snapshots for owned AVDs, so every restart is a full boot but exit does
  not retain a large snapshot. \`gc\` prints the on-disk size beside an
  orphaned or stale owned Android AVD when its content directory can be read.

  So are the logs, and one of them is not small: build-ios.ndjson /
  build-android.ndjson hold the whole xcodebuild or gradle transcript at debug
  level, which for a cold build is tens of megabytes (74 MB measured on one
  first iOS build of a real app). They are worth that -- a build that fails at
  minute nine is unreadable any other way -- and they are per workspace, not
  global, so \`worktree remove\` reclaims them along with everything else in
  the global workspace directory. Each build starts its transcript file over, so the log
  holds one run and a workspace you keep building in does not accumulate them.

  Simulators are large and live in the CoreSimulator device set, not in your
  project. If the disk is filling up, Stim's own devices are usually not the
  bulk of it -- Apple's default simulators and old runtimes are. Useful:
    xcrun simctl delete unavailable     # sims for runtimes you removed
    xcrun simctl list devices           # see everything
    stim gc                           # report dead entries, orphans, caches
  Xcode recreates default simulators on demand, so deleting them is safe.

SHARED BUILD CACHES
  The caches that make a second workspace fast are alive by design and never
  included in a plain \`gc --delete\`. Every \`gc\` run reports them anyway,
  each row tagged (registered) or (detected), with its size:
    stim gc                            # report, caches included
    stim gc --delete --older-than 30   # trim entries nothing has used
    stim gc --delete --cache all       # empty them whole, index-backed ones
                                         # (the Xcode CAS) included
  The Gradle build cache under GRADLE_USER_HOME (default ~/.gradle) is
  report-only because every Gradle build shares it. Stim reports its size
  but never prunes or empties it, including with --older-than or --cache all.
  Trim rather than empty. Emptying costs the next build in every project the
  time the cache was saving.`,
  },

  settings: {
    summary: 'Settings Stim reads, and where they can live',
    body: () => `SETTINGS

There is no \`stim config\` command: Stim's commands take no device flags, so
settings are FILES, edited by hand or committed.

Resolution order, first match wins:
  1. project layer   ~/.stim/config.json, under this project's entry
  2. repo layer      ~/.stim/config.json, under this repo's git common dir
  3. committed       .stim.json at the repo root  <- normally the one you want
  4. Stim default

The committed file is plain JSON and is the only layer that travels with the
repo, so a device model or a carry-over rule every worktree should share
belongs there:

  {
    "ios": {
      "deviceType": "iPhone 17 Pro",
      "runtime": "26.2",
      "simslimProfile": ".simslim/dev.json"
    },
    "android": { "variant": "productionDebug" },
    "worktree": { "baseRef": "head" },
    "caches": ["~/.myapp-metro-cache"]
  }

KEYS STIM READS
  ios.deviceType        e.g. "iPhone 17 Pro" -- the simulator model this
                        workspace's owned sim is created as, spelled exactly as
                        \`xcrun simctl list devicetypes\` names it, and one an
                        installed runtime can create. The \`--device-type\`
                        flag overrides this per invocation. A name no installed
                        runtime offers is STIM_BAD_ARG and the creatable names
                        are printed
  ios.runtime           e.g. "26.2" -- the iOS runtime that sim is created on,
                        as a version ("26.2") or a runtime's full name
                        ("iOS 26.2"); nothing else matches. The \`--runtime\`
                        flag overrides this per invocation, and an uninstalled
                        version refuses the same way
  ios.configuration     e.g. "Release" -- the Xcode configuration to build
                        (simulator only). Committing
                        { "ios": { "configuration": "Release" } } makes every
                        \`stim ios\` in the repo a release-shaped build:
                        embedded JS, no Metro, cache keyed -release-sim, and
                        a JS-bundle swap on cache hits. The \`--configuration\`
                        flag overrides this per invocation. Unset means Debug.
  ios.remote            "proxy" or "eas" to use that remote backend, the same
                        as passing \`--remote proxy\` or \`--remote eas\`. The
                        build still runs here; only the device is elsewhere.
  ios.simslimProfile    a SimSlim JSON profile under the repository root (or
                        project root outside Git), at most 64 KiB. Install the
                        external tool once with
                        \`brew install mobai-app/tap/simslim\`. SimSlim requires
                        an iOS 18 or newer simulator. Each local \`stim ios\`
                        reconciles the profile on its Stim-owned simulator.
                        The first change can reboot it; a matching profile is a
                        fast no-op. Removing the setting restores stock services
                        when Stim applied the profile. Absolute paths, root or
                        symlink escapes, and missing files are refused before
                        simulator creation. Remote and unowned simulators are
                        never changed.
  ios.signingIdentity   e.g. "Apple Development: Jane (TEAMID5678)" -- the
                        keychain identity to re-seal a \`--device\` build with,
                        overriding the one Stim derives from the artifact's own
                        embedded.mobileprovision. Discovery is zero-config, so
                        this exists only for the case discovery cannot cover.
                        The name must be one \`security find-identity -v -p
                        codesigning\` prints.
  ios.signingIdentitySha1
                        the 40-character hex SHA-1 hash printed beside that
                        name. Set it when two certificates share one common
                        name: Stim is non-interactive, so it refuses an
                        ambiguous identity rather than picking one. It wins
                        over ios.signingIdentity.
  ios.lanHost           e.g. "192.168.1.42" -- the address a phone uses to
                        reach this workspace's Metro on an \`ios --device\`
                        Debug run, pinning the interface on a multi-NIC Mac
                        whose en0 is not the one the phone shares. A bare
                        address or hostname ONLY: never a scheme, a port, or a
                        URL, because the channels that carry it to the phone
                        (the dev-client deep link and the bundle's ip.txt)
                        compose the URL themselves. Unset means Stim orders the
                        host's non-internal IPv4 interfaces en0 first, then the
                        remaining en* by index -- react-native-xcode.sh's own
                        heuristic, so Stim and a plain Xcode run pick the same
                        interface.
  android.systemImage   e.g. "system-images;android-36;google_apis;arm64-v8a"
                        -- the sdkmanager package id the owned AVD is created
                        from. The \`--system-image\` flag overrides this per
                        invocation, and an id this SDK has not installed is
                        STIM_BAD_ARG with the installed ids printed
  android.dataPartitionSizeGb
                        whole GiB for a newly created owned AVD's data
                        partition. Defaults to 8; accepts 6 through 16384.
                        Existing AVDs are never resized because Android
                        userdata grows but does not shrink. Recreate the
                        environment to adopt a changed value.
  android.avdConfigFile
                        path under the repository root (or project root
                        outside Git) to a flat native key=value INI fragment,
                        at most 64 KiB. Stim parses it and
                        merges supported values into avdmanager's generated
                        config.ini before first boot; it is never used as a
                        replacement file. Absolute paths, repository or
                        symlink escapes, malformed or duplicate lines, and
                        unsupported keys are refused before AVD creation.
  android.avdConfig     flat object of the same native keys. It merges key by
                        key across settings layers and overrides the selected
                        avdConfigFile fragment. Boolean values accept true,
                        false, "yes", or "no"; numbers and enums are checked.
                        Supported keys and values:
${ANDROID_AVD_CONFIG_HELP.map((line) => `                          ${line}`).join('\n')}
                        Identity, architecture, host path, storage, image,
                        kernel, camera, snapshot, boot-lifecycle, and unknown
                        keys are protected. The emulator may normalize a valid
                        value. These overrides apply only to a newly created
                        AVD; existing and recovered AVDs are never rewritten.
                        On displayless Linux, Stim launches with
                        -gpu swiftshader_indirect -noaudio; those arguments
                        override hw.gpu.enabled, hw.gpu.mode, hw.audioInput,
                        and hw.audioOutput for that headless launch.
  android.variant       e.g. "productionDebug" -- the gradle variant to
                        assemble and install on a project with product
                        flavors. A repo like tlon-mobile with
                        flavorDimensions "profile" and production/preview
                        flavors has NO plain assembleDebug output: commit
                        { "android": { "variant": "productionDebug" } } and
                        \`stim android\` runs assembleProductionDebug,
                        finds the APK in apk/production/debug/ and keys the
                        build cache on the variant. The \`--variant\` flag
                        overrides this per invocation. Unset means plain
                        assembleDebug. A variant whose name ENDS IN Release
                        (\`release\`, \`productionRelease\`) is a release
                        build: embedded JS, no Metro, cache keyed on the
                        variant, and an APK re-pack on cache hits. See
                        \`guide lifecycle\`.
  android.keystore      the keystore a RE-PACKED release APK is signed with,
                        absolute or relative to the project root. Unset means
                        android/app/debug.keystore, which every RN and Expo
                        android project carries -- the right default, because
                        what this signs is a local emulator install and never
                        anything distributed. Set it only when the release
                        variant must be signed with the repo's own key.
  android.keystorePassword
                        the password for it. apksigner's SCHEMED form is
                        passed through unchanged (\`env:MY_KS_PASS\`,
                        \`file:/keys/pw.txt\`, \`stdin\`), which is how a
                        committed .stim.json avoids carrying a secret; a
                        bare string is used as the literal password. Unset
                        means the debug keystore's fixed "android".
  android.remote        "proxy" or "eas"; the Android half of ios.remote
  metro.tunnel          selects how a remote device reaches this workspace's
                        Metro after remote intent exists. Plain \`start\` stays
                        local. For Expo and bare React Native, "auto" (default)
                        first tries an authenticated and working ngrok.
                        After an auth refusal,
                        or any failure before ngrok returns a URL, it falls back
                        to cloudflared. "off" asserts the device
                        shares this machine and is the only mode that needs no
                        tunnel. "expo" lets the Expo dev server tunnel itself.
                        "cloudflared" and "ngrok" name a managed provider
                        explicitly. Any other value is refused as invalid.
  metro.ngrokUrl        the stable managed ngrok URL. It requires metro.tunnel
                        "ngrok" and passes --url to ngrok http. Stim owns
                        this process.
  metro.publicUrl       an existing tunnel's URL. Takes precedence over
                        starting one, whatever metro.tunnel says -- Stim
                        did not create it, so a Metro request through it is
                        still gated the same way a managed tunnel's is. Set it
                        before Expo start so the manifest advertises it.
  worktreeDir           where worktrees are created. A relative value resolves
                        against the settings root (the repository root), not the
                        current directory, so a committed .stim.json can place
                        worktrees inside the repo. worktree create --dir
                        overrides it for one run and resolves against the
                        current directory instead.
  worktree.baseRef      "head" (current HEAD) or "fresh" (origin/HEAD).
                        Unset means "head". It is a default, not an assertion:
                        only the --base FLAG triggers the
                        STIM_WORKTREE_BRANCH_EXISTS refusal, so a create that
                        finds an existing worktree-<name> still attaches to it
                        and says which ref was not applied.
  worktree.include      carry-over patterns, same role as .worktreeinclude
  worktree.exclude      additional --carry-ignored skip list, same role as
                        .worktreeexclude. Registered nested Git worktrees are
                        always skipped.
  cache.provider        one optional SECOND-TIER cache provider: a module
                        path relative to the settings file that names it, or a
                        package name. It implements the @stim-cli/cache
                        contract and can serve Metro transforms, native build
                        artifacts, or both. The local filesystem stays tier
                        one; a provider is read only after a local miss and
                        written after the local write. Failures and timeouts
                        are cache misses, never build or bundle failures.
                        Stim ships no provider and never configures one.
                        This module is EXECUTABLE CODE that every worktree on
                        this repository runs; review a committed value the way
                        you review a build script.
                        \`stim ios\` and \`stim android\` always use it. Metro
                        uses it only when the project's own metro.config.js
                        calls \`sharedCacheStores()\` from @stim-cli/metro: the
                        store Stim injects for you (bare in-process, or the
                        Expo config override) stays local-only.
  cache.options         free-form object handed to that module's factory. It
                        merges key by key across settings layers. Keep secrets
                        out of the committed file: read them from the
                        environment or the machine layers.
  caches                extra shared-cache paths for \`gc\` to report. A JSON
                        array; every path is treated as a flat store.

Every key above takes ONE type: a string, an array of strings, a number, or,
for android.avdConfig and cache.options, an object. A value of the wrong type is
refused by name on every command that resolves settings, so a wrong shape never
falls back to a default silently. \`stim doctor\` reports it as a finding
instead of refusing.

Anything else is IGNORED, and Stim warns about it by name on every run that
resolves settings. If you see such a warning, the key was either renamed or
removed -- check this list rather than assuming it still applies.

CONCURRENCY LIMITS ARE MACHINE-LEVEL, NOT A PER-PROJECT SETTING
The caps above are not in the layered settings -- they are not per-project,
because the resource they share (cores, RAM, booted simulators) is the whole
machine's. They live under a top-level \`concurrency\` key in
~/.stim/config.json, edited by hand:

  {
    "concurrency": { "maxBuilds": 2, "maxDevices": 3 }
  }

or via the environment, which overrides the file:

  STIM_MAX_BUILDS=2 STIM_MAX_DEVICES=3 stim ios

Unset, 0, or any non-positive value means NO enforcement -- the default, where
Stim limits nothing. See \`guide lifecycle\` for what each cap does.

THE SIMULATOR POOL BOUND IS MACHINE-LEVEL TOO
\`pool.iosParkedMax\` caps how many parked simulators \`worktree remove\` may
leave behind for a later workspace to adopt. It is machine-level for the same
reason: the disk they sit on is the whole machine's, about 2.5 GB each.

  {
    "pool": { "iosParkedMax": 3 }
  }

in ~/.stim/config.json, or STIM_POOL_IOS_PARKED_MAX in the environment, which
overrides the file. Absent means 3. \`0\` turns parking and adoption off:
\`worktree remove\` deletes the simulator, \`ios\` never adopts, and a pool
that already exists stays where it is until \`gc --delete\`. A value that is
not a whole number 0 or more is refused by name on \`worktree remove\` and
\`ios\`, and warned about by \`status\`, \`gc\` and \`doctor\`.

When STIM_HOME is set, parking and adoption are OFF unless
STIM_POOL_IOS_PARKED_MAX is set too. A redirected home is a scoped config --
test suites and the end-to-end harness use one -- and a scoped config must not
leave simulators on the machine it cannot account for. A redirected home that
wants a pool says so with the variable.

STIM NEEDS NO PROJECT CHANGES TO RUN
Nothing above is required to use Stim. The performance caches that used to
be setup steps are supplied by Stim on the command lines it composes itself:

  xcodebuild   COMPILATION_CACHE_ENABLE_CACHING / COMPILATION_CACHE_CAS_PATH /
               SWIFT_ENABLE_COMPILE_CACHE / CLANG_ENABLE_PREFIX_MAPPING /
               CLANG_OTHER_PREFIX_MAPPINGS -- so no Podfile post_install block
               (Xcode 26+ only, and skipped when the project configured ccache,
               which defeats it)
  gradlew      --build-cache -- so no org.gradle.caching=true in a committed
               gradle.properties
  start        a shared Metro FileStore, APPENDED to whatever the project
               configured -- so no metro.config.js. On a bare project Stim
               hosts Metro itself and adds it to the config it loaded; on Expo
               SDK 54+ the child loads Stim's config adapter through
               EXPO_OVERRIDE_METRO_CONFIG. Expo SDK 53 and older run with
               their normal Metro cache.

Each of those prints one dim line saying it happened. There is no setup skill
and no init command; \`stim doctor\` reports the project-side settings as
things you need only if you ALSO build outside Stim.

TURNING THE METRO STORE OFF (MACHINE-LEVEL)
The Expo injection is the invasive one, so it has a switch -- and the switch is
machine-level, because a committed file would be exactly the repo change this
feature exists to avoid:

  {
    "caches": { "injectMetroStore": false }
  }

in ~/.stim/config.json. It turns the store off on BOTH dev servers. Only the
literal false does; anything else leaves it on. The Expo adapter also fails
soft when it cannot create a FileStore: it writes one line to stderr (which
lands in the timeline) and the dev server runs with whatever cache it would
have had.

Reading the timeline for it: on Expo, \`cache_store_requested\` is Stim saying
it asked (it set EXPO_OVERRIDE_METRO_CONFIG on a process it does not run, which
is all this side can know), and \`cache_store_added\` is the adapter reporting
from inside that process that the store is in the config Metro loaded. Only the
second one means transforms are being shared. A bare project writes
\`cache_store_added\` directly, because there Stim adds the store itself.

CACHE LOCATIONS ARE MACHINE-LEVEL TOO
The shared build cache and Metro transform cache default to living under
~/.stim. To relocate them (say, to an external disk), set a top-level
\`caches\` key in ~/.stim/config.json, edited by hand -- absolute paths:

  {
    "caches": { "buildCache": "/Volumes/SSD/stim/build-cache",
                "metroCache": "/Volumes/SSD/stim/metro-cache" }
  }

STIM_BUILD_CACHE / STIM_METRO_CACHE in the environment override the file.
The CLI and both cache packages resolve these identically, so every process
finds the same store regardless of shell profile. A relative path is ignored.
The Metro value is a PARENT root. The sanitized package name is appended below
it, so apps remain separately reportable and prunable. Earlier releases used an
overridden Metro root as one flat store. A new registration replaces that legacy
parent entry and marks the named layout. If an older package registers it again,
current gc ignores the exact unmarked legacy parent while a marked child exists.
A marked store that later becomes another override parent remains visible but is
report-only while its marked child exists. Root-level legacy files remain
untouched for manual cleanup.

PREFER SELF-REGISTRATION OVER THE 'caches' SETTING
There is no 'cache' command. A cache registers itself from code instead, once,
and every 'gc' report shows it from then on, tagged (registered):

  import { register } from 'stim-cli/cache-manifest';
  register({ dir: '<dir>', name: '<what to call it>', entriesDepth: 2 });

entriesDepth is how far below dir one entry sits (default 1, a flat store).
Pass 2 for a root with a layer of grouping above the entries -- a Metro
FileStore shards across 256 directories, a build cache is keyed
<platform>/<key> -- or 'gc --delete --older-than N' removes a whole shard or
platform instead of one entry. Pass prune: 'atomic' for a cache whose index
references its own data (an LLVM CAS): it is then left alone by --older-than
and emptied whole only by 'gc --delete --cache all'.
Registration is idempotent and keyed on the directory.`,
  },
};

export function topicNames(): string[] {
  return Object.keys(TOPICS);
}

const COMMAND_NOTATION = 'Commands use `stim`. If it is not installed globally, replace `stim` with `npx stim-cli`.';

export function renderTopic(name: string): string | null {
  const topic = TOPICS[name];
  if (!topic) return null;
  return `${COMMAND_NOTATION}\n\n${topic.body()}`;
}

export function renderIndex(version: string): string {
  const lines = [
    `stim ${version} -- reference for the binary you are running.`,
    '',
    COMMAND_NOTATION,
    '',
    'This output is generated by the CLI, so it always matches this version.',
    'The bundled skill routes coding agents to the agent topic. Other topics',
    'carry the detailed command contracts and remedies.',
    '',
    'TOPICS',
  ];
  const width = Math.max(...topicNames().map((n) => n.length));
  for (const name of topicNames()) {
    lines.push(`  ${name.padEnd(width)}  ${TOPICS[name]?.summary ?? ''}`);
  }
  lines.push('', 'Read one with:  stim guide <topic>');
  return lines.join('\n');
}

export default function guideCommand(program: Command, version: string): void {
  program
    .command('guide [topic]')
    .description(
      'Print reference documentation for THIS version of Stim (topics: ' +
        topicNames().join(', ') +
        '). Generated by the binary, so it cannot drift from the installed CLI.',
    )
    .action((topic) => {
      if (!topic) {
        console.log(renderIndex(version));
        return;
      }
      const body = renderTopic(topic);
      if (!body) {
        console.error(chalk.red(`Unknown topic "${topic}".`));
        console.error(chalk.dim(`Available: ${topicNames().join(', ')}`));
        process.exit(1);
      }
      console.log(body);
    });
}
