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

  # JavaScript and TypeScript edits use Fast Refresh. If an error screen stays
  # after the edit, reload the running app without rebuilding it.
  stim reload                            # add ios or android when both are live
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
  the error screen remains, use stim reload. Do not run ios or android again.
  If launch says FATAL because the app process exited,
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
};
