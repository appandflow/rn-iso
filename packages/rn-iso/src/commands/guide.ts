// src/commands/guide.js
//
// Version-matched reference documentation, printed by the binary itself.
//
// Why this exists: skill/SKILL.md ships through `npx skills add` (GitHub) while
// the CLI ships through npm, with no version relationship between them. A user
// reported running a newer CLI against an older skill and not noticing. Docs
// that live only in the skill drift silently.
//
// The split is by VOLATILITY, not by length. The skill keeps what makes an
// agent trigger correctly and behave safely -- the ownership model, the
// destructive-command rules, the parallel-agent rules. Everything that changes
// per release -- exact flags, payload shape, error remedies -- lives here, so
// `npx rn-iso@latest guide facts` always describes the binary the agent is
// about to run.
import chalk from 'chalk';
import type { Command } from 'commander';

// One reference topic: a one-line summary for the index and a lazy body
// renderer. Typed as a Record so `TOPICS[name]` is a keyed lookup (returns
// undefined for an unknown topic, which renderTopic/renderIndex guard).
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

  npx rn-iso start --json

  port            the Metro port RESERVED for this workspace
  supervisorPid   the detached supervisor's pid, or NULL when a dev server was
                  already answering that rn-iso did not start
  mode            "bare-inproc" | "expo-child" | null (see \`guide metro\`)
  logsDir         where the NDJSON timeline is written
  alreadyRunning  true when nothing needed starting

  npx rn-iso ios --json

  platform        "ios"
  udid            the owned simulator this workspace installed onto
  deviceName      its name, or null
  fingerprint     the @expo/fingerprint hash of the native inputs
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
  cacheSkipped    true only when --no-build-cache was passed: "nothing was
                  looked up", which is a different fact from "nothing was found"
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
  launched        true, or "unverified" when no bundle request from this app
                  reached this workspace's Metro within ~20s of the launch
                  (an iOS 26 confirmation alert gating simctl openurl -- it
                  appears on EVERY first launch on a fresh sim -- or a
                  dev-client server picker awaiting a tap). The warning on
                  stderr is a numbered list in the order that clears it:
                  confirm the alert first, then the picker, and only with no
                  alert showing, the openurl retry it prints. On ANDROID
                  there is no alert, so the list leads with the dev-client
                  deep link (\`am start -a android.intent.action.VIEW -d
                  '<devClientUrl>'\`), which is the whole answer when the app
                  has a scheme.
  metroPort       the port the app was wired to; NULL on a non-Debug
                  configuration, whose JS is embedded and which is launched
                  with no dev server at all. There, \`launched\` is verified
                  by the app process staying alive after launch (a bad
                  embedded bundle crashes within seconds), not by a bundle
                  request -- "unverified" means the process died or could not
                  be checked, and \`rn-iso logs --errors\` has the device
                  log that says why
  logs            { dir }
  durationMs      wall time for the whole run

  npx rn-iso android --json

  platform        "android"
  serial          the owned emulator (always "emulator-<consolePort>")
  avdName         the AVD's NAME (rn-iso-<label>). The serial is a slot --
                  emulator-5554 is whatever booted into that console port
                  first -- so this is what addresses the emulator in
                  \`emulator -avd\`, avdmanager, or a device tool
  deviceName      the same name, matching the iOS payload's field
  fingerprint / cacheHit / cacheSkipped / waitedForBuild / appPath / launched
                  as above
  variant         the gradle variant that was built ("productionDebug" from
                  --variant or the android.variant setting); null for the
                  default assembleDebug
  bundleId        the ANDROID PACKAGE NAME the launch, the port wiring and
                  the remedies all target -- read from the BUILT APK's
                  manifest, which on a flavored project is the flavor's
                  applicationId, not what the project files say
  debugHttpHost   "10.0.2.2:<port>" when the app's SharedPreferences were
                  pointed at this workspace's Metro, null when they were not
                  (Contract 6's Android half; the adb reverse still covers
                  the app's compiled-in 8081)
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

    { "code": "RN_ISO_NO_METRO", "message": "...", "remedy": "..." }

  Branch on \`code\`, never on the message text. \`guide errors\` enumerates
  every code.

RULES
  - Never hardcode or guess a udid/serial/port. Read them from the payload.
  - Pass them EXPLICITLY to every device tool you drive yourself
    (agent-device, xcrun simctl, adb -s, idb).
  - Never assume "booted" is your simulator. Other agents have theirs booted
    too.
  - There is no physical-device support. Every device rn-iso touches is one
    rn-iso created, named rn-iso-<label>.`,
  },

  metro: {
    summary: 'The dev server: `rn-iso start`, the supervisor, and starting your own',
    body: () => `THE DEV SERVER

  npx rn-iso start

Reserves (or reuses) this workspace's Metro port, starts the dev server under a
detached SUPERVISOR, and waits until it both answers AND verifies as this
project's before exiting. You get your shell back with a bundler running: no
backgrounding idiom, no sleep, no poll loop, and no chance of building against
another worktree's bundler.

  --json            one line of facts on stdout, everything else on stderr:
                      { port, supervisorPid, mode, logsDir, alreadyRunning }
  --wait <seconds>  how long to wait for the server to answer (default 60)

Two flags, deliberately. Anything a project needs beyond them is the project's
own bundler command, which is not rn-iso's judgment to make.

IDEMPOTENT
  A healthy dev server on the reserved port is a no-op: \`start\` prints the
  facts with alreadyRunning: true and starts nothing. A foreign process holding
  the reserved port moves the RESERVATION instead, so the project is never
  stranded on a port it can never use.

WHAT THE SUPERVISOR IS
  One detached process per workspace. There is no machine-wide daemon, nothing
  to install, and no cross-project state. It hosts the dev server, writes its
  output as NDJSON into <root>/.rn-iso/logs (see \`guide logs\`), and records
  itself in <root>/.rn-iso/state.json before it starts serving. Two modes,
  chosen by ecosystem detection:

    bare-inproc  bare React Native: Metro is hosted INSIDE the supervisor,
                 from the project's own node_modules, with rn-iso's reporter
                 attached. Bundler events, in-app console logs and redboxes
                 all arrive structured.
    expo-child   Expo: the project's own \`expo start --port <port>\` runs as
                 a child and its stdout is parsed into records. Levels are
                 INFERRED from each line, so those records carry raw: true.

  \`rn-iso status\` reports the pid, the mode, and whether it is answering.
  \`rn-iso stop\` is the inverse of \`start\`: it halts the supervisor, reaps
  the device-log collectors, shuts the owned device down (never deletes it)
  and frees the port.

  ENVIRONMENT: the supervisor -- and through it the dev server, including a
  metro.config.js evaluated inside the expo child -- inherits the environment
  of the \`start\` call that SPAWNED it. A later \`start\` that finds a healthy
  supervisor is a no-op and cannot change a running supervisor's env: to apply
  a new env var, \`stop\` first, then \`start\` with it set.

  The supervisor's own stdio goes to .rn-iso/logs/supervisor.log, which is NOT
  part of the NDJSON timeline. It is what a supervisor that died before it
  could write a structured record leaves behind. In expo-child mode the child's
  output is parsed into the TIMELINE instead, so a dev server that dies on a
  config error leaves supervisor.log empty and its death cry in metro.ndjson.
  A failed \`start\` quotes both for you: the supervisor.log tail when it has
  one, and this attempt's error records from the timeline.

STARTING YOUR OWN BUNDLER STILL WORKS
  A dev server YOU started is detected and left alone: \`start\` reports it
  with supervisorPid: null and mode: null, exits 0, and starts nothing over it.
  Starting a second bundler on a working one is the actual failure.

  Start it from INSIDE the project directory, on the reserved port, or nothing
  can attribute it to you:

    Expo                      npx expo start --port <port>
    Bare React Native         npx react-native start --port <port>
    Has its own start script  run it and append --port <port>; it may carry
                              flags that matter (e.g. --client-logs)
    Monorepo                  run from the APP directory, not the repo root

  The reserved port comes from \`rn-iso status\` or from a previous
  \`start --json\`. Then \`rn-iso ios\` accepts it: its Metro gate checks that
  the process on the port answers /status AND runs from inside this project,
  and yours does.

  The cost is logs. rn-iso captures only a dev server it hosted, so
  \`rn-iso logs\` stays empty -- which is indistinguishable from a clean run --
  and finding output is back to redirecting it to a file yourself. Prefer
  \`start\`.

  The same identity check governs teardown: started elsewhere, \`stop\` refuses
  to kill it without \`--force\`.`,
  },

  logs: {
    summary: 'Querying the merged NDJSON timeline, and what --errors means',
    body: () => `LOGS

  npx rn-iso logs [filters]

Reads every *.ndjson file in <root>/.rn-iso/logs, merges them into one timeline
ordered by timestamp, prints what matches, and EXITS. The file set is
discovered, not enumerated.

NOTHING MATCHING IS EXIT 0. \`rn-iso logs --errors\` printing nothing is the
pass condition of a build loop, so an empty result must never read as a
failure. The only exit-1 paths are a malformed query and no project.

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
  The metro stream carries exactly one demotion of its own, and it is rn-iso's
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

  \`rn-iso status\` reports the same count per workspace, as
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

  Only a dev server rn-iso hosted is captured. If you started the bundler
  yourself, the metro and client sources stay empty -- which is not a sign of a
  clean build. The device and build sources are written either way, because
  \`ios\` / \`android\` produce them.

  A collector is killed and replaced on the next \`ios\` / \`android\` run for
  that platform, and reaped by \`stop\`.`,
  },

  errors: {
    summary: 'Every refusal rn-iso can print, and what to do about it',
    body: () => `WHAT RN-ISO REFUSES, AND WHY

Every refusal from \`ios\` / \`android\` carries a stable CODE. Branch on the
code, never on the message.

--- BUILD-PATH CODES (\`rn-iso ios\` / \`rn-iso android\`) ---

RN_ISO_NO_METRO
  Nothing that could be proven to be THIS workspace's dev server holds the
  reserved port -- or no port is reserved at all. The gate fires in about a
  second, before the device is even booted, rather than after four minutes of
  compiling an app that could not load a bundle. Run \`rn-iso start\` first.
  \`--no-metro-check\` overrides it and wires the app to the reservation (or to
  8081 when there is none). A non-Debug \`ios --configuration\` never emits
  this: a release-shaped build embeds its JS, so the gate does not run at all.
  A port held by SOMETHING ELSE reports what: usually a bundler started from
  the wrong directory (the repo root instead of the app dir in a monorepo), or
  another repo's Metro. Restart it from inside the project, or free the port
  and run \`rn-iso start\` to get a fresh reservation.

RN_ISO_NO_FINGERPRINT
  \`@expo/fingerprint\` is not resolvable from the project or from rn-iso, so
  the shared build cache cannot be addressed. Install it in the project:
  \`npm i -D @expo/fingerprint\`. It works on a bare project too. This is a
  refusal rather than a silent full build because an unaddressable cache means
  every workspace on the commit compiles from scratch, forever.

RN_ISO_PREBUILD_FAILED
  \`expo prebuild\` could not generate the missing native directory. The
  extracted output is above the code; the transcript is in
  .rn-iso/logs/build-<platform>.ndjson.

RN_ISO_DEPS_FAILED
  \`pod install\` (iOS) or the gradle dependency sync (Android) failed. On iOS
  this runs only when Podfile.lock and Pods/Manifest.lock disagree, or Pods is
  absent -- which is exactly what a carried worktree produces.

RN_ISO_BUILD_FAILED
  xcodebuild or gradle failed. The EXTRACTED diagnostics are printed (capped),
  not the transcript. Read the log path on the next line for the rest.
  Three Android refusals share this code without gradle itself failing:
  - MORE THAN ONE debug APK under android/app/build/outputs/apk and nothing
    configured to pick one (a project with product flavors, several flavors
    already built). rn-iso will not guess which flavor to install: the
    refusal lists the candidates -- pass \`--variant <name>\` or set the
    android.variant setting (e.g. "productionDebug") to the one you want.
  - NO APK for the configured variant: the android.variant / --variant value
    does not name a real variant (\`./gradlew :app:tasks\` in android/ lists
    the assemble tasks).
  - A STALE APK: the build succeeded but the APK's mtime predates the build
    that just ran, so it is an artifact this run did not produce (a copied
    build/ directory, a carried worktree). Delete
    android/app/build/outputs/apk and run again.

ONE FALLBACK NOTE THAT IS NOT A CODE (\`ios --configuration Release\`)
  On a Release cache hit rn-iso regenerates this workspace's JS bundle into a
  copy of the cached .app before installing it. When any step of that swap
  fails (the bundle command, hermesc, the re-sign), the run does NOT install
  the cached artifact -- its baked-in JS is the builder's, not yours -- and
  does NOT fail: it prints a \`js swap  failed at <step>: ... -- building
  fresh instead\` note on stderr and falls back to a full build. If the run
  then fails, the code is the build's own (RN_ISO_BUILD_FAILED etc.); the
  swap note above it says why the cache hit was not used. A swap that merely
  finds no hermesc notes it and embeds the plain JS bundle instead -- that is
  a note, not a fallback.

RN_ISO_BUILD_WAIT_TIMEOUT
  This run was waiting for ANOTHER workspace's build of the same fingerprint
  (see \`guide lifecycle\`), and after ~90 minutes that process was still alive
  and had still produced nothing. A wait is normally bounded by the builder
  being alive at all -- a crash or a kill frees it within a second -- so this
  means a genuinely wedged xcodebuild/gradle, not a slow one. The message names
  the pid and the lock directory: check the pid, and if it is not really
  building, remove that directory and run the command again.

RN_ISO_INSTALL_FAILED
  The artifact built or came from cache, but \`simctl install\` / \`adb install\`
  refused it. A signature or architecture mismatch, or a full device.

RN_ISO_LAUNCH_FAILED
  Installed, but the app would not start. On Android this usually means no
  launchable activity resolved.

RN_ISO_NO_SCHEME
  No buildable Xcode scheme was found in ios/. A scheme has to be shared to be
  visible to xcodebuild.

RN_ISO_NO_DEVICE
  The owned simulator/emulator could not be created or could not reach a booted
  state. \`rn-iso doctor\` checks the toolchain; \`rn-iso status\` says what
  rn-iso thinks it owns. Re-running the command creates a fresh owned device
  when the recorded one is gone.

RN_ISO_AT_CAPACITY
  Only when concurrency.maxDevices is set (it is UNSET by default, so this never
  fires unless you opted in). Booting a NEW owned device would exceed the cap:
  the machine already has that many rn-iso-owned devices booted. It is a refusal, not
  a queue -- \`ios\`/\`android\` are interactive-shaped, so rn-iso does not make
  you wait at a prompt. The remedy is fixed: stop an environment
  (\`rn-iso stop\`) to free a device, or raise concurrency.maxDevices. A
  workspace whose OWN device is already booted is never refused -- re-running
  \`ios\` on an environment you already have is idempotent. (The build cap
  behaves differently: a compile WAITS for a free slot rather than refusing.
  See \`guide lifecycle\`, "opt-in concurrency limits".)

--- DEV-SERVER CODES (\`rn-iso start\`) ---

RN_ISO_BARE_DEPS / RN_ISO_BARE_LOAD / RN_ISO_BARE_API  (bare RN)
  The supervisor hosts Metro out of the PROJECT's node_modules, so metro,
  @react-native/dev-middleware and @react-native-community/cli-server-api must
  be installed there and must match the project's React Native. DEPS = not
  resolvable (install them), LOAD = installed but threw while loading,
  API = loaded but is not the API rn-iso expects (mismatched versions).

RN_ISO_EXPO_BIN  (Expo)
  node_modules/.bin/expo does not exist. Install the project's dependencies.

RN_ISO_METRO_TIMEOUT
  "The dev server did not answer on port <n> within <s>s."
  The supervisor is alive, but nothing is serving yet. \`start\` has already
  printed the last lines of .rn-iso/logs/supervisor.log above this -- read
  them. A cold Metro on a large graph can genuinely need more than the default
  60s: re-run with \`--wait 180\`. Otherwise \`rn-iso stop\`, then \`start\`.

RN_ISO_SUPERVISOR_EXITED
  "The supervisor exited (<code|signal>) before the dev server came up"
  The dev server failed outright, and the quoted evidence is the real error:
  the supervisor.log tail if it wrote one, plus this attempt's error records
  from the timeline (an expo child's config error -- a PluginError, a bad app
  config -- lands THERE, not in supervisor.log). \`rn-iso logs --errors\` has
  the full records. Fix that and run \`start\` again; nothing is left running.

RN_ISO_BAD_ARG / RN_ISO_NO_PROJECT
  \`start\` refused before doing anything: an unusable --wait value, or a
  working directory with no package.json above it. Both are caught before the
  port is reserved and before anything is spawned, so nothing was started.

"@rn-iso/metro is not installed ... so bundler and client logs will not be
captured"  (in metro.ndjson, bare RN)
  The dev server is serving; only capture is missing, so \`logs\` would report
  a quiet timeline for a broken build. Install \`@rn-iso/metro\` as a
  devDependency of the project.

--- TEARDOWN AND WORKSPACE REFUSALS ---

"metro: refusing to kill port <n>: ... runs from <dir>, outside <project>"
  (stop) rn-iso will not kill a process it cannot attribute to you.
  \`rn-iso stop --force\` kills it without proving whose it is -- ask the user
  first. That flag is reachable only when no supervisor is recorded for this
  workspace, and it never deletes anything.

"supervisor: refusing to signal pid <n>: ..."  (stop)
  The two records describing that supervisor disagree, or it records a port
  this project did not reserve. A pid is a number the OS reuses, so it is not
  signalled. The port reservation is KEPT -- it is the only handle a retry
  has. Check \`ps -p <n>\` and \`rn-iso status\` before signalling by hand.

"supervisor pid <n> did not exit within 10s of SIGTERM"  (stop)
  Deliberately not escalated to SIGKILL: the supervisor may be mid-write on the
  very log files \`logs\` reads. The device is left alone and the port stays
  reserved. Re-run \`stop\`, or signal it yourself: kill -9 -<n> (note the
  minus -- it is a process group).

"this project's sim is X, but --device-type asked for Y"
  The project already owns a simulator of a different model, and rn-iso will
  not silently boot a different one. Reap it (\`worktree remove\`, or
  \`gc --delete\`) and run \`rn-iso ios\` again to create the requested model.
  That loses the old sim's app state.

"Refusing to remove <path>: uncommitted changes / untracked files / commits
not on any remote"  (worktree remove)
  A native build rewrites tracked files, and rn-iso now RESTORES the one class
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
  Two things rn-iso wrote itself never cause this refusal: the workspace's own
  \`.rn-iso/\`, and a \`.gitignore\` that is nothing but the \`.rn-iso/\` entry
  \`start\`/\`ios\`/\`android\` add -- appended to a tracked file (restored before
  the removal) or created whole in a repo that had none (deleted before it),
  verified line by line against what rn-iso writes; any other line either way
  still refuses. Commit that entry with your PR and it stops being written at
  all.

"Refusing to create <name>: the branch worktree-<name> already exists at <sha>,
but --base <ref> resolves to <sha>"  (worktree create)
  \`git worktree add\` attaches to an existing branch and ignores the base, so
  the worktree would not be based on what you asked for. An earlier
  \`worktree remove\` left that branch behind -- removing a worktree never
  deletes its branch. Either pick another name, or \`git branch -D
  worktree-<name>\` and retry. Without --base, attaching is still the
  behaviour: nothing was promised about the tip.

"Carried <dir>/Pods does not match <dir>/Podfile.lock"  (worktree create)
  \`ios/Pods\` is gitignored, so --carry-ignored clones it; \`ios/Podfile.lock\`
  is tracked, so it comes from the branch. When the source worktree's two
  disagree, the new worktree inherits the contradiction. \`rn-iso ios\` detects
  this and runs \`pod install\` for you; the note is there so a build you run
  yourself does not fail in its LAST phase with
    error: The sandbox is not in sync with the Podfile.lock

"No node_modules among them"  (worktree create --carry-ignored)
  The clone can only carry what the source worktree has, and the source has no
  node_modules. The path count above that line is not evidence of a usable
  worktree. Install dependencies before building.

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

"Installed rn-iso skill is X but this CLI is Y"
  The skill is a plain file copy, so upgrading rn-iso never refreshes it, and
  npx can serve a cached older CLI. Refresh the skill with \`npx skills\`. If the
  CLI itself is the old half, \`npx rn-iso@latest\` bypasses the stale cache.

"Found no free Metro port between ..."
  200 consecutive ports are claimed or occupied. \`rn-iso status\` shows what
  rn-iso knows about; the rest is other software.

"Could not reserve a Metro port after 5 attempts"
  Several commands raced for the same ports and each one lost. Nothing is
  wrong; retry.

"rn-iso config at <path> is not valid JSON"
  The file holding every owned-device record will not parse, and rn-iso never
  resets it for you -- a silent reset would orphan every simulator it names.
  Repair the file, or move it aside (\`mv <path> <path>.broken\`) and accept
  that the devices it recorded become orphans you delete by hand.

"Timed out waiting for the rn-iso config lock at <path>"
  Every config write is serialised so parallel commands cannot lose each
  other's records. A lock older than 10s is taken over automatically, so this
  means a command really is holding it. If none is running, remove that
  directory.`,
  },

  lifecycle: {
    summary: 'The full worktree -> start -> ios/android -> logs -> teardown flow',
    body: () => `ENVIRONMENT LIFECYCLE

  # 1. Isolated worktree (skip if you are already in one).
  #    It does NOT install dependencies -- that is yours.
  cd "$(npx rn-iso worktree create app-412 --carry-ignored)"

  # 2. The dev server, under a detached supervisor. Blocks until it is
  #    verifiably THIS project's, then hands your shell back.
  npx rn-iso start
    port       8082 (reserved)
    supervisor pid 41233

  # 3. Owned device booted, native inputs fingerprinted, cached build
  #    installed (or built), app launched wired to port 8082, device-log
  #    collector attached.
  npx rn-iso ios          # or: npx rn-iso android
    device      rn-iso-app-412 (BF2A..) booted (9s)
    fingerprint a3f9b1.. hit (2s)
    install     from cache (3s)
    launch      com.example.app (1s)

  # 4. Did it work? Empty output and exit 0 is the pass condition.
  npx rn-iso logs --errors --json

  # 5. Edit the JS. Fast Refresh applies it; no rn-iso command is involved.
  #    Then ask again.
  npx rn-iso logs --since 30s --level error

  # 6. Pausing: supervisor halted, collectors reaped, owned device SHUT DOWN
  #    (never deleted), port freed. Coming back costs a boot, not a create.
  npx rn-iso stop

  # 7. Done with the branch: the environment dies whole.
  npx rn-iso worktree remove

Steps 2 and 3 are ordered, not interchangeable: \`ios\` and \`android\` never
start the bundler, and refuse with RN_ISO_NO_METRO when nothing holds the
reserved port. That refusal costs a second; the alternative costs four minutes
and produces an app that cannot load a bundle.

Repeat step 3 whenever a NATIVE input changes. A JS-only edit needs nothing --
that is what Fast Refresh over the running dev server is for.

THE BUILD CACHE HAS TWO LEVELS
  1. rn-iso's own, on this machine: a directory under ~/.rn-iso shared by
     every worktree, keyed on the @expo/fingerprint hash of the native inputs.
     Free, instant, offline, and the only level a bare React Native project
     has.
  2. On an EXPO project only, the provider the project ALREADY configured for
     Expo (\`expo.buildCacheProvider\` -- "eas", or a module of its own).
     Consulted only when level one misses, bounded so a slow or expired remote
     cannot stall the loop, and a hit is copied into level one on the way past
     so the next workspace on this machine gets it for free. After a build,
     the result is stored locally AND handed to the provider.

  rn-iso never configures a provider and never suggests changing one: a
  project without one is a perfectly ordinary local-only project (doctor does
  not ask for one either -- a provider only serves builds run OUTSIDE rn-iso).

  A MISS explains itself when it can. When this workspace's previous build
  stored its fingerprint sources beside the cache entry, the fingerprint line
  gains " -- N sources changed: <up to three paths>", and the full list
  (capped at 20 names) lands in the build log as a fingerprint_diff record.

ONE COMPILE PER FINGERPRINT, ACROSS EVERY WORKSPACE
  The cache makes the SECOND workspace on a commit free -- but only once the
  first has finished. Three agents starting within the same minute all miss it,
  and without this all three compile the same app at once, fighting for the
  same cores. So when both cache levels miss, the run takes a LOCK on
  <fingerprint, platform> (a directory under ~/.rn-iso/build-locks). Exactly
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
  that ends after ~90 minutes with RN_ISO_BUILD_WAIT_TIMEOUT naming the lock.

  --no-build-cache looks nothing up -- not level one, not level two -- and
  takes no lock and never waits, because it asked for a compile of its own.
  It still STORES the result, over the entry it was told not to trust, and
  still uploads it. Use it when a cached artifact is suspect; the --json
  payload reports cacheSkipped: true so a caller can tell that run apart from
  a plain miss.

OPT-IN CONCURRENCY LIMITS (UNLIMITED BY DEFAULT)
  rn-iso imposes NO limits of its own: unset is exactly the behaviour above --
  every build compiles, every device boots. When a machine cannot host as many
  parallel builds or booted simulators as there are agents, two MACHINE-level
  caps rein it in. They live under a top-level \`concurrency\` key in
  ~/.rn-iso/config.json (not per-project -- the resource being shared is the
  machine's), and RN_ISO_MAX_BUILDS / RN_ISO_MAX_DEVICES override the file.
  Absent, 0, or any non-positive value means NO enforcement.

    concurrency.maxBuilds   how many builds COMPILE at once. It is a semaphore
                            of N slots (~/.rn-iso/build-slots). A run takes a
                            slot AFTER the single-flight lock -- a workspace
                            waiting to install another's identical artifact
                            never burns a slot -- so it caps distinct compiles,
                            not waiters. A full slate WAITS (this is batch work),
                            printing the same kind of progress line the build
                            lock does, and a dead builder frees its slot within
                            a poll (pid-liveness, like the lock).

    concurrency.maxDevices  how many rn-iso-owned devices are BOOTED at once. Checked
                            at device time, before a sim is created or booted.
                            At the cap, a NEW device is REFUSED with
                            RN_ISO_AT_CAPACITY (interactive-shaped: it does not
                            queue). A workspace whose own device is already
                            booted is never refused. See \`guide errors\`.

  \`rn-iso doctor\` prints one note echoing the caps and the current live count,
  but ONLY when a cap is set. \`rn-iso gc\` reports stale build slots the way it
  reports stale build locks, and \`gc --delete\` clears them. There is no
  \`rn-iso config\` command: set these by editing ~/.rn-iso/config.json or via
  the two env vars (see \`guide settings\`).

THE OPTION SURFACE, IN FULL
  start           --json --wait <seconds>
  ios             --json --no-metro-check --no-build-cache --configuration <name>
  android         --json --no-metro-check --no-build-cache --variant <name>
  logs            --source --level --since --grep --tail --follow --errors --json
  stop            --json --force
  status          --json          (already machine-wide; there is no --all)
  gc              --delete --older-than <days> --all
  worktree create <name> --carry-ignored --base <ref>; remove [path] --force

  That is the whole surface, deliberately. A project needing more wraps rn-iso
  in an npm script rather than rn-iso growing a flag for it.

  \`android --variant <name>\` selects the gradle variant to assemble and
  install on a project with product flavors -- \`--variant productionDebug\`
  runs \`assembleProductionDebug\`, finds the APK in apk/production/debug/ and
  keys the build cache on the variant. It overrides the android.variant
  setting (see \`guide settings\`), which is the repo-level default; unset,
  the plain \`assembleDebug\` flow is unchanged. Debug variants of flavors
  only -- release builds stay out of scope on Android for now. The --json
  payload's \`variant\` field reports what was built (null for the default).

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
  Simulator only -- device builds, signing and distribution stay out of
  scope.

DESTRUCTIVE COMMANDS -- ask the user first
  gc --delete             deletes orphaned rn-iso-* devices, tens of GB
  gc --delete --all       empties the shared build caches every project uses
  worktree remove --force discards uncommitted and untracked work
  stop --force            kills a process rn-iso could not identify

Destruction lives in exactly TWO commands: \`worktree remove\` (the workspace
you name) and \`gc --delete\` (the machine). \`stop\` destroys nothing by
design -- it shuts the owned device down and leaves it assigned, and there is
no flag on it that could become a delete. An agent reaching for \`stop\` to
reclaim memory must not have a \`--delete\` within reach of a typo.
\`stop --force\` is not an exception: it only kills an unidentified process on
the reserved port, and deletes nothing.

CAPACITY
  A booted iOS sim is roughly 1-2 GB of RAM, an Android emulator 2-3 GB. On a
  16 GB machine plan for 2-3 live environments. Nothing enforces this;
  \`rn-iso status\` is how you check -- it reports every workspace on the
  machine, not just this one.`,
  },

  cleanup: {
    summary: 'Where simulators come from, and how they get reclaimed',
    body: () => `CLEANUP AND DISK

WHAT RECLAIMS AN OWNED DEVICE
  rn-iso worktree remove    deletes every owned device under the worktree
  rn-iso gc --delete        sweeps rn-iso-* devices no project references
  rn-iso gc --delete --older-than <days>
                            also reaps the device of a project nothing has
                            touched in that long, even though the project is
                            still on disk

Those are the only two commands that delete. \`rn-iso stop\` shuts a device
DOWN and leaves it assigned, which is what makes returning to a branch cost a
boot rather than a create, a provision and a reinstall.

ON THE MAIN CHECKOUT
  git cannot remove the main working tree, and deleting the source tree is not
  what anyone meant -- so there, and only there, \`worktree remove\` reclaims
  the ENVIRONMENT and nothing else: the owned devices are deleted, the Metro
  port freed, the registry entries (including nested monorepo app dirs)
  dropped, and <root>/.rn-iso deleted. The tree itself is never touched, which
  is also why the dirty-tree and unpushed guards do not apply on that path.
  It ends with:
    Reclaimed the environment; the working tree stays (it is the main checkout).
  A registered project directory that is not a git repo at all gets the same
  environment reclaim -- there is nothing else remove could mean there.

Neither delete path checks occupancy: a device being deleted goes away even if
something is still driving it, because it is one rn-iso created for a project
that is going away. \`stop\` DOES spare an occupied sim, because there the
device survives the call.

If a delete fails, the device's config record is KEPT and the command reports
it. A record is what makes the device findable again, so it outlives a failed
teardown rather than turning it into an orphan.

WHAT ELSE STOP REAPS
  The device-log collectors (\`simctl log stream\` / \`adb logcat\`) that
  \`ios\` / \`android\` attach after launch. They are recorded in
  <root>/.rn-iso/state.json, and nothing outside this workspace can name them,
  so \`stop\` is what stands between a teardown and a log stream that outlives
  the device it was reading. A fresh \`ios\` / \`android\` run also kills the
  previous collector for that platform before starting its own.

BUILD LOCKS
  \`gc\` also reports the single-flight build locks (above): the ones whose
  builder is no longer running are debris a reboot or a kill left behind, and
  \`gc --delete\` clears them. A lock whose builder IS running is a build in
  progress -- it is named in the report and touched by nothing, because
  removing it would put a second workspace on the same compile.

A device leaks when a project is abandoned WITHOUT either delete path -- the
sim survives with nothing pointing at it. \`rn-iso gc\` (no flag, writes
nothing, always safe) reports those; \`gc --delete\` reaps them, and in the same
run drops the dead config ENTRIES those projects left behind and frees their
Metro ports.

THE MIRROR IMAGE: A STALE DEVICE RECORD
  A device deleted out from under a LIVE project (by hand, or by Xcode) leaves
  the opposite problem: the record points at a sim that is not on the machine,
  and \`rn-iso status\` warns about it on every run. \`gc\` reports these under
  "Stale device records", and \`gc --delete\` clears the RECORD -- only the
  record. There is no device left to shut down or delete, so nothing is issued
  at simctl or avdmanager, and the project keeps its entry, its label and its
  Metro port. The next \`ios\` / \`android\` creates a fresh owned device.

THE ONE CASE GC WILL NOT REAP
  If the config is gone entirely (deleted ~/.rn-iso, or a throwaway
  RN_ISO_HOME), gc cannot tell your stale devices from another config's LIVE
  ones, so it refuses to delete anything. It still NAMES the rn-iso-* devices
  it found, so you can judge. Delete them yourself:
    xcrun simctl delete <udid>
    avdmanager delete avd -n <name>

DISK
  Build output is workspace-local -- <worktree>/.rn-iso/derived-data and
  gradle-build -- so \`worktree remove\` reclaims it definitionally and there
  is no global DerivedData sweep to run.

  So are the logs, and one of them is not small: build-ios.ndjson /
  build-android.ndjson hold the whole xcodebuild or gradle transcript at debug
  level, which for a cold build is tens of megabytes (74 MB measured on one
  first iOS build of a real app). They are worth that -- a build that fails at
  minute nine is unreadable any other way -- and they are per workspace, not
  global, so \`worktree remove\` reclaims them along with everything else in
  <worktree>/.rn-iso. Each build starts its transcript file over, so the log
  holds one run and a workspace you keep building in does not accumulate them.

  Simulators are large and live in the CoreSimulator device set, not in your
  project. If the disk is filling up, rn-iso's own devices are usually not the
  bulk of it -- Apple's default simulators and old runtimes are. Useful:
    xcrun simctl delete unavailable     # sims for runtimes you removed
    xcrun simctl list devices           # see everything
    rn-iso gc                           # report dead entries, orphans, caches
  Xcode recreates default simulators on demand, so deleting them is safe.

SHARED BUILD CACHES
  The caches that make a second workspace fast are alive by design and never
  included in a plain \`gc --delete\`. Every \`gc\` run reports them anyway,
  each row tagged (registered) or (detected), with its size:
    rn-iso gc                            # report, caches included
    rn-iso gc --delete --older-than 30   # trim entries nothing has used
    rn-iso gc --delete --all             # empty them whole, index-backed ones
                                         # (the Xcode CAS) included
  Trim rather than empty. Emptying costs the next build in every project the
  time the cache was saving.`,
  },

  settings: {
    summary: 'Settings rn-iso reads, and where they can live',
    body: () => `SETTINGS

There is no \`rn-iso config\` command: rn-iso's commands take no device flags, so
settings are FILES, edited by hand or committed.

Resolution order, first match wins:
  1. project layer   ~/.rn-iso/config.json, under this project's entry
  2. repo layer      ~/.rn-iso/config.json, under this repo's git common dir
  3. committed       .rn-iso.json at the repo root  <- normally the one you want
  4. rn-iso default

The committed file is plain JSON and is the only layer that travels with the
repo, so a device model or a carry-over rule every worktree should share
belongs there:

  {
    "ios": { "deviceType": "iPhone 17 Pro", "runtime": "26.2" },
    "android": { "variant": "productionDebug" },
    "worktree": { "baseRef": "fresh" },
    "caches": ["~/.myapp-metro-cache"]
  }

KEYS RN-ISO READS
  ios.deviceType        e.g. "iPhone 17 Pro"
  ios.runtime           e.g. "26.2"
  ios.configuration     e.g. "Release" -- the Xcode configuration to build
                        (simulator only). Committing
                        { "ios": { "configuration": "Release" } } makes every
                        \`rn-iso ios\` in the repo a release-shaped build:
                        embedded JS, no Metro, cache keyed -release-sim, and
                        a JS-bundle swap on cache hits. The \`--configuration\`
                        flag overrides this per invocation. Unset means Debug.
  android.systemImage   e.g. "system-images;android-36;google_apis;arm64-v8a"
  android.variant       e.g. "productionDebug" -- the gradle variant to
                        assemble and install on a project with product
                        flavors. A repo like tlon-mobile with
                        flavorDimensions "profile" and production/preview
                        flavors has NO plain assembleDebug output: commit
                        { "android": { "variant": "productionDebug" } } and
                        \`rn-iso android\` runs assembleProductionDebug,
                        finds the APK in apk/production/debug/ and keys the
                        build cache on the variant. The \`--variant\` flag
                        overrides this per invocation. Unset means plain
                        assembleDebug. Debug variants only; release is out
                        of scope.
  worktreeDir           where worktrees are created
  worktree.baseRef      "fresh" (origin/HEAD) or "head"
  worktree.include      carry-over patterns, same role as .worktreeinclude
  worktree.exclude      --carry-ignored skip list, same role as .worktreeexclude
  caches                extra shared-cache paths for \`gc\` to report. A JSON
                        array; every path is treated as a flat store.

Anything else is IGNORED, and rn-iso warns about it by name on every run that
resolves settings. If you see such a warning, the key was either renamed or
removed -- check this list rather than assuming it still applies.

CONCURRENCY LIMITS ARE MACHINE-LEVEL, NOT A PER-PROJECT SETTING
The caps above are not in the layered settings -- they are not per-project,
because the resource they share (cores, RAM, booted simulators) is the whole
machine's. They live under a top-level \`concurrency\` key in
~/.rn-iso/config.json, edited by hand:

  {
    "concurrency": { "maxBuilds": 2, "maxDevices": 3 }
  }

or via the environment, which overrides the file:

  RN_ISO_MAX_BUILDS=2 RN_ISO_MAX_DEVICES=3 npx rn-iso ios

Unset, 0, or any non-positive value means NO enforcement -- the default, where
rn-iso limits nothing. See \`guide lifecycle\` for what each cap does.

CACHE LOCATIONS ARE MACHINE-LEVEL TOO
The shared build cache and Metro transform cache default to living under
~/.rn-iso. To relocate them (say, to an external disk), set a top-level
\`caches\` key in ~/.rn-iso/config.json, edited by hand -- absolute paths:

  {
    "caches": { "buildCache": "/Volumes/SSD/rn-iso/build-cache",
                "metroCache": "/Volumes/SSD/rn-iso/metro-cache" }
  }

RN_ISO_BUILD_CACHE / RN_ISO_METRO_CACHE in the environment override the file.
The CLI and both cache packages resolve these identically, so every process
finds the same store regardless of shell profile. A relative path is ignored.

PREFER SELF-REGISTRATION OVER THE 'caches' SETTING
There is no 'cache' command. A cache registers itself from code instead, once,
and every 'gc' report shows it from then on, tagged (registered):

  import { register } from 'rn-iso/cache-manifest';
  register({ dir: '<dir>', name: '<what to call it>', entriesDepth: 2 });

entriesDepth is how far below dir one entry sits (default 1, a flat store).
Pass 2 for a root with a layer of grouping above the entries -- a Metro
FileStore shards across 256 directories, a build cache is keyed
<platform>/<key> -- or 'gc --delete --older-than N' removes a whole shard or
platform instead of one entry. Pass prune: 'atomic' for a cache whose index
references its own data (an LLVM CAS): it is then left alone by --older-than
and emptied whole only by 'gc --delete --all'.
Registration is idempotent and keyed on the directory.`,
  },
};

export function topicNames(): string[] {
  return Object.keys(TOPICS);
}

export function renderTopic(name: string): string | null {
  const topic = TOPICS[name];
  if (!topic) return null;
  return topic.body();
}

export function renderIndex(version: string): string {
  const lines = [
    `rn-iso ${version} -- reference for the binary you are running.`,
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
  lines.push('', 'Read one with:  npx rn-iso guide <topic>');
  return lines.join('\n');
}

export default function guideCommand(program: Command, version: string): void {
  program
    .command('guide [topic]')
    .description(
      'Print reference documentation for THIS version of rn-iso (topics: ' +
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
