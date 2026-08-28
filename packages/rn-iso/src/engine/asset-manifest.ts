import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface AssetManifestEntry {
  path: string;
  sha256: string;
}

export interface AssetManifest {
  version: number;
  assets: AssetManifestEntry[];
}

export const ASSET_MANIFEST_VERSION = 1;

export const ASSET_MANIFEST_FILE = 'assets-manifest.json';

const MAX_DEPTH = 4;

function hashFile(file: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

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

export interface AssetManifestDiff {
  same: boolean;
  added: string[];
  removed: string[];
  changed: string[];
  example: string | null;
}

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
