// src/commands/guide.js
//
// Version-matched reference documentation, printed by the binary itself.
//
// Why this exists: skill/SKILL.md ships through `npx skills add` (GitHub) while
// the CLI ships through npm, with no version relationship between them. A user
// reported running a 0.10.0 CLI against a 0.6.x skill and not noticing. Docs
// that live only in the skill drift silently.
//
// The split is by VOLATILITY, not by length. The skill keeps what makes an
// agent trigger correctly and behave safely -- the ownership model, the
// destructive-command rules, the parallel-agent rules. Everything that changes
// per release -- exact flags, payload shape, error remedies -- lives here, so
// `npx rn-iso@latest guide facts` always describes the binary the agent is
// about to run.
import chalk from 'chalk';

const TOPICS = {
  facts: {
    summary: 'The `up --json` / `device --json` payload, field by field',
    body: () => `FACTS CONTRACT

\`rn-iso up <ios|android> --json\` prints exactly ONE line of JSON on stdout.
Every other line goes to stderr, so it is safe to pipe.

  platform       "ios" | "android"
  owned          true when rn-iso created the device (and so may destroy it)
  metroPort      the port RESERVED for this project. rn-iso does not start
                 Metro; you start it on this port.
  metroHealthy   true only when a Metro answering /status is running FROM
                 INSIDE this project. Normally false right after \`up\`.
  metroConflict  null, or why the process on metroPort could not be proven to
                 be this project's Metro. Non-null means: do not build yet.
  bundleId       iOS bundle id. On Android this is the ANDROID PACKAGE NAME.

iOS adds:      udid, deviceName
Android adds:  kind ("emulator" | "physical"), serial, avdName, consolePort

RULES
  - Never hardcode or guess a udid/serial/port. Read them from the payload.
  - Pass them EXPLICITLY to your build and to every device tool
    (agent-device, xcrun simctl, adb -s, idb).
  - Never assume "booted" is your simulator. Other agents have theirs booted
    too.
  - Do not build while metroConflict is non-null: the build CLIs reuse
    whatever answers on the port, so you would build against it.`,
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
  facts with alreadyRunning: true and starts nothing. That holds for a server
  YOU started too -- it is reported with supervisorPid: null and left alone,
  because starting a second bundler over a working one is the actual failure.
  A foreign process holding the reserved port moves the RESERVATION instead,
  exactly as \`up\` does.

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
  \`rn-iso stop\` is the inverse of \`start\`: it halts the supervisor, shuts
  the owned device down (never deletes it) and frees the port.

  The supervisor's own stdio goes to .rn-iso/logs/supervisor.log, which is NOT
  part of the NDJSON timeline. It is what a supervisor that died before it
  could write a structured record leaves behind, so it is the file to read when
  \`start\` fails -- and \`start\` already prints its last lines for you.

STARTING YOUR OWN BUNDLER STILL WORKS
  \`up\` still only reserves the port and prints the facts, so driving your own
  bundler against them is still supported. Start it from INSIDE the project
  directory, in the background, on the reserved port:

    Expo                      npx expo start --port <port>
    Bare React Native         npx react-native start --port <port>
    Has its own start script  run it and append --port <port>; it may carry
                              flags that matter (e.g. --client-logs)
    Monorepo                  run from the APP directory, not the repo root

  Then confirm it is yours before building, either by polling
  \`rn-iso device --platform ios --json\` until metroHealthy is true, or with:

    npx rn-iso up ios --wait-metro --json

  The cost is logs: rn-iso captures only a dev server it hosted, so
  \`rn-iso logs\` stays empty and finding output is back to redirecting it to a
  file yourself. Prefer \`start\`.

  Either way, start it from inside the project directory. Teardown identifies a
  bundler by checking that the process on the port both answers /status AND
  runs from inside the project; started elsewhere, rn-iso refuses to kill it.`,
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
  --source <s...>  metro, client, device, build (one or more). An unknown
                   value is REJECTED rather than quietly matching nothing.
  --level <l>      minimum level: debug, info, warn, error, fatal
  --since <d>      only records newer than this: 30s, 5m, 2h
  --grep <re>      only records whose msg matches this regular expression
  --tail <n>       only the last n MATCHING records (applied after filtering,
                   so --level error --tail 5 is the last five ERRORS)
  --errors         errors and fatals since the last marker -- the agent query
  --follow         keep streaming until interrupted (Ctrl+C is exit 0)
  --json           the raw records, one per line, so stdout is valid NDJSON

--ERRORS, PRECISELY
  Level error or fatal, timestamped strictly AFTER the most recent record
  carrying marker: true. The marker is searched across every source, not just
  the ones being reported, so a marker in one file closes the window for all of
  them. A marker is written when a bundle build finishes: it means everything
  before it is history, which is what stops a redbox you already fixed from
  being reported forever.

  In --follow mode the marker window is dropped -- every error arriving from
  then on is by definition after the last marker seen.

  \`rn-iso status\` reports the same count per workspace, as
  logs.errorsSinceMarker.

THE RECORD
  { ts, src, level, msg } always. ts is epoch milliseconds; src is one of
  metro / client / device / build; level is one of the five above.
  Optional fields:
    event    the producer's own event name (bundle_build_done, client_log, ...)
    stack    frames of { file, line, column, fn }, passed through as reported
    marker   true on the records that close an error window
    raw      true when the level was inferred from a line of text rather than
             reported by the producer (every expo-child record)

WHAT WRITES TODAY
  metro.ndjson   the bundler, in both supervisor modes
  client.ndjson  in-app console logs and redboxes -- BARE PROJECTS ONLY. In
                 expo-child mode everything Expo prints lands in metro.ndjson
                 with raw: true, so \`--source client\` returns nothing there.
  Nothing writes the device or build sources yet: they are accepted by
  \`--source\` and match nothing.

  Only a dev server rn-iso hosted is captured. If you started the bundler
  yourself, this timeline is empty and that is not a sign of a clean build.`,
  },

  errors: {
    summary: 'Every refusal rn-iso can print, and what to do about it',
    body: () => `WHAT RN-ISO REFUSES, AND WHY

"port <n> is in use but is NOT this project's Metro" / metroConflict non-null
  Something holds your reserved port that rn-iso cannot prove is your Metro.
  Causes, most common first:
    - You started Metro from the wrong directory (repo root instead of the
      app dir in a monorepo). Restart it from inside the project.
    - Another repo's Metro owns the port. Stop it there, or free the port and
      re-run \`up\` to get a fresh reservation.
    - A non-Metro server (a web dev server) took the port. Free it.
  \`rn-iso stop --force\` kills whatever holds it without proving whose it is
  -- ask the user first. That flag is reachable only when no supervisor is
  recorded for this workspace; it never deletes anything.

"metro: refusing to kill port <n>: ... runs from <dir>, outside <project>"
  Same cause, seen from \`stop\`. rn-iso will not kill a process it cannot
  attribute to you.

"this project's sim is X, but --device-type asked for Y"
  The project already owns a simulator of a different model. \`rn-iso release\`
  deletes it (losing that sim's app state), then \`up ios\` creates the one you
  asked for.

"Refusing to remove <path>: uncommitted changes / untracked files / commits
not on any remote"
  A native build rewrites tracked files -- \`pod install\` always touches
  Podfile.lock and project.pbxproj -- so this fires after almost every iOS
  build. The refusal now PRINTS THE DIRTY PATHS: restore those rather than
  reaching for --force. When the list is only pod churn:
    git checkout -- ios/Podfile.lock ios/*.xcodeproj/project.pbxproj
  A setup script that rewrites tracked assets (brand icons, generated config)
  produces the same refusal and the command above clears nothing -- restore
  the paths the refusal actually named.
  Use --force only when you genuinely intend to discard work; it deletes
  uncommitted and untracked files permanently.

"Carried <dir>/Pods does not match <dir>/Podfile.lock" (worktree create)
  \`ios/Pods\` is gitignored, so --carry-ignored clones it; \`ios/Podfile.lock\`
  is tracked, so it comes from the branch. When the source worktree's two
  disagree, the new worktree inherits the contradiction. Run \`pod install\`
  before building. Ignore it and xcodebuild fails with
    error: The sandbox is not in sync with the Podfile.lock
  in the LAST build phase, after every pod has already compiled.

"No node_modules among them" (worktree create --carry-ignored)
  The clone can only carry what the source worktree has, and the source has no
  node_modules. The path count above that line is not evidence of a usable
  worktree. Install dependencies before building.

"Installed rn-iso skill is X but this CLI is Y"
  The skill is a plain file copy, so upgrading rn-iso never refreshes it, and
  npx can serve a cached older CLI. Run \`npx rn-iso skill install\`. If the
  CLI itself is the old half, \`npx rn-iso@latest\` bypasses the stale cache.

"The dev server did not answer on port <n> within <s>s." (start)
  The supervisor is alive, but nothing is serving yet. \`start\` has already
  printed the last lines of .rn-iso/logs/supervisor.log above this -- read
  them. A cold Metro on a large graph can genuinely need more than the default
  60s: re-run with \`--wait 180\`. Otherwise \`rn-iso stop\`, then \`start\`.

"The supervisor exited (<code|signal>) before the dev server came up" (start)
  The dev server failed outright, and the quoted supervisor.log tail is the
  real error. Fix that and run \`start\` again; nothing is left running.

"RN_ISO_BARE_DEPS" / "RN_ISO_BARE_LOAD" / "RN_ISO_BARE_API" (start, bare RN)
  The supervisor hosts Metro out of the PROJECT's node_modules, so metro,
  @react-native/dev-middleware and @react-native-community/cli-server-api must
  be installed there and must match the project's React Native. DEPS = not
  resolvable (install them), LOAD = installed but threw while loading,
  API = loaded but is not the API rn-iso expects (mismatched versions).

"RN_ISO_EXPO_BIN" (start, Expo)
  node_modules/.bin/expo does not exist. Install the project's dependencies.

"@rn-iso/metro is not installed ... so bundler and client logs will not be
captured" (in metro.ndjson, bare RN)
  The dev server is serving; only capture is missing, so \`logs\` would report
  a quiet timeline for a broken build. Install \`@rn-iso/metro\` as a
  devDependency of the project.

"supervisor: refusing to signal pid <n>: ..." (stop)
  The two records describing that supervisor disagree, or it records a port
  this project did not reserve. A pid is a number the OS reuses, so it is not
  signalled. The port reservation is KEPT -- it is the only handle a retry
  has. Check \`ps -p <n>\` and \`rn-iso status\` before signalling by hand.

"supervisor pid <n> did not exit within 10s of SIGTERM" (stop)
  Deliberately not escalated to SIGKILL: the supervisor may be mid-write on the
  very log files \`logs\` reads. The device is left alone and the port stays
  reserved. Re-run \`stop\`, or signal it yourself: kill -9 -<n> (note the
  minus -- it is a process group).

"Found no free Metro port between ..."
  200 consecutive ports are claimed or occupied. \`rn-iso status\` shows what
  rn-iso knows about; the rest is other software.

"Could not reserve a Metro port after 5 attempts"
  Several \`up\` runs raced for the same ports and each one lost. Nothing is
  wrong; retry.

"Failed to ensure android device: No physical device is connected"
  \`up android --serial <s>\` needs the device visible to \`adb devices\`.

"Could not tear down the <platform> device: ..."
  The delete itself failed, so \`release\` KEPT the assignment and exited 1.
  That is deliberate: dropping the record would leave a device on the machine
  that nothing references and nothing will ever reap. Fix the cause and re-run
  \`rn-iso release\`.

"rn-iso config at <path> is not valid JSON"
  The file holding every owned-device record will not parse, and rn-iso never
  resets it for you -- a silent reset would orphan every simulator it names.
  Repair the file, or move it aside (\`mv <path> <path>.broken\`) and accept
  that the devices it recorded become orphans you delete by hand.

"Timed out waiting for the rn-iso config lock at <path>"
  Every config write is serialised so parallel \`up\` runs cannot lose each
  other's records. A lock older than 10s is taken over automatically, so this
  means a command really is holding it. If none is running, remove that
  directory.`,
  },

  lifecycle: {
    summary: 'The full worktree -> dev server -> device -> build -> teardown flow',
    body: () => `ENVIRONMENT LIFECYCLE

  # 1. Isolated worktree (skip if you are already in one).
  #    It does NOT install dependencies -- that is yours.
  cd "$(npx rn-iso worktree create feature-x)"
  npm install

  # 2. The dev server, under a detached supervisor. Blocks until it is
  #    verifiably THIS project's, then hands your shell back.
  npx rn-iso start --json

  # 3. Device + the reserved port, as facts. metroHealthy is already true.
  npx rn-iso up ios --json

  # 4. YOUR build, against the printed facts. rn-iso does not build.
  npx expo run:ios --device <udid> --port <metroPort>

  # 5. Did it work? Empty output and exit 0 is the pass condition.
  npx rn-iso logs --errors

  # 6. Pausing: supervisor halted, owned sim SHUT DOWN (never deleted), port
  #    freed. Coming back costs a boot, not a create and a reinstall.
  npx rn-iso stop

  # 7. Done with the branch: the environment dies whole.
  npx rn-iso worktree remove <path>

Steps 2 and 3 commute: \`start\` reserves the port itself and \`up\` reuses
whatever is reserved.

WHAT THIS BINARY DOES NOT DO YET
  It does not build, install or launch your app -- step 4 is still the
  project's own command, and \`up\` exists to hand you the facts it needs.
  \`device\`, \`release\` and \`shutdown\` are all still here as well. Run
  \`npx rn-iso --help\` for the surface this version actually has, rather than
  assuming a command exists because a newer document mentions it.

DESTRUCTIVE COMMANDS -- ask the user first
  gc --delete             deletes orphaned rn-iso-* devices, tens of GB
  gc --delete --all       empties the shared build caches every project uses
  worktree remove --force discards uncommitted and untracked work
  release                 DELETES the owned device, not just its assignment,
                          without checking whether anything is still attached
  stop --force            kills a process rn-iso could not identify

\`stop\` itself destroys nothing, by design: it shuts the owned device down and
leaves it assigned, and there is no flag on it that could become a delete.
Destruction lives in \`release\`, \`worktree remove\` and \`gc --delete\`.
Shutting down spares a device another process is driving (\`stop\` and
\`shutdown\` share that path) because the device survives the call. A delete
goes ahead regardless, so there is no \`--force\` on \`release\` -- there is
nothing for it to override.

CAPACITY
  A booted iOS sim is roughly 1-2 GB of RAM, an Android emulator 2-3 GB. On a
  16 GB machine plan for 2-3 live environments. Nothing enforces this.`,
  },

  cleanup: {
    summary: 'Where simulators come from, and how they get reclaimed',
    body: () => `CLEANUP AND DISK

WHAT RECLAIMS AN OWNED DEVICE
  rn-iso release            deletes this project's owned device
  rn-iso worktree remove    deletes every owned device under the worktree
  rn-iso gc --delete        sweeps rn-iso-* devices no project references

None of those checks occupancy: a device being deleted goes away even if
something is still driving it. \`rn-iso shutdown\` is the one that spares an
occupied sim, because it only shuts down and never deletes.

If a delete fails, the device's config record is KEPT and the command reports
it. A record is what makes the device findable again, so it outlives a failed
teardown rather than turning it into an orphan.

A device leaks when a project is abandoned WITHOUT any of those -- the sim
survives with nothing pointing at it. \`rn-iso gc\` (no flag, writes nothing,
always safe) reports those; \`gc --delete\` reaps them, and in the same run
drops the dead config ENTRIES those projects left behind and frees their
Metro ports. \`--older-than <days>\` goes further: it also reaps an owned
device whose PROJECT has been untouched that long, even though the project
itself is still there.

THE ONE CASE GC WILL NOT REAP
  If the config is gone entirely (deleted ~/.rn-iso, or a throwaway
  RN_ISO_HOME), gc cannot tell your stale devices from another config's LIVE
  ones, so it refuses to delete anything. It still NAMES the rn-iso-* devices
  it found, so you can judge. Delete them yourself:
    xcrun simctl delete <udid>
    avdmanager delete avd -n <name>

DISK
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

Resolution order, first match wins:
  1. CLI flag        --device-type / --runtime / --system-image / --serial
  2. project layer   rn-iso config <key> <value>
  3. repo layer      rn-iso config --repo <key> <value>
  4. committed       .rn-iso.json at the repo root
  5. rn-iso default

KEYS RN-ISO READS
  ios.deviceType        e.g. "iPhone 17 Pro"
  ios.runtime           e.g. "26.2"
  android.systemImage   e.g. "system-images;android-36;google_apis;arm64-v8a"
  worktreeDir           where worktrees are created (repo layer)
  worktree.baseRef      "fresh" (origin/HEAD) or "head"
  worktree.include      carry-over patterns, same role as .worktreeinclude
  worktree.exclude      --carry-ignored skip list, same role as .worktreeexclude
  caches                extra shared-cache paths for 'gc' to report.
                        Repo layer or .rn-iso.json; the value is a JSON array,
                        e.g. rn-iso config caches '["~/.myapp-metro-cache"]'
                        --repo. Every path is treated as a flat store.

Anything else is IGNORED, and rn-iso warns about it by name. If you see such a
warning, the key was either renamed or removed -- check this list rather than
assuming it still applies.

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

export function topicNames() {
  return Object.keys(TOPICS);
}

export function renderTopic(name) {
  const topic = TOPICS[name];
  if (!topic) return null;
  return topic.body();
}

export function renderIndex(version) {
  const lines = [
    `rn-iso ${version} -- reference for the binary you are running.`,
    '',
    'This output is generated by the CLI, so it always matches this version.',
    'The bundled skill covers the stable rules; these topics cover the surface',
    'that changes between releases.',
    '',
    'TOPICS',
  ];
  const width = Math.max(...topicNames().map(n => n.length));
  for (const name of topicNames()) {
    lines.push(`  ${name.padEnd(width)}  ${TOPICS[name].summary}`);
  }
  lines.push('', 'Read one with:  npx rn-iso guide <topic>');
  return lines.join('\n');
}

export default function guideCommand(program, version) {
  program
    .command('guide [topic]')
    .description('Print reference documentation for THIS version of rn-iso (topics: ' + topicNames().join(', ') + '). Generated by the binary, so it cannot drift from the installed CLI.')
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
