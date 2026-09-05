import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { plural } from './command-output.ts';
import { getExecutor } from './exec.ts';
import { makeTemporaryDirectory } from './temporary.ts';
import { checkStorageLayout } from './doctor-storage.ts';
import { appProjectProblem, detectIsExpo } from './project.ts';
import * as expoFingerprint from '@expo/fingerprint';
import { diffFingerprintSources, fingerprintProject } from './build-cache.ts';
import { dirtyFingerprintFiles, gitCommonDir, listWorktrees, repoRoot } from './worktree.ts';
import { workspaceDerivedData } from './paths.ts';
import { type Config, type ConcurrencyLimits, getConcurrencyLimits, loadConfig } from './config.ts';
import { podInstallCommand } from './engine/bundler.ts';
import { liveOwnedDeviceCount } from './engine/device.ts';
import { simslimIsOnPath } from './engine/simslim.ts';
import { listBuildSlots } from './engine/build-slots.ts';
import { type IosSimRecord, listAllIosSims } from './sim/ios.ts';
import { parkedMaxSetting, POOL_SETTING_REMEDY } from './sim-pool.ts';
import { ccacheEnabled, COMPILATION_CACHE_MIN_XCODE, detectXcodeMajor, parseXcodeMajor } from './engine/xcode.ts';
import { type AdbDevices, listAdbDevices } from './sim/android.ts';
import {
  type EasAuthResult,
  checkEasAuth as probeEasAuth,
  ownerFromConfig,
  providerFromConfig,
  resolveEasCliBin,
} from './engine/remote-cache.ts';
import {
  iosSimSlimProfileSetting,
  remoteAndroidSetting,
  remoteIosSetting,
  resolveSettings,
  SETTING_SHAPE_REMEDY,
  settingShapeErrors,
} from './settings.ts';
import type { RemoteDeviceBackend } from './types.ts';

type AnyJson = Record<string, unknown>;

export { detectXcodeMajor, parseXcodeMajor };

export interface Finding {
  level: 'cost' | 'note';
  title: string;
  detail: string;
  fix: string | null;
}

export type DoctorPlatform = 'ios' | 'android';

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

interface UpstreamState {
  name: string;
  ahead: number;
  behind: number;
}

function mainCheckoutProjectRoot(projectRoot: string): string {
  const currentRepoRoot = repoRoot(projectRoot);
  if (!currentRepoRoot) return projectRoot;
  try {
    // Git lists the main working tree before all linked worktrees.
    const main = listWorktrees(currentRepoRoot)[0];
    if (!main) return projectRoot;
    const projectRel = relative(currentRepoRoot, realpathSync(projectRoot));
    if (projectRel.startsWith('..')) return projectRoot;
    return resolve(main.path, projectRel);
  } catch {
    return projectRoot;
  }
}

function installedNpmTreeIsValid(projectRoot: string): boolean {
  try {
    getExecutor().runFile('npm', ['ls', '--all', '--json', '--silent'], { cwd: projectRoot, timeoutMs: 30_000 });
    return true;
  } catch {
    return false;
  }
}

const DEPENDENCY_STATES = [
  { lock: 'pnpm-lock.yaml', installed: ['node_modules'], command: 'pnpm install' },
  { lock: 'yarn.lock', installed: ['node_modules', '.pnp.cjs', '.pnp.js'], command: 'yarn install' },
  { lock: 'bun.lock', installed: ['node_modules'], command: 'bun install' },
  { lock: 'bun.lockb', installed: ['node_modules'], command: 'bun install' },
  { lock: 'package-lock.json', installed: ['node_modules'], command: 'npm ci' },
];

function dependencyState(projectRoot: string) {
  const root = repoRoot(projectRoot) ?? projectRoot;
  let dir = projectRoot;
  while (true) {
    const state = DEPENDENCY_STATES.find((candidate) => existsSync(join(dir, candidate.lock)));
    if (state) return { ...state, root: dir };
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir || relative(root, parent).startsWith('..')) return null;
    dir = parent;
  }
}

function hasInstalledDependencies(projectRoot: string, markers: string[] = ['node_modules', '.pnp.cjs', '.pnp.js']) {
  return markers.some((entry) => existsSync(join(projectRoot, entry)));
}

function locallyKnownUpstream(projectRoot: string): UpstreamState | null {
  try {
    const name = getExecutor().runFile(
      'git',
      ['-C', projectRoot, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      { timeoutMs: 5000 },
    );
    const counts = getExecutor()
      .runFile('git', ['-C', projectRoot, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], {
        timeoutMs: 5000,
      })
      .trim()
      .split(/\s+/)
      .map(Number);
    const ahead = counts[0] ?? NaN;
    const behind = counts[1] ?? NaN;
    if (!name || !Number.isInteger(ahead) || !Number.isInteger(behind)) return null;
    return { name, ahead, behind };
  } catch {
    return null;
  }
}

function quotedPath(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function brokenPodLinks(podsRoot: string): string[] {
  try {
    const output = getExecutor().runFile('find', ['-L', podsRoot, '-type', 'l', '-print'], { timeoutMs: 10_000 });
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function checkMainCheckout(
  projectRoot: string,
  {
    npmTreeValid,
    brokenPods = undefined,
    upstream = undefined,
    platform,
  }: {
    npmTreeValid?: boolean | null;
    brokenPods?: string[];
    upstream?: UpstreamState | null;
    platform?: DoctorPlatform;
  } = {},
): Finding[] {
  const mainRoot = mainCheckoutProjectRoot(projectRoot);
  const findings: Finding[] = [];
  const dependencies = dependencyState(mainRoot);

  if (dependencies) {
    const installed = hasInstalledDependencies(dependencies.root, dependencies.installed);
    const installCommand = `cd ${quotedPath(dependencies.root)} && ${dependencies.command}`;
    if (!installed) {
      findings.push(
        finding(
          'cost',
          'The main checkout has no installed dependencies',
          `A worktree cannot carry dependencies from ${dependencies.root}, so its first build must install them from scratch.`,
          `Run \`${installCommand}\` before creating native worktrees.`,
        ),
      );
    } else if (dependencies.lock === 'package-lock.json') {
      const valid = npmTreeValid === undefined ? installedNpmTreeIsValid(dependencies.root) : npmTreeValid;
      if (valid === false) {
        findings.push(
          finding(
            'cost',
            'The main checkout dependency tree is stale',
            `npm reports that ${dependencies.root}/node_modules does not match the project dependency graph. Copying it makes each worktree start from the same invalid state.`,
            `Run \`${installCommand}\` before creating native worktrees.`,
          ),
        );
      }
    }
  }

  const podfileLock = join(mainRoot, 'ios', 'Podfile.lock');
  const podManifest = join(mainRoot, 'ios', 'Pods', 'Manifest.lock');
  const podsRoot = join(mainRoot, 'ios', 'Pods');
  if (platform !== 'android' && existsSync(podfileLock)) {
    let podsState: 'missing' | 'stale' | null = null;
    if (!existsSync(podManifest)) podsState = 'missing';
    else {
      try {
        if (readFileSync(podfileLock, 'utf-8') !== readFileSync(podManifest, 'utf-8')) podsState = 'stale';
      } catch {
        podsState = 'stale';
      }
    }
    if (podsState) {
      const iosRoot = join(mainRoot, 'ios');
      const podCommand = `cd ${quotedPath(iosRoot)} && ${podInstallCommand(mainRoot)}`;
      findings.push(
        finding(
          'cost',
          `The main checkout CocoaPods state is ${podsState}`,
          `ios/Pods cannot be reused safely because its Manifest.lock ${podsState === 'missing' ? 'is absent' : 'does not match ios/Podfile.lock'}.`,
          `Run \`${podCommand}\` before creating native worktrees.`,
        ),
      );
    }

    const broken = brokenPods === undefined && existsSync(podsRoot) ? brokenPodLinks(podsRoot) : brokenPods || [];
    if (broken.length) {
      const iosRoot = join(mainRoot, 'ios');
      const podCommand = `cd ${quotedPath(iosRoot)} && ${podInstallCommand(mainRoot, '--clean-install')}`;
      findings.push(
        finding(
          'cost',
          'The main checkout CocoaPods state has broken links',
          `${broken.length} symlink${broken.length === 1 ? '' : 's'} under ios/Pods point to missing files. Worktrees copy these broken links and can fail during compilation. First: ${broken[0]}.`,
          `Run \`${podCommand}\` before creating native worktrees.`,
        ),
      );
    }
  }

  const coldPlatforms = [
    platform !== 'android' &&
    existsSync(join(mainRoot, 'ios')) &&
    !existsSync(join(mainRoot, 'ios', 'build')) &&
    !existsSync(join(workspaceDerivedData(mainRoot), 'Build', 'Products'))
      ? 'iOS'
      : null,
    platform !== 'ios' &&
    existsSync(join(mainRoot, 'android')) &&
    !existsSync(join(mainRoot, 'android', 'build')) &&
    !existsSync(join(mainRoot, 'android', 'app', 'build'))
      ? 'Android'
      : null,
  ].filter((coldPlatform): coldPlatform is string => coldPlatform !== null);
  if (coldPlatforms.length) {
    findings.push(
      finding(
        'note',
        `The main checkout has no ${coldPlatforms.join(' or ')} warm build output`,
        'The shared Stim artifact or compilation cache can still be warm. Building the main checkout once gives later native worktrees the strongest warm starting point.',
        `When more native worktrees are expected, run \`stim start\`, \`stim ${coldPlatforms[0] === 'iOS' ? 'ios' : 'android'}\`, and \`stim stop\` from ${mainRoot}.`,
      ),
    );
  }

  const knownUpstream = upstream === undefined ? locallyKnownUpstream(mainRoot) : upstream;
  if (knownUpstream && knownUpstream.behind > 0) {
    findings.push(
      finding(
        'note',
        `The main checkout is ${knownUpstream.behind} commit${knownUpstream.behind === 1 ? '' : 's'} behind ${knownUpstream.name}`,
        'The count uses the locally known upstream ref. A fetch can reveal additional commits. A later rebase or merge can change native inputs and invalidate work done from the older base.',
        `Run \`git -C ${quotedPath(mainRoot)} fetch --prune\`, then inspect the branch before creating the worktree.`,
      ),
    );
  }

  return findings;
}

export function checkDevClient(pkg: AnyJson | null, isExpo: boolean = true): Finding | null {
  const deps = {
    ...(pkg?.dependencies as AnyJson | undefined),
    ...(pkg?.devDependencies as AnyJson | undefined),
  };
  if (deps['expo-dev-client']) return null;
  if (!isExpo || !deps.expo) return null;
  return finding(
    'cost',
    'expo-dev-client is not installed',
    'A Metro port reserved by Stim cannot reach the app without it: the port travels in the dev-client deep link `stim ios` opens, and without the dev client nothing handles that URL. The app falls back to port 8081 and shows "No script URL provided".',
    'npx expo install expo-dev-client, then rebuild with `stim ios` / `stim android`. It is a NATIVE dependency: an app already on the device will not pick it up, and the first build after installing it is a cache miss by design because the native fingerprint moved. Do not solve this by compiling the port in (RCT_METRO_PORT, or the dev client defaultLaunchURL) -- the build cache does not key on the port, so a binary built for one workspace would silently talk to another workspace bundler.',
  );
}

export function checkMetroCache(metroConfigSource: string | null): Finding | null {
  if (metroConfigSource == null) return null;
  const lines = String(metroConfigSource).split('\n');
  const mentions = lines.filter((line) => /cacheStores/.test(line));
  if (!mentions.length) return null;
  if (!lines.every((line, i) => !/cacheStores/.test(line) || isConditional(lines, i))) return null;
  return finding(
    'note',
    'metro.config.js mentions cacheStores, but not unconditionally',
    `Every line naming it is inside a conditional, and doctor reads this file rather than executing it, so it cannot tell whether the store is installed. Under \`stim start\` this costs nothing -- Stim appends its own store whether the project's is on or off -- but outside Stim a cacheStores that is off by default costs exactly what having none costs: ${mentions.map((l) => l.trim()).join(' / ')}`,
    'Only for Metro runs Stim does not host: confirm it applies without env vars -- a store behind an opt-in flag is not shared until every workspace sets the flag.',
  );
}

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

export function checkCompilationCache(podfileSource: string | null, xcodeMajor: number | null): Finding | null {
  if (podfileSource == null) return null;
  if (xcodeMajor != null && xcodeMajor < COMPILATION_CACHE_MIN_XCODE) return null;
  if (!/COMPILATION_CACHE_ENABLE_CACHING/.test(podfileSource)) return null;
  if (/COMPILATION_CACHE_CAS_PATH/.test(podfileSource)) return null;
  return finding(
    'note',
    'The Podfile enables compilation caching but leaves the CAS at its default path',
    'The default CAS lives at the DerivedData root, and DerivedData is per-workspace -- so nothing is actually shared between worktrees, which is the only reason to turn it on. Builds Stim drives are unaffected: they override COMPILATION_CACHE_CAS_PATH to a shared path on the xcodebuild command line, which wins over the project setting. This costs only the builds you run outside Stim.',
    'Nothing to do for Stim. For builds outside it: set COMPILATION_CACHE_CAS_PATH to a fixed path outside DerivedData -- ~/.stim/compilation-cache is where Stim puts its own, so the two share entries instead of filling two caches.',
  );
}

export function checkCcacheConflict(podfileSource: string | null, podfileProperties: AnyJson | null): Finding | null {
  if (podfileSource == null) return null;
  if (!ccacheEnabled(podfileProperties)) return null;
  return finding(
    'cost',
    'ccache is enabled, so Stim leaves Xcode compilation caching off',
    "The ccache launcher script is what disables explicitly built modules, which compilation caching requires -- so enabling both tends to mean neither works. Stim will not add its compilation-cache settings to a build whose project has apple.ccacheEnabled=true, and in its default configuration ccache hashes the working directory and every absolute include path, so it misses across worktrees. (Stim relocates ccache itself on Android, where it drives the compile and can set CCACHE_BASEDIR and CCACHE_NOHASHDIR; the Podfile launcher script here is the project's, not Stim's.)",
    'Pick one, and on Xcode 26 the compilation cache is the one that survives a different workspace path -- Stim supplies it on its own builds as soon as ccache is off. Turn it off where the value comes FROM: on Expo that is the expo-build-properties plugin in the app config (ios.ccacheEnabled), because prebuild rewrites ios/Podfile.properties.json from it; on a bare project edit ios/Podfile.properties.json directly. Then re-run pod install (or let `stim ios` do it).',
  );
}

export function checkCcacheInstalled(onPath: boolean): Finding | null {
  if (onPath) return null;
  return finding(
    'cost',
    'ccache is not on PATH, so Android C++ recompiles in every worktree',
    'Stim resolves the launcher with `command -v ccache` -- the same PATH lookup the build itself uses -- and found nothing, so it passes no CMAKE_C_COMPILER_LAUNCHER / CMAKE_CXX_COMPILER_LAUNCHER to Gradle and every AGP CMake task compiles without one. Those tasks are uncacheable by Gradle, so not one C++ object crosses a worktree. Measured on trailhead (arm64, fresh worktree): 49.6s without the launcher against 34.2s with it.',
    'brew install ccache, then delete android/app/.cxx and node_modules/**/android/.cxx once so CMake reconfigures with the launcher. The shell that runs Stim must have the install location on PATH -- agent shells often lack /opt/homebrew/bin.',
  );
}

export interface CxxLauncherState {
  path: string;
  launcher: string | null;
}

export function parseCmakeCacheLauncher(source: unknown): string | null {
  if (typeof source !== 'string') return null;
  const match = /^CMAKE_CXX_COMPILER_LAUNCHER(?::[A-Z]+)?=(.*)$/m.exec(source);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

// CMake docs, CMAKE_<LANG>_COMPILER_LAUNCHER: the value is a ;-separated
// command line whose first word is resolved through PATH unless it is
// absolute, so only an absolute one is a path this machine must hold.
function launcherPath(launcher: string | null): string | null {
  const command = launcher?.split(';')[0]?.trim();
  return command && isAbsolute(command) ? command : null;
}

export function checkCxxCompilerLauncher({
  states,
  ccacheOnPath,
  launcherExists = existsSync,
}: {
  states: CxxLauncherState[];
  ccacheOnPath: boolean;
  launcherExists?: (path: string) => boolean;
}): Finding | null {
  const missing = states
    .map((state) => ({ path: state.path, command: launcherPath(state.launcher) }))
    .filter(
      (state): state is { path: string; command: string } => state.command !== null && !launcherExists(state.command),
    );
  if (missing.length > 0) {
    const named = [...new Set(missing.map((state) => state.command))].join(', ');
    return finding(
      'cost',
      'A configured CMake cache names a compiler launcher that is not on this machine',
      `${plural(missing.length, 'CMakeCache.txt file')} under this project name ${named}, and CMake runs that path for every C++ compile. Until the cache is reconfigured the build fails there rather than falling back: ${missing[0]?.path}.`,
      'Delete the configured CMake directories once so the next build reconfigures: `rm -rf android/app/.cxx android/app/build` (and node_modules/*/android/.cxx for library modules).',
    );
  }
  if (!ccacheOnPath) return null;
  if (states.length === 0) return null;
  if (states.some((state) => state.launcher !== null)) return null;
  return finding(
    'cost',
    'The configured CMake cache predates the ccache launcher, so C++ compiles still bypass it',
    `CMake seeds CMAKE_CXX_COMPILER_LAUNCHER from the environment on a FRESH configure only, so a .cxx directory written before Stim set the variable keeps compiling without it and the shared cache stays empty. ${plural(states.length, 'CMakeCache.txt file')} here names no launcher: ${states[0]?.path}.`,
    'Delete the configured CMake directories once: `rm -rf android/app/.cxx android/app/build` (and node_modules/*/android/.cxx for library modules). The next `stim android` reconfigures with the launcher and every later build keeps it.',
  );
}

const CXX_SCAN_DEPTH = 4;

function readCxxLauncherStates(projectRoot: string): CxxLauncherState[] {
  const base = join(projectRoot, 'android', 'app', '.cxx');
  const states: CxxLauncherState[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (name === 'CMakeCache.txt') {
        let source: string | null = null;
        try {
          source = readFileSync(path, 'utf-8');
        } catch {
          continue;
        }
        states.push({ path: relative(projectRoot, path), launcher: parseCmakeCacheLauncher(source) });
        continue;
      }
      if (depth >= CXX_SCAN_DEPTH) continue;
      try {
        if (!statSync(path).isDirectory()) continue;
      } catch {
        continue;
      }
      walk(path, depth + 1);
    }
  };
  walk(base, 0);
  return states;
}

function ccacheIsOnPath(): boolean {
  try {
    return Boolean(getExecutor().runQuiet('command -v ccache', { timeoutMs: 5000 }));
  } catch {
    return false;
  }
}

export function checkBuildCacheProvider(
  appConfig: AnyJson | null,
  sdkMajor: number | null,
  isExpo: boolean = true,
  dynamicConfig: string | null = null,
): Finding | null {
  if (!isExpo) return null;
  if (!appConfig && dynamicConfig) {
    return finding(
      'note',
      `Cannot check the build cache provider in ${dynamicConfig}`,
      'This config is code, so it is not readable without executing it. A provider is optional -- stim ios/android have their own cache -- but if this project DOES set one, confirm by hand that it is on the key this SDK reads.',
      `${
        sdkMajor && sdkMajor <= 53
          ? `SDK ${sdkMajor} reads expo.experiments.buildCacheProvider and ignores the top-level key in silence.`
          : 'Use the top-level expo.buildCacheProvider; the experiments key still works as a fallback.'
      } Run \`npx expo config --json\` and look for buildCacheProvider. If one is already set -- including "eas" -- that satisfies this; Stim never replaces it.`,
    );
  }
  if (!appConfig) return null;
  const expo = (appConfig.expo ?? appConfig) as AnyJson;
  const topLevel = expo.buildCacheProvider;
  const experimental = (expo.experiments as AnyJson | null | undefined)?.buildCacheProvider;

  if (!topLevel && !experimental) return null;

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
    `${caps}. Right now ${liveDevices} Stim device(s) are booted and ${activeBuilds} build slot(s) are in use on this machine. ` +
      'At the device cap a new `stim ios`/`android` is refused with STIM_AT_CAPACITY (stop an environment or raise it); ' +
      'at the build cap a compile waits for a free slot.',
    null,
  );
}

export function checkRemoteDevice({
  configured = null,
  daemonInEnv = false,
  agentDeviceOnPath = false,
  easCliResolvable = false,
}: {
  configured?: RemoteDeviceBackend | null;
  daemonInEnv?: boolean;
  agentDeviceOnPath?: boolean;
  easCliResolvable?: boolean;
} = {}): Finding | null {
  if (!configured) return null;

  if (!agentDeviceOnPath) {
    return finding(
      'cost',
      'A remote device is configured, but agent-device is missing',
      `agent-device drives the selected remote backend. Without it, \`stim ios --remote ${configured}\` and \`stim android --remote ${configured}\` refuse before device work.`,
      'npm i -g agent-device',
    );
  }

  if (configured === 'proxy') {
    if (daemonInEnv) {
      return finding(
        'note',
        'This project uses a remote proxy',
        'The proxy backend connects through AGENT_DEVICE_DAEMON_BASE_URL and AGENT_DEVICE_DAEMON_AUTH_TOKEN. Stim does not create or stop the remote device.',
        null,
      );
    }
    return finding(
      'cost',
      'The remote proxy credentials are missing',
      'The proxy backend requires AGENT_DEVICE_DAEMON_BASE_URL and AGENT_DEVICE_DAEMON_AUTH_TOKEN.',
      'Export AGENT_DEVICE_DAEMON_BASE_URL and AGENT_DEVICE_DAEMON_AUTH_TOKEN.',
    );
  }

  if (!easCliResolvable) {
    return finding(
      'cost',
      'A remote device is configured, but there is no eas-cli to create a session with',
      'The eas backend creates an EAS Simulator session. It needs eas-cli and an account with EAS Simulator access. Neither a project copy nor one on PATH was found.',
      'Install eas-cli.',
    );
  }

  return finding(
    'note',
    'This project uses a remote device',
    '`ios --remote eas` / `android --remote eas` create an EAS Simulator session named stim-<label> and end it on `stop` and `worktree remove`. The build still runs on this machine; only the device is elsewhere. Native device logs are not captured on a remote device -- the Metro half of the timeline is unaffected.',
    null,
  );
}

export function checkSimSlim({
  configured = false,
  profileError = null,
  onPath = false,
}: {
  configured?: boolean;
  profileError?: string | null;
  onPath?: boolean;
} = {}): Finding | null {
  if (profileError) {
    return finding(
      'cost',
      'The SimSlim profile is invalid',
      profileError,
      'Set ios.simslimProfile to a readable JSON profile inside the repository.',
    );
  }
  if (!configured || onPath) return null;
  return finding(
    'cost',
    'A SimSlim profile is configured, but SimSlim is not installed',
    '`stim ios` needs the `simslim` command to apply the profile to its owned simulator.',
    'brew install mobai-app/tap/simslim',
  );
}

export function runDoctor(
  projectRoot: string,
  {
    readFile = readFileSync,
    xcodeMajor = null,
    easAuth = probeEasAuth,
    concurrency = getConcurrencyLimits,
    liveDevices = null,
    activeBuilds = null,
    remoteEnv = process.env,
    lookupAgentDevice = null,
    lookupEasCli = null,
    lookupSimSlim = null,
    lookupCcache = null,
    platform,
  }: {
    readFile?: typeof readFileSync;
    xcodeMajor?: number | null;
    easAuth?: (opts: { projectRoot: string; owner?: string | null }) => EasAuthResult;
    concurrency?: (() => ConcurrencyLimits) | ConcurrencyLimits;
    liveDevices?: (() => number) | null;
    activeBuilds?: (() => number) | null;
    remoteEnv?: NodeJS.ProcessEnv;
    lookupAgentDevice?: (() => boolean) | null;
    lookupEasCli?: (() => boolean) | null;
    lookupSimSlim?: (() => boolean) | null;
    lookupCcache?: (() => boolean) | null;
    platform?: DoctorPlatform;
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
  const metroConfig = read('metro.config.js') ?? read('metro.config.cjs');

  const isExpo = detectIsExpo(projectRoot);
  const expoRange = (pkg?.dependencies as AnyJson | undefined)?.expo || '';
  const sdkMajor =
    parseInt(
      String(expoRange)
        .replace(/[^\d.]/g, '')
        .split('.')[0] ?? '',
      10,
    ) || null;

  const provider = appConfig ? providerFromConfig(appConfig) : null;
  const owner = appConfig ? ownerFromConfig(appConfig) : null;
  const easFinding =
    provider === 'eas' ? checkEasAuth({ provider, owner, auth: easAuth({ projectRoot, owner }) }) : null;

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

  const settingsRepoRoot = repoRoot(projectRoot) ?? projectRoot;
  const projectSettings = resolveSettings({
    projectPath: projectRoot,
    gitCommonDir: gitCommonDir(projectRoot),
    repoRoot: settingsRepoRoot,
  });
  const settingShapeFindings = settingShapeErrors(projectSettings).map((error) =>
    finding('cost', 'A setting has the wrong type', error, SETTING_SHAPE_REMEDY),
  );
  if (platform !== 'android') {
    const poolSettingError = parkedMaxSetting('ios').error;
    if (poolSettingError) {
      settingShapeFindings.push(
        finding('cost', 'The simulator pool bound is not a number', poolSettingError, POOL_SETTING_REMEDY),
      );
    }
  }
  let simslimProfile: string | null = null;
  let simslimProfileError: string | null = null;
  if (platform !== 'android') {
    try {
      simslimProfile = iosSimSlimProfileSetting(projectSettings, settingsRepoRoot);
    } catch (error) {
      simslimProfileError = String((error as Error)?.message || error);
    }
  }
  const simslimFinding =
    platform === 'android'
      ? null
      : checkSimSlim({
          configured: Boolean(simslimProfile),
          profileError: simslimProfileError,
          onPath: simslimProfile ? (lookupSimSlim ? lookupSimSlim() : simslimIsOnPath()) : false,
        });
  const remoteBackends = [
    ...new Set([
      ...(platform !== 'android' ? [remoteIosSetting(projectSettings)] : []),
      ...(platform !== 'ios' ? [remoteAndroidSetting(projectSettings)] : []),
    ]),
  ].filter((backend): backend is RemoteDeviceBackend => backend !== null);
  const daemonInEnv = Boolean(
    remoteEnv.AGENT_DEVICE_DAEMON_BASE_URL?.trim() && remoteEnv.AGENT_DEVICE_DAEMON_AUTH_TOKEN?.trim(),
  );
  const agentDeviceOnPath = remoteBackends.length
    ? lookupAgentDevice
      ? lookupAgentDevice()
      : agentDeviceIsOnPath()
    : false;
  const easCliResolvable = remoteBackends.includes('eas')
    ? lookupEasCli
      ? lookupEasCli()
      : Boolean(resolveEasCliBin(projectRoot))
    : false;
  const remoteFindings = remoteBackends
    .map((backend) =>
      checkRemoteDevice({
        configured: backend,
        daemonInEnv,
        agentDeviceOnPath,
        easCliResolvable,
      }),
    )
    .filter((remoteFinding): remoteFinding is Finding => remoteFinding !== null);

  return [
    checkAppProject(projectRoot),
    ...checkMainCheckout(projectRoot, { platform }),
    ...checkStorageLayout(projectRoot, { platform }),
    checkDevClient(pkg, isExpo),
    checkMetroCache(metroConfig),
    platform === 'android' ? null : checkCompilationCache(podfile, xcodeMajor),
    platform === 'android' ? null : checkCcacheConflict(podfile, podfileProperties),
    ...(platform === 'ios' ? [] : androidCcacheFindings(projectRoot, platform, lookupCcache)),
    checkBuildCacheProvider(appConfig, sdkMajor, isExpo, dynamicConfig),
    easFinding,
    concurrencyFinding,
    simslimFinding,
    ...remoteFindings,
    ...settingShapeFindings,
  ].filter((f): f is Finding => Boolean(f));
}

function androidCcacheFindings(
  projectRoot: string,
  platform: DoctorPlatform | undefined,
  lookupCcache: (() => boolean) | null,
): (Finding | null)[] {
  if (platform !== 'android' && !existsSync(join(projectRoot, 'android'))) return [];
  const onPath = lookupCcache ? lookupCcache() : ccacheIsOnPath();
  return [
    checkCcacheInstalled(onPath),
    checkCxxCompilerLauncher({ states: readCxxLauncherStates(projectRoot), ccacheOnPath: onPath }),
  ];
}

function checkAppProject(projectRoot: string): Finding | null {
  const problem = appProjectProblem(projectRoot);
  if (!problem) return null;
  return finding(
    'cost',
    problem.kind === 'unreadable'
      ? 'This package.json does not parse'
      : 'This directory is not a React Native or Expo app',
    `${problem.message} \`stim start\`, \`stim ios\` and \`stim android\` refuse here with STIM_NO_PROJECT, so nothing below was measured against an app.`,
    problem.remedy,
  );
}

function agentDeviceIsOnPath(): boolean {
  try {
    return Boolean(getExecutor().runQuiet('command -v agent-device', { timeoutMs: 5000 }));
  } catch {
    return true;
  }
}

function countLiveDevices(): number {
  let sims: IosSimRecord[] = [];
  let adb: AdbDevices = { emulators: [], physical: [], unhealthy: [] };
  let config: Config | null = null;
  try {
    sims = listAllIosSims() || [];
  } catch {}
  try {
    adb = listAdbDevices() || adb;
  } catch {}
  try {
    config = loadConfig();
  } catch {}
  return liveOwnedDeviceCount({ sims, adbEmulators: adb.emulators || [], config });
}

function countActiveBuilds(): number {
  try {
    return listBuildSlots().filter((s) => s.alive).length;
  } catch {
    return 0;
  }
}

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
    'Commit the dirty fingerprint inputs, or list the build-irrelevant ones in .fingerprintignore (same syntax as .gitignore, at the project root; Stim already ignores android/local.properties and android/.idea). Only the ones that genuinely cannot change the native build belong there -- generated reports, local env files, a lockfile whose checksums embed absolute machine paths. Never ignore a real native input (a Podfile, a gradle file, the app config) to force a hit: that trades a slow build for a wrong one.',
  );
}

export async function detectFingerprintParity(
  projectRoot: string,
  {
    createFingerprint = expoFingerprint.createFingerprintAsync,
    differ = expoFingerprint.diffFingerprints,
    dirtyFiles = dirtyFingerprintFiles,
    platform: selectedPlatform,
  }: {
    createFingerprint?: typeof expoFingerprint.createFingerprintAsync;
    differ?: typeof expoFingerprint.diffFingerprints | null;
    dirtyFiles?: (root: string) => string[];
    platform?: DoctorPlatform;
  } = {},
): Promise<Finding | null> {
  const exec = getExecutor();
  if (exec.runFileQuiet('git', ['-C', projectRoot, 'rev-parse', '--git-dir'], { timeoutMs: 10000 }) == null) {
    return null;
  }
  // A fresh `git worktree add` of HEAD carries no node_modules, and @expo/fingerprint reads
  // installed packages as sources, so from an installed checkout every comparison reports drift
  // that is only the missing install. The question has an answer only on a cold checkout.
  if (hasInstalledDependencies(projectRoot)) return null;

  const platform =
    selectedPlatform ??
    (existsSync(join(projectRoot, 'ios')) ? 'ios' : existsSync(join(projectRoot, 'android')) ? 'android' : undefined);

  let base: string;
  try {
    base = makeTemporaryDirectory(projectRoot, 'stim-parity-');
  } catch {
    return null;
  }
  const worktree = join(base, 'head');
  const added = exec.runFileQuiet('git', ['-C', projectRoot, 'worktree', 'add', '--detach', worktree, 'HEAD'], {
    timeoutMs: 60000,
  });
  if (added == null) {
    rmSync(base, { recursive: true, force: true });
    return null;
  }

  try {
    const project = await fingerprintProject(projectRoot, { platform, createFingerprint });
    const clean = await fingerprintProject(worktree, { platform, createFingerprint });
    if (!project || !clean) return null;
    if (project.hash === clean.hash) return null;
    const changed = diffFingerprintSources({
      previous: clean.sources,
      previousHash: clean.hash,
      current: project,
      differ,
    });
    return checkFingerprintParity({
      projectHash: project.hash,
      worktreeHash: clean.hash,
      changed,
      dirtyFiles: dirtyFiles(projectRoot),
    });
  } catch {
    return null;
  } finally {
    exec.runFileQuiet('git', ['-C', projectRoot, 'worktree', 'remove', '--force', worktree], { timeoutMs: 30000 });
    rmSync(base, { recursive: true, force: true });
    exec.runFileQuiet('git', ['-C', projectRoot, 'worktree', 'prune'], { timeoutMs: 10000 });
  }
}
