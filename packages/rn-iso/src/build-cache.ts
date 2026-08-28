import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import * as expoFingerprint from '@expo/fingerprint';
import type { Fingerprint, FingerprintSource, Options as FingerprintOptions } from '@expo/fingerprint';
import { buildCacheKey as coreBuildCacheKey } from '@rn-iso/core';
import { getExecutor } from './exec.ts';
import { register } from './cache-manifest.ts';
import { ASSET_MANIFEST_FILE, parseAssetManifest, type AssetManifest } from './engine/asset-manifest.ts';
import { sharedBuildCache } from './paths.ts';

export interface BuildRunOptions {
  variant?: string;
  configuration?: string;
  buildConfiguration?: string;
  isSimulator?: boolean;
  device?: string | boolean | null;
}

export function cacheRoot(): string {
  return sharedBuildCache();
}

export function entryDir(platform: string, key: string, root: string = cacheRoot()): string {
  return join(root, platform, key);
}

export function buildCacheKey(platform: string, fingerprintHash: string, options: unknown = {}): string {
  return coreBuildCacheKey(platform, fingerprintHash, options);
}

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

export type ProjectFingerprint = Fingerprint;

const FINGERPRINT_PLATFORMS = new Set(['ios', 'android']);

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

function registerOnce(root: string): void {
  try {
    register({
      dir: root,
      name: 'Build cache',
      prune: 'entries',
      entriesDepth: 2,
      note: 'built .app/.apk keyed on the native fingerprint',
    });
  } catch {}
}

export function resolveBuild(platform: string, key: string, root: string = cacheRoot()): string | null {
  const hit = artifactIn(entryDir(platform, key, root));
  if (!hit) return null;
  try {
    utimesSync(dirname(hit), new Date(), new Date());
  } catch {}
  return hit;
}

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

  const staging = `${dest}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    getExecutor().runFile('cp', ['-c', '-R', buildPath, join(staging, basename(buildPath))]);
  } catch {
    getExecutor().runFile('cp', ['-R', buildPath, join(staging, basename(buildPath))]);
  }

  if (Array.isArray(options.sources)) {
    try {
      writeFileSync(join(staging, SOURCES_FILE), JSON.stringify(options.sources));
    } catch {}
  }

  if (options.assetManifest) {
    try {
      writeFileSync(join(staging, ASSET_MANIFEST_FILE), JSON.stringify(options.assetManifest));
    } catch {}
  }

  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  renameSync(staging, dest);
  return artifactIn(dest);
}

const SOURCES_FILE = 'fingerprint-sources.json';

export function storedSources(platform: string, key: string, root: string = cacheRoot()): FingerprintSource[] | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(entryDir(platform, key, root), SOURCES_FILE), 'utf-8'));
    return Array.isArray(parsed) ? (parsed as FingerprintSource[]) : null;
  } catch {
    return null;
  }
}

export function storedAssetManifest(platform: string, key: string, root: string = cacheRoot()): AssetManifest | null {
  try {
    return parseAssetManifest(readFileSync(join(entryDir(platform, key, root), ASSET_MANIFEST_FILE), 'utf-8'));
  } catch {
    return null;
  }
}

function sourceName(source: unknown): string | null {
  const s = source as Record<string, unknown> | null | undefined;
  if (typeof s?.filePath === 'string' && s.filePath !== '') return s.filePath;
  if (typeof s?.id === 'string' && s.id !== '') return s.id;
  return null;
}

function diffItemName(item: unknown): string | null {
  const o = item as Record<string, unknown> | null | undefined;
  for (const candidate of [o, o?.addedSource, o?.removedSource, o?.afterSource, o?.beforeSource]) {
    const name = sourceName(candidate);
    if (name) return name;
  }
  return null;
}

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
    } catch {}
  }
  return compareSourceLists(previous, current.sources);
}

export function fingerprintDiffSuffix(changed: string[]): string {
  if (!changed.length) return '';
  const shown = changed.slice(0, 3).join(', ');
  return ` -- ${changed.length} source${changed.length === 1 ? '' : 's'} changed: ${shown}`;
}

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
    return [];
  }
  return String(out || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

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

export const FINGERPRINT_DIFF_LOG_CAP = 20;

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
