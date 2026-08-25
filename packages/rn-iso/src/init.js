// The files `rn-iso init` writes into a repo: the `.gitignore` entry that keeps
// a workspace's own output out of `git status`, the Podfile compilation-cache
// pin, and `scripts/dev`.
//
// There used to be a generated WORKFLOW.md here too. It went in v3: v2 needed a
// per-repo document because rn-iso refused to know a project's build commands,
// and v3 IS the build command -- so the file had decayed into an unmanaged copy
// of `rn-iso guide lifecycle` and the rn-iso-init skill, wrong in exactly the
// places the repo had moved on (it told a repo already pointing
// `buildCacheProvider` at "eas" to install another provider over it). Generated
// prose about behaviour goes stale in a file nobody re-generates; the guide and
// the skill ship with the version they describe.
//
// `scripts/dev` stays because it is not documentation: it is the composition
// point a repo edits when it needs a codegen pass or a workspace filter around
// the two commands.
//
// Everything here is a pure function of facts about the project, so the
// templates can be tested without touching a filesystem. The one exception is
// `projectFacts`, which resolves `@expo/fingerprint` from the project when it is
// given a root -- see the note there.
import { homedir } from 'os';
import { loadFingerprinter } from './build-cache.js';
import { sharedCompilationCache } from './paths.js';
import { WORKSPACE_DIR_NAME as WORKSPACE_DIR } from './paths.js';

// What `init` reports back about the project it just wrote into. Nothing here
// composes a command line for the project: v3 runs the dev server and the build
// itself, so the script table and the invented run command that v2's facts
// carried are gone.
//
// `packageManager` is the one that came back: a remedy printed as `npm i -D` in
// a pnpm workspace writes a second lockfile and installs where nothing resolves
// from, so the caller detects the manager from the lockfile and this only
// passes it through to `installCommand`.
//
// `hasFingerprint` is deliberately NOT just the dependency table. In a monorepo
// `@expo/fingerprint` is hoisted and usually transitive, so the app's own
// dependencies do not list it while it resolves perfectly well -- and init used
// to announce that builds could not be cached in a repo where they already
// could. Given a root, this resolves it the way the build path does
// (`loadFingerprinter`), and falls back to the dependency table without one.
export function projectFacts({ pkg, hasPodfile, projectRoot = null, packageManager = null }) {
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const expoRange = deps.expo || null;
  const sdkMajor = expoRange
    ? parseInt(String(expoRange).replace(/[^\d.]/g, '').split('.')[0], 10) || null
    : null;
  return {
    isExpo: Boolean(expoRange),
    sdkMajor,
    hasDevClient: Boolean(deps['expo-dev-client']),
    hasPodfile: Boolean(hasPodfile),
    hasFingerprint: Boolean(deps['@expo/fingerprint'])
      || (projectRoot ? loadFingerprinter(projectRoot) != null : false),
    packageManager,
  };
}

// The repo's own package manager, because `npm i -D` in a pnpm workspace
// writes a second lockfile and installs into a directory nothing resolves
// from. Null means it could not be told, and the caller says so in words
// rather than picking one.
export function installCommand(packageManager, pkg) {
  if (packageManager === 'pnpm') return `pnpm add -D ${pkg}`;
  if (packageManager === 'yarn') return `yarn add -D ${pkg}`;
  if (packageManager === 'npm') return `npm i -D ${pkg}`;
  return null;
}

// `.rn-iso/` is gitignored and nothing more. It used to need a second entry in
// a generated `.worktreeexclude` as well, and missing that one was silent: a
// fresh worktree got handed the previous workspace's derived data, its stale
// logs and a pidfile for a dead supervisor. `worktree create --carry-ignored`
// now skips the directory unconditionally in code (isWorkspaceArtifact in
// src/worktree.js), so there is no second file to keep in sync and nothing to
// generate. `.worktreeexclude` remains supported, as the repo's own additions
// to that skip list.


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
#
# Paste this whole block inside \`post_install do |installer|\`. It brings its
# own loop on purpose: the two settings only mean anything against a build
# configuration, and a post_install with no target loop of its own -- or one
# that loops over resource bundles only -- takes the bare lines happily and
# caches nothing.
installer.pods_project.targets.each do |target|
  target.build_configurations.each do |config|
    config.build_settings['COMPILATION_CACHE_ENABLE_CACHING'] = 'YES'
    config.build_settings['COMPILATION_CACHE_CAS_PATH'] = ${rubyPathLiteral(casPath)}
  end
end
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
#
# The loop itself -- worktree, start, ios/android, logs, stop -- is documented by
# \`npx rn-iso guide lifecycle\`, which ships with the version you have installed.
set -euo pipefail

PLATFORM="\${1:-ios}"
if [ "$#" -gt 0 ]; then shift; fi

# Idempotent: a healthy dev server on the reserved port is a no-op exit 0.
npx rn-iso start

# Remaining arguments are forwarded, so \`./scripts/dev ios --json\` works.
npx rn-iso "$PLATFORM" "$@"
`;
}
