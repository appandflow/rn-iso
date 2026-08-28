import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getProjectSettings, getRepoSettings } from './config.ts';
import { TUNNEL_MODES, type TunnelMode } from './engine/metro-reach.ts';
import type { RemoteDeviceBackend, Settings, SettingsObject } from './types.ts';
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
  'ios.remote',
  'android.systemImage',
  'android.variant',
  'android.keystore',
  'android.keystorePassword',
  'android.remote',
  'metro.tunnel',
  'metro.ngrokUrl',
  'metro.publicUrl',
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
  const p = join(repoRoot, '.stim-cli.json');
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

export const REMOTE_DEVICE_BACKENDS: readonly RemoteDeviceBackend[] = ['proxy', 'eas'] as const;

export function remoteIosSetting(settings: SettingsObject): RemoteDeviceBackend | null {
  return remoteSetting(settings, 'ios');
}

export function remoteAndroidSetting(settings: SettingsObject): RemoteDeviceBackend | null {
  return remoteSetting(settings, 'android');
}

function remoteSetting(settings: SettingsObject, platform: 'ios' | 'android'): RemoteDeviceBackend | null {
  const block = settings[platform];
  if (!isPlainObject(block)) return null;
  const remote = block.remote;
  return typeof remote === 'string' && (REMOTE_DEVICE_BACKENDS as readonly string[]).includes(remote)
    ? (remote as RemoteDeviceBackend)
    : null;
}

export function remoteDeviceSettingError(settings: SettingsObject): string | null {
  for (const platform of ['ios', 'android'] as const) {
    const block = settings[platform];
    if (!isPlainObject(block) || !('remote' in block)) continue;
    if (remoteSetting(settings, platform) === null) {
      return `Invalid ${platform}.remote setting ${JSON.stringify(block.remote)}. Expected one of: ${REMOTE_DEVICE_BACKENDS.join(', ')}.`;
    }
  }
  return null;
}

export function tunnelModeSetting(settings: SettingsObject): TunnelMode | null {
  const block = settings.metro;
  if (typeof block !== 'object' || block === null) return null;
  const mode = (block as { tunnel?: unknown }).tunnel;
  return typeof mode === 'string' && (TUNNEL_MODES as readonly string[]).includes(mode) ? (mode as TunnelMode) : null;
}

export function metroTunnelSettingError(settings: SettingsObject): string | null {
  const block = settings.metro;
  if (!isPlainObject(block)) return null;
  if ('tunnel' in block) {
    const mode = block.tunnel;
    if (typeof mode !== 'string' || !(TUNNEL_MODES as readonly string[]).includes(mode)) {
      return `Invalid metro.tunnel setting ${JSON.stringify(mode)}. Expected one of: ${TUNNEL_MODES.join(', ')}.`;
    }
  }
  if (!('ngrokUrl' in block)) return null;
  if (block.tunnel !== 'ngrok') {
    return 'metro.ngrokUrl requires metro.tunnel to be "ngrok".';
  }
  if (normalizedHttpsUrl(block.ngrokUrl) === null) {
    return 'metro.ngrokUrl must be a valid HTTPS URL.';
  }
  return null;
}

export function publicUrlSetting(settings: SettingsObject): string | null {
  const block = settings.metro;
  if (typeof block !== 'object' || block === null) return null;
  const url = (block as { publicUrl?: unknown }).publicUrl;
  return typeof url === 'string' && url.trim() ? url : null;
}

export function ngrokUrlSetting(settings: SettingsObject): string | null {
  const block = settings.metro;
  if (typeof block !== 'object' || block === null) return null;
  if ((block as { tunnel?: unknown }).tunnel !== 'ngrok') return null;
  return normalizedHttpsUrl((block as { ngrokUrl?: unknown }).ngrokUrl);
}

function normalizedHttpsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' ? raw.trim().replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}
