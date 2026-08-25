// A local Expo build cache provider.
//
// Expo fingerprints the project's native inputs and hands the hash to a
// provider. If a build already exists for that hash, the provider returns it and
// the CLI installs it instead of compiling. That is the difference between a
// JS-only change costing a simulator boot and costing a full native build, and
// most changes are JS-only.
//
// Local on purpose: a directory under $HOME shared by every worktree on the
// machine. No account, no network, and a second worktree building the same
// commit is a hit rather than a second five-minute build.
//
// Wire it up in app.json. Which key depends on the SDK, and the wrong one is a
// silent no-op rather than an error:
//
//   SDK 54+  { "expo": { "buildCacheProvider": { "plugin": "@rn-iso/expo-build-cache" } } }
//   SDK 53   { "expo": { "experiments": { "buildCacheProvider": { ... } } } }
//
// SDK 53's CLI reads only the experiments key and ignores the top-level one
// without saying so; SDK 54+ reads the top-level key and falls back to
// experiments.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CACHE_ROOT =
  process.env.RN_ISO_BUILD_CACHE || path.join(os.homedir(), '.rn-iso-build-cache');

function entryDir(platform, key) {
  return path.join(CACHE_ROOT, platform, key);
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

// The Xcode configuration on iOS, the gradle variant on Android. `expo run:ios`
// defaults to Debug and `expo run:android` to debug, so an absent value is that
// and not "unknown".
function buildVariant(platform, options) {
  const raw = platform === 'android'
    ? options.variant
    : (options.configuration != null ? options.configuration : options.buildConfiguration);
  return (typeof raw === 'string' ? slug(raw) : '') || 'debug';
}

// A binary built for real hardware cannot run on a simulator, and the reverse is
// equally true, so the target class is part of the key. `runOptions.device` is
// the only signal Expo passes, and it is ambiguous by nature:
//   absent            -- the CLI targets a simulator or emulator. The default.
//   "generic"         -- a build-only simulator build.
//   a udid or serial  -- classifiable when it has the shape of a simulator id.
//   a bare -d flag    -- the CLI prompts, and the answer can be hardware.
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
// run. Only the run-option keys named above are read, so a future Expo CLI
// cannot change the key by adding one.
//
// rn-iso's own `rn-iso build-cache` command computes this key the same way
// (src/build-cache.js), so both entry points address the same entry. Changing
// one without the other splits them onto separate sets of entries.
function buildCacheKey(platform, fingerprintHash, runOptions) {
  const opts = runOptions && typeof runOptions === 'object' ? runOptions : {};
  return `${fingerprintHash}-${buildVariant(platform, opts)}-${buildTarget(opts)}`;
}

// Log lines name the entry, so they have to carry what distinguishes it: the
// fingerprint abbreviates fine, the variant and target do not -- a Debug miss
// and a Release miss on the same commit read identically without them.
function shortKey(key, fingerprintHash) {
  return `${String(fingerprintHash).slice(0, 12)}${key.slice(String(fingerprintHash).length)}`;
}

// The cached artifact is the single .app / .apk inside the entry directory.
function artifactIn(dir) {
  if (!fs.existsSync(dir)) return null;
  const found = fs.readdirSync(dir).find(f => f.endsWith('.app') || f.endsWith('.apk'));
  return found ? path.join(dir, found) : null;
}

// Registering makes this cache visible to `rn-iso gc --caches`, which is the
// only thing that will ever trim it.
//
// The manifest is written directly rather than through rn-iso's own module, for
// two reasons that both made the import silently do nothing:
//   - the documented way to use the CLI is `npx rn-iso`, so it is usually not a
//     dependency of the project and the specifier does not resolve at all
//   - rn-iso is an ES module, so `require` of it throws ERR_REQUIRE_ESM on Node
//     before 20.19
// A dynamic import fixes the second and not the first. The format is a stable
// contract, so writing it is the cheaper trade.
function registerCache({ dir, name, prune, note }) {
  try {
    const home = process.env.RN_ISO_HOME || path.join(os.homedir(), '.rn-iso');
    const file = path.join(home, 'caches.json');
    let manifest = { version: 1, caches: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (Array.isArray(parsed?.caches)) manifest = { version: 1, caches: parsed.caches };
    } catch {
      // No manifest yet, or an unreadable one: start clean rather than fail.
    }
    // Keyed on the directory so repeated calls update rather than accumulate --
    // these run on every build.
    const others = manifest.caches.filter(c => c.dir !== dir);
    others.push({ dir, name, prune, note, registeredBy: process.cwd() });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, caches: others }, null, 2));
  } catch {
    // A cache that cannot announce itself still works; it is just invisible.
  }
}

let registered = false;
function registerOnce() {
  if (registered) return;
  registered = true;
  registerCache({
    dir: CACHE_ROOT,
    name: 'Expo build cache',
    // Every entry is an independent directory keyed by fingerprint, so old ones
    // can be trimmed individually. They sit two levels down --
    // <root>/<platform>/<key> -- and gc has to be told, or it treats ios/ and
    // android/ as the entries and one removal takes a whole platform.
    prune: 'entries',
    entriesDepth: 2,
    note: 'built .app/.apk keyed on the native fingerprint',
  });
}

// The hash the CLI passes is stable once .fingerprintignore excludes generated
// files that embed absolute paths -- ios/Podfile.lock is the usual culprit, as
// pod checksums can carry machine-specific paths. Use it directly rather than
// recomputing: fingerprinting walks node_modules and is otherwise the single
// largest cost of a cache hit.
async function resolveBuildCache({ platform, fingerprintHash, runOptions }) {
  registerOnce();
  const key = buildCacheKey(platform, fingerprintHash, runOptions);
  const hit = artifactIn(entryDir(platform, key));
  if (hit) {
    console.log(`[build-cache] hit ${platform} ${shortKey(key, fingerprintHash)}`);
    // Touch on hit so age-based trimming can tell a working entry from a dead
    // one. Without this, the entries earning their keep look identical to the
    // ones nothing has used in months.
    fs.utimesSync(path.dirname(hit), new Date(), new Date());
    return hit;
  }
  console.log(`[build-cache] miss ${platform} ${shortKey(key, fingerprintHash)}`);
  return null;
}

async function uploadBuildCache({ platform, fingerprintHash, buildPath, runOptions }) {
  registerOnce();
  if (!buildPath || !fs.existsSync(buildPath)) return null;

  const key = buildCacheKey(platform, fingerprintHash, runOptions);
  const dest = entryDir(platform, key);
  if (artifactIn(dest)) return artifactIn(dest);

  // Stage in a sibling and rename into place. A copy interrupted halfway must
  // never be readable as a complete entry by a worktree building in parallel,
  // and rename is the only step that is atomic.
  const staging = `${dest}.staging-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  execFileSync('cp', ['-R', buildPath, path.join(staging, path.basename(buildPath))]);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(staging, dest);

  console.log(`[build-cache] stored ${platform} ${shortKey(key, fingerprintHash)}`);
  return artifactIn(dest);
}

module.exports = { resolveBuildCache, uploadBuildCache, buildCacheKey, CACHE_ROOT };
