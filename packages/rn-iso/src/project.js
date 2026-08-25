import { existsSync, readFileSync, readdirSync, realpathSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { loadConfig, findEnclosingWorktreeRoot, getProject } from './config.js';

// A project's "shortcut": its `label` field if set, else derived from the
// enclosing worktree's label (if this path lives inside a registered
// worktree), else the path basename.
//
// The worktree-inherited form matters because every worktree of a monorepo
// has app dirs sharing the same basename (every worktree's mobile app is
// "tlon-mobile"), so a bare basename shortcut would collide across
// worktrees. Deriving from the worktree label instead keeps shortcuts
// unique: "<worktreeLabel>/<basename>".
export function projectShortcut(path, proj) {
  if (proj?.label) return proj.label;
  const rootPath = findEnclosingWorktreeRoot(path);
  if (rootPath && rootPath !== path) {
    const rootLabel = projectShortcut(rootPath, getProject(rootPath));
    const base = path.split('/').pop() || path;
    return `${rootLabel}/${base}`;
  }
  return path.split('/').pop() || path;
}

// Resolve a project from one of three forms:
//   - undefined / null  -> walk up from cwd
//   - absolute / relative path matching a registered project key
//   - a shortcut (label or path basename) that uniquely identifies a project
//
// Basename matching errors out on collision (multiple projects share the
// basename) -- set a `--label` on one of them via `rn-iso worktree create`
// to disambiguate.
//
// Returns { found, error }.
export function resolveRegisteredProject(arg) {
  const cfg = loadConfig();
  const projects = cfg?.projects || {};

  if (!arg) {
    const root = findProjectRoot(process.cwd());
    if (!root) return { found: null, error: 'Not in a React Native project (no package.json found).' };
    if (!projects[root]) return { found: null, error: `No rn-iso entry for ${root}. Run \`rn-iso start\` or \`rn-iso ios\` there first.` };
    return { found: root };
  }

  // Exact path match. realpath() canonicalizes symlinks the same way
  // findProjectRoot does, so the keys line up.
  let abs;
  try { abs = realpathSync(resolve(arg)); } catch { abs = resolve(arg); }
  if (projects[abs]) return { found: abs };
  if (projects[arg]) return { found: arg };

  // Shortcut match (label or basename).
  const matches = Object.keys(projects).filter(p => projectShortcut(p, projects[p]) === arg);
  if (matches.length === 1) return { found: matches[0] };
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
  // The `expo` package can be in deps for prebuild / config / modules without
  // the project actually using `expo run:ios`. The strongest signal is what the
  // project's `ios` script invokes -- check that first.
  const iosScript = readPackageJson(projectRoot)?.scripts?.ios;
  if (typeof iosScript === 'string') {
    if (/\bexpo\s+run:ios\b/.test(iosScript)) return true;
    if (/\breact-native\s+run-ios\b/.test(iosScript)) return false;
  }
  // No conclusive script. Require `expo` in deps AND an expo config block to
  // be reasonably sure expo run:ios is appropriate as a fallback.
  const pkg = readPackageJson(projectRoot);
  if (!pkg) return false;
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (!('expo' in deps)) return false;
  const appJson = readAppJson(projectRoot);
  if (appJson?.expo) return true;
  const text = readAppConfigText(projectRoot);
  if (text && /\b(?:from\s+['"]expo['"]|expo\/config|ExpoConfig)\b/.test(text)) return true;
  return false;
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
