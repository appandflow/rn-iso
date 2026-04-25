import { existsSync, readFileSync, realpathSync } from 'fs';
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
  return null;
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
  return null;
}
