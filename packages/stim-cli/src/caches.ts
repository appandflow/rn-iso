import { existsSync, readdirSync, realpathSync, rmSync, statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { isAbsolute, join, relative, resolve } from 'path';
import { directorySize } from './fs-util.ts';
import { registeredCaches } from './cache-manifest.ts';
import { findProjectRoot } from './project.ts';
import { resolveSettings } from './settings.ts';
import { gitCommonDir, repoRoot } from './worktree.ts';

export interface CacheDescriptor {
  name: string;
  dir: string;
  prune: 'atomic' | 'entries' | 'report-only';
  note: string;
  entriesDepth?: number;
  files?: string[];
  bytes?: number;
  source?: 'registered' | 'detected';
}

function xcodeDerivedDataRoot(): string {
  return join(homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');
}

function compilationCache(): CacheDescriptor | null {
  const dir = join(xcodeDerivedDataRoot(), 'CompilationCache.noindex');
  if (!existsSync(dir)) return null;
  return {
    name: 'Xcode compilation cache',
    dir,
    prune: 'atomic',
    note: 'index-backed, so it can only be emptied whole',
  };
}

function gradleBuildCache(): CacheDescriptor | null {
  const gradleHome = process.env.GRADLE_USER_HOME || join(homedir(), '.gradle');
  const dir = resolve(gradleHome, 'caches', 'build-cache-1');
  if (!existsSync(dir)) return null;
  return {
    name: 'Gradle build cache',
    dir,
    prune: 'report-only',
    note: 'shared with every Gradle build; report only, never pruned or emptied by stim-cli',
  };
}

function metroFileMaps(): CacheDescriptor | null {
  const root = tmpdir();
  if (!existsSync(root)) return null;
  let names;
  try {
    names = readdirSync(root).filter((n) => n.startsWith('metro-file-map-'));
  } catch {
    return null;
  }
  if (!names.length) return null;
  let bytes = 0;
  for (const n of names) {
    try {
      bytes += statSync(join(root, n)).size;
    } catch {}
  }
  return {
    name: 'Metro file maps',
    dir: root,
    files: names.map((n) => join(root, n)),
    bytes,
    prune: 'entries',
    note: `${names.length} file(s), one per project root Metro has served`,
  };
}

function declaredCaches(paths: string[]): CacheDescriptor[] {
  return (paths || [])
    .map((p) => resolve(p.startsWith('~') ? join(homedir(), p.slice(1)) : p))
    .filter((p) => existsSync(p))
    .map((dir): CacheDescriptor => ({ name: 'declared', dir, prune: 'entries', note: 'from the `caches` setting' }));
}

export function declaredCachePaths(cwd: string = process.cwd()): string[] {
  const root = findProjectRoot(cwd);
  if (!root) return [];
  const settings = resolveSettings({
    projectPath: root,
    gitCommonDir: gitCommonDir(root),
    repoRoot: repoRoot(root),
  });
  return Array.isArray(settings?.caches) ? (settings.caches as string[]) : [];
}

export function discoverCaches({ declared = [] }: { declared?: string[] } = {}): CacheDescriptor[] {
  const gradle = gradleBuildCache();
  const gradleDir = gradle ? canonicalCacheDir(gradle.dir) : null;
  const registered = registeredCaches().map((c): CacheDescriptor =>
    Object.assign({}, c, {
      name: c.name ?? c.dir,
      note: c.note ?? 'registered',
      prune: c.prune,
      source: 'registered' as const,
    }),
  );
  const detected = [compilationCache(), gradle, metroFileMaps(), ...declaredCaches(declared)]
    .filter((c): c is CacheDescriptor => Boolean(c))
    .map((c): CacheDescriptor => Object.assign({}, c, { source: 'detected' as const }));
  return mergeCacheDescriptors([...registered, ...detected], gradleDir);
}

function mergeCacheDescriptors(caches: CacheDescriptor[], gradleDir: string | null): CacheDescriptor[] {
  const merged: CacheDescriptor[] = [];
  for (const cache of caches) {
    const descriptor = protectGradleCache(cache, gradleDir);
    const dir = canonicalCacheDir(descriptor.dir);
    const exact = merged.findIndex((candidate) => canonicalCacheDir(candidate.dir) === dir);
    if (exact !== -1) {
      const current = merged[exact] as CacheDescriptor;
      if (pruneStrength(descriptor.prune) > pruneStrength(current.prune)) {
        merged[exact] = Object.assign({}, current, { prune: descriptor.prune, note: descriptor.note });
      }
      continue;
    }

    if (gradleDir && isGradleProtectedDescriptor(descriptor, gradleDir)) {
      const protectedAncestor = merged.some((candidate) => {
        const candidateDir = canonicalCacheDir(candidate.dir);
        return isGradleProtectedDescriptor(candidate, gradleDir) && cachePathContains(candidateDir, dir);
      });
      if (protectedAncestor) continue;
      for (let i = merged.length - 1; i >= 0; i--) {
        const candidate = merged[i] as CacheDescriptor;
        const candidateDir = canonicalCacheDir(candidate.dir);
        if (isGradleProtectedDescriptor(candidate, gradleDir) && cachePathContains(dir, candidateDir)) {
          merged.splice(i, 1);
        }
      }
    }
    merged.push(descriptor);
  }
  return merged;
}

function protectGradleCache(cache: CacheDescriptor, gradleDir: string | null): CacheDescriptor {
  if (cache.files) return cache;
  if (!gradleDir || !cachePathsOverlap(canonicalCacheDir(cache.dir), gradleDir)) return cache;
  return Object.assign({}, cache, {
    prune: 'report-only' as const,
    note: 'shared with every Gradle build; report only, never pruned or emptied by stim-cli',
  });
}

function isGradleProtectedDescriptor(cache: CacheDescriptor, gradleDir: string): boolean {
  return cache.prune === 'report-only' && cachePathsOverlap(canonicalCacheDir(cache.dir), gradleDir);
}

function pruneStrength(prune: CacheDescriptor['prune']): number {
  if (prune === 'report-only') return 3;
  if (prune === 'atomic') return 2;
  return 1;
}

function cachePathsOverlap(left: string, right: string): boolean {
  return cachePathContains(left, right) || cachePathContains(right, left);
}

function cachePathContains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function canonicalCacheDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

export function sizeCaches(caches: CacheDescriptor[]): CacheDescriptor[] {
  return caches.map((c) =>
    Object.assign({}, c, {
      bytes: c.bytes ?? directorySize(c.dir),
    }),
  );
}

export function pruneCache(
  cache: CacheDescriptor,
  { olderThanDays, now = Date.now() }: { olderThanDays?: number; now?: number } = {},
): { removed: number; bytes: number; skipped: string | null } {
  const cutoff = now - (olderThanDays as number) * 24 * 60 * 60 * 1000;

  if (cache.prune === 'report-only') {
    return { removed: 0, bytes: 0, skipped: 'report-only shared cache; stim-cli never deletes it' };
  }

  if (cache.prune === 'atomic') {
    return { removed: 0, bytes: 0, skipped: 'index-backed; empty it whole or not at all' };
  }

  const entries = cache.files ?? entriesAtDepth(cache.dir, cache.entriesDepth ?? 1);
  let removed = 0;
  let bytes = 0;
  for (const entry of entries) {
    let used;
    let size;
    try {
      const st = statSync(entry);
      used = Math.max(st.atimeMs, st.mtimeMs);
      size = st.isDirectory() ? directorySize(entry) : st.size;
    } catch {
      continue;
    }
    if (used >= cutoff) continue;
    try {
      rmSync(entry, { recursive: true, force: true });
      removed++;
      bytes += size;
    } catch {}
  }
  return { removed, bytes, skipped: null };
}

function entriesAtDepth(dir: string, depth: number): string[] {
  let level = [dir];
  for (let i = 0; i < depth; i++) {
    const next: string[] = [];
    for (const parent of level) {
      let names;
      try {
        names = readdirSync(parent);
      } catch {
        continue;
      }
      for (const name of names) next.push(join(parent, name));
    }
    level = next;
  }
  return level;
}
