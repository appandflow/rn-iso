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
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import * as expoFingerprint from '@expo/fingerprint';
import type { Fingerprint, FingerprintSource, Options as FingerprintOptions } from '@expo/fingerprint';
import { buildCacheKey as coreBuildCacheKey } from '@rn-iso/core';
import { getExecutor } from './exec.ts';
import { register } from './cache-manifest.ts';
import { ASSET_MANIFEST_FILE, parseAssetManifest, type AssetManifest } from './engine/asset-manifest.ts';
import { sharedBuildCache } from './paths.ts';

// The run-options bag Expo hands a build cache provider. Only the fields this
// module reads are named -- an unfamiliar CLI version adding one must not
// change the key (see buildCacheKey below).
export interface BuildRunOptions {
  variant?: string;
  configuration?: string;
  buildConfiguration?: string;
  isSimulator?: boolean;
  device?: string | boolean | null;
}

// One line, but the one that decides whether the CLI and the provider address
// the same entries at all: src/paths.js owns the resolution, and
// packages/expo-build-cache/index.js repeats it because it must run with no
// rn-iso installed. See the note above sharedBuildCache.
export function cacheRoot(): string {
  return sharedBuildCache();
}

export function entryDir(platform: string, key: string, root: string = cacheRoot()): string {
  return join(root, platform, key);
}

// The fingerprint covers what the project IS, never how it was built. Keying on
// it alone means a Release build answers a Debug resolve, and a device build
// answers a simulator one -- both silently, both producing a binary that cannot
// run. `options` is the run-options object Expo hands a build cache provider;
// only the keys named here are read, so an unfamiliar CLI version cannot change
// the key by adding one.
export function buildCacheKey(platform: string, fingerprintHash: string, options: unknown = {}): string {
  return coreBuildCacheKey(platform, fingerprintHash, options);
}

// The artifact is the single .app / .apk inside an entry directory.
export function artifactIn(dir: string): string | null {
  if (!existsSync(dir)) return null;
  let found;
  try {
    found = readdirSync(dir).find((f) => f.endsWith('.app') || f.endsWith('.apk'));
  } catch {
    return null;
  }
  return found ? join(dir, found) : null;
}

// What fingerprintProject returns: the hash that keys the cache, plus the
// sources it was computed from -- the half that can explain a MISS.
export type ProjectFingerprint = Fingerprint;

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
 * Returns the SOURCES alongside the hash: createFingerprintAsync computes both
 * anyway, and the sources are what can say WHY two hashes differ. Callers that
 * only want the key read `.hash` and ignore the rest.
 *
 * `createFingerprint` is injected only so option threading is testable without
 * hashing a real project. Production calls the declared dependency directly.
 */
export async function fingerprintProject(
  projectRoot: string,
  {
    platform,
    createFingerprint = expoFingerprint.createFingerprintAsync,
  }: { platform?: string; createFingerprint?: typeof expoFingerprint.createFingerprintAsync } = {},
): Promise<ProjectFingerprint | null> {
  const options: FingerprintOptions | undefined =
    platform && FINGERPRINT_PLATFORMS.has(platform)
      ? { platforms: [platform] as FingerprintOptions['platforms'] }
      : undefined;
  const result = await createFingerprint(projectRoot, options);
  const hash = result?.hash ?? null;
  if (!hash) return null;
  const sources = Array.isArray(result?.sources) ? (result.sources as FingerprintSource[]) : [];
  return { hash, sources };
}

// Registration is what makes an entry visible to `gc`'s report, and every entry
// is an independent directory, so old ones can be trimmed individually. The
// entries sit two levels down -- <root>/<platform>/<key> -- so gc must be told
// that, or it treats ios/ and android/ as the entries and one removal takes a
// whole platform.
function registerOnce(root: string): void {
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

export function resolveBuild(platform: string, key: string, root: string = cacheRoot()): string | null {
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
// `sources` rides along when the caller has them: the fingerprint's sources
// array is stored beside the artifact (SOURCES_FILE) so a later MISS can be
// diffed against the entry the workspace last installed. Written into the
// staging directory, so it lands atomically with the artifact or not at all.
//
// `assetManifest` rides along the same way and for the same kind of reason:
// it is what the build EMITTED (engine/asset-manifest.ts), stored as
// ASSET_MANIFEST_FILE so a later release cache HIT can prove its own emitted
// assets are byte-identical before re-packing this artifact. One mechanism,
// two files -- both staged, both optional, neither able to fail the store.
export function storeBuild(
  platform: string,
  key: string,
  buildPath: string,
  rootOrOptions:
    | string
    | {
        root?: string;
        overwrite?: boolean;
        sources?: FingerprintSource[] | null;
        assetManifest?: AssetManifest | null;
      } = {},
): string | null {
  const options = typeof rootOrOptions === 'string' ? { root: rootOrOptions } : rootOrOptions || {};
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
  // -c asks APFS for a copy-on-write clone: storing a several-hundred-MB
  // .app costs milliseconds instead of seconds when the cache shares the
  // artifact's volume. It errors on non-APFS or across volumes, where the
  // plain copy is the correct price.
  try {
    getExecutor().runFile('cp', ['-c', '-R', buildPath, join(staging, basename(buildPath))]);
  } catch {
    getExecutor().runFile('cp', ['-R', buildPath, join(staging, basename(buildPath))]);
  }

  if (Array.isArray(options.sources)) {
    try {
      writeFileSync(join(staging, SOURCES_FILE), JSON.stringify(options.sources));
    } catch {
      // The artifact is the entry; the sources file only enriches a later
      // miss's diagnosis, and failing to write it must not fail the store.
    }
  }

  if (options.assetManifest) {
    try {
      writeFileSync(join(staging, ASSET_MANIFEST_FILE), JSON.stringify(options.assetManifest));
    } catch {
      // Contained like the sources file. An entry with no manifest simply
      // never swaps -- the conservative outcome, and the same one a build
      // that emitted no assets at all produces.
    }
  }

  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  renameSync(staging, dest);
  return artifactIn(dest);
}

// --- explaining a MISS ------------------------------------------------------
//
// A cache miss says only "the hash changed". The sources stored beside each
// entry (SOURCES_FILE, written by storeBuild above) are what can say WHICH
// native inputs moved -- diffed against the current run's sources with rn-iso's
// declared @expo/fingerprint, with a plain per-path comparison if its diff
// cannot interpret an older stored entry.

// The sources JSON stored beside the artifact in an entry directory.
// artifactIn above only ever matches .app/.apk, so this file can never be
// mistaken for the artifact.
const SOURCES_FILE = 'fingerprint-sources.json';

// The stored sources of an entry, or null when the entry has none (it predates
// this file, was stored by the Expo provider, or the JSON is unreadable).
export function storedSources(platform: string, key: string, root: string = cacheRoot()): FingerprintSource[] | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(entryDir(platform, key, root), SOURCES_FILE), 'utf-8'));
    return Array.isArray(parsed) ? (parsed as FingerprintSource[]) : null;
  } catch {
    return null;
  }
}

// The asset manifest stored beside the artifact, or null when the entry has
// none (it predates asset tracking, was stored by the Expo provider, was
// stored from a build that emitted no asset tree, or the JSON is unreadable).
// The release asset gate refuses to swap on null -- see
// engine/asset-manifest.ts.
export function storedAssetManifest(platform: string, key: string, root: string = cacheRoot()): AssetManifest | null {
  try {
    return parseAssetManifest(readFileSync(join(entryDir(platform, key, root), ASSET_MANIFEST_FILE), 'utf-8'));
  } catch {
    return null;
  }
}

// PURE. The name a source is reported by: filePath for file/dir sources, id
// for contents sources. Null for a shape this does not recognise.
function sourceName(source: unknown): string | null {
  const s = source as Record<string, unknown> | null | undefined;
  if (typeof s?.filePath === 'string' && s.filePath !== '') return s.filePath;
  if (typeof s?.id === 'string' && s.id !== '') return s.id;
  return null;
}

// PURE. The name a diffFingerprints item is about. Current versions return
// { op, addedSource | removedSource | beforeSource/afterSource }; accepting a
// source directly also keeps older cache metadata readable after an upgrade.
function diffItemName(item: unknown): string | null {
  const o = item as Record<string, unknown> | null | undefined;
  for (const candidate of [o, o?.addedSource, o?.removedSource, o?.afterSource, o?.beforeSource]) {
    const name = sourceName(candidate);
    if (name) return name;
  }
  return null;
}

// PURE fallback: the per-name hash comparison of two sources arrays. Reports
// changed and added names in the current list's order, then names the previous
// list had that are now gone.
export function compareSourceLists(previous: unknown[], current: unknown[]): string[] {
  const previousByName = new Map<string, string | null>();
  for (const source of previous) {
    const name = sourceName(source);
    if (name !== null) previousByName.set(name, ((source as Record<string, unknown>).hash as string | null) ?? null);
  }
  const changed: string[] = [];
  const seen = new Set<string>();
  for (const source of current) {
    const name = sourceName(source);
    if (name === null || seen.has(name)) continue;
    seen.add(name);
    const hash = (source as Record<string, unknown>).hash;
    if (!previousByName.has(name) || previousByName.get(name) !== (hash ?? null)) changed.push(name);
  }
  for (const [name] of previousByName) {
    if (!seen.has(name)) changed.push(name);
  }
  return changed;
}

// The changed-source names between two fingerprints: the project's own
// diffFingerprints when the module has one (its verdict matches what its
// createFingerprintAsync hashed), the plain comparison otherwise -- or when
// the project's diff throws or returns a shape this cannot read.
export function diffFingerprintSources({
  previous,
  previousHash = null,
  current,
  differ = null,
}: {
  previous: FingerprintSource[];
  previousHash?: string | null;
  current: ProjectFingerprint;
  differ?: typeof expoFingerprint.diffFingerprints | null;
}): string[] {
  if (typeof differ === 'function') {
    try {
      const items = differ(
        { sources: previous, hash: previousHash ?? '' },
        { sources: current.sources, hash: current.hash },
      );
      if (Array.isArray(items)) {
        const names: string[] = [];
        const seen = new Set<string>();
        for (const item of items) {
          const name = diffItemName(item);
          if (name !== null && !seen.has(name)) {
            seen.add(name);
            names.push(name);
          }
        }
        return names;
      }
    } catch {
      // Fall through to the plain comparison.
    }
  }
  return compareSourceLists(previous, current.sources);
}

// PURE. The suffix appended to the `fingerprint <hash> miss` phase line. Three
// names at most -- the line has to stay a line; the full list goes to the
// build log.
export function fingerprintDiffSuffix(changed: string[]): string {
  if (!changed.length) return '';
  const shown = changed.slice(0, 3).join(', ');
  return ` -- ${changed.length} source${changed.length === 1 ? '' : 's'} changed: ${shown}`;
}

// What a MISS can say about itself, given the workspace's previous build
// (state.json.lastBuild). Null whenever there is nothing true to say: no
// previous build on this platform, the same fingerprint (the entry was
// trimmed, not changed), no stored sources for the previous entry, or a diff
// that comes back empty.
export function describeFingerprintMiss({
  platform,
  current,
  lastBuild,
  root = cacheRoot(),
  differ = expoFingerprint.diffFingerprints,
}: {
  platform: string;
  current: ProjectFingerprint;
  lastBuild: Record<string, unknown> | null | undefined;
  root?: string;
  differ?: typeof expoFingerprint.diffFingerprints | null;
}): { changed: string[]; previousHash: string } | null {
  if (!lastBuild || lastBuild.platform !== platform) return null;
  const previousHash = typeof lastBuild.fingerprint === 'string' ? lastBuild.fingerprint : null;
  const previousKey = typeof lastBuild.cacheKey === 'string' ? lastBuild.cacheKey : null;
  if (!previousHash || !previousKey || previousHash === current.hash) return null;
  const previous = storedSources(platform, previousKey, root);
  if (!previous) return null;
  const changed = diffFingerprintSources({ previous, previousHash, current, differ });
  return changed.length ? { changed, previousHash } : null;
}

/**
 * Recompute the fingerprint AFTER the steps that rewrite fingerprinted inputs.
 *
 * `expo prebuild` generates ios/ or android/ and rewrites package.json's
 * scripts and the app config; `pod install` writes ios/Podfile.lock. All three
 * are fingerprint SOURCES, so the hash computed before them is not the hash the
 * tree has afterwards -- and a build stored under the pre-mutation key is an
 * entry no later run in that tree will ever look up. Rock's buildApp.ts does
 * the same thing for the same reason ("After installing pods the fingerprint
 * likely changes... update the artifact name to reflect the new fingerprint").
 *
 * The PRE-mutation hash stays the lookup key -- it is what the tree computed
 * when the run started -- and this is only ever used to decide what the
 * artifact is STORED as. Null when the recompute could not be made (the
 * declared fingerprinter threw): the caller keeps the key it has, which is
 * exactly the old behaviour.
 */
export async function refingerprintAfterMutation({
  projectRoot,
  platform,
  previousHash,
  fingerprint = fingerprintProject,
}: {
  projectRoot: string;
  platform: string;
  previousHash: string;
  fingerprint?: typeof fingerprintProject;
}): Promise<(ProjectFingerprint & { moved: boolean }) | null> {
  let computed: ProjectFingerprint | null = null;
  try {
    computed = await fingerprint(projectRoot, { platform });
  } catch {
    return null;
  }
  if (!computed?.hash) return null;
  return { hash: computed.hash, sources: computed.sources, moved: computed.hash !== previousHash };
}

// --- a MISS with nothing to diff against ----------------------------------
//
// describeFingerprintMiss needs a PREVIOUS entry; the first miss in a
// workspace has none, and that is exactly the miss an agent cannot explain.
// What can still be said is which files under the native directories git does
// not know about: an untracked file there is hashed like any other source, so
// a leftover build script, a copied Podfile.lock or an editor scratch file
// under ios/ moves the key on this machine and nowhere else. Read-only, and
// silent whenever it cannot answer (no git, not a repo, nothing untracked).

// Three names, the same cap fingerprintDiffSuffix uses: the line has to stay a
// line.
export const UNTRACKED_MISS_CAP = 3;

export function untrackedNativeFiles({
  projectRoot,
  exec = getExecutor(),
}: {
  projectRoot: string;
  exec?: { runFile: (file: string, args?: string[]) => string };
}): string[] {
  let out: string;
  try {
    // runFile, not run: projectRoot is a path the user chose, and a space in
    // it must reach git as one argument. `--exclude-standard` is what makes
    // this "untracked and NOT gitignored" -- a build directory git already
    // ignores is not news.
    out = exec.runFile('git', [
      '-C',
      projectRoot,
      'ls-files',
      '--others',
      '--exclude-standard',
      '--',
      'ios',
      'android',
    ]);
  } catch {
    // Not a repo, no git on PATH, an unreadable index: all of them mean this
    // diagnostic has nothing to say, and none of them is worth a word.
    return [];
  }
  return String(out || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

// PURE. The one line the miss reports when there was nothing to diff. Null
// when there is nothing to say.
export function untrackedMissLine(files: string[], cap: number = UNTRACKED_MISS_CAP): string | null {
  if (!Array.isArray(files) || files.length === 0) return null;
  const shown = files.slice(0, cap);
  const more = files.length > shown.length ? `, and ${files.length - shown.length} more` : '';
  return (
    `no previous entry to diff against; ${files.length} untracked file${files.length === 1 ? '' : 's'} ` +
    `under ios/ or android/ are hashed like any other source: ${shown.join(', ')}${more}` +
    ' -- list the build-irrelevant ones in .fingerprintignore'
  );
}

// How many changed-source names the build-log record carries. The stored
// sources file in the entry dir is the full-depth record; the log line is a
// summary, and an unbounded list would make one edit to a vendored SDK write
// thousands of paths into every miss.
export const FINGERPRINT_DIFF_LOG_CAP = 20;

// PURE. The Contract-1 record `ios`/`android` write on a diagnosed miss:
// the total count, plus at most FINGERPRINT_DIFF_LOG_CAP names.
export function fingerprintDiffRecord({
  changed,
  previousHash,
  hash,
}: {
  changed: string[];
  previousHash: string;
  hash: string;
}): Record<string, unknown> {
  const shown = changed.slice(0, FINGERPRINT_DIFF_LOG_CAP);
  return {
    src: 'build',
    level: 'info',
    event: 'fingerprint_diff',
    msg:
      `fingerprint ${previousHash} -> ${hash}: ${changed.length} source${changed.length === 1 ? '' : 's'} changed: ` +
      shown.join(', ') +
      (changed.length > shown.length ? `, and ${changed.length - shown.length} more` : ''),
    changed: changed.length,
    sources: shown,
  };
}
