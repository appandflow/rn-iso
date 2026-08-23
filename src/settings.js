import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getProjectSettings, getRepoSettings } from './config.js';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// First layer wins. Nested plain objects merge key by key so a repo can set
// worktree.baseRef without erasing a committed worktree.install. Arrays are
// replaced wholesale: a partial override of a command pipeline would be
// meaningless.
export function mergeSettingsLayers(layers) {
  const out = {};
  for (const layer of layers) {
    if (!isPlainObject(layer)) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (isPlainObject(value) && isPlainObject(out[key])) {
        out[key] = mergeSettingsLayers([out[key], value]);
      } else if (!(key in out)) {
        out[key] = value;
      }
    }
  }
  return out;
}

// Every setting rn-iso actually reads. Kept next to the resolver so deleting a
// feature forces a decision about its setting: a key that quietly stops being
// honoured is worse than one that errors. A committed `worktree.install`
// silently became a no-op in 0.9.0 and the only symptom was a worktree with no
// dependencies.
const KNOWN_SETTINGS = new Set([
  'ios.deviceType',
  'ios.runtime',
  'android.systemImage',
  'worktreeDir',
  'worktree.baseRef',
  'worktree.include',
  'worktree.exclude',
]);

// Returns dotted paths for keys rn-iso does not read. Leaf-level: a known
// parent with an unknown child reports only the child.
export function unknownSettingKeys(settings, prefix = '') {
  if (!isPlainObject(settings)) return [];
  const unknown = [];
  for (const [key, value] of Object.entries(settings)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) {
      // Only recurse into a namespace we know; an entirely unknown object is
      // reported once rather than leaf by leaf.
      const hasKnownChildren = [...KNOWN_SETTINGS].some(k => k.startsWith(`${path}.`));
      if (hasKnownChildren) unknown.push(...unknownSettingKeys(value, path));
      else unknown.push(path);
      continue;
    }
    if (!KNOWN_SETTINGS.has(path)) unknown.push(path);
  }
  return unknown;
}

export function readCommittedSettings(repoRoot) {
  if (!repoRoot) return {};
  const p = join(repoRoot, '.rn-iso.json');
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    // A malformed committed file must not break every command. Callers that
    // care can surface it; resolution treats it as absent.
    return {};
  }
}

export function resolveSettings({ projectPath, gitCommonDir, repoRoot }) {
  return mergeSettingsLayers([
    projectPath ? getProjectSettings(projectPath) : null,
    gitCommonDir ? getRepoSettings(gitCommonDir) : null,
    readCommittedSettings(repoRoot),
  ]);
}
