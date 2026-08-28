import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getProjectSettings, getRepoSettings } from './config.ts';
import type { Settings, SettingsObject } from './types.ts';
export type { Settings, SettingsObject };

function isPlainObject(v: unknown): v is SettingsObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

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

const KNOWN_SETTINGS = new Set([
  'ios.deviceType',
  'ios.runtime',
  'ios.configuration',
  'android.systemImage',
  'android.variant',
  'android.keystore',
  'android.keystorePassword',
  'worktreeDir',
  'worktree.baseRef',
  'worktree.include',
  'worktree.exclude',
  'caches',
]);

export function unknownSettingKeys(settings: unknown, prefix = ''): string[] {
  if (!isPlainObject(settings)) return [];
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(settings)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) {
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
