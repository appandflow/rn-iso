// A build cache for projects that have no provider hook.
//
// Expo's CLI consults a build-cache provider and hands it a fingerprint of the
// native inputs; the React Native community CLI does not, so a bare project
// rebuilds from scratch every time even when nothing native changed. The
// fingerprint itself is not Expo-specific -- @expo/fingerprint hashes ios/ and
// android/ on a project with no Expo in it at all -- so the only missing piece
// is somewhere to put the answer.
//
// This is the broker's usual shape rather than a build wrapper: `resolve` says
// whether a build already exists for what is on disk, and the caller decides
// what to do about it. rn-iso still never runs your build.
//
// The on-disk layout is deliberately the same as @rn-iso/expo-build-cache's --
// <root>/<platform>/<key>/<artifact> -- so a project that later adopts the Expo
// provider keeps every entry it already had. Both packages build <key> with the
// same rules (see buildCacheKey below); changing one without the other splits
// the two entry points onto separate sets of entries.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, utimesSync } from 'fs';
import { basename, dirname, join } from 'path';
import { createRequire } from 'module';
import { getExecutor } from './exec.js';
import { register } from './cache-manifest.js';
import { sharedBuildCache } from './paths.js';

// One line, but the one that decides whether the CLI and the provider address
// the same entries at all: src/paths.js owns the resolution, and
// packages/expo-build-cache/index.js repeats it because it must run with no
// rn-iso installed. See the note above sharedBuildCache.
export function cacheRoot() {
  return sharedBuildCache();
}

export function entryDir(platform, key, root = cacheRoot()) {
  return join(root, platform, key);
}

// A simulator udid is a canonical UUID. Apple's hardware identifiers are not:
// they are 40 hex characters, or the 8-digits-dash-16-hex form newer devices
// use.
const SIMULATOR_UDID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// adb's name for a running emulator.
const EMULATOR_SERIAL = /^emulator-\d+$/;

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// The Xcode configuration on iOS, the gradle variant on Android. Both CLIs
// default to Debug/debug, so an absent value is that and not "unknown".
function buildVariant(platform, options) {
  const raw = platform === 'android'
    ? options.variant
    : (options.configuration ?? options.buildConfiguration);
  return (typeof raw === 'string' ? slug(raw) : '') || 'debug';
}

// A binary built for real hardware cannot run on a simulator, and the reverse is
// equally true, so the target class is part of the key. The device selector is
// the only signal available, and it is ambiguous by nature:
//   absent            -- the CLI targets a simulator or emulator. The default.
//   "generic"         -- a build-only simulator build.
//   a udid or serial  -- classifiable when it has the shape of a simulator id.
//   a bare flag       -- the CLI prompts, and the answer can be hardware.
//   a name            -- unclassifiable.
// The last two get a bucket of their own rather than sharing the simulator one:
// a wasted rebuild is cheap, and a binary that cannot launch is not. Two
// workspaces naming the same device still share their entries.
function buildTarget(options) {
  if (typeof options.isSimulator === 'boolean') return options.isSimulator ? 'sim' : 'device';
  const device = options.device;
  if (device === undefined || device === null || device === false) return 'sim';
  if (typeof device !== 'string') return 'prompted';
  const name = device.trim();
  if (name === '' || name === 'generic') return 'sim';
  if (SIMULATOR_UDID.test(name) || EMULATOR_SERIAL.test(name)) return 'sim';
  return `on-${slug(name)}`;
}

// The fingerprint covers what the project IS, never how it was built. Keying on
// it alone means a Release build answers a Debug resolve, and a device build
// answers a simulator one -- both silently, both producing a binary that cannot
// run. `options` is the run-options object Expo hands a build cache provider;
// only the keys named here are read, so an unfamiliar CLI version cannot change
// the key by adding one.
export function buildCacheKey(platform, fingerprintHash, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  return `${fingerprintHash}-${buildVariant(platform, opts)}-${buildTarget(opts)}`;
}

// The artifact is the single .app / .apk inside an entry directory.
export function artifactIn(dir) {
  if (!existsSync(dir)) return null;
  let found;
  try {
    found = readdirSync(dir).find(f => f.endsWith('.app') || f.endsWith('.apk'));
  } catch {
    return null;
  }
  return found ? join(dir, found) : null;
}

// @expo/fingerprint is resolved from the PROJECT first: an Expo app already has
// it, and using the project's copy means the hash matches the one its own CLI
// would compute. Only then fall back to a copy installed alongside rn-iso.
// Returning null rather than throwing lets the caller give advice instead of a
// stack trace.
export function loadFingerprinter(projectRoot) {
  for (const from of [join(projectRoot, 'package.json'), import.meta.url]) {
    try {
      const require_ = createRequire(from);
      return require_('@expo/fingerprint');
    } catch {
      // Try the next location.
    }
  }
  return null;
}

// The platforms @expo/fingerprint accepts as a scope (options.platforms:
// Platform[]). Anything else is not passed at all -- an unrecognized value
// would scope the hash to nothing native and give every project on the machine
// the same key.
const FINGERPRINT_PLATFORMS = new Set(['ios', 'android']);

/**
 * The @expo/fingerprint hash of the project's native inputs, SCOPED to the
 * platform being built.
 *
 * THE SCOPE IS THE POINT, and it was measured: without it,
 * `createFingerprintAsync(root)` hashes ios/ AND android/ into one hash, so the
 * ANDROID cache key changes whenever anything under ios/ does. On th3rdwave's
 * tlon-apps that is not a rare event -- the hermes-engine podspec bakes the
 * absolute worktree path into ios/Podfile.lock, so two worktrees of the same
 * commit differ under ios/ by construction and `rn-iso android` missed the
 * shared cache 100% of the time across worktrees. Scoping to ['android'] made
 * both worktrees hash identically.
 *
 * `load` is injected only so the option threading is testable without a real
 * @expo/fingerprint on disk.
 */
export async function fingerprintProject(projectRoot, { platform, load = loadFingerprinter } = {}) {
  const fp = load(projectRoot);
  if (!fp) return null;
  const options = FINGERPRINT_PLATFORMS.has(platform) ? { platforms: [platform] } : undefined;
  const result = await fp.createFingerprintAsync(projectRoot, options);
  return result?.hash ?? null;
}

// Registration is what makes an entry visible to `gc`'s report, and every entry
// is an independent directory, so old ones can be trimmed individually. The
// entries sit two levels down -- <root>/<platform>/<key> -- so gc must be told
// that, or it treats ios/ and android/ as the entries and one removal takes a
// whole platform.
function registerOnce(root) {
  try {
    register({
      dir: root,
      name: 'Build cache',
      prune: 'entries',
      entriesDepth: 2,
      note: 'built .app/.apk keyed on the native fingerprint',
    });
  } catch {
    // A cache that cannot announce itself still works; it is just invisible.
  }
}

export function resolveBuild(platform, key, root = cacheRoot()) {
  const hit = artifactIn(entryDir(platform, key, root));
  if (!hit) return null;
  // Touch on hit so age-based trimming can tell an entry that is earning its
  // keep from one nothing has used in months: a hit reads the entry without
  // rewriting it, so mtime alone would age out exactly the wrong ones.
  try {
    utimesSync(dirname(hit), new Date(), new Date());
  } catch {
    // Not being able to touch it is not a reason to refuse the hit.
  }
  return hit;
}

// The fourth argument is the cache ROOT (a string, which is what every caller
// passed before options existed) or an options object `{ root, overwrite }`.
// Both forms are supported rather than one being migrated, because the string
// form is how the tests address a temp cache and there is nothing wrong with
// it.
//
// `overwrite` exists for `--no-build-cache`. Keeping an existing entry is right
// by default -- two worktrees building the same fingerprint produce the same
// app, and the first one there wins without a redundant copy. But it also
// meant an entry could never be REPLACED, so a poisoned one (a build that
// links a stale pod, a copy interrupted by something other than the staging
// rename) survived every attempt to get rid of it short of `gc`. That is
// exactly the situation "build it again without the cache" exists to fix, so
// the flag that says so replaces the entry. The write is atomic either way:
// the staging directory is renamed over the destination.
export function storeBuild(platform, key, buildPath, rootOrOptions = {}) {
  const options = typeof rootOrOptions === 'string' ? { root: rootOrOptions } : (rootOrOptions || {});
  const root = options.root || cacheRoot();
  const overwrite = Boolean(options.overwrite);

  if (!buildPath || !existsSync(buildPath)) {
    throw new Error(`No build to store at ${buildPath}`);
  }
  registerOnce(root);

  const dest = entryDir(platform, key, root);
  const existing = artifactIn(dest);
  if (existing && !overwrite) return existing;

  // Stage in a sibling and rename into place: a copy interrupted halfway must
  // never be readable as a complete entry by a worktree building in parallel,
  // and rename is the only step here that is atomic.
  //
  // An argv array rather than a command string: buildPath is a path the caller
  // chose, and a space or a quote in it would otherwise be read by the shell.
  const staging = `${dest}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  getExecutor().runFile('cp', ['-R', buildPath, join(staging, basename(buildPath))]);

  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  renameSync(staging, dest);
  return artifactIn(dest);
}
