export default {
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

  stim stop
  stim worktree remove

RULES DURING THE LOOP

- Run Stim from the app directory: the one whose package.json depends on
  react-native or expo. Anywhere else -- a monorepo root, a tools package --
  start, ios and android refuse with STIM_NO_PROJECT naming that package.json,
  and doctor reports it as a finding.
- Run start before a debug ios or android build. If it returns STIM_NO_METRO,
  run stim start and retry.
- Run ios or android again after a native input changes. A JavaScript-only
  change does not need one.
- If fingerprinting fails after native inputs change during the run, Stim
  installs the build without caching it. A null fingerprint or cacheKey is
  unavailable cache information, not an install failure.
- Android Debug builds target the owned emulator system-image ABI or the
  physical device's primary ABI. Unknown targets and Release builds stay
  universal.
- Reload is not part of the normal workflow. Use stim reload on an owned local
  simulator or emulator after a failed first bundle load, when an error screen
  remains after the fix, or when you explicitly need an app restart. For a
  physical device that reached Metro, use agent-device metro reload with the
  reported port. The detected iOS Local Network first-load remedy uses UI
  automation instead because that app never established a Metro connection.
- A successful stim reload confirms that the request was sent, not that new
  JavaScript loaded or the screen recovered. Verify the expected UI on the
  reported device and inspect stim logs --errors before claiming recovery.
- If launch reports an app error but also says the native process is alive,
  the app did not crash. Fix JavaScript or TypeScript and use Fast Refresh. If
  the error screen remains, follow the printed reload remedy instead of
  running ios or android again. If launch says FATAL because the app process exited,
  fix the crash and run the platform command again; Metro cannot restart it.
- A cold native build can outlive a shell timeout. Run the same command again:
  the second call joins the active build or returns its result. If a builder
  fails, one waiter takes over and the others keep waiting within the same
  90-minute limit. Follow the remedy if STIM_BUILD_WAIT_TIMEOUT is returned.
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
entries and keeps failures; see guide lifecycle pool. First launch on a
physical iPhone can need the one-time taps named by the remedy.

stim android --device [serial] and stim ios --device [udid] install on a
connected physical device. Stim never creates, boots, shuts down, or deletes
hardware. It records a temporary lease, not an owned-device registry entry.

A --device run leases that device for the run. stim device lock ios --for 10m
holds it across runs; stim device unlock gives it back. Never delete another
workspace's lease file under ~/.stim/device-locks; gc --delete removes expired
ones.

stop and worktree remove release this workspace's leases. On a physical
iPhone, stop also closes the app by ending its log collector; it does not
shut down the phone or uninstall the app.

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
user to allow those operations. guide errors sandbox lists the exact
requirements.

LOAD ADVANCED GUIDANCE WHEN NEEDED

  stim guide                      # list topics
  stim guide errors               # index of every refusal code and message
  stim guide errors <CODE>        # one refusal, e.g. stim guide errors STIM_NO_METRO
  stim guide errors sandbox       # running under a sandboxing harness
  stim guide errors unverified    # launch unverified, and the Local Network reason
  stim guide errors fallbacks     # swap, cache, and install notes on a release cache hit
  stim guide lifecycle            # the ordered flow, consent rules, and capacity
  stim guide lifecycle builds     # cache hits, misses, fingerprints, .fingerprintignore
  stim guide lifecycle options    # every flag, Android variants, --device-type, --system-image
  stim guide lifecycle devices    # ios --device and android --device on a physical phone
  stim guide lifecycle release    # Release configurations and ...Release variants
  stim guide facts                # the --json payloads
  stim guide facts devmenu        # the Expo dev menu or Tools button over the app
  stim guide metro                # supervisor, custom Metro, tunnels, and remote devices
  stim guide logs                 # filters, record shape, and capture limits
  stim guide cleanup              # what reclaims a device, and what deletes
  stim guide cleanup collector    # an unproven collector pid; why the app on a phone closed
  stim guide settings             # configuration files and supported keys

A refusal prints a CODE such as STIM_NO_METRO. Run stim guide errors <CODE>
with the code exactly as printed and read only that section; every code in a
shared header (STIM_BAD_ARG / STIM_NO_PROJECT) resolves to the same section. A
refusal with no code is quoted by message in stim guide errors. A topic with
sections called bare prints its section index, so read the narrowest section
before release configurations or Android variants; remote devices; custom
Metro processes or tunnels; cache misses, bypasses, or concurrent builds;
capacity limits; cache statistics from stim stats; worktree carry-over;
fingerprint exclusions; gc; --force; cleanup failures; or unfamiliar states
and error codes. Ordinary stim stop and an authorized clean
stim worktree remove do not need the cleanup guide.`,
};
