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

function entryDir(platform, fingerprintHash) {
  return path.join(CACHE_ROOT, platform, fingerprintHash);
}

// The cached artifact is the single .app / .apk inside the entry directory.
function artifactIn(dir) {
  if (!fs.existsSync(dir)) return null;
  const found = fs.readdirSync(dir).find(f => f.endsWith('.app') || f.endsWith('.apk'));
  return found ? path.join(dir, found) : null;
}

// Tell rn-iso this cache exists, so `gc --caches` can report and trim it. Every
// entry is an independent directory keyed by fingerprint, hence prune: entries.
//
// Best effort by design: this package is useful without rn-iso installed, and a
// missing peer must never break a build. Registration is idempotent, so calling
// it on every resolve is fine.
let registered = false;
function registerOnce() {
  if (registered) return;
  registered = true;
  try {
    // eslint-disable-next-line global-require
    const { register } = require('rn-iso/cache-manifest');
    register({
      dir: CACHE_ROOT,
      name: 'Expo build cache',
      prune: 'entries',
      note: 'built .app/.apk keyed on the native fingerprint',
    });
  } catch {
    // rn-iso not installed, or too old to export the manifest. Nothing to do.
  }
}

// The hash the CLI passes is stable once .fingerprintignore excludes generated
// files that embed absolute paths -- ios/Podfile.lock is the usual culprit, as
// pod checksums can carry machine-specific paths. Use it directly rather than
// recomputing: fingerprinting walks node_modules and is otherwise the single
// largest cost of a cache hit.
async function resolveBuildCache({ platform, fingerprintHash }) {
  registerOnce();
  const key = fingerprintHash;
  const hit = artifactIn(entryDir(platform, key));
  if (hit) {
    console.log(`[build-cache] hit ${platform} ${key.slice(0, 12)}`);
    // Touch on hit so age-based trimming can tell a working entry from a dead
    // one. Without this, the entries earning their keep look identical to the
    // ones nothing has used in months.
    fs.utimesSync(path.dirname(hit), new Date(), new Date());
    return hit;
  }
  console.log(`[build-cache] miss ${platform} ${key.slice(0, 12)}`);
  return null;
}

async function uploadBuildCache({ platform, fingerprintHash, buildPath }) {
  registerOnce();
  if (!buildPath || !fs.existsSync(buildPath)) return null;

  const key = fingerprintHash;
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

  console.log(`[build-cache] stored ${platform} ${key.slice(0, 12)}`);
  return artifactIn(dest);
}

module.exports = { resolveBuildCache, uploadBuildCache, CACHE_ROOT };
