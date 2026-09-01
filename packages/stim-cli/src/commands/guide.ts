import chalk from 'chalk';
import type { Command } from 'commander';
import { ANDROID_AVD_CONFIG_HELP } from '../settings.ts';

interface GuideTopic {
  summary: string;
  body: () => string;
}

const TOPICS: Record<string, GuideTopic> = {
  facts: {
    summary: 'The --json payloads: `start`, `ios`, `android`, and the error contract',
    body: () => `FACTS CONTRACT

Every command with \`--json\` prints exactly ONE line of JSON on stdout. Every
other line goes to stderr, so it is always safe to pipe.

  stim start --json

  port            the Metro port RESERVED for this workspace
  supervisorPid   the detached supervisor's pid, or NULL when a dev server was
                  already answering that Stim did not start
  mode            "bare-inproc" | "expo-child" | null (see \`guide metro\`)
  logsDir         where the NDJSON timeline is written
  alreadyRunning  true when nothing needed starting

  stim ios --json

  platform        "ios"
  udid            the owned simulator this workspace installed onto
  deviceName      its name, or null
  fingerprint     the @expo/fingerprint hash of the native inputs, AS STORED.
                  A run that had to \`expo prebuild\` or \`pod install\`
                  rewrote fingerprinted files while it worked (the generated
                  native directory, package.json's scripts, the app config,
                  Podfile.lock), so the hash it looked up is not the hash the
                  tree has afterwards. The artifact is stored under the hash
                  computed AFTER those steps -- the one the next run in this
                  tree computes -- and this field reports that one. The shift
                  is printed on stderr as one dim line naming both short
                  hashes; no shift, no line, and no second fingerprint.
                  A shift is RE-LOOKED-UP before anything compiles (\`cache
                  hit under the post-prebuild key\`), so a cold tree -- a
                  fresh worktree or clone of a CNG app -- installs an entry
                  another workspace already built instead of compiling
                  beside it
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
                  launch (see \`guide lifecycle\`). false means an install ran
  launched        true, "bundling", or "unverified". THE THREE ARE DIFFERENT
                  FACTS and only the last one is a problem.
                    true         Metro finished the bundle, then the app stayed
                                 alive through a three-second stability window.
                                 The command checks process liveness when the
                                 platform exposes it. Errors from that window
                                 are printed even when the app stays alive; the
                                 agent decides whether a nonfatal error matters
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
                  Before a local dev-client openurl, Stim preapproves
                  CoreSimulatorBridge for exactly the installed bundle id and
                  discovered scheme on its owned simulator. That suppresses
                  iOS's first-launch confirmation; unrelated schemes remain
                  unapproved. It also finishes Expo dev-menu onboarding and
                  disables the menu's automatic launch, so device automation
                  opens on the app. The unverified warning therefore leads
                  with the picker, then prints the openurl retry. On ANDROID the list
                  leads with the dev-client deep link (\`am start -a
                  android.intent.action.VIEW -d '<devClientUrl>'\`), which is
                  the whole answer when the app has a scheme.
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
                  \`emulator -avd\`, avdmanager, or a device tool
  deviceName      the same name, matching the iOS payload's field
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
    stim-<label>. The exceptions are \`android --device\` and
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

NOTHING MATCHING IS EXIT 0. \`stim logs --errors\` finding nothing is the
pass condition of a build loop, so an empty result must never read as a
failure. Precisely what that looks like: STDOUT IS EMPTY, exit code 0, and
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
  has always shown everything.

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

  OUTPUT. --errors prints at most 20 records and then a "... and N more" line.
  N is exactly what \`--tail N\` prints, because what was held back IS the
  tail. --json is never capped, and neither is an explicit --tail.

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
                       --errors leaves this source out unless asked.
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
  space. COLLISION means the readable-name-plus-digest directory already has a
  workspace.json for a different canonical project path; do not overwrite it
  until you identify which workspace owns it.

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
  NOT fail: it prints a \`js swap\` / \`apk swap  failed at <step>: ... --
  building fresh instead\` note on stderr and falls back to a full build. If
  the run then fails, the code is the build's own (STIM_BUILD_FAILED etc.);
  the swap note above it says why the cache hit was not used. A swap that
  merely finds no hermesc notes it and embeds the plain JS bundle instead --
  that is a note, not a fallback.

  ANDROID'S ASSET GATE is the second, and it is not a failure at all. Before
  re-packing, Stim compares this workspace's freshly emitted asset tree
  against the assets the cached APK carries. Any added, removed or changed
  asset prints

    apk swap    this workspace's asset set differs from the cached APK's
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

STIM_BUILD_WAIT_TIMEOUT
  This run was waiting for ANOTHER workspace's build of the same fingerprint
  (see \`guide lifecycle\`), and after ~90 minutes that process was still alive
  and had still produced nothing. A wait is normally bounded by the builder
  being alive at all -- a crash or a kill frees it within a second -- so this
  means a genuinely wedged xcodebuild/gradle, not a slow one. The message names
  the pid and the lock directory: check the pid, and if it is not really
  building, remove that directory and run the command again.

STIM_INSTALL_FAILED
  The artifact built or came from cache, but \`simctl install\` / \`adb install\`
  refused it. A signature or architecture mismatch, or a full device.
  On Android a signature or downgrade conflict names the package that is really
  installed -- the built APK's applicationId, which on a flavored project is
  the flavor's id and not the gradle namespace -- and gives you the
  \`adb -s <serial> uninstall <applicationId>\` that clears it. Re-running after
  that is a cache hit: one install, no build.

STIM_LAUNCH_FAILED
  Installed, but the app would not start. On Android this usually means no
  launchable activity resolved.

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
  The command refused before doing anything: an unusable --wait value, an invalid
  Metro tunnel setting, an invalid android.dataPartitionSizeGb value, an unsafe
  android.avdConfig key or fragment, a malformed ios.signingIdentity,
  ios.signingIdentitySha1 or ios.lanHost value, \`--device\` with an empty
  serial or UDID, \`--device\` together with \`--remote\`, a working directory
  with no package.json above it, or an android/app/build.gradle that
  declares product flavors with
  no variant selected (the refusal names the debug variants).
  \`ios --device\` also refuses HERE after a successful build, because it
  selects a phone and builds the iphoneos slice for it but cannot yet install
  onto one; the message names the cache key the artifact was stored under.
  These errors are caught before the port is reserved and before anything is
  spawned, so nothing was started.

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

"metro: refusing to kill port <n>: ... runs from <dir>, outside <project>"
  (stop) Stim will not kill a process it cannot attribute to you.
  \`stim stop --force\` kills it without proving whose it is -- ask the user
  first. That flag is reachable only when no supervisor is recorded for this
  workspace, and it never deletes anything.

"supervisor: refusing to signal pid <n>: ..."  (stop)
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

"Refusing to create <name>: the branch worktree-<name> already exists at <sha>,
but --base <ref> resolves to <sha>"  (worktree create)
  \`git worktree add\` attaches to an existing branch and ignores the base, so
  the worktree would not be based on what you asked for. Stim keeps branches
  it did not create and branches with unique commits. Either pick another
  name, or \`git branch -D worktree-<name>\` and retry. Without --base,
  attaching is still the behaviour: nothing was promised about the tip.

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

"Carried <dir>/Pods does not match <dir>/Podfile.lock"  (worktree create)
  \`ios/Pods\` is gitignored, so --carry-ignored clones it; \`ios/Podfile.lock\`
  is tracked, so it comes from the branch. When the source worktree's two
  disagree, the new worktree inherits the contradiction. \`stim ios\` detects
  this and runs \`pod install\` for you; the note is there so a build you run
  yourself does not fail in its LAST phase with
    error: The sandbox is not in sync with the Podfile.lock

"Warm source not carried: ... For the next worktree, use: stim worktree create
<name> --carry-ignored"  (worktree create)
  A plain create found installed dependencies, CocoaPods, or native build output
  in the source. The new worktree stays clean. Use the printed command for the
  next worktree to clone that warm state.

"Carried warm state: dependencies=..., CocoaPods=..., native build output=..."
  The line reports each useful warm category. The following copy-mode line says
  whether APFS used a copy-on-write clone or Stim made a full byte copy.

"Dependencies were not carried. Run ... before building."
  The source has no node_modules to clone. Run the printed package-manager
  command in the new worktree.

"Carried N uncommitted change(s) from the source (...) -- uncommitted here
too; commit deliberately."  (worktree create --carry-ignored)
  The source tree had uncommitted tracked changes, and the cloned artifacts
  were installed against that working tree -- so the same changes were applied
  to the new worktree as a patch, still uncommitted. Whether they belong in a
  commit is your call; the tool never commits for you.

"Could not carry the source's uncommitted changes (...)"  (worktree create
--carry-ignored)
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
  cd "$(stim worktree create app-412 --carry-ignored)"

  # 2. The dev server, under a detached supervisor. Blocks until it is
  #    verifiably THIS project's, then hands your shell back.
  stim start
    port       8082 (reserved)
    supervisor pid 41233

  # 3. Owned device booted, native inputs fingerprinted, cached build
  #    installed (or built), app launched wired to port 8082, device-log
  #    collector attached.
  stim ios          # or: stim android
    device      stim-app-412 (BF2A..) booted (9s)
    fingerprint a3f9b1.. hit (2s)
    install     from cache (3s)
    launch      com.example.app (1s)

  # 4. Did it work? Exit 0 is the pass condition. Human mode prints a
  #    "No matching log records" note on stderr when the result is clean.
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

AN ARTIFACT THE DEVICE ALREADY HOLDS IS NOT INSTALLED AGAIN
  Both platforms store the artifact verbatim, so its hash is its identity.
  Before installing, Stim hashes the artifact it is about to install and the
  one the device already has -- \`pm path\` then \`sha256sum\` on Android, the
  \`simctl get_app_container\` bundle on iOS. Byte-identical means the install
  is skipped and the run goes straight to launch, which is under a second
  instead of the ~43s a 400MB APK costs over USB.

    install     skipped; emulator-5584 already holds this APK (0.4s)

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
no setup skill to run. \`stim doctor\` is the read-only second opinion when
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

WHAT MAKES THE CACHE ACTUALLY HIT: .FINGERPRINTIGNORE
  Every entry is keyed on what the tree hashes, so two workspaces share an
  entry only when they hash alike. A file that changes without changing the
  BUILD is what breaks that, and it fails silently -- a cache that never hits
  looks exactly like a cache that is not there.

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
  ios             --json --no-metro-check --no-build-cache --configuration <name> --device [udid] --remote <proxy|eas>
  android         --json --no-metro-check --no-build-cache --variant <name> --device [serial] --remote <proxy|eas>
  logs            --source --level --since --grep --tail --follow --errors --json
  stop            --json --force
  status          --json          (already machine-wide)
  gc              --delete --older-than <days> --cache <name|all>
  worktree create <name> --carry-ignored --base <ref> --label <label>; remove [path] --force

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

  \`android --device [serial]\` installs and launches on a physical device
  connected to this machine instead of this workspace's owned emulator. With
  no serial it uses the one connected device, and refuses with the candidate
  list when adb reports several. It cannot be combined with --remote.

  The build, the fingerprint, the build cache and the Metro port gate are
  unchanged. What is skipped is everything that manages an owned device:
  no capacity check, no AVD creation, no boot wait, and no device record --
  so \`stop\` and \`gc\` never touch the phone. The app is pointed at
  localhost:<port>, which the adb reverse serves, instead of the emulator's
  10.0.2.2. Stim never creates, boots, shuts down, or deletes hardware.

  \`ios --device [udid]\` selects a connected iPhone, the same way
  \`android --device\` selects a connected phone: with no UDID the one
  connected device is used, several is a refusal listing them, and an iPhone
  that is unpaired or has Developer Mode off is refused with the fix. It
  cannot be combined with --remote, and it never creates, boots, or deletes
  hardware -- there is no capacity check, no simulator creation, no boot wait,
  and no device record, so \`stop\` and \`gc\` never see the phone.

  IT IS NOT FINISHED. Today it builds the \`iphoneos\` slice for the selected
  phone -- \`-sdk iphoneos\`, the project's own signing settings, cache key
  \`<fingerprint>-<configuration>-device\` so a device app can never collide
  with a simulator one -- stores that artifact, and then REFUSES with
  STIM_BAD_ARG, because installing and launching on hardware are not wired yet
  (appandflow/stim#178). Use it to prove a project signs for a device and to
  warm the device cache; use \`stim ios\` with no --device for a run that ends
  with an app on screen.

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
  machine, not just this one.`,
  },

  cleanup: {
    summary: 'Where simulators come from, and how they get reclaimed',
    body: () => `CLEANUP AND DISK

WHAT RECLAIMS AN OWNED DEVICE
  stim worktree remove    deletes every owned device under the worktree
  stim gc --delete        sweeps stim-* devices no project references
  stim gc --delete --older-than <days>
                            also reaps the device of a project nothing has
                            touched in that long, even though the project is
                            still on disk

Those are the only two commands that delete. \`stim stop\` shuts a device
DOWN and leaves it assigned, which is what makes returning to a branch cost a
boot rather than a create, a provision and a reinstall.

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
  ios.deviceType        e.g. "iPhone 17 Pro"
  ios.runtime           e.g. "26.2"
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
  worktreeDir           where worktrees are created
  worktree.baseRef      "head" (current HEAD) or "fresh" (origin/HEAD).
                        Unset means "head".
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
    'The bundled skill covers the stable rules; these topics cover the surface',
    'that changes between releases.',
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
