import type { GuideTopic } from './types.ts';

const cleanup: GuideTopic = {
  summary: 'Where simulators come from, and how they get reclaimed',
  preamble: () => `CLEANUP AND DISK

WHAT RECLAIMS AN OWNED DEVICE
  stim worktree remove    parks the owned simulator
                            (\`guide lifecycle pool\`) and deletes every other
                            owned device under the worktree
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
to stats.json.corrupt-<unix ms> and starts a new one.`,
  sections: {
    gc: {
      summary:
        'what gc and worktree remove delete, keep and refuse: orphans, stale records, locks, leases, EAS sessions',
      body: () => `LINKED WORKTREES
  \`stim worktree remove\` works with any linked worktree, warmed or not.
  Git registration identifies the worktree; a Stim registry entry is not
  required. The command reclaims any owned resources it finds, checks for
  uncommitted and unpushed work, and removes the linked checkout. Git-created
  branches stay. A branch with an existing Stim ownership record is deleted
  only when it has no unique commits.

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
    avdmanager delete avd -n <name>`,
    },
    collector: {
      summary: 'log collector reaping: an unproven collector pid, and why the app on a phone closed',
      body: () => `WHAT ELSE STOP REAPS
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
  collector alone terminates the app. The phone has no owned-device registry
  entry. \`stop\` closes the app and releases this workspace's leases.
  Nothing is uninstalled, and the next \`ios --device\` starts it again.

  Unplugging the phone ends devicectl, which ends the collector: it unregisters
  itself and exits either way. A separately held \`device lock\` lease survives
  collector exit until released or expired; \`gc --delete\` can remove its
  expired lease file.
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
  that could not be confirmed keeps its record.`,
    },
    disk: {
      summary: 'disk usage, AVD and build-log sizes, the data partition, trimming the shared caches',
      body: () => `DISK
  Logs, state, pidfiles and Xcode DerivedData are under the global workspace
  directory, and \`worktree remove\` reclaims them. Gradle retains its normal
  project build directories while sharing task outputs through its build cache.

  Android AVDs normally live under ~/.android/avd, and a booted owned AVD can
  use several GB. \`worktree remove\` deletes the workspace's owned AVD; plain
  \`stop\` only shuts it down for reuse. Stim uses Android's default Quick Boot
  unless displayless Linux requires software rendering, where snapshots are
  disabled. The first boot and a boot after the emulator, system image, or AVD
  settings change are cold, while later supported boots load the one automatic
  snapshot saved on exit. \`stop\` waits for the emulator process and, when
  enabled, the snapshot save to finish.
  New owned AVDs default to an 8 GiB data partition, though project settings can
  change it. When enabled, Quick Boot keeps one automatic snapshot, and \`worktree remove\`
  deletes the whole AVD.
  \`gc\` prints the on-disk size beside an orphaned or stale owned Android AVD
  when its content directory can be read.

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

New owned Android AVDs use an 8 GiB data partition by default. This leaves room
for repeated app installs while capping userdata growth below the 10 GiB
setting measured on the selected API 36 profile. Set
\`android.dataPartitionSizeGb\` to a whole number from 6 through 16384 when a
project needs another size. Android userdata grows but does not shrink, so the
setting applies only to a newly created AVD; recreate the environment to adopt
a changed value.

SHARED BUILD CACHES
  The caches that make a second workspace fast are alive by design and never
  included in a plain \`gc --delete\`. Every \`gc\` run reports them anyway,
  each row tagged (registered) or (detected), with its size:
    stim gc                            # report, caches included
    stim gc --delete --older-than 30   # trim entries nothing has used
    stim gc --delete --cache all       # empty them whole, index-backed ones
                                         # (the Xcode CAS) included
  $STIM_HOME/ccache (default ~/.stim/ccache) holds the Android C++ objects
  \`stim android\` compiles through ccache. ccache keeps it under CCACHE_MAXSIZE
  on its own, so \`gc\` reports its size and leaves it alone; --older-than
  skips it, and \`--cache all\` empties it whole like the Xcode CAS. That
  bound is Stim's: it sets CCACHE_MAXSIZE on the Gradle run, which wins over
  a max_size written into the cache directory's own ccache.conf.

  The Gradle build cache under GRADLE_USER_HOME (default ~/.gradle) is
  report-only because every Gradle build shares it. Stim reports its size
  but never prunes or empties it, including with --older-than or --cache all.
  Trim rather than empty. Emptying costs the next build in every project the
  time the cache was saving.`,
    },
  },
};

export default cleanup;
