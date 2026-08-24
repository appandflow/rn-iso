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
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// 'cost'  -- measurably slower, silently
// 'note'  -- worth knowing, not necessarily wrong
export function finding(level, title, detail, fix) {
  return { level, title, detail, fix };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

// A reserved Metro port only reaches the app through expo-dev-client's deep
// link: `--port` is never compiled into the binary. Without it the app looks
// for Metro on 8081, finds nothing, and shows a red screen naming none of this.
export function checkDevClient(pkg) {
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  if (deps['expo-dev-client']) return null;
  // Bare React Native has its own way of reaching a non-default port and no
  // dev client to install; this advice only applies to an Expo app.
  if (!deps.expo) return null;
  return finding(
    'cost',
    'expo-dev-client is not installed',
    'A Metro port reserved by rn-iso cannot reach the app without it: --port travels in the deep link `expo run:ios` opens, and nothing handles that URL. The app falls back to port 8081 and shows "No script URL provided".',
    'npx expo install expo-dev-client'
  );
}

// Metro's default cache is per-project, so every worktree re-transforms the
// whole module graph. One FileStore outside any project fixes it.
export function checkMetroCache(metroConfigSource) {
  if (metroConfigSource == null) {
    return finding(
      'note',
      'No metro.config.js found',
      'Metro then caches transforms under the project itself, so a second workspace starts cold and re-transforms every module.',
      'Add a metro.config.js with a FileStore cacheStore pointing outside the project.'
    );
  }
  if (/cacheStores/.test(metroConfigSource)) return null;
  return finding(
    'cost',
    'Metro cache is per-project',
    'Without a shared cacheStore each worktree transforms the whole module graph from cold -- thousands of modules, every time.',
    "config.cacheStores = [new FileStore({ root: path.join(os.homedir(), '.<app>-metro-cache') })]"
  );
}

// Xcode's compilation cache defaults to the DerivedData root. DerivedData is
// derived from the workspace path, so the default is per-workspace -- which is
// exactly the sharing it looks like it is providing.
export function checkCompilationCache(podfileSource, xcodeMajor) {
  if (podfileSource == null) return null;
  // The content-addressed compilation cache is Xcode 26+. On anything older
  // there is nothing to advise: saying "enable it" would be wrong, and saying
  // "upgrade Xcode" is a bigger decision than this command should be making.
  if (xcodeMajor != null && xcodeMajor < 26) return null;
  const enabled = /COMPILATION_CACHE_ENABLE_CACHING/.test(podfileSource);
  const path = /COMPILATION_CACHE_CAS_PATH/.test(podfileSource);
  if (!enabled) {
    return finding(
      'note',
      'Xcode compilation caching is not enabled',
      `On Xcode ${xcodeMajor ?? 26}+ a content-addressed cache can carry compiled output between workspaces, which is the difference between a full build and a partial one in a fresh worktree.`,
      "Set COMPILATION_CACHE_ENABLE_CACHING = YES in the Podfile's post_install, with COMPILATION_CACHE_CAS_PATH outside DerivedData."
    );
  }
  if (!path) {
    return finding(
      'cost',
      'Compilation cache is enabled but left at its default path',
      'The default CAS lives at the DerivedData root, and DerivedData is per-workspace -- so nothing is actually shared between worktrees, which is the only reason to turn it on.',
      'Set COMPILATION_CACHE_CAS_PATH to a fixed path outside DerivedData.'
    );
  }
  return null;
}

// ccache and compilation caching are mutually exclusive in practice: the ccache
// launcher is what disables explicitly built modules, which caching requires.
export function checkCcacheConflict(podfileSource, podfileProperties) {
  if (podfileSource == null) return null;
  const cachingOn = /COMPILATION_CACHE_ENABLE_CACHING/.test(podfileSource);
  const ccacheOn = podfileProperties?.['apple.ccacheEnabled'] === 'true';
  if (!cachingOn || !ccacheOn) return null;
  return finding(
    'cost',
    'ccache and Xcode compilation caching are both enabled',
    'The ccache launcher script is what disables explicitly built modules, which compilation caching requires -- so enabling both tends to mean neither works. ccache also keys on absolute paths, so it misses across worktrees.',
    'Pick one. On Xcode 26 the compilation cache is the one that survives a different workspace path.'
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
export function checkBuildCacheProvider(appConfig, sdkMajor, isExpo = true, dynamicConfig = null) {
  // Bare React Native has no equivalent hook: the community CLI never consults
  // a provider, so there is nothing to misconfigure and nothing to suggest
  // beyond building the lookup yourself.
  if (!isExpo) {
    return finding(
      'note',
      'No build cache hook outside Expo',
      'The provider that lets a workspace install a cached .app instead of compiling is an Expo CLI feature; the React Native community CLI has no equivalent. `@expo/fingerprint` works standalone on a bare project, so the pieces exist -- keying a stored .app on it and installing that yourself is the missing part.',
      null
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
      'This config is code, so it is not readable without executing it. Confirm by hand that a buildCacheProvider is set, and that it is on the key this SDK reads.',
      sdkMajor && sdkMajor <= 53
        ? `SDK ${sdkMajor} reads expo.experiments.buildCacheProvider and ignores the top-level key in silence.`
        : 'Use the top-level expo.buildCacheProvider; the experiments key still works as a fallback.'
    );
  }
  if (!appConfig) return null;
  const expo = appConfig.expo ?? appConfig;
  const topLevel = expo?.buildCacheProvider;
  const experimental = expo?.experiments?.buildCacheProvider;

  if (!topLevel && !experimental) {
    return finding(
      'note',
      'No Expo build cache provider configured',
      'Without one, every workspace builds the app even when no native input changed. With one, a JS-only ticket installs a cached .app instead of compiling.',
      'Add a buildCacheProvider to app.json pointing at a local provider module.'
    );
  }

  if (sdkMajor && sdkMajor <= 53 && topLevel && !experimental) {
    return finding(
      'cost',
      'buildCacheProvider is at the top level, but this SDK only reads it from experiments',
      `SDK ${sdkMajor}'s CLI resolves exp.experiments.buildCacheProvider and nothing else. The top-level key is ignored in silence, so the provider is never called and every build is a full build.`,
      'Move it to expo.experiments.buildCacheProvider.'
    );
  }

  if (sdkMajor && sdkMajor >= 54 && experimental && !topLevel) {
    return finding(
      'note',
      'buildCacheProvider is still under experiments',
      `It works -- SDK ${sdkMajor} falls back to the experiments key -- but the setting was promoted out of experiments, and the top-level key is the one that will keep working.`,
      'Move it to expo.buildCacheProvider.'
    );
  }

  return null;
}

// Runs every check against one project directory. Pure enough to test: all file
// reads happen here, and each check is a function of the text it was given.
export function runDoctor(projectRoot, { readFile = readFileSync, xcodeMajor = null } = {}) {
  const read = (rel) => {
    const p = join(projectRoot, rel);
    if (!existsSync(p)) return null;
    try {
      return readFile(p, 'utf-8');
    } catch {
      return null;
    }
  };

  const pkg = readJson(join(projectRoot, 'package.json'));
  const appConfig = readJson(join(projectRoot, 'app.json'));
  const dynamicConfig = appConfig
    ? null
    : ['app.config.ts', 'app.config.js', 'app.config.mjs'].find(f => existsSync(join(projectRoot, f))) || null;
  const podfileProperties = readJson(join(projectRoot, 'ios', 'Podfile.properties.json'));
  const podfile = read(join('ios', 'Podfile'));
  const metroConfig = read('metro.config.js');

  const isExpo = Boolean(pkg?.dependencies?.expo);
  const expoRange = pkg?.dependencies?.expo || '';
  const sdkMajor = parseInt(String(expoRange).replace(/[^\d.]/g, '').split('.')[0], 10) || null;

  return [
    checkDevClient(pkg),
    checkMetroCache(metroConfig),
    checkCompilationCache(podfile, xcodeMajor),
    checkCcacheConflict(podfile, podfileProperties),
    checkBuildCacheProvider(appConfig, sdkMajor, isExpo, dynamicConfig),
  ].filter(Boolean);
}
