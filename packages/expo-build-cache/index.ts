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
//
// This file is authored in TypeScript with ESM syntax and built to CommonJS by
// tsdown (format: 'cjs'), because @expo/cli loads a build-cache provider through
// require().

import fs from 'node:fs';
import path from 'node:path';
import { buildCacheRoot, buildCacheKey, registerCache } from '@rn-iso/core';
import type { BuildRunOptions as RunOptions } from '@rn-iso/core';

export { buildCacheKey };

// Register at most once per resolved root, not once per process: the root can
// move if the env/config changes between calls in one process, and re-checking
// is one string compare.
let registeredDir: string | null = null;
import { execFileSync } from 'node:child_process';

// The run options Expo hands a provider. Only the keys named below are read; a
// future CLI cannot change the cache key by adding one.

// THIS RESOLUTION EXISTS THREE TIMES: here, in packages/metro/index.ts,
// and in rn-iso's own src/paths.ts (sharedBuildCache / sharedMetroCache). This
// package cannot import that module -- it has to work on a machine with no
// rn-iso installed at all -- so the duplication is deliberate, exactly like
// buildCacheKey below. Change one and you must change all three: when they
// drift, the CLI stores a build in one directory and this provider looks for it
// in another, and neither of them says so. rn-iso's
// src/__tests__/cache-packages.test.ts asserts all three agree.
//
// RN_ISO_BUILD_CACHE comes first because it did before the layout existed, and
// quietly ignoring an override someone already set reads as an empty cache
// rather than as an error.
export function cacheRoot(): string {
  return buildCacheRoot();
}

function entryDir(platform: string, key: string): string {
  return path.join(cacheRoot(), platform, key);
}

// A simulator udid is a canonical UUID. Apple's hardware identifiers are not:
// they are 40 hex characters, or the 8-digits-dash-16-hex form newer devices
// use.
// Log lines name the entry, so they have to carry what distinguishes it: the
// fingerprint abbreviates fine, the variant and target do not -- a Debug miss
// and a Release miss on the same commit read identically without them.
function shortKey(key: string, fingerprintHash: string): string {
  return `${String(fingerprintHash).slice(0, 12)}${key.slice(String(fingerprintHash).length)}`;
}

// The cached artifact is the single .app / .apk inside the entry directory.
function artifactIn(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  // Wrapped like the CLI-side twin (src/build-cache.ts): the entry can be
  // pruned by `gc --delete` between the existsSync and the readdir, and an
  // ENOENT here must degrade to a miss, not throw out of the Expo provider.
  let found;
  try {
    found = fs.readdirSync(dir).find((f) => f.endsWith('.app') || f.endsWith('.apk'));
  } catch {
    return null;
  }
  return found ? path.join(dir, found) : null;
}

// Registering makes this cache visible to `rn-iso gc`'s report, which is the
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
function registerOnce(): void {
  const root = cacheRoot();
  if (registeredDir === root) return;
  registeredDir = root;
  registerCache({
    dir: root,
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
export async function resolveBuildCache({
  platform,
  fingerprintHash,
  runOptions,
}: {
  platform: string;
  fingerprintHash: string;
  runOptions?: RunOptions;
}): Promise<string | null> {
  registerOnce();
  const key = buildCacheKey(platform, fingerprintHash, runOptions);
  const hit = artifactIn(entryDir(platform, key));
  if (hit) {
    console.log(`[build-cache] hit ${platform} ${shortKey(key, fingerprintHash)}`);
    // Touch on hit so age-based trimming can tell a working entry from a dead
    // one. Without this, the entries earning their keep look identical to the
    // ones nothing has used in months. Guarded like the CLI twin: not being
    // able to touch it (a concurrent prune) is not a reason to refuse the hit.
    try {
      fs.utimesSync(path.dirname(hit), new Date(), new Date());
    } catch {
      /* the hit still stands */
    }
    return hit;
  }
  console.log(`[build-cache] miss ${platform} ${shortKey(key, fingerprintHash)}`);
  return null;
}

export async function uploadBuildCache({
  platform,
  fingerprintHash,
  buildPath,
  runOptions,
}: {
  platform: string;
  fingerprintHash: string;
  buildPath?: string;
  runOptions?: RunOptions;
}): Promise<string | null> {
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
  // APFS clone first (milliseconds for a big .app on the same volume), plain
  // copy where cloning cannot work -- the same trade the CLI-side twin makes.
  try {
    execFileSync('cp', ['-c', '-R', buildPath, path.join(staging, path.basename(buildPath))]);
  } catch {
    execFileSync('cp', ['-R', buildPath, path.join(staging, path.basename(buildPath))]);
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  try {
    fs.renameSync(staging, dest);
  } catch {
    // Two `expo run` builds of the same fingerprint can finish together and
    // interleave rm/rm/rename/rename; the loser's rename onto the now-populated
    // dest throws. The winner's entry is byte-identical, so keep it and drop our
    // staging rather than fail an otherwise-successful build.
    fs.rmSync(staging, { recursive: true, force: true });
  }

  console.log(`[build-cache] stored ${platform} ${shortKey(key, fingerprintHash)}`);
  return artifactIn(dest);
}
