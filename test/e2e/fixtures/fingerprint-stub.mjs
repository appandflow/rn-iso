// A vendored, @expo/fingerprint-compatible stub for the cross-platform e2e.
//
// WHY THIS EXISTS. @expo/fingerprint is not a dependency of this repo (verified:
// `require.resolve('@expo/fingerprint')` throws MODULE_NOT_FOUND from the
// workspace root), and installing it -- plus its transitive native-tooling
// dependencies -- would make the "fast, Ubuntu, no-Xcode" e2e depend on a
// network install and a much larger tree. The cache machinery under test does
// not need the REAL hasher: it needs a hasher that (a) speaks the same API
// rn-iso calls, (b) hashes IDENTICAL native trees to the SAME value -- the
// cross-worktree cache premise -- and (c) SCOPES to a platform, which is the
// exact property src/build-cache.js's `fingerprintProject` relies on to keep
// an ios/ change out of the android/ key. This stub does all three
// deterministically and offline.
//
// It is injected through the `load` seam `fingerprintProject(root, { load })`
// already exposes for precisely this reason (see its docstring: "load is
// injected only so the option threading is testable without a real
// @expo/fingerprint on disk"). So the code under test -- buildCacheKey,
// storeBuild, resolveBuild, and fingerprintProject's own platform-scoping
// option threading -- is the REAL library; only the leaf hash function is the
// stub, and the test tolerates that by construction.
//
// API shape mirrors @expo/fingerprint: createFingerprintAsync(projectRoot,
// options?) -> { hash, sources }, honouring options.platforms: Platform[].
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ALL_PLATFORMS = ['ios', 'android'];

// Files/dirs a real fingerprint would never let leak into the hash. `.rn-iso`
// especially: it is location-addressed workspace state and hashing it would
// give two worktrees different hashes for the same commit -- the very bug
// rn-iso exists to avoid.
const IGNORED_SEGMENTS = new Set(['.git', '.rn-iso', 'node_modules']);

function walk(dir, acc, root) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (IGNORED_SEGMENTS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc, root);
    } else if (entry.isFile()) {
      let contents = '';
      try {
        contents = readFileSync(full, 'utf-8');
      } catch {
        contents = `<<unreadable:${statSync(full).size}>>`;
      }
      // Relative POSIX path so the hash is independent of WHERE the worktree
      // lives on disk -- two checkouts of one commit at different absolute
      // paths must hash identically. This is the cross-worktree premise in one
      // line.
      acc.push([relative(root, full).split('\\').join('/'), contents]);
    }
  }
}

/**
 * @param {string} projectRoot
 * @param {{ platforms?: string[] }} [options]
 * @returns {Promise<{ hash: string, sources: Array<{ type: string, filePath: string }> }>}
 */
export async function createFingerprintAsync(projectRoot, options = {}) {
  const platforms = Array.isArray(options?.platforms) && options.platforms.length ? options.platforms : ALL_PLATFORMS;

  const files = [];
  // The root package.json is a native input in the real hasher too (it names
  // the RN/Expo versions), so include it whatever the scope is.
  files.push(['package.json', safeRead(join(projectRoot, 'package.json'))]);
  for (const platform of platforms) {
    walk(join(projectRoot, platform), files, projectRoot);
  }

  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const hasher = createHash('sha256');
  // Scope goes into the hash too, so an ['android'] fingerprint can never
  // collide with an ['ios'] one even for a project whose two native trees
  // happen to be byte-identical.
  hasher.update(`platforms:${[...platforms].sort().join(',')}\n`);
  for (const [path, contents] of files) {
    hasher.update(path);
    hasher.update('\0');
    hasher.update(contents);
    hasher.update('\0');
  }
  return {
    hash: hasher.digest('hex'),
    sources: files.map(([filePath]) => ({ type: 'file', filePath })),
  };
}

function safeRead(path) {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

// The object shape `loadFingerprinter` would have returned, so the e2e can pass
// `load: () => fingerprinter` straight into fingerprintProject.
export function makeFingerprinter() {
  return { createFingerprintAsync };
}
