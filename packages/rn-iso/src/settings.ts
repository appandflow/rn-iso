import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getProjectSettings, getRepoSettings } from './config.ts';
import { TUNNEL_MODES, type TunnelMode } from './engine/metro-reach.ts';
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

// Whether this workspace's iOS device is remote. Kept beside KNOWN_SETTINGS
// for the reason stated above: the name of a setting and the code that reads
// it drifting apart is how `worktree.install` became a silent no-op.
//
// Settings are Record<string, unknown> because they come from three JSON
// layers, so the read narrows rather than asserts. Anything other than a
// literal `true` is false: a setting that means "use a billable cloud device"
// must not be switched on by a stray string.
export function remoteIosSetting(settings: SettingsObject): boolean {
  return remoteSetting(settings, 'ios');
}

// The android half. Same rule, same reason: anything other than a literal
// `true` is false, because a setting meaning "use a billable cloud device"
// must not be switched on by a stray string.
export function remoteAndroidSetting(settings: SettingsObject): boolean {
  return remoteSetting(settings, 'android');
}

function remoteSetting(settings: SettingsObject, platform: 'ios' | 'android'): boolean {
  const block = settings[platform];
  if (typeof block !== 'object' || block === null) return false;
  return (block as { remote?: unknown }).remote === true;
}

// engine/metro-reach.ts's TunnelMode, committed once for the whole repo
// rather than passed per invocation -- there is no `--tunnel` flag. Readers
// return null for missing or invalid input; commands validate before using the
// value so invalid input cannot silently select a default.
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

// An operator-supplied tunnel URL that already exists. planMetroReach uses
// this in place of starting one of its own, whatever metro.tunnel says.
export function publicUrlSetting(settings: SettingsObject): string | null {
  const block = settings.metro;
  if (typeof block !== 'object' || block === null) return null;
  const url = (block as { publicUrl?: unknown }).publicUrl;
  return typeof url === 'string' && url.trim() ? url : null;
}

// A stable URL for a managed ngrok process. It is deliberately scoped to an
// explicit ngrok selection: `auto` can fall back to cloudflared, where an
// ngrok-only URL has no meaning. HTTPS is required because remote development
// clients must not receive a public clear-text origin.
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
