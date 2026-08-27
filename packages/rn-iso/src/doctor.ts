// Checks for the settings that decide whether a second workspace is fast or
// slow, and that give no feedback when they are wrong.
//
// Every finding here was a real, silent cost on a real project: a build cache
// that never hit because its key was per-workspace, a dev client missing so a
// reserved Metro port could not reach the app, a Metro cache that re-transformed
// two thousand modules per worktree. None of them fail a build. They just make
// it slow, and nothing says so.
//
// Findings are observations with a reason, not pass/fail rules: the specifics
// are Xcode- and SDK-version-shaped and will age. A finding that says what was
// seen and why it matters stays useful even when its advice does not.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getExecutor } from './exec.ts';
import { detectIsExpo } from './project.ts';
import { diffFingerprintSources, fingerprintProject, loadFingerprinter, type Fingerprinter } from './build-cache.ts';
import { dirtyFingerprintFiles } from './worktree.ts';
import { type Config, type ConcurrencyLimits, getConcurrencyLimits, loadConfig } from './config.ts';
import { liveOwnedDeviceCount } from './engine/device.ts';
import { listBuildSlots } from './engine/build-slots.ts';
import { type IosSimRecord, listAllIosSims } from './sim/ios.ts';
// parseXcodeMajor / detectXcodeMajor / ccacheEnabled live in the BUILD engine
// now, because the build is what consumes them: rn-iso puts the compilation
// cache on its own xcodebuild argv, and both the version floor and the ccache
// veto are that decision's. doctor reports on the same two facts, so it reads
// the one implementation rather than keeping a second.
import { ccacheEnabled, COMPILATION_CACHE_MIN_XCODE, detectXcodeMajor, parseXcodeMajor } from './engine/xcode.ts';
import { type AdbDevices, listAdbDevices } from './sim/android.ts';
// The engine owns the eas-cli half (resolution, whoami, the parse); this file
// owns what to SAY about it. Imported under a second name because the pure
// check below is the doctor-side function of the same idea.
import {
  type EasAuthResult,
  checkEasAuth as probeEasAuth,
  ownerFromConfig,
  providerFromConfig,
} from './engine/remote-cache.ts';
import { WORKSPACE_DIR_NAME as WORKSPACE_DIR } from './paths.ts';

// Loosely-typed views of the JSON config files this module parses
// defensively (package.json, app.json, Podfile.properties.json): the shapes
// come from outside this codebase, so they are read with `?.` rather than
// modelled as closed interfaces.
type AnyJson = Record<string, unknown>;

export { detectXcodeMajor, parseXcodeMajor };

// 'cost'  -- measurably slower, silently
// 'note'  -- worth knowing, not necessarily wrong
export interface Finding {
  level: 'cost' | 'note';
  title: string;
  detail: string;
  fix: string | null;
}

// 'cost'  -- measurably slower, silently
// 'note'  -- worth knowing, not necessarily wrong
function finding(level: 'cost' | 'note', title: string, detail: string, fix: string | null): Finding {
  return { level, title, detail, fix };
}

function readJson(path: string): AnyJson | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

// A reserved Metro port only reaches the app through expo-dev-client's deep
// link: `--port` is never compiled into the binary. Without it the app looks
// for Metro on 8081, finds nothing, and shows a red screen naming none of this.
//
// `isExpo` is whether the project BUILDS with the Expo CLI, which is not the
// same as having `expo` in dependencies: an app can depend on a dozen expo-*
// modules and still launch through `react-native run-ios`, where `--port` is
// baked in at build time and no deep link is involved. Callers pass
// detectIsExpo(projectRoot) so this agrees with what `status` prints.
export function checkDevClient(pkg: AnyJson | null, isExpo: boolean = true): Finding | null {
  const deps = {
    ...(pkg?.dependencies as AnyJson | undefined),
    ...(pkg?.devDependencies as AnyJson | undefined),
  };
  if (deps['expo-dev-client']) return null;
  // Bare React Native has its own way of reaching a non-default port and no
  // dev client to install; this advice only applies to an Expo app.
  if (!isExpo || !deps.expo) return null;
  return finding(
    'cost',
    'expo-dev-client is not installed',
    'A Metro port reserved by rn-iso cannot reach the app without it: the port travels in the dev-client deep link `rn-iso ios` opens, and without the dev client nothing handles that URL. The app falls back to port 8081 and shows "No script URL provided".',
    'npx expo install expo-dev-client',
  );
}

// Metro's default cache is per-project, so every worktree re-transforms the
// whole module graph. One FileStore outside any project fixes it -- and rn-iso
// now installs that store ITSELF, on its own dev server, so none of what
// follows is a setup step any more.
//
// THESE FINDINGS ARE ABOUT BUILDS RN-ISO DOES NOT DRIVE. `rn-iso start` hosts
// a bare project's Metro in-process and appends rn-iso's own FileStore to
// whatever cacheStores the project configured; on Expo it injects the same
// store into the child through NODE_OPTIONS. So a project with no cacheStores
// at all still gets a shared transform cache under `rn-iso start`. What a
// committed store buys is the runs rn-iso is not in: `npx expo start` by hand,
// a teammate's editor task, CI.
//
// This reads the file and never evaluates it -- a metro.config.js runs project
// code, and a diagnostic may not. That is why a mention of `cacheStores` is not
// the same as a cacheStore: on a real repo the store was built behind
// `process.env.X === '1' ? [...] : undefined` and spread in, so it was off for
// everyone who had not opted in, and a substring match called that a pass.
// Unreadable stays unreadable; the finding says so instead of guessing either
// way.
export function checkMetroCache(metroConfigSource: string | null): Finding | null {
  if (metroConfigSource == null) {
    return finding(
      'note',
      'No metro.config.js found (rn-iso supplies the shared store anyway)',
      "Metro's default transform cache lives under $TMPDIR/metro-cache -- outside the project, but in a location the OS periodically purges and rn-iso's gc cannot see. `rn-iso start` appends its own FileStore under ~/.rn-iso/metro-cache regardless, so the dev server rn-iso runs is already sharing transforms between worktrees.",
      'Nothing to do for rn-iso. Add a metro.config.js with a FileStore cacheStore only if you also run Metro outside it.',
    );
  }
  // A config that is nothing but a re-export cannot be read here at all: the
  // store, if there is one, lives in the package it delegates to. Saying so is
  // the honest answer; the confident per-project finding below would be a
  // measurement of a file that decides nothing.
  const delegate = metroConfigDelegate(metroConfigSource);
  if (delegate) {
    return finding(
      'note',
      `metro config delegates to ${delegate}; rn-iso cannot inspect it`,
      `metro.config.js is a re-export of ${delegate} and doctor reads this file rather than executing it, so whether a shared cacheStore is configured is decided somewhere rn-iso cannot see. This is a note, not a cost: the store may well be there, and \`rn-iso start\` appends its own to whatever that file resolves to either way.`,
      `Nothing to do for rn-iso. If you also run Metro outside it, check ${delegate} for a cacheStores/FileStore rooted outside every project (@rn-iso/metro's sharedCacheStores() is the packaged one).`,
    );
  }
  const lines = String(metroConfigSource).split('\n');
  const mentions = lines.filter((line) => /cacheStores/.test(line));
  if (mentions.length) {
    // One unconditional mention is enough: the store is wired for everybody.
    if (!lines.every((line, i) => !/cacheStores/.test(line) || isConditional(lines, i))) return null;
    return finding(
      'note',
      'metro.config.js mentions cacheStores, but not unconditionally',
      `Every line naming it is inside a conditional, and doctor reads this file rather than executing it, so it cannot tell whether the store is installed. Under \`rn-iso start\` this costs nothing -- rn-iso appends its own store whether the project's is on or off -- but outside rn-iso a cacheStores that is off by default costs exactly what having none costs: ${mentions.map((l) => l.trim()).join(' / ')}`,
      'Only for Metro runs rn-iso does not host: confirm it applies without env vars -- a store behind an opt-in flag is not shared until every workspace sets the flag.',
    );
  }
  return finding(
    'note',
    'metro.config.js sets no cacheStores (rn-iso supplies one on its own dev server)',
    'Without a shared cacheStore each worktree transforms the whole module graph from cold -- thousands of modules, every time. `rn-iso start` appends its own FileStore under ~/.rn-iso/metro-cache, so the dev server rn-iso hosts does not pay that; a Metro started any other way still does.',
    "Nothing to do for rn-iso. For runs outside it: config.cacheStores = [new FileStore({ root: path.join(os.homedir(), '.<app>-metro-cache') })]",
  );
}

// PURE. The package a metro.config.js hands its whole job to, or null.
//
// A real monorepo's app had this as its entire config:
//
//   module.exports = require('@acme/app-scripts/metro-config')(__dirname);
//
// Every text check below it -- and the "Metro cache is per-project" finding it
// would otherwise emit -- is blind on a file like that, and reporting a cost
// nobody can act on is worse than reporting nothing. The rule: no mention of
// cacheStores anywhere, and the file's only statement is a re-export of a
// module that is not one of Metro's own config packages (a config that
// requires `expo/metro-config` and then builds on it is an ordinary config,
// not a delegation).
const METRO_CORE_MODULES =
  /^(?:metro|metro-config|metro-cache|@react-native\/metro-config|@expo\/metro-config|expo\/metro-config|expo\/metro-config\/.*|@react-native\/metro-babel-transformer|path|node:path|fs|node:fs|os|node:os)$/;

export function metroConfigDelegate(source: unknown): string | null {
  const text = String(source || '');
  if (/cacheStores/.test(text)) return null;
  const code = text
    // Comments first: the delegating config in the wild carried a commented-out
    // `getDefaultConfig` require, and counting that as a statement would hide
    // every real delegation behind it.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line !== '' && line !== "'use strict';" && line !== '"use strict";')
    .join(' ');
  const m =
    /^module\.exports\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)[^;]*;?$/.exec(code) ||
    /^export\s+(?:\*|\{\s*default[^}]*\})\s+from\s+['"]([^'"]+)['"];?$/.exec(code) ||
    /^export\s+default\s+require\(\s*['"]([^'"]+)['"]\s*\)[^;]*;?$/.exec(code);
  if (!m) return null;
  const pkg = m[1];
  if (pkg === undefined) return null;
  const base = pkg.startsWith('@') ? pkg.split('/').slice(0, 2).join('/') : (pkg.split('/')[0] ?? pkg);
  if (METRO_CORE_MODULES.test(pkg) || METRO_CORE_MODULES.test(base)) return null;
  // A relative path is still this repo's own code, and naming it is still the
  // honest answer -- doctor cannot follow it either.
  return pkg;
}

// Deliberately crude, because the alternative is evaluating the file: an env
// var, a ternary or an `if` on the line means the wiring depends on something
// this cannot see. The window is the line itself plus -- only when the line is
// indented, i.e. it is somebody's block body -- the line that opens the block,
// which is what catches `if (process.env.X) { config.cacheStores = ... }`
// written across two lines. It stops there on purpose: chasing an arbitrary
// nesting is parsing, and the wrong answer here costs a note, not a cost.
function isConditional(lines: string[], index: number): boolean {
  const line = lines[index];
  if (line === undefined) return false;
  if (isConditionalLine(line)) return true;
  if (!/^\s+\S/.test(line)) return false;
  for (let i = index - 1; i >= 0; i--) {
    const prev = lines[i];
    if (prev === undefined) continue;
    if (prev.trim() === '') continue;
    return isConditionalLine(prev);
  }
  return false;
}

function isConditionalLine(line: string): boolean {
  return /process\.env/.test(line) || line.includes('?') || /(^|[^\w])if([^\w]|$)/.test(line);
}

// Xcode's compilation cache defaults to the DerivedData root. DerivedData is
// derived from the workspace path, so the default is per-workspace -- which is
// exactly the sharing it looks like it is providing.
//
// NOT A SETUP STEP ANY MORE. `rn-iso ios` passes the caching settings, the
// shared CAS path and the clang prefix mapping on its own xcodebuild argv
// (compilationCacheSettings in engine/xcode.ts), where a `SETTING=value`
// override reaches every target including the Pods. So the Podfile edit buys
// nothing for a build rn-iso drives; it buys the builds rn-iso does not drive.
// Both findings below say that, and both are notes for that reason.
export function checkCompilationCache(podfileSource: string | null, xcodeMajor: number | null): Finding | null {
  if (podfileSource == null) return null;
  // The content-addressed compilation cache is Xcode 26+. On anything older
  // there is nothing to advise: saying "enable it" would be wrong, and saying
  // "upgrade Xcode" is a bigger decision than this command should be making.
  // A null major means the version could not be read, which is not the same as
  // "old": the advice still goes out, hedged, rather than being withheld.
  // (rn-iso's OWN argv is stricter -- it needs a version it actually read; see
  // compilationCacheSettings.)
  if (xcodeMajor != null && xcodeMajor < COMPILATION_CACHE_MIN_XCODE) return null;
  const enabled = /COMPILATION_CACHE_ENABLE_CACHING/.test(podfileSource);
  const path = /COMPILATION_CACHE_CAS_PATH/.test(podfileSource);
  if (!enabled) {
    // Say which Xcode this is about. Naming a version rn-iso never read would
    // read as a measurement, and the advice is wrong on anything older than 26.
    const version =
      xcodeMajor != null
        ? `On Xcode ${xcodeMajor}`
        : "On Xcode 26 or newer (this machine's Xcode version could not be read, so check yours first)";
    return finding(
      'note',
      'The Podfile does not enable Xcode compilation caching (rn-iso supplies it on its own builds)',
      `${version} a content-addressed cache can carry compiled output between workspaces, which is the difference between a full build and a partial one in a fresh worktree. \`rn-iso ios\` already passes COMPILATION_CACHE_ENABLE_CACHING, a shared COMPILATION_CACHE_CAS_PATH and the clang prefix mapping on its own xcodebuild command line, so this repo needs no change to get it. The Podfile only matters if you ALSO build outside rn-iso -- Xcode itself, \`npx expo run:ios\`, CI -- where those runs fall back to the per-workspace default.`,
      "Nothing to do for rn-iso. For builds outside it: in the Podfile's post_install, inside an `installer.pods_project.targets.each { |t| t.build_configurations.each { |config| ... } }` loop -- adding one if post_install has none, or has only a loop over resource bundles -- set config.build_settings['COMPILATION_CACHE_ENABLE_CACHING'] = 'YES' and COMPILATION_CACHE_CAS_PATH to a path outside DerivedData.",
    );
  }
  if (!path) {
    return finding(
      'note',
      'The Podfile enables compilation caching but leaves the CAS at its default path',
      'The default CAS lives at the DerivedData root, and DerivedData is per-workspace -- so nothing is actually shared between worktrees, which is the only reason to turn it on. Builds rn-iso drives are unaffected: they override COMPILATION_CACHE_CAS_PATH to a shared path on the xcodebuild command line, which wins over the project setting. This costs only the builds you run outside rn-iso.',
      'Nothing to do for rn-iso. For builds outside it: set COMPILATION_CACHE_CAS_PATH to a fixed path outside DerivedData.',
    );
  }
  return null;
}

// `.rn-iso/` holds this workspace's build output, its logs and the supervisor
// pidfile: everything that is meaningful only to the checkout that produced it.
//
// This used to check two files. The other half -- whether `.rn-iso/` was listed
// in a `.worktreeexclude` -- is gone because it cannot be wrong any more:
// `worktree create --carry-ignored` skips the directory unconditionally, in
// code (isWorkspaceArtifact in src/worktree.js), at any depth and whatever any
// pattern file says. Checking a guarantee is how doctor ends up confirming a
// file nothing reads, which is exactly what it did in a monorepo, where the
// `.worktreeexclude` it read sat next to package.json and `worktree create`
// read the repo root's.

// gitignore is a line-oriented path list, so the entry is matched as a path and
// not as a substring: a commented-out line ignores nothing, and `/.rn-iso`,
// `.rn-iso` and `.rn-iso/` are the same entry.
function listsWorkspaceDir(source: string | null | undefined): boolean {
  if (source == null) return false;
  return String(source)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .some((line) => line.replace(/^\/+/, '').replace(/\/+$/, '') === WORKSPACE_DIR);
}

// `gitIgnored` is git's own verdict (`git check-ignore`), which sees every
// .gitignore on the path -- a monorepo app dir covered by the REPO ROOT's
// .gitignore is properly ignored even though its own file never says so
// (appandflow/rn-iso#31). The file read stays as the fallback for a tree
// where git is not available.
export function checkArtifactLayout({
  gitignoreSource,
  gitIgnored = null,
}: { gitignoreSource?: string | null; gitIgnored?: boolean | null } = {}): Finding | null {
  if (gitIgnored === true) return null;
  if (gitIgnored === null && listsWorkspaceDir(gitignoreSource)) return null;
  return finding(
    'note',
    '.rn-iso/ is not gitignored',
    "It holds this workspace's build output, logs and supervisor pidfile -- location-addressed, meaningful only to the checkout that produced it. Unignored, every build offers its own DerivedData up for commit and git status stops being readable.",
    `Add ${WORKSPACE_DIR}/ to .gitignore -- or just run start/ios/android once: they add it themselves and say so. On a repo rn-iso has already touched, this finding means that self-write failed or was reverted.`,
  );
}

// ccache and compilation caching are mutually exclusive in practice: the ccache
// launcher is what disables explicitly built modules, which caching requires.
//
// THIS ONE STAYS A REAL WARNING, and it now fires on ccache ALONE. It used to
// need both halves enabled in the project, because the project was the only
// thing that could turn compilation caching on. rn-iso turns it on itself now,
// on every `rn-iso ios` -- except here: `apple.ccacheEnabled=true` is the one
// condition that makes it skip (ccacheEnabled, engine/xcode.ts). So a project
// that has ccache on is a project silently getting neither cache, and saying so
// is the point.
export function checkCcacheConflict(podfileSource: string | null, podfileProperties: AnyJson | null): Finding | null {
  if (podfileSource == null) return null;
  if (!ccacheEnabled(podfileProperties)) return null;
  return finding(
    'cost',
    'ccache is enabled, so rn-iso leaves Xcode compilation caching off',
    'The ccache launcher script is what disables explicitly built modules, which compilation caching requires -- so enabling both tends to mean neither works. rn-iso will not add its compilation-cache settings to a build whose project has apple.ccacheEnabled=true, and ccache itself keys on absolute paths, so it misses across worktrees anyway.',
    'Pick one. On Xcode 26 the compilation cache is the one that survives a different workspace path, and rn-iso supplies it on its own builds as soon as apple.ccacheEnabled is off.',
  );
}

// The build cache provider is what lets a ticket that changes no native input
// skip the build entirely. Where the key lives moved when it was promoted out
// of experiments, and the old CLI ignores the new key in silence:
//
//   SDK 53:  exp.experiments.buildCacheProvider          (only)
//   SDK 57:  exp.buildCacheProvider ?? exp.experiments.buildCacheProvider
//
// So top-level is right going forward, experiments still works as a fallback,
// and top-level ON AN OLD SDK is the combination that silently does nothing.
export function checkBuildCacheProvider(
  appConfig: AnyJson | null,
  sdkMajor: number | null,
  isExpo: boolean = true,
  dynamicConfig: string | null = null,
): Finding | null {
  // Bare React Native has no equivalent hook: the community CLI never consults
  // a provider, so there is nothing to misconfigure and nothing to suggest
  // beyond building the lookup yourself.
  if (!isExpo) {
    return finding(
      'note',
      'No build cache hook outside Expo',
      'The provider that lets a workspace install a cached .app instead of compiling is an Expo CLI feature; the React Native community CLI has no equivalent. `@expo/fingerprint` works standalone on a bare project, so the pieces exist -- keying a stored .app on it and installing that yourself is the missing part.',
      null,
    );
  }
  // A project whose config is code -- app.config.ts / app.config.js -- cannot be
  // read statically, and evaluating it would mean running arbitrary project code
  // inside a diagnostic. Saying nothing would be worse: it reads as a pass, and
  // this is the check whose failure mode is silence in the first place.
  if (!appConfig && dynamicConfig) {
    return finding(
      'note',
      `Cannot check the build cache provider in ${dynamicConfig}`,
      'This config is code, so it is not readable without executing it. A provider is optional -- rn-iso ios/android have their own cache -- but if this project DOES set one, confirm by hand that it is on the key this SDK reads.',
      `${
        sdkMajor && sdkMajor <= 53
          ? `SDK ${sdkMajor} reads expo.experiments.buildCacheProvider and ignores the top-level key in silence.`
          : 'Use the top-level expo.buildCacheProvider; the experiments key still works as a fallback.'
      } Run \`npx expo config --json\` and look for buildCacheProvider. If one is already set -- including "eas" -- that satisfies this; rn-iso never replaces it.`,
    );
  }
  if (!appConfig) return null;
  const expo = (appConfig.expo ?? appConfig) as AnyJson;
  const topLevel = expo.buildCacheProvider;
  const experimental = (expo.experiments as AnyJson | null | undefined)?.buildCacheProvider;

  // NO provider at all is deliberately not a finding. rn-iso's own cache
  // already covers every build rn-iso drives, so a provider only adds value to
  // builds run OUTSIDE it (`expo run` by hand, EAS for a team) -- optional, and
  // not part of setup. What this check reports is a provider that IS
  // configured but on a key this SDK never reads, which is a silent no-op.
  if (!topLevel && !experimental) return null;

  // A provider is configured. Which one is the project's own business: "eas"
  // (the remote cache), @rn-iso/expo-build-cache, or a custom module all
  // satisfy this check, and init never replaces one. rn-iso ios/android do
  // not consult the provider -- they build with xcodebuild/gradle directly
  // and use rn-iso's local cache -- so a remote EAS cache and rn-iso's cache
  // coexist, each serving the builds that go through its own path.

  if (sdkMajor && sdkMajor <= 53 && topLevel && !experimental) {
    return finding(
      'cost',
      'buildCacheProvider is at the top level, but this SDK only reads it from experiments',
      `SDK ${sdkMajor}'s CLI resolves exp.experiments.buildCacheProvider and nothing else. The top-level key is ignored in silence, so the provider is never called and every build is a full build.`,
      'Move it to expo.experiments.buildCacheProvider.',
    );
  }

  if (sdkMajor && sdkMajor >= 54 && experimental && !topLevel) {
    return finding(
      'note',
      'buildCacheProvider is still under experiments',
      `It works -- SDK ${sdkMajor} falls back to the experiments key -- but the setting was promoted out of experiments, and the top-level key is the one that will keep working.`,
      'Move it to expo.buildCacheProvider.',
    );
  }

  return null;
}

// The EAS session behind a `"buildCacheProvider": "eas"`.
//
// This is the one provider whose failure mode is SILENCE by construction:
// eas-build-cache-provider wraps each `npx eas-cli` call in a try/catch that
// returns null (its own build/index.js), so an expired session, a missing CLI
// and an empty cache all look identical from the outside -- a miss, on every
// build, forever. Nothing in a build log says "log in". doctor is where it can
// be said.
//
// PURE: `auth` is the answer the caller already obtained (engine's
// checkEasAuth). The only IO decision made here is not to ask at all when the
// project does not use EAS -- whoami is a network call, and a project on a
// local provider should not pay for one.
export function checkEasAuth({
  provider,
  owner = null,
  auth = null,
}: {
  provider?: string | null;
  owner?: string | null;
  auth?: EasAuthResult | ((opts: { owner: string | null }) => EasAuthResult) | null;
} = {}): Finding | null {
  if (provider !== 'eas') return null;
  const status = typeof auth === 'function' ? auth({ owner }) : auth;
  if (!status || status.ok) return null;

  // Offline, timed out, or an output shape this eas-cli does not produce.
  // Never an accusation: whoami reaches the network whenever a session exists,
  // so "could not check" is a fact about the check, not about the user.
  if (status.unknown) {
    return finding(
      'note',
      'Could not check the EAS session',
      `\`eas whoami\` did not give a definite answer (${status.unknown}), so whether this project's EAS build cache can be reached is unknown. Offline is the ordinary reason, and it is not a problem: the cache simply does not answer until the machine is back on the network.`,
      null,
    );
  }

  if (status.code === 'no-cli') {
    return finding(
      'cost',
      'The build cache provider is "eas", but no eas-cli is installed',
      'The provider shells out to `npx eas-cli` on every lookup and every upload. With no eas-cli resolvable, npx downloads one on the fly (slow, and a version nobody chose) or the call fails -- and the provider swallows that failure and returns null, so every build looks like a cache miss and nothing says why.',
      status.remedy ?? null,
    );
  }

  if (status.code === 'logged-out') {
    return finding(
      'cost',
      'Not logged in to EAS, so the shared build cache never answers',
      'eas-build-cache-provider catches its own errors and returns null, so an unauthenticated lookup reads as a plain cache miss: every build compiles, nothing is uploaded for anybody else, and no line in any log mentions authentication.',
      status.remedy ?? null,
    );
  }

  if (status.code === 'wrong-account') {
    return finding(
      'note',
      `EAS is authenticated as ${status.account}, but this project's owner is ${status.owner}`,
      `A session on an account that does not cover ${status.owner} cannot read or write that account's builds, so the shared cache silently does nothing here. This is a NOTE and not a hard failure on purpose: \`eas whoami\` only enumerates accounts for some actors (a robot prints a display name that is not an account name at all), the list may be incomplete, and access is the server's decision rather than this list's. Confirm before acting on it.`,
      status.remedy ?? null,
    );
  }

  return null;
}

// Gradle's task-output cache (`org.gradle.caching`) is OFF by default, and a
// second worktree then recompiles every task from scratch even when nothing
// changed. The cache lives under the Gradle user home (~/.gradle by default),
// which every worktree on the machine already shares.
//
// NOT A SETUP STEP ANY MORE, for the same reason as the compilation cache:
// `rn-iso android` puts `--build-cache` on its own gradlew argv, which turns
// the cache on for that invocation regardless of what the properties file
// says. The finding is about the gradle runs rn-iso does not make.
//
// `source` is android/gradle.properties, read and never evaluated. Null means
// the file is absent -- a CNG project has no android/ until prebuild generates
// one -- and the check is skipped rather than guessed at: there is no file to
// set the property in, and prebuild writes the template's own.
export function checkGradleBuildCache(gradlePropertiesSource: string | null): Finding | null {
  if (gradlePropertiesSource == null) return null;
  const enabled = String(gradlePropertiesSource)
    .split('\n')
    .map((line) => line.trim())
    // A properties file comments with # or !; a commented-out property sets
    // nothing.
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
    .some((line) => {
      // The KEY is case-sensitive (Java properties are); the VALUE is parsed
      // by Boolean.parseBoolean, which is not.
      const m = /^org\.gradle\.caching\s*[=:]\s*(.+)$/.exec(line);
      return m !== null && m[1]?.trim().toLowerCase() === 'true';
    });
  if (enabled) return null;
  return finding(
    'note',
    "Gradle's build cache is off in gradle.properties (rn-iso passes --build-cache anyway)",
    "org.gradle.caching=true is not set in android/gradle.properties. `rn-iso android` passes --build-cache on its own ./gradlew invocation, so a second worktree already reuses the first one's compiled classes -- the task-output cache lives under the Gradle user home, which every worktree on this machine shares. The property only matters for gradle runs made OUTSIDE rn-iso (Android Studio, a plain ./gradlew, CI), which re-run every task from scratch.",
    'Nothing to do for rn-iso. Add org.gradle.caching=true to android/gradle.properties only if you also build outside it.',
  );
}

// The one note about concurrency limits, and ONLY when a limit is set: an
// unset cap is the default (rn-iso imposes nothing), so saying "no limits are
// configured" on every run would be noise. When one IS set, echoing the caps
// beside the current live count is what makes the two RN_ISO_AT_CAPACITY /
// slot-wait behaviours legible before they fire.
export function checkConcurrency({
  maxBuilds = 0,
  maxDevices = 0,
  liveDevices = 0,
  activeBuilds = 0,
}: { maxBuilds?: number; maxDevices?: number; liveDevices?: number; activeBuilds?: number } = {}): Finding | null {
  if (!maxBuilds && !maxDevices) return null;
  const caps = `maxBuilds ${maxBuilds || 'unlimited'}, maxDevices ${maxDevices || 'unlimited'}`;
  return finding(
    'note',
    'Concurrency limits are set',
    `${caps}. Right now ${liveDevices} rn-iso device(s) are booted and ${activeBuilds} build slot(s) are in use on this machine. ` +
      'At the device cap a new `rn-iso ios`/`android` is refused with RN_ISO_AT_CAPACITY (stop an environment or raise it); ' +
      'at the build cap a compile waits for a free slot.',
    null,
  );
}

// Runs every check against one project directory. Pure enough to test: all file
// reads happen here, and each check is a function of the text it was given.
export function runDoctor(
  projectRoot: string,
  {
    readFile = readFileSync,
    xcodeMajor = null,
    easAuth = probeEasAuth,
    concurrency = getConcurrencyLimits,
    liveDevices = null,
    activeBuilds = null,
  }: {
    readFile?: typeof readFileSync;
    xcodeMajor?: number | null;
    easAuth?: (opts: { projectRoot: string; owner?: string | null }) => EasAuthResult;
    concurrency?: (() => ConcurrencyLimits) | ConcurrencyLimits;
    liveDevices?: (() => number) | null;
    activeBuilds?: (() => number) | null;
  } = {},
): Finding[] {
  const read = (rel: string): string | null => {
    const p = join(projectRoot, rel);
    if (!existsSync(p)) return null;
    try {
      return readFile(p, 'utf-8') as string;
    } catch {
      return null;
    }
  };

  const pkg = readJson(join(projectRoot, 'package.json'));
  const appConfig = readJson(join(projectRoot, 'app.json'));
  const dynamicConfig = appConfig
    ? null
    : ['app.config.ts', 'app.config.js', 'app.config.mjs'].find((f) => existsSync(join(projectRoot, f))) || null;
  const podfileProperties = readJson(join(projectRoot, 'ios', 'Podfile.properties.json'));
  const podfile = read(join('ios', 'Podfile'));
  // Null when android/gradle.properties does not exist -- a CNG project has no
  // android/ until prebuild -- which skips the gradle-cache check entirely.
  const gradleProperties = read(join('android', 'gradle.properties'));
  const metroConfig = read('metro.config.js') ?? read('metro.config.cjs');
  const gitignore = read('.gitignore');
  // git's verdict on the workspace dir, monorepo-aware. check-ignore exits 0
  // for ignored, 1 for not ignored, 128 outside a repo; runQuiet nulls the
  // failures, so only a definite "ignored" upgrades the file-based answer.
  const gitIgnored =
    getExecutor().runQuiet(`git -C ${JSON.stringify(projectRoot)} check-ignore ${WORKSPACE_DIR}`, {
      timeoutMs: 10000,
    }) != null
      ? true
      : null;

  // Same detector `status` uses, so one project never reads as expo in one
  // command and bare in another. It weighs the `ios` script above the presence
  // of the `expo` package, which is the distinction the Expo-only checks below
  // actually depend on.
  const isExpo = detectIsExpo(projectRoot);
  const expoRange = (pkg?.dependencies as AnyJson | undefined)?.expo || '';
  const sdkMajor =
    parseInt(
      String(expoRange)
        .replace(/[^\d.]/g, '')
        .split('.')[0] ?? '',
      10,
    ) || null;

  // The EAS session is only asked about when the config STATICALLY says the
  // provider is EAS. A dynamic config is not evaluated here for the same reason
  // checkBuildCacheProvider does not evaluate one -- running project code
  // inside a diagnostic -- and its existing note already says the provider
  // could not be read.
  const provider = appConfig ? providerFromConfig(appConfig) : null;
  const owner = appConfig ? ownerFromConfig(appConfig) : null;
  const easFinding =
    provider === 'eas' ? checkEasAuth({ provider, owner, auth: easAuth({ projectRoot, owner }) }) : null;

  // Concurrency: gathered only when a cap is set, so an unset default costs no
  // simctl/adb enumeration and stays silent.
  const limits = typeof concurrency === 'function' ? concurrency() : concurrency;
  let concurrencyFinding: Finding | null = null;
  if (limits && (limits.maxBuilds || limits.maxDevices)) {
    concurrencyFinding = checkConcurrency({
      maxBuilds: limits.maxBuilds,
      maxDevices: limits.maxDevices,
      liveDevices: liveDevices ? liveDevices() : countLiveDevices(),
      activeBuilds: activeBuilds ? activeBuilds() : countActiveBuilds(),
    });
  }

  return [
    checkDevClient(pkg, isExpo),
    checkMetroCache(metroConfig),
    checkCompilationCache(podfile, xcodeMajor),
    checkGradleBuildCache(gradleProperties),
    checkArtifactLayout({ gitignoreSource: gitignore, gitIgnored }),
    checkCcacheConflict(podfile, podfileProperties),
    checkBuildCacheProvider(appConfig, sdkMajor, isExpo, dynamicConfig),
    easFinding,
    concurrencyFinding,
  ].filter((f): f is Finding => Boolean(f));
}

// The thin I/O behind the concurrency note. Both fail OPEN (0): a flaky simctl
// or adb must not turn a read-only advice command into an error.
function countLiveDevices(): number {
  let sims: IosSimRecord[] = [];
  let adb: AdbDevices = { emulators: [], physical: [], unhealthy: [] };
  let config: Config | null = null;
  try {
    sims = listAllIosSims() || [];
  } catch {
    /* fail open */
  }
  try {
    adb = listAdbDevices() || adb;
  } catch {
    /* fail open */
  }
  try {
    config = loadConfig();
  } catch {
    /* fail open */
  }
  return liveOwnedDeviceCount({ sims, adbEmulators: adb.emulators || [], config });
}

function countActiveBuilds(): number {
  try {
    return listBuildSlots().filter((s) => s.alive).length;
  } catch {
    return 0;
  }
}

// --- fingerprint parity: does THIS checkout hash like a fresh worktree? -----
//
// The whole premise of the shared build cache is that a worktree of the same
// commit computes the same fingerprint as the checkout that filled the cache.
// When the main checkout carries uncommitted edits to a fingerprint input,
// that premise is silently false: every entry it stores is keyed on a hash no
// fresh worktree will ever compute, and every worktree misses. The only way to
// measure that is to actually do it once -- fingerprint HEAD in a clean
// temporary worktree and compare.

// PURE. The finding, given both hashes and the diagnosis.
export function checkFingerprintParity({
  projectHash,
  worktreeHash,
  changed = [],
  dirtyFiles = [],
}: {
  projectHash?: string | null;
  worktreeHash?: string | null;
  changed?: string[];
  dirtyFiles?: string[];
} = {}): Finding | null {
  if (!projectHash || !worktreeHash || projectHash === worktreeHash) return null;
  const names = changed.slice(0, 3).join(', ');
  const differing = changed.length
    ? ` The differing source${changed.length === 1 ? '' : 's'}: ${names}${changed.length > 3 ? ` (and ${changed.length - 3} more)` : ''}.`
    : '';
  const cause = dirtyFiles.length
    ? `The likely cause is uncommitted changes to tracked fingerprint inputs -- git reports ${dirtyFiles.slice(0, 3).join(', ')}${dirtyFiles.length > 3 ? ` (and ${dirtyFiles.length - 3} more)` : ''} dirty in this checkout.`
    : 'The likely cause is uncommitted changes to tracked fingerprint inputs (this check compared against a clean worktree of HEAD).';
  return finding(
    'note',
    'This checkout does not fingerprint like a fresh worktree of HEAD',
    `A clean detached worktree of HEAD computes a different @expo/fingerprint hash than this checkout, so worktrees will MISS the cache entries this checkout fills (and vice versa) until the two agree.${differing} ${cause} (To measure this, doctor ran a real fingerprint twice and briefly created a temporary git worktree -- .git/worktrees metadata was touched and cleaned up.)`,
    'Commit the dirty fingerprint inputs, or add genuinely build-irrelevant ones to .fingerprintignore.',
  );
}

// The I/O half. ONE temporary detached worktree of HEAD in the OS tmpdir, a
// fingerprint on each side, and an unconditional cleanup. Every guard skips
// silently -- not a git repo, `git worktree add` refused, no @expo/fingerprint,
// a fingerprint that throws -- because doctor always exits 0 and a diagnostic
// must not manufacture a failure of its own. This is doctor's most expensive
// check (two real fingerprints); callers run it LAST.
export async function detectFingerprintParity(
  projectRoot: string,
  {
    load = loadFingerprinter,
    dirtyFiles = dirtyFingerprintFiles,
  }: {
    load?: (projectRoot: string) => Fingerprinter | null;
    dirtyFiles?: (root: string) => string[];
  } = {},
): Promise<Finding | null> {
  const fp = load(projectRoot);
  if (!fp) return null;
  const exec = getExecutor();
  const quotedRoot = JSON.stringify(projectRoot);
  if (exec.runQuiet(`git -C ${quotedRoot} rev-parse --git-dir`, { timeoutMs: 10000 }) == null) return null;

  // The same platform scope ios/android use, picked by what this repo has, so
  // the two hashes compared here are the ones the cache is actually keyed on.
  const platform = existsSync(join(projectRoot, 'ios'))
    ? 'ios'
    : existsSync(join(projectRoot, 'android'))
      ? 'android'
      : undefined;

  const base = mkdtempSync(join(tmpdir(), 'rn-iso-parity-'));
  const worktree = join(base, 'head');
  const added = exec.runQuiet(`git -C ${quotedRoot} worktree add --detach ${JSON.stringify(worktree)} HEAD`, {
    timeoutMs: 60000,
  });
  if (added == null) {
    rmSync(base, { recursive: true, force: true });
    return null;
  }

  try {
    const loadHere = () => fp;
    const project = await fingerprintProject(projectRoot, { platform, load: loadHere });
    const clean = await fingerprintProject(worktree, { platform, load: loadHere });
    if (!project || !clean) return null;
    if (project.hash === clean.hash) return null;
    const changed = diffFingerprintSources({
      previous: clean.sources,
      previousHash: clean.hash,
      current: project,
      differ: fp.diffFingerprints ?? null,
    });
    return checkFingerprintParity({
      projectHash: project.hash,
      worktreeHash: clean.hash,
      changed,
      dirtyFiles: dirtyFiles(projectRoot),
    });
  } catch {
    // A fingerprint that cannot run (a worktree with no node_modules can make
    // the project's own fingerprinter throw) is a skip, not a finding.
    return null;
  } finally {
    // Always, on every exit path: the temp worktree registered itself in
    // .git/worktrees, and leaving it there would make this read-only command
    // the thing that dirtied the repo.
    exec.runQuiet(`git -C ${quotedRoot} worktree remove --force ${JSON.stringify(worktree)}`, { timeoutMs: 30000 });
    rmSync(base, { recursive: true, force: true });
    exec.runQuiet(`git -C ${quotedRoot} worktree prune`, { timeoutMs: 10000 });
  }
}
