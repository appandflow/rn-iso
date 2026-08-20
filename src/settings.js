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
