// @rn-iso/core -- the primitives rn-iso and its cache packages must AGREE on,
// implemented once. Until this package existed they were deliberately
// duplicated three times (the cache packages may not import rn-iso itself: it
// is an optional ESM peer, usually absent under `npx rn-iso`, and requiring
// it threw ERR_REQUIRE_ESM on Node before 20.19 -- a silent no-op both times).
// A tiny CJS hard dependency has neither failure mode, so the copies collapse
// here. CJS on purpose: metro.config.js and Expo providers `require()` this.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function configDir(): string {
  return process.env.RN_ISO_HOME || path.join(os.homedir(), '.rn-iso');
}

// The machine config's cache overrides (`caches.buildCache` / `caches.metroCache`
// in <configDir>/config.json). Unreadable or malformed answers null -- a cache
// override must never be the reason a bundler config or a build fails. Only an
// absolute path counts.
export function cachePathSetting(key: 'buildCache' | 'metroCache'): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir(), 'config.json'), 'utf-8')) as {
      caches?: Record<string, unknown>;
    };
    const value = parsed?.caches?.[key];
    return typeof value === 'string' && value.startsWith('/') ? value : null;
  } catch {
    return null;
  }
}

// Anything that is not a plain path segment is replaced, and leading dots go,
// so a scoped package name cannot climb out of the cache root.
export function cacheNameSegment(name: string | null | undefined): string {
  return (
    String(name)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^\.+/, '') || 'app'
  );
}

// Resolution order in both roots: env override, machine config, default
// layout under the config dir. The env vars come first because they were
// honoured before the rest existed, and quietly ignoring an override someone
// already set reads as an empty cache rather than as an error. An override
// names ONE directory and is returned as-is -- no per-app segment -- otherwise
// half the stores on a machine would move and half would not.
export function buildCacheRoot(): string {
  return process.env.RN_ISO_BUILD_CACHE || cachePathSetting('buildCache') || path.join(configDir(), 'build-cache');
}

export function metroCacheRoot(name?: string | null): string {
  const override = process.env.RN_ISO_METRO_CACHE || cachePathSetting('metroCache');
  if (override) return override;
  const root = path.join(configDir(), 'metro-cache');
  return name === undefined || name === null || name === '' ? root : path.join(root, cacheNameSegment(name));
}

// ---- identifying a store rn-iso installed -----------------------------------
//
// Metro's FileStore kept its root on a PUBLIC `_root` until metro-cache
// 0.83.0, which made it a private `#root`. Every "is our store already in this
// list" check in this repo read `_root`, so all of them went silently false on
// every current Metro -- measured on real installs: 0.81.5 and 0.82.5 expose
// `_root`, 0.83.5 / 0.84.4 / 0.85.0 / 0.87.0 do not. A private field cannot be
// read from outside at all, so the fix is not a better probe: it is to TAG the
// instances we create with a root we can read back.
//
// It lives here because rn-iso and @rn-iso/metro both create these stores and
// each must recognize the other's, which is the whole reason this package
// exists. The shim (packages/rn-iso/shim) repeats the property NAME rather
// than importing it, for the reason it repeats the env var names: it may have
// no dependencies at all.
export const STORE_ROOT_TAG = 'rnIsoStoreRoot';

// Tag a freshly constructed store and hand it back, so a call site stays one
// expression. Best-effort: a frozen store instance is still a working store.
export function tagSharedStore<T extends object>(store: T, root: string): T {
  try {
    Object.defineProperty(store, STORE_ROOT_TAG, { value: root, enumerable: false, configurable: true });
  } catch {
    // Untaggable means undetectable, which costs a duplicate store entry at
    // worst -- never a failed dev server.
  }
  return store;
}

// The root a store in a cacheStores list was created for, or null when it is
// not one of ours. `_root` is read as well so a project still on metro-cache
// 0.82 or older, where the field was public, is recognized the way it always
// was.
export function sharedStoreRoot(store: unknown): string | null {
  if (store === null || typeof store !== 'object') return null;
  const tagged = (store as Record<string, unknown>)[STORE_ROOT_TAG];
  if (typeof tagged === 'string') return tagged;
  const legacy = (store as { _root?: unknown })._root;
  return typeof legacy === 'string' ? legacy : null;
}

// ---- the build cache key ---------------------------------------------------
//
// The fingerprint covers what the project IS, never how it was built. Keying
// on it alone means a Release build answers a Debug resolve, and a device
// build answers a simulator one -- both silently, both producing a binary that
// cannot run. `options` is the run-options object Expo hands a build cache
// provider; only the keys named here are read, so an unfamiliar CLI version
// cannot change the key by adding one.

export interface BuildRunOptions {
  variant?: string;
  configuration?: string;
  buildConfiguration?: string;
  isSimulator?: boolean;
  device?: string | boolean | null;
}

// A simulator udid is a canonical UUID. Apple's hardware identifiers are not:
// they are 40 hex characters, or the 8-digits-dash-16-hex form newer devices
// use.
const SIMULATOR_UDID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// adb's name for a running emulator.
const EMULATOR_SERIAL = /^emulator-\d+$/;

function slug(value: unknown): string {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The Xcode configuration on iOS, the gradle variant on Android. Both CLIs
// default to Debug/debug, so an absent value is that and not "unknown".
function buildVariant(platform: string, options: BuildRunOptions): string {
  const raw = platform === 'android' ? options.variant : (options.configuration ?? options.buildConfiguration);
  return (typeof raw === 'string' ? slug(raw) : '') || 'debug';
}

// A binary built for real hardware cannot run on a simulator, and the reverse
// is equally true, so the target class is part of the key. The device selector
// is the only signal available, and it is ambiguous by nature; the
// unclassifiable shapes get a bucket of their own rather than sharing the
// simulator one: a wasted rebuild is cheap, a binary that cannot launch is not.
function buildTarget(options: BuildRunOptions): string {
  if (typeof options.isSimulator === 'boolean') return options.isSimulator ? 'sim' : 'device';
  const device = options.device;
  if (device === undefined || device === null || device === false) return 'sim';
  if (typeof device !== 'string') return 'prompted';
  const name = device.trim();
  if (name === '' || name === 'generic') return 'sim';
  if (SIMULATOR_UDID.test(name) || EMULATOR_SERIAL.test(name)) return 'sim';
  return `on-${slug(name)}`;
}

export function buildCacheKey(platform: string, fingerprintHash: string, options: unknown = {}): string {
  const opts = (options && typeof options === 'object' ? options : {}) as BuildRunOptions;
  return `${fingerprintHash}-${buildVariant(platform, opts)}-${buildTarget(opts)}`;
}

// ---- cache self-registration ----------------------------------------------
//
// Registering makes a cache visible to `rn-iso gc`'s report, which is the only
// thing that will ever trim it. The manifest is written directly (not through
// any rn-iso module) and a failure to announce is swallowed: a cache that
// cannot register still works, it is just invisible.

export interface RegisterOptions {
  dir: string;
  name: string;
  prune: string;
  note: string;
  entriesDepth?: number;
}

export function registerCache({ dir, name, prune, note, entriesDepth }: RegisterOptions): void {
  try {
    const home = configDir();
    const file = path.join(home, 'caches.json');
    let manifest: { version: number; caches: Array<Record<string, unknown>> } = { version: 1, caches: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { caches?: Array<Record<string, unknown>> };
      if (Array.isArray(parsed?.caches)) manifest = { version: 1, caches: parsed.caches };
    } catch {
      // No manifest yet, or an unreadable one: start clean rather than fail.
    }
    // Keyed on the directory so repeated calls update rather than accumulate --
    // these run on every build.
    const others = manifest.caches.filter((c) => c.dir !== dir);
    const record: Record<string, unknown> = { dir, name, prune, note, registeredBy: process.cwd() };
    // Only written when the caller sets it: an absent depth means the entries
    // are the directory's immediate children, which is the common case.
    if (entriesDepth) record.entriesDepth = entriesDepth;
    others.push(record);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, caches: others }, null, 2));
  } catch {
    // A cache that cannot announce itself still works; it is just invisible.
  }
}
