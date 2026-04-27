import { existsSync, readFileSync, readdirSync, realpathSync } from 'fs';
import { join, dirname, resolve } from 'path';

export function findProjectRoot(startDir) {
  let dir;
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

function readPackageJson(projectRoot) {
  const p = join(projectRoot, 'package.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

export function detectIsExpo(projectRoot) {
  const pkg = readPackageJson(projectRoot);
  if (!pkg) return false;
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  return 'expo' in deps;
}

function readAppJson(projectRoot) {
  const p = join(projectRoot, 'app.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function readAppConfigText(projectRoot) {
  for (const name of ['app.config.js', 'app.config.ts', 'app.config.cjs', 'app.config.mjs']) {
    const p = join(projectRoot, name);
    if (existsSync(p)) {
      try {
        return readFileSync(p, 'utf-8');
      } catch { /* ignore */ }
    }
  }
  return null;
}

export function detectBundleId(projectRoot) {
  const appJson = readAppJson(projectRoot);
  const fromJson = appJson?.expo?.ios?.bundleIdentifier;
  if (fromJson) return fromJson;

  const text = readAppConfigText(projectRoot);
  if (text) {
    const m = text.match(/bundleIdentifier\s*:\s*["']([^"']+)["']/);
    if (m) return m[1];
  }

  // Fallback: hybrid Expo / bare RN projects keep the bundle ID in the Xcode
  // project file rather than app config. Pick the most common concrete value
  // (the main app target appears in multiple build configs; extensions show up
  // less often) and tie-break by shortest length (extensions usually have a
  // suffix on the main app's id).
  return detectBundleIdFromPbxproj(projectRoot);
}

export function detectAndroidPackage(projectRoot) {
  const appJson = readAppJson(projectRoot);
  const fromJson = appJson?.expo?.android?.package;
  if (fromJson) return fromJson;

  const text = readAppConfigText(projectRoot);
  if (text) {
    const m = text.match(/package\s*:\s*["']([^"']+)["']/);
    if (m) return m[1];
  }

  // Fallback: bare RN keeps the package in android/app/build.gradle.
  return detectAndroidPackageFromGradle(projectRoot);
}

export function detectBundleIdFromPbxproj(projectRoot) {
  const iosDir = join(projectRoot, 'ios');
  if (!existsSync(iosDir)) return null;
  let entries;
  try {
    entries = readdirSync(iosDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith('.xcodeproj')) continue;
    const pbx = join(iosDir, entry.name, 'project.pbxproj');
    if (!existsSync(pbx)) continue;
    let text;
    try { text = readFileSync(pbx, 'utf-8'); } catch { continue; }
    const all = [...text.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;\s"]+)\s*;/g)].map(m => m[1]);
    const concrete = all.filter(id => id && !id.startsWith('$') && !id.includes('('));
    if (concrete.length === 0) continue;
    const counts = {};
    for (const id of concrete) counts[id] = (counts[id] || 0) + 1;
    let best = null, bestCount = 0, bestLen = Infinity;
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

export function detectAndroidPackageFromGradle(projectRoot) {
  const gradle = join(projectRoot, 'android', 'app', 'build.gradle');
  if (!existsSync(gradle)) return null;
  let text;
  try { text = readFileSync(gradle, 'utf-8'); } catch { return null; }
  // Try `namespace "com.foo"` (modern AGP) first, then fall back to
  // `applicationId "com.foo"`.
  const ns = text.match(/namespace\s+["']([^"']+)["']/);
  if (ns) return ns[1];
  const app = text.match(/applicationId\s+["']([^"']+)["']/);
  if (app) return app[1];
  return null;
}
