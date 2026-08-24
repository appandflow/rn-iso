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
// <root>/<platform>/<fingerprint>/<artifact> -- so a project that later adopts
// the Expo provider keeps every entry it already had.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, utimesSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import { createRequire } from 'module';
import { getExecutor } from './exec.js';
import { register } from './cache-manifest.js';

export function cacheRoot() {
  return process.env.RN_ISO_BUILD_CACHE || join(homedir(), '.rn-iso-build-cache');
}

export function entryDir(platform, fingerprint, root = cacheRoot()) {
  return join(root, platform, fingerprint);
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

export async function fingerprintProject(projectRoot) {
  const fp = loadFingerprinter(projectRoot);
  if (!fp) return null;
  const result = await fp.createFingerprintAsync(projectRoot);
  return result?.hash ?? null;
}

// Registration is what makes an entry visible to `gc --caches`, and every entry
// is an independent directory, so old ones can be trimmed individually.
function registerOnce(root) {
  try {
    register({
      dir: root,
      name: 'Build cache',
      prune: 'entries',
      note: 'built .app/.apk keyed on the native fingerprint',
    });
  } catch {
    // A cache that cannot announce itself still works; it is just invisible.
  }
}

export function resolveBuild(platform, fingerprint, root = cacheRoot()) {
  const hit = artifactIn(entryDir(platform, fingerprint, root));
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

export function storeBuild(platform, fingerprint, buildPath, root = cacheRoot()) {
  if (!buildPath || !existsSync(buildPath)) {
    throw new Error(`No build to store at ${buildPath}`);
  }
  registerOnce(root);

  const dest = entryDir(platform, fingerprint, root);
  const existing = artifactIn(dest);
  if (existing) return existing;

  // Stage in a sibling and rename into place: a copy interrupted halfway must
  // never be readable as a complete entry by a worktree building in parallel,
  // and rename is the only step here that is atomic.
  const staging = `${dest}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  getExecutor().run(`cp -R "${buildPath}" "${join(staging, basename(buildPath))}"`);

  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  renameSync(staging, dest);
  return artifactIn(dest);
}
