import type { GuideTopic } from './types.ts';

const lifecycle: GuideTopic = {
  summary:
    'The full worktree -> start -> ios/android -> logs -> teardown flow, with sections for builds, devices and flags',
  preamble: () => `ENVIRONMENT LIFECYCLE

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
that is what Fast Refresh over the running dev server is for. \`stim reload\` is
not part of the normal workflow. It is the explicit recovery path after a
failed first bundle load, when Fast Refresh cannot clear the current screen,
or when you explicitly need an app restart. Use \`stim reload ios\` or
\`stim reload android\` to select a platform when both owned apps are live.
It never builds, installs, boots, or cold-launches. It acts only on a live app
on this workspace's owned local simulator or emulator, and refuses release
builds, stopped or unowned devices, a missing or foreign Metro, and an
ambiguous no-platform request. Expo/dev-client reloads resend the exact deep
link recorded at launch. Bare Android sends the app-scoped React Native reload
broadcast. Bare iOS reloads through this Metro's sole identifiable iOS peer. If
Metro cannot identify one iOS peer, the command tells the agent to press Reload
through its existing automation session on the exact simulator. Stim does not
take over that stateful session.

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
  sections: {
    progress: {
      summary: 'phase lines, the label set, heartbeats and their ~ estimate, what create, start, stop and remove print',
      body: () => `PROGRESS ON A LONG RUN
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

  A GAP BETWEEN HEARTBEATS IS NOT A HANG. Stim runs device tools
  synchronously, so a long \`simctl\`, \`adb\` or copy call holds the timer
  until it returns; the next heartbeat then lands on the grid, which is why an
  elapsed value can jump. Read the phase lines, not the wall clock, before
  killing a run.`,
    },
    pool: {
      summary: 'parked and adopted simulators: what park and adoption clear or keep, the model and runtime match',
      body: () => `  THE SIMULATOR POOL
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
  does \`gc --delete\`, which is deleting what it finds.`,
    },
    builds: {
      summary:
        'cache hits, misses, the fingerprint shift, .fingerprintignore, install unchanged, where runtime state lives',
      body: () => `AN ARTIFACT THE DEVICE ALREADY HOLDS IS NOT INSTALLED AGAIN
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

RUNTIME STATE AND BUILD INPUTS
Runtime state is stored outside the project tree under
$STIM_HOME/workspaces/<project>--<digest>/ (default ~/.stim/workspaces/).
The aggregate run counters \`stats\` prints live beside it in
$STIM_HOME/stats.json, one bucket per project and platform plus a machine-wide
one; nothing per run is kept there.
No .gitignore entry is created or required.
Native preparation can change project files: expo prebuild generates native
sources, and pod install can update Podfile.lock. Review those changes before
committing. The shared caches need no project-file edits:

  ios      xcodebuild carries COMPILATION_CACHE_ENABLE_CACHING, a shared
           COMPILATION_CACHE_CAS_PATH and a clang prefix mapping of this
           workspace's root, so compiled output crosses worktrees with no
           Podfile post_install block. Xcode 26+ only, and skipped entirely
           when the project configured ccache (the two defeat each other).
  android  gradlew carries --build-cache, so task outputs cross worktrees with
           no org.gradle.caching=true in gradle.properties. Debug builds also
           carry -PreactNativeArchitectures=<target ABI> when Stim can prove
           the emulator or physical-device ABI; otherwise they stay universal.
  ccache   the same gradlew run carries an absolute
           CMAKE_C_COMPILER_LAUNCHER / CMAKE_CXX_COMPILER_LAUNCHER plus
           CCACHE_DIR, CCACHE_BASEDIR, CCACHE_NOHASHDIR, CCACHE_SLOPPINESS
           and CCACHE_MAXSIZE whenever a ccache binary is on PATH, so the C++
           objects cross worktrees as well. Nothing is set when ccache is
           absent, or when the project passes a CMake compiler launcher of
           its own.
  start    the dev server gets a shared Metro FileStore APPENDED to whatever
           the project configured -- in-process on a bare project, and through
           Expo's config override on SDK 54+. Expo SDK 53 and older use their
           normal Metro cache. Turn it off machine-wide with
           { "caches": { "injectMetroStore": false } } in
           ~/.stim/config.json; see \`guide settings\`. A project that calls
           \`sharedCacheStores()\` from @stim-cli/metro in its own metro
           config also gets the \`cache.provider\` tier behind that store.

Each reports its cache setup. \`stim doctor\` checks missing or stale setup
when a build is blocked or slow. It reports what Stim cannot handle itself
(a missing dev client, ccache absent from PATH or a .cxx that predates the
launcher, a fingerprint no fresh worktree reproduces, a provider on a key this
SDK ignores) and settings for builds outside Stim.

WHY ANDROID NEEDS CCACHE, AND WHAT IT COSTS
Every AGP CMake task is uncacheable by Gradle, so --build-cache serves not one
C++ compile. Without a launcher a fresh worktree recompiles every translation
unit, which on a React Native app with native modules is most of a first build.
The shared objects live at $STIM_HOME/ccache (default ~/.stim/ccache), which is
registered for \`gc\` and prunes itself at CCACHE_MAXSIZE.

CCACHE_BASEDIR rewrites paths under the workspace root relative to the compile
directory and CCACHE_NOHASHDIR keeps the working directory out of the hash;
together they are what lets an object built in one worktree match in another.
The trade-off is the same class as the iOS CAS one: an object reused from
worktree A carries A's directory as its DWARF comp_dir, so a debugger stepping
into reused C++ resolves sources against that path.

Precompiled headers are where the misses are, and the cause is mtime, not
paths. worklets and expo-modules-core precompile a header without
-fno-pch-timestamp, so ccache re-checks the mtime of the PCH inputs
(\`Precompiled header includes ..., which has a new mtime\`), rebuilds the
header, and every translation unit that includes it misses too -- 5 to 11
seconds per module, paid again after anything that rewrites those mtimes,
a fresh npm ci included. No stale .pch is ever served. reanimated passes
-Xclang -fno-pch-timestamp and hits across worktrees like everything else.

The launcher persists in the project. AGP writes it into each
.cxx/**/CMakeCache.txt on the first configure, so a plain \`./gradlew\` in that
checkout also compiles through ccache -- and a .cxx configured BEFORE the
variables existed keeps compiling without them until it is deleted once.
\`stim doctor\` reports both.

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
     run independently. An ABI-targeted Android Debug build skips this Expo
     tier because its run-options contract cannot distinguish ABIs; levels one
     and two remain ABI-keyed and active.

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

  If the iOS fingerprint after prebuild or pod install is unavailable, Stim
  installs the build but skips local storage and remote uploads. fingerprint
  and cacheKey are null in the result and lastBuild; the old key is not reused.

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
  stray file there moves the key on your machine and nowhere else.`,
    },
    concurrency: {
      summary: "waiting on another workspace's build, --no-build-cache, concurrency.maxBuilds and maxDevices",
      body: () => `ONE COMPILE PER FINGERPRINT, ACROSS EVERY WORKSPACE
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
  released lock with no artifact, and one of them takes over and builds. The
  other waiters keep waiting for that holder. All replacement builders share
  one ~90-minute deadline, including lock acquisition between waits; reaching
  it returns STIM_BUILD_WAIT_TIMEOUT naming the current holder and lock.

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
                            booted is never refused.
                            See \`guide errors STIM_AT_CAPACITY\`.

  \`stim doctor\` prints one note echoing the caps and the current live count,
  but ONLY when a cap is set. \`stim gc\` reports stale build slots the way it
  reports stale build locks, and \`gc --delete\` clears them. There is no
  \`stim config\` command: set these by editing ~/.stim/config.json or via
  the two env vars (see \`guide settings\`).`,
    },
    options: {
      summary:
        'every flag per command, Android variants and flavors, the per-run simulator model, runtime and system image',
      body: () => `THE OPTION SURFACE, IN FULL
  start           --json --wait <seconds> --remote
  ios             --json --no-metro-check --no-build-cache --configuration <name> --device-type <name> --runtime <version> --device [udid] --wait <seconds> --no-wait --remote <proxy|eas>
  android         --json --no-metro-check --no-build-cache --variant <name> --system-image <id> --device [serial] --wait <seconds> --no-wait --remote <proxy|eas>
  reload          [ios|android] --json
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
  read from the device itself, so a settings-driven run reports them too.`,
    },
    devices: {
      summary:
        'ios --device and android --device on a phone: what the run skips, signing, the LAN wiring, the collector',
      body: () => `  \`android --device [serial]\` installs and launches on a physical device
  connected to this machine instead of this workspace's owned emulator. With
  no serial it takes the first device it can lease (\`guide lifecycle lease\`).
  It cannot be combined with --remote.

  A \`--device\` run LEASES the device from just after the build until it
  exits, so a second workspace cannot install over it mid-run
  (\`guide lifecycle lease\`).

  The build, the fingerprint, the build cache and the Metro port gate are
  unchanged. What is skipped is everything that manages an owned device:
  no capacity check, no AVD creation, no boot wait, and no owned-device
  registry entry. The app is pointed at
  localhost:<port>, which the adb reverse serves, instead of the emulator's
  10.0.2.2. Stim never creates, boots, shuts down, or deletes hardware.

  \`ios --device [udid]\` selects a connected iPhone, the same way
  \`android --device\` selects a connected phone: with no UDID it takes the
  first device it can lease (\`guide lifecycle lease\`), and an iPhone
  that is unpaired or has Developer Mode off is refused with the fix. It
  cannot be combined with --remote, and it never creates, boots, or deletes
  hardware -- there is no capacity check, no simulator creation, no boot wait,
  and no owned-device registry entry. Like
  \`android --device\`, it leases the phone for the run
  (\`guide lifecycle lease\`).

  \`stop\` releases this workspace's leases and stops its log collectors.
  On a physical iPhone that also closes the app, because its collector owns
  the devicectl launch session. \`gc --delete\` removes expired lease files;
  neither command shuts down the phone or uninstalls the app.

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
  machine's keychain (see \`guide errors STIM_NO_PROFILE\`). A gate refusal on
  a CACHED app falls back to a full build; on a freshly built one it exits on
  its own code, because building again would produce the same app.

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
  ends the collector: it removes its own registration and exits. A separately
  held \`device lock\` lease survives collector exit until released or expired;
  \`gc --delete\` can remove its expired lease file. Whether it closes with collector_stopped or
  collector_failed follows devicectl's exit code, which no one has watched a
  cable-pull produce yet. See \`guide logs\` for what the device stream can
  and cannot carry, and appandflow/stim#179.

  THE APP RUNS FOR AS LONG AS THE COLLECTOR DOES. Because the collector is the
  launch, the app is attached to it: \`stop\` (and any other end of that
  collector -- a crash, the host sleeping, the cable coming out) closes the app
  on the phone. It stays INSTALLED. Collector exit removes the collector's
  registration, not a separately held device lease; \`stop\` also releases
  this workspace's leases. See \`guide cleanup\`.

  THERE IS NO INSTALL SKIP ON A PHONE. The simulator path skips the install
  when the device already holds the same bundle byte for byte, which it proves
  by hashing the installed container; there is no cheap equivalent through
  devicectl, so a device run always installs. It is an upgrade install: the
  app's data, and the Local Network permission the phone granted it, survive.`,
    },
    lease: {
      summary: 'run-scoped leases, --wait and --no-wait, device lock and unlock, which phone an id-less --device picks',
      body: () => `THE DEVICE LEASE ON A \`--device\` RUN
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
  device tool.`,
    },
    release: {
      summary: 'Release configurations and ...Release variants: Metro skipped, process-proven launch, the JS swap',
      body: () => `  A VARIANT WHOSE NAME ENDS IN "Release" IS A RELEASE BUILD (\`release\`,
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
  \`.ipa\` export, store signing and distribution stay out of scope.`,
    },
    simslim: {
      summary: 'installing SimSlim and what ios.simslimProfile does to an owned simulator',
      body: () => `OPTIONAL SIMSLIM PROFILE
  Install SimSlim once on each Mac:

    brew install mobai-app/tap/simslim

  Then commit a profile and select it in .stim.json:

    { "ios": { "simslimProfile": ".simslim/dev.json" } }

  SimSlim requires an iOS 18 or newer simulator. On each local \`stim ios\`,
  Stim reconciles that profile on the owned simulator before the app build.
  The first change can update services and reboot the simulator. A matching
  profile is a fast no-op on later launches. The settings persist across normal
  shutdowns and reboots. Removing the setting restores stock services when
  Stim applied the profile. Stim never changes an unowned or remote simulator.`,
    },
  },
};

export default lifecycle;
