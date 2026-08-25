// Generates the loop documentation a repo needs before several agents can work
// in it at once.
//
// What a repo cannot get from `--help` is the ORDER, and the handful of traps
// that cost an afternoon each -- so that is what gets written down. The
// generated `scripts/dev` is deliberately thin for the same reason: v3 runs the
// dev server and the build itself, so the script sequences two rn-iso commands
// instead of reconstructing a bundler and a build command the way v2's had to.
// It still lives in the consuming repo rather than inside rn-iso, because
// anything a project needs AROUND those two steps -- a codegen pass, a
// workspace filter, an env file -- is the judgement rn-iso refuses to take
// back, and a generated file is editable in a way a built-in command is not.
//
// Everything here is a pure function of facts about the project, so the template
// can be tested without touching a filesystem.
import { homedir } from 'os';
import { sharedCompilationCache } from './paths.js';
import { WORKSPACE_DIR_NAME as WORKSPACE_DIR } from './paths.js';

// Detected rather than assumed: the advice differs enough between an Expo app
// and a bare one that guessing would produce a document that is wrong in the
// places people actually get stuck.
// v2's facts also carried the project's package manager and its own
// start/ios scripts, because the generated script had to RECONSTRUCT a bundler
// and a build command. v3 runs both itself, so the templates name `rn-iso
// start` and `rn-iso ios` and there is nothing left to reconstruct: the package
// manager, the script table and the invented run command all went with it.
export function projectFacts({ pkg, appConfig, hasPodfile }) {
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const expoRange = deps.expo || null;
  const sdkMajor = expoRange
    ? parseInt(String(expoRange).replace(/[^\d.]/g, '').split('.')[0], 10) || null
    : null;
  return {
    name: appConfig?.expo?.name || pkg?.name || 'the app',
    isExpo: Boolean(expoRange),
    sdkMajor,
    hasDevClient: Boolean(deps['expo-dev-client']),
    hasPodfile: Boolean(hasPodfile),
    hasFingerprint: Boolean(deps['@expo/fingerprint']),
  };
}

// How this workspace's reserved port reaches the app. rn-iso does the wiring
// itself in `engine/app-install.js`; this section exists so the document says
// what it did, because a red "No script URL provided" screen is the symptom of
// the one case rn-iso cannot fix on its own (an Expo app with no dev client).
function devClientSection(facts) {
  if (!facts.isExpo) {
    return `Bare React Native: before launching, \`rn-iso ios\` writes
\`RCT_jsLocation\` into the app's defaults on the simulator, and \`rn-iso
android\` runs \`adb reverse tcp:8081\` onto the reserved port. Neither bakes
the port into the binary, which is what lets one cached build serve several
workspaces holding different ports.`;
  }
  if (facts.hasDevClient) {
    return `The port reaches the app through \`expo-dev-client\`: \`rn-iso ios\`
launches it with a \`<scheme>://expo-development-client/?url=...\` deep link
carrying this workspace's port, so nothing about the port is compiled in and one
cached build serves every workspace.`;
  }
  return `**Install \`expo-dev-client\` before anything else here works.** The
reserved port travels in the deep link \`rn-iso ios\` opens, and with nothing
handling that URL the app looks for Metro on 8081, finds nothing, and shows a
red \`No script URL provided\`.

\`\`\`bash
npx expo install expo-dev-client
\`\`\``;
}

// The cache that decides whether a second workspace on the same commit compiles
// at all. `rn-iso ios` / `rn-iso android` consult it themselves, so the only
// thing a repo has to supply is the fingerprinter they key on.
function buildCacheSection(facts) {
  const fingerprint = facts.hasFingerprint
    ? `\`@expo/fingerprint\` is already a dependency here, so this works today.`
    : `It needs \`@expo/fingerprint\`, which works on a bare project too:
\`npm i -D @expo/fingerprint\`. Without it \`rn-iso ios\` refuses with
\`RN_ISO_NO_FINGERPRINT\` rather than silently compiling every time.`;

  const key = facts.sdkMajor && facts.sdkMajor <= 53
    ? 'expo.experiments.buildCacheProvider'
    : 'expo.buildCacheProvider';
  const provider = facts.isExpo
    ? `

Builds run OUTSIDE rn-iso -- \`npx expo run:ios\` by hand, or EAS -- can share
the same artifacts through \`@rn-iso/expo-build-cache\`. Install it and point
\`${key}\` at it in app.json. That key matters: SDK 53 reads only the
\`experiments\` one and ignores the top-level one in silence, while SDK 54+
reads the top-level one and falls back to \`experiments\`. \`rn-iso doctor\`
checks this.`
    : '';

  return `Most changes touch no native input, and those should not compile anything.
\`rn-iso ios\` fingerprints the native inputs before it builds, and a
fingerprint another workspace has already built installs from
\`~/.rn-iso/build-cache\` instead -- the \`fingerprint <hash> hit\` line.

${fingerprint}${provider}`;
}

export function renderWorkflow(facts) {
  return `# WORKFLOW.md

Take a task, produce a pull request. Two or three in flight at once.

Generated by \`rn-iso init\`. Edit freely -- it is a starting point, not managed.

## 1. Workspace

\`\`\`bash
WS=$(npx rn-iso worktree create task-123 --carry-ignored)
cd "$WS"
\`\`\`

A git worktree with every gitignored path cloned rather than reinstalled --
\`node_modules\`, \`ios/Pods\`, build codegen, \`.env\`. On APFS those are
copy-on-write, so it costs seconds and almost no real disk instead of an install
plus a pod install.

The main checkout is never touched. Nothing in the loop runs there.

Cloned dependencies match the source worktree, not this branch's manifests --
the same contract as restoring a CI cache. Reinstall if the branch changes them.

## 2. Dev server

\`\`\`bash
npx rn-iso start
\`\`\`

Reserves a collision-free Metro port, starts the dev server under a detached
supervisor, and does not return until the server both answers and verifies as
THIS workspace's. No backgrounding, no \`sleep\`, no poll loop -- and no chance
of building against another worktree's bundler.

Nothing is ephemeral: every bundler event and every \`console.log\` from the app
is written to \`.rn-iso/logs/\` as it happens, and \`rn-iso logs\` is how you
read it back. There is no terminal to keep open and nothing to tee.

Running it twice is a no-op. A dev server you started yourself, outside rn-iso,
is left alone and reported with \`supervisorPid: null\`.

## 3. Build, install, launch

\`\`\`bash
./scripts/dev             # or: npx rn-iso ios
./scripts/dev android
\`\`\`

\`rn-iso init\` wrote that script next to this file; it is \`start\` and then
\`ios\`/\`android\`, in the order they have to happen. Edit it freely -- it is
this repo's entry point, not rn-iso's.

\`rn-iso ios\` boots this workspace's own simulator, checks the reserved port
BEFORE doing anything expensive, fingerprints the native inputs, installs the
cached build if there is one, and launches the app wired to that port.

It never starts the bundler. If nothing holds the reserved port it refuses in
about a second with \`RN_ISO_NO_METRO\`, rather than spending four minutes
building an app that cannot load a bundle.

A failure prints the extracted compiler diagnostic and a log path, not the
transcript. The transcript is still on disk in
\`.rn-iso/logs/build-ios.ndjson\` for the rare time you want it.

${devClientSection(facts)}

${buildCacheSection(facts)}

## 4. Implement, validate, PR

\`\`\`bash
npx rn-iso logs --errors --json      # the crash, symbolicated to a source line
\`\`\`

Edit, let Fast Refresh apply it -- no rn-iso command is involved in editing JS
-- then ask again:

\`\`\`bash
npx rn-iso logs --since 30s --level error
\`\`\`

Empty is the pass condition, and it exits rather than streaming. Reach for
\`--follow\` only when you are watching a reproduction happen; \`--source
device\` for a native crash that never reached JS.

Validate on the device. Screenshots for anything visual, before-and-after for
anything perceptual, both platforms when the task itself is cross-platform.
Capture the "before" evidence *before* you edit anything -- recovering it later
means stashing your fix and rebuilding the state you already had.

A perceptual problem still needs a number. Video proves the feel; it does not
measure.

## 5. Finish

\`\`\`bash
npx rn-iso stop                      # done for now: supervisor down, sim shut down, port freed
npx rn-iso worktree remove "$WS"     # done with the branch
\`\`\`

\`stop\` is the inverse of \`start\` and destroys nothing -- the simulator stays
assigned, so coming back costs a boot rather than a create and a reinstall. Use
it to reclaim ~1.5 GB from a branch you are not finished with.

\`worktree remove\` is the destructive one: it removes the worktree, deletes the
owned simulator, and frees the port. It refuses if the worktree holds
uncommitted changes or commits that exist on no remote -- push first rather than
forcing. Note that an iOS build rewrites \`Podfile.lock\` and
\`ios/*.xcodeproj/project.pbxproj\`, so that refusal fires after almost every
one; it is correct, and the fix is to commit.

## Concurrency

Two or three workspaces, not ten. Each holds a simulator (1-2 GB) and a dev
server; the binding constraint is RAM, and a machine that starts swapping is
slower than one working in sequence. \`npx rn-iso status\` says how many are
already up -- it reports every workspace on the machine, not just this one.

Builds do not need serialising: each workspace has its own derived data under
\`.rn-iso/\`, and the shared caches are content-addressed and append-only.

## Keeping it fast

\`\`\`bash
npx rn-iso doctor                        # what is silently costing time
npx rn-iso gc                            # what the shared caches have grown to
npx rn-iso gc --delete --older-than 30   # trim what nothing has used
\`\`\`
`;
}

// A worktree carries every gitignored path by default, which is what makes it
// cheap -- but per-run output is pure noise in a fresh workspace and can be far
// larger than everything else combined.
export function renderWorktreeExclude() {
  return `# Paths not worth carrying into a new workspace (gitignore-style patterns).
# Everything else that is gitignored comes along, which is what makes
# \`worktree create --carry-ignored\` cheap.

# Per-run output: large, and meaningless in a fresh workspace.
**/*.log
coverage

# This workspace's own build output, logs and supervisor pidfile. Carrying them
# is worse than starting cold: the build output is keyed to a path the new
# worktree does not have, and the pidfile names a process that is not running.
${WORKSPACE_DIR}/
`;
}

// The workspace directory is ignored AND excluded, and both halves are load
// bearing. Ignored but not excluded is the state in which --carry-ignored
// clones the last workspace's build output into a fresh one; excluded but not
// ignored means every build offers its own DerivedData up for commit.


// Appended rather than generated: .gitignore belongs to the repo, and by the
// second week its contents are none of rn-iso's business.
export function renderGitignoreAdditions() {
  return `# rn-iso: this workspace's build output, logs and supervisor pidfile.
# Location-addressed -- meaningful only to the checkout that produced it, so it
# dies with the worktree instead of being reverse-mapped out of a global cache.
${WORKSPACE_DIR}/
`;
}

// The lines that enable Xcode's content-addressed compilation cache and pin
// where it lives, for the \`post_install\` block of an ios/Podfile.
//
// The pin is the entire point. The default CAS path is INSIDE DerivedData, and
// rn-iso gives every workspace its own DerivedData -- so left at its default
// the cache follows DerivedData into the worktree, becomes per-worktree, and
// shares with nothing, which is the only reason to turn it on. Pinning it to
// the shared directory is what makes a second workspace's build partial rather
// than full.
export function renderPodfileCasPin(casPath = sharedCompilationCache()) {
  return `# rn-iso: share compiled output between workspaces (Xcode 26+).
# The default CAS path is inside DerivedData, which is per-workspace, so
# leaving it there shares nothing. Pin it outside instead.
config.build_settings['COMPILATION_CACHE_ENABLE_CACHING'] = 'YES'
config.build_settings['COMPILATION_CACHE_CAS_PATH'] = ${rubyPathLiteral(casPath)}
`;
}

// A Podfile is committed and every machine's home directory is a different
// absolute path, so a path under $HOME is written relative to it and expanded
// at pod install time. Anything else is already machine-specific by choice
// (RN_ISO_HOME), and is emitted as given.
function rubyPathLiteral(path) {
  const home = homedir();
  const relative = path.startsWith(`${home}/`) ? path.slice(home.length + 1) : null;
  return relative ? `File.expand_path('~/${relative}')` : `'${path}'`;
}

// The one script worth generating. `worktree create` and `worktree remove` are
// already commands, but the middle of the loop is a SEQUENCE -- reserve, start
// the bundler, wait for it, run against it -- and getting the order wrong fails
// in ways that do not name themselves: build before Metro answers and the app
// opens on a red screen, pass --no-bundler and the command exits without
// building.
//
// It lives in the consuming repo rather than inside rn-iso on purpose. Which
// build command a project needs is the judgement rn-iso refuses to take back,
// and a generated script is editable in a way a built-in command is not.
export function renderDevScript() {
  return `#!/usr/bin/env bash
# Generated by \`rn-iso init\`. Edit freely.
#
# The two commands of the loop, in the order they have to happen: a verified dev
# server on this workspace's reserved port, then the build/install/launch
# against it. Building before the server answers gets you a red screen instead
# of your app, which is why \`rn-iso ios\` refuses outright when the port is
# empty.
#
# This lives in the repo rather than inside rn-iso so it stays yours to edit --
# a pre-build codegen step, a workspace filter, an env file to source. Anything
# rn-iso itself would have to guess at belongs here.
set -euo pipefail

PLATFORM="\${1:-ios}"
if [ "$#" -gt 0 ]; then shift; fi

# Idempotent: a healthy dev server on the reserved port is a no-op exit 0.
npx rn-iso start

# Remaining arguments are forwarded, so \`./scripts/dev ios --json\` works.
npx rn-iso "$PLATFORM" "$@"
`;
}
