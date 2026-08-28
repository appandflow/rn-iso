import { existsSync, readFileSync, readdirSync, realpathSync } from 'fs';
import { createRequire } from 'module';
import { join, dirname, resolve } from 'path';
import { type ProjectRecord, loadConfig, findEnclosingWorktreeRoot, getProject } from './config.ts';

interface PackageJson {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

interface AnyJson {
  expo?: {
    ios?: { bundleIdentifier?: unknown };
    android?: { package?: unknown };
    [key: string]: unknown;
  };
  extra?: { eas?: unknown };
  [key: string]: unknown;
}

export interface ResolveResult {
  found: string | null;
  error?: string;
}

const requireFromHere = createRequire(import.meta.url);

export function resolvePackageJson(projectRoot: string, name: string): string | null {
  try {
    return requireFromHere.resolve(`${name}/package.json`, { paths: [projectRoot] });
  } catch {
    try {
      const main = requireFromHere.resolve(name, { paths: [projectRoot] });
      const marker = `/node_modules/${name}/`;
      const at = main.lastIndexOf(marker);
      if (at === -1) return null;
      const candidate = join(main.slice(0, at + marker.length), 'package.json');
      return existsSync(candidate) ? candidate : null;
    } catch {
      return null;
    }
  }
}

export function isPackageResolvable(projectRoot: string, name: string): boolean {
  return resolvePackageJson(projectRoot, name) !== null;
}

export function projectShortcut(path: string, proj: ProjectRecord | null | undefined): string {
  if (proj?.label) return proj.label;
  const rootPath = findEnclosingWorktreeRoot(path);
  if (rootPath && rootPath !== path) {
    const rootLabel = projectShortcut(rootPath, getProject(rootPath));
    const base = path.split('/').pop() || path;
    return `${rootLabel}/${base}`;
  }
  return path.split('/').pop() || path;
}

export function resolveRegisteredProject(arg?: string | null): ResolveResult {
  const cfg = loadConfig();
  const projects = cfg?.projects || {};

  if (!arg) {
    const root = findProjectRoot(process.cwd());
    if (!root) return { found: null, error: 'Not in a React Native project (no package.json found).' };
    if (!projects[root])
      return { found: null, error: `No rn-iso entry for ${root}. Run \`rn-iso start\` or \`rn-iso ios\` there first.` };
    return { found: root };
  }

  let abs: string;
  try {
    abs = realpathSync(resolve(arg));
  } catch {
    abs = resolve(arg);
  }
  if (projects[abs]) return { found: abs };
  if (projects[arg]) return { found: arg };

  const matches = Object.keys(projects).filter((p) => projectShortcut(p, projects[p]) === arg);
  if (matches.length === 1) {
    const only = matches[0];
    if (only !== undefined) return { found: only };
  }
  if (matches.length > 1) {
    return {
      found: null,
      error: `Multiple projects share the shortcut "${arg}": ${matches.join(', ')}. Pass the absolute path or set a unique --label.`,
    };
  }

  return {
    found: null,
    error: `No registered project matches "${arg}". See \`rn-iso status\` for the list.`,
  };
}

export function findProjectRoot(startDir: string): string | null {
  let dir: string;
  try {
    dir = realpathSync(resolve(startDir));
  } catch {
    dir = resolve(startDir);
  }
  while (true) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readPackageJson(projectRoot: string): PackageJson | null {
  const p = join(projectRoot, 'package.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

export function detectIsExpo(projectRoot: string): boolean {
  const pkg = readPackageJson(projectRoot);
  const iosScript = pkg?.scripts?.ios;
  if (typeof iosScript === 'string') {
    if (/\bexpo\s+run:ios\b/.test(iosScript)) return true;
    if (/\breact-native\s+run-ios\b/.test(iosScript)) return false;
  }
  if (!pkg) return false;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const hasExpoDep = 'expo' in deps;
  const resolvable = () => isPackageResolvable(projectRoot, 'expo');
  if (!hasExpoDep && !resolvable()) return false;

  const appJson = readAppJson(projectRoot);
  if (appJson?.expo) return true;
  const text = readAppConfigText(projectRoot);
  if (text && /\b(?:from\s+['"]expo['"]|expo\/config|ExpoConfig)\b/.test(text)) return true;
  if (hasExpoDep && resolvable()) return true;
  if (looksLikeExpoConfig(appJson)) return true;
  if (podfileUsesExpoModules(projectRoot)) return true;
  return false;
}

function looksLikeExpoConfig(appJson: AnyJson | null): boolean {
  if (!appJson || typeof appJson !== 'object' || Array.isArray(appJson)) return false;
  if (appJson.expo) return true;
  const keys = [
    'slug',
    'plugins',
    'sdkVersion',
    'experiments',
    'runtimeVersion',
    'updates',
    'buildCacheProvider',
    'assetBundlePatterns',
    'splash',
    'orientation',
    'userInterfaceStyle',
  ];
  if (keys.some((key) => appJson[key] !== undefined)) return true;
  return Boolean(appJson.extra && typeof appJson.extra === 'object' && appJson.extra.eas);
}

function podfileUsesExpoModules(projectRoot: string): boolean {
  const p = join(projectRoot, 'ios', 'Podfile');
  if (!existsSync(p)) return false;
  try {
    return /^[^#\n]*use_expo_modules!/m.test(readFileSync(p, 'utf-8'));
  } catch {
    return false;
  }
}

function readAppJson(projectRoot: string): AnyJson | null {
  const p = join(projectRoot, 'app.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function readAppConfigText(projectRoot: string): string | null {
  for (const name of ['app.config.js', 'app.config.ts', 'app.config.cjs', 'app.config.mjs']) {
    const p = join(projectRoot, name);
    if (existsSync(p)) {
      try {
        return readFileSync(p, 'utf-8');
      } catch {}
    }
  }
  return null;
}

export function detectBundleId(projectRoot: string): string | null {
  const appJson = readAppJson(projectRoot);
  const fromJson = appJson?.expo?.ios?.bundleIdentifier;
  if (typeof fromJson === 'string' && fromJson) return fromJson;

  const text = readAppConfigText(projectRoot);
  if (text) {
    const m = text.match(/bundleIdentifier\s*:\s*["']([^"']+)["']/);
    const id = m?.[1];
    if (id) return id;
  }

  return detectBundleIdFromPbxproj(projectRoot);
}

export function detectAndroidPackage(projectRoot: string): string | null {
  const appJson = readAppJson(projectRoot);
  const fromJson = appJson?.expo?.android?.package;
  if (typeof fromJson === 'string' && fromJson) return fromJson;

  const text = readAppConfigText(projectRoot);
  if (text) {
    const m = text.match(/package\s*:\s*["']([^"']+)["']/);
    const pkg = m?.[1];
    if (pkg) return pkg;
  }

  return detectAndroidPackageFromGradle(projectRoot);
}

function detectBundleIdFromPbxproj(projectRoot: string): string | null {
  const iosDir = join(projectRoot, 'ios');
  if (!existsSync(iosDir)) return null;
  let entries: import('fs').Dirent[];
  try {
    entries = readdirSync(iosDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith('.xcodeproj')) continue;
    const pbx = join(iosDir, entry.name, 'project.pbxproj');
    if (!existsSync(pbx)) continue;
    let text: string;
    try {
      text = readFileSync(pbx, 'utf-8');
    } catch {
      continue;
    }
    const all = [...text.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;\s"]+)\s*;/g)].map((m) => m[1]);
    const concrete = all.filter((id): id is string => !!id && !id.startsWith('$') && !id.includes('('));
    if (concrete.length === 0) continue;
    const counts: Record<string, number> = {};
    for (const id of concrete) counts[id] = (counts[id] || 0) + 1;
    let best: string | null = null,
      bestCount = 0,
      bestLen = Infinity;
    for (const [id, count] of Object.entries(counts)) {
      if (count > bestCount || (count === bestCount && id.length < bestLen)) {
        best = id;
        bestCount = count;
        bestLen = id.length;
      }
    }
    return best;
  }
  return null;
}

function detectAndroidPackageFromGradle(projectRoot: string): string | null {
  const gradle = join(projectRoot, 'android', 'app', 'build.gradle');
  if (!existsSync(gradle)) return null;
  let text: string;
  try {
    text = readFileSync(gradle, 'utf-8');
  } catch {
    return null;
  }
  const ns = text.match(/namespace\s+["']([^"']+)["']/);
  const nsId = ns?.[1];
  if (nsId) return nsId;
  const app = text.match(/applicationId\s+["']([^"']+)["']/);
  const appId = app?.[1];
  if (appId) return appId;
  return null;
}
