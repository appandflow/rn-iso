// src/engine/asset-manifest.ts -- what the RELEASE asset gate compares.
//
// The gate used to compare the freshly emitted `--assets-dest` tree against
// the cached APK's own `res/` entries. Live verification on a real Expo
// release APK proved that mis-specified in two independent ways, and both are
// blocking:
//
// 1. AGP runs `optimizeReleaseResources` by default on a release build, which
//    applies AAPT2 RESOURCE PATH SHORTENING: the packaged entries are
//    `res/-B.png`, `res/0h.png`, not `res/drawable-mdpi-v4/logo.png`. The old
//    `res/(drawable-*|raw)/...` predicate matched ZERO of 972 res entries, so
//    every emitted asset read as "added" and the swap refused on every
//    JS-only change. The feature never fired at all on a real app.
// 2. With shortening disabled, `res/drawable-*` ALSO holds every AppCompat and
//    AndroidX library drawable (177 of them on that app) that `--assets-dest`
//    never emits, so all of those read as "removed" and the gate refused
//    again.
//
// So the APK's res/ table is not a side of this comparison at all. Instead the
// build that produced the cache entry records WHAT IT EMITTED -- the React
// Native gradle plugin's own generated asset directory, hashed -- into
// `assets-manifest.json` beside the artifact, and a later cache hit compares
// what IT emitted against that. Apples to apples: same producer, same layout,
// same bytes, so a content change under an unchanged filename is caught
// exactly (issue #62), and no AAPT transformation is in the way.
//
// An entry with NO manifest cannot be proven and is never swapped. That is
// conservative on purpose: the cost is one gradle build, which also REPLACES
// the entry (storeBuild with overwrite) so the next run has a manifest.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// One emitted asset: its path relative to the asset root (the directory
// `--assets-dest` names, whose contents land under res/ in the APK), and the
// sha256 of the file as EMITTED, before AAPT ever sees it.
interface AssetManifestEntry {
  path: string;
  sha256: string;
}

// What is written beside the artifact. `version` is there so a later shape
// change can be recognised rather than mis-read: an unrecognised version reads
// as no manifest at all, which refuses the swap.
export interface AssetManifest {
  version: number;
  assets: AssetManifestEntry[];
}

export const ASSET_MANIFEST_VERSION = 1;

// The file the manifest is stored as inside a cache entry, beside the
// artifact and beside fingerprint-sources.json. artifactIn only ever matches
// .app/.apk, so this can never be mistaken for the artifact.
export const ASSET_MANIFEST_FILE = 'assets-manifest.json';

// How deep the asset tree is walked. `--assets-dest` writes
// `<root>/drawable-<qualifier>/<file>` and `<root>/raw/<file>`, so two levels
// is the real shape; the cap is what stops a symlink cycle from hanging a
// build that already succeeded.
const MAX_DEPTH = 4;

// PURE-ish (reads one file). The sha256 of a file's contents, or null when it
// cannot be read -- and an unreadable file makes the whole manifest null,
// because a manifest that silently omits an asset would let a changed one
// through the gate.
function hashFile(file: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Walk an emitted asset root into a manifest.
 *
 * `root` is the directory `--assets-dest` names: at BUILD time the React
 * Native gradle plugin's generated resource directory, at SWAP time the
 * staging `res` directory. Both are the same producer's output, which is what
 * makes the two sides comparable.
 *
 * Null when the directory does not exist (the caller stores no manifest) or
 * when a file inside it cannot be hashed (an incomplete manifest is worse
 * than none). An EXISTING but empty directory is a manifest with no assets --
 * a real and common answer for an app that requires no images.
 */
export function readAssetManifest(root: string): AssetManifest | null {
  if (!existsSync(root)) return null;
  const assets: AssetManifestEntry[] = [];
  let broken = false;
  const walk = (abs: string, rel: string, depth: number): void => {
    if (depth > MAX_DEPTH || broken) return;
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      broken = true;
      return;
    }
    for (const name of names) {
      const child = join(abs, name);
      let stat;
      try {
        stat = statSync(child);
      } catch {
        broken = true;
        return;
      }
      const path = rel === '' ? name : `${rel}/${name}`;
      if (stat.isDirectory()) {
        walk(child, path, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      const sha256 = hashFile(child);
      if (sha256 === null) {
        broken = true;
        return;
      }
      assets.push({ path, sha256 });
    }
  };
  walk(root, '', 0);
  if (broken) return null;
  assets.sort((a, b) => a.path.localeCompare(b.path));
  return { version: ASSET_MANIFEST_VERSION, assets };
}

// PURE. The JSON stored in a cache entry, read back as a manifest. Anything
// that is not a version this understands, with an assets array of the right
// shape, is null -- which the gate treats as "no manifest", never as "no
// assets".
export function parseAssetManifest(text: unknown): AssetManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    return null;
  }
  const obj = parsed as { version?: unknown; assets?: unknown } | null;
  if (!obj || obj.version !== ASSET_MANIFEST_VERSION || !Array.isArray(obj.assets)) return null;
  const assets: AssetManifestEntry[] = [];
  for (const raw of obj.assets) {
    const entry = raw as { path?: unknown; sha256?: unknown } | null;
    if (typeof entry?.path !== 'string' || typeof entry?.sha256 !== 'string') return null;
    assets.push({ path: entry.path, sha256: entry.sha256 });
  }
  return { version: ASSET_MANIFEST_VERSION, assets };
}

// --- where the build's emitted assets are ----------------------------------

// PURE. The generated-resource subdirectory a bundle task writes into, given
// the listing of `<module>/build/generated/res` and the variant being built.
//
// Two layouts, because both are in the wild:
//   createBundle<Variant>JsAndAssets/   react-native-gradle-plugin, RN 0.71+
//   react/<variant>/                    the older plugin
//
// The variant match is what keeps a debug run's leftovers out of a release
// entry: a tree that has built both carries BOTH directories forever.
export function pickGeneratedResDir(
  names: string[],
  variant: string | null,
  reactChildren: string[] = [],
): string | null {
  const wanted = (variant ?? '').trim().toLowerCase();
  const modern = names.filter((n) => /^createBundle.+JsAndAssets$/.test(n)).toSorted();
  if (wanted) {
    const match = modern.find((n) => n.toLowerCase() === `createbundle${wanted}jsandassets`);
    if (match) return match;
  } else if (modern.length === 1) {
    return modern[0]!;
  }
  if (!names.includes('react')) return null;
  const children = reactChildren.toSorted();
  if (wanted) {
    const match = children.find((n) => n.toLowerCase() === wanted);
    if (match) return `react/${match}`;
  } else if (children.length === 1) {
    return `react/${children[0]!}`;
  }
  return null;
}

// The gradle module the app is built from. engine/gradle.ts hardcodes `app`
// (AGP's own default, and what both `expo prebuild` and the RN template
// generate), so `app` is tried first; a project whose app module is named
// something else is found by looking for the one module that HAS a
// build/generated/res directory.
export function androidModuleDirs(
  root: string,
  { list = safeList }: { list?: (dir: string) => string[] } = {},
): string[] {
  const android = join(root, 'android');
  const others = list(android).filter(
    (name) => name !== 'app' && existsSync(join(android, name, 'build', 'generated', 'res')),
  );
  return ['app', ...others.toSorted()];
}

/**
 * The directory THIS build emitted its assets into, or null when none can be
 * identified. Null is a real answer: the caller stores no manifest, and an
 * entry with no manifest never swaps.
 */
export function findGeneratedResDir(
  root: string,
  variant: string | null,
  { list = safeList }: { list?: (dir: string) => string[] } = {},
): string | null {
  for (const module of androidModuleDirs(root, { list })) {
    const base = join(root, 'android', module, 'build', 'generated', 'res');
    const names = list(base);
    if (names.length === 0) continue;
    const picked = pickGeneratedResDir(names, variant, names.includes('react') ? list(join(base, 'react')) : []);
    if (picked) return join(base, ...picked.split('/'));
  }
  return null;
}

/**
 * The manifest for a build that just finished: find the bundle task's
 * generated resource directory and hash what is in it. Null when there is no
 * such directory (a debug build never runs the bundle task) or when it cannot
 * be read.
 */
export function captureAssetManifest(
  root: string,
  {
    variant = null,
    findDir = findGeneratedResDir,
    read = readAssetManifest,
  }: {
    variant?: string | null;
    findDir?: typeof findGeneratedResDir;
    read?: typeof readAssetManifest;
  } = {},
): AssetManifest | null {
  const dir = findDir(root, variant);
  return dir ? read(dir) : null;
}

// --- the comparison --------------------------------------------------------

// What the gate branches on. `same` is the verdict; the three lists are what
// the refusal note names.
export interface AssetManifestDiff {
  same: boolean;
  // Emitted now, not emitted by the build behind the cache entry. THE case
  // this gate exists for: the JS references it and the APK cannot serve it.
  added: string[];
  // Emitted by that build, not emitted now.
  removed: string[];
  // Same path, different bytes -- a REPLACED image under an unchanged
  // filename, which the names-only gate could not see (issue #62).
  changed: string[];
  // One path to print, so the fallback note says WHICH asset moved.
  example: string | null;
}

// PURE. The gate. Both sides are what React Native itself emitted, so the
// comparison is exact: identical path set AND identical sha256 per path, or
// no swap.
export function compareAssetManifests(fresh: AssetManifest, stored: AssetManifest): AssetManifestDiff {
  const left = new Map(fresh.assets.map((a) => [a.path, a.sha256]));
  const right = new Map(stored.assets.map((a) => [a.path, a.sha256]));
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [path, sha256] of left) {
    if (!right.has(path)) added.push(path);
    else if (right.get(path) !== sha256) changed.push(path);
  }
  for (const path of right.keys()) if (!left.has(path)) removed.push(path);
  added.sort();
  changed.sort();
  removed.sort();
  return {
    same: added.length === 0 && changed.length === 0 && removed.length === 0,
    added,
    removed,
    changed,
    example: added[0] ?? changed[0] ?? removed[0] ?? null,
  };
}

// PURE. The sentence a refusal prints: which way the sets differ, and one
// example so the note is actionable rather than merely true.
export function assetDiffReason(diff: AssetManifestDiff): string {
  const which = diff.added.length ? 'added' : diff.changed.length ? 'changed' : 'removed';
  return (
    `this workspace emits a different asset set than the cached build did ` +
    `(${diff.added.length} added, ${diff.changed.length} changed, ${diff.removed.length} removed; ` +
    `e.g. ${which} ${diff.example})`
  );
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
