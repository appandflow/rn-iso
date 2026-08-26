import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getProjectSettings, getRepoSettings } from './config.ts';
import type { Settings, SettingsObject } from './types.ts';
export type { Settings, SettingsObject };

function isPlainObject(v: unknown): v is SettingsObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// First layer wins. Nested plain objects merge key by key so a repo can set
// worktree.baseRef without erasing a committed worktree.include. Arrays are
// replaced wholesale: a carry-over pattern list is one decision, and half of
// one from another layer would be meaningless.
export function mergeSettingsLayers(layers: Array<SettingsObject | null | undefined>): SettingsObject {
  const out: SettingsObject = {};
  for (const layer of layers) {
    if (!isPlainObject(layer)) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (isPlainObject(value) && isPlainObject(out[key])) {
        out[key] = mergeSettingsLayers([out[key] as SettingsObject, value]);
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
// is silently not read, and the only symptom would be a worktree with no
// dependencies.
const KNOWN_SETTINGS = new Set([
  'ios.deviceType',
  'ios.runtime',
  'android.systemImage',
  'worktreeDir',
  'worktree.baseRef',
  'worktree.include',
  'worktree.exclude',
  'caches',
]);

// Returns dotted paths for keys rn-iso does not read. Leaf-level: a known
// parent with an unknown child reports only the child.
export function unknownSettingKeys(settings: unknown, prefix = ''): string[] {
  if (!isPlainObject(settings)) return [];
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(settings)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) {
      // Only recurse into a namespace we know; an entirely unknown object is
      // reported once rather than leaf by leaf.
      const hasKnownChildren = [...KNOWN_SETTINGS].some((k) => k.startsWith(`${path}.`));
      if (hasKnownChildren) unknown.push(...unknownSettingKeys(value, path));
      else unknown.push(path);
      continue;
    }
    if (!KNOWN_SETTINGS.has(path)) unknown.push(path);
  }
  return unknown;
}

export function readCommittedSettings(repoRoot?: string | null): SettingsObject {
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

export function resolveSettings({
  projectPath,
  gitCommonDir,
  repoRoot,
}: {
  projectPath?: string | null;
  gitCommonDir?: string | null;
  repoRoot?: string | null;
}): SettingsObject {
  return mergeSettingsLayers([
    projectPath ? getProjectSettings(projectPath) : null,
    gitCommonDir ? getRepoSettings(gitCommonDir) : null,
    readCommittedSettings(repoRoot),
  ]);
}
