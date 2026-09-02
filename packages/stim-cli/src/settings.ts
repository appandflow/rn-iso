import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import type { CacheProviderConfig } from '@stim-cli/cache';
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
  'ios.simslimProfile',
  'ios.signingIdentity',
  'ios.signingIdentitySha1',
  'ios.lanHost',
  'android.systemImage',
  'android.dataPartitionSizeGb',
  'android.avdConfigFile',
  'android.avdConfig',
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
  'cache.provider',
  'cache.options',
  'caches',
]);

const OPEN_SETTINGS_OBJECTS = new Set(['android.avdConfig', 'cache.options']);

export const MIN_ANDROID_DATA_PARTITION_SIZE_GB: number = 6;
export const DEFAULT_ANDROID_DATA_PARTITION_SIZE_GB: number = 8;
export const MAX_ANDROID_DATA_PARTITION_SIZE_GB: number = 16 * 1024;

function validateAndroidDataPartitionSizeGb(raw: unknown): number {
  if (
    typeof raw !== 'number' ||
    !Number.isSafeInteger(raw) ||
    raw < MIN_ANDROID_DATA_PARTITION_SIZE_GB ||
    raw > MAX_ANDROID_DATA_PARTITION_SIZE_GB
  ) {
    throw new Error(
      `Invalid android.dataPartitionSizeGb setting ${JSON.stringify(raw)}. Expected an integer from ${MIN_ANDROID_DATA_PARTITION_SIZE_GB} through ${MAX_ANDROID_DATA_PARTITION_SIZE_GB} GiB.`,
    );
  }
  return raw;
}

export function androidDataPartitionSizeBytes(sizeGb: unknown): number {
  return validateAndroidDataPartitionSizeGb(sizeGb) * 1024 ** 3;
}

function androidDataPartitionSizeGbRaw(settings: unknown): unknown {
  if (!isPlainObject(settings) || !isPlainObject(settings.android)) return undefined;
  return settings.android.dataPartitionSizeGb;
}

export function androidDataPartitionSizeGbSetting(settings: unknown): number {
  const raw = androidDataPartitionSizeGbRaw(settings);
  if (raw === undefined) return DEFAULT_ANDROID_DATA_PARTITION_SIZE_GB;
  return validateAndroidDataPartitionSizeGb(raw);
}

export function androidDataPartitionSizeGbSettingError(settings: unknown): string | null {
  try {
    androidDataPartitionSizeGbSetting(settings);
    return null;
  } catch (error) {
    return String((error as Error)?.message || error);
  }
}

interface AndroidAvdConfigRule {
  parse: (value: unknown) => string;
  help: string;
}

function yesNoAvdValue(value: unknown): string {
  if (value === true || value === 'true' || value === 'yes') return 'yes';
  if (value === false || value === 'false' || value === 'no') return 'no';
  throw new Error('expected true, false, "yes", or "no"');
}

function boundedIntegerAvdRule(min: number, max: number, unit?: string): AndroidAvdConfigRule {
  return {
    help: `integer ${min}-${max}${unit ? ` ${unit}` : ''}`,
    parse: (value) => {
      const parsed =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
            ? Number(value)
            : Number.NaN;
      if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(`expected an integer from ${min} through ${max}${unit ? ` ${unit}` : ''}`);
      }
      return String(parsed);
    },
  };
}

function enumAvdRule(values: readonly string[]): AndroidAvdConfigRule {
  return {
    help: values.join('|'),
    parse: (value) => {
      if (typeof value !== 'string' || !values.includes(value)) {
        throw new Error(`expected one of: ${values.join(', ')}`);
      }
      return value;
    },
  };
}

const ANDROID_AVD_CONFIG_RULES: Record<string, AndroidAvdConfigRule> = {
  'hw.cpu.ncore': boundedIntegerAvdRule(1, 64),
  'hw.gpu.mode': enumAvdRule(['auto', 'host', 'software', 'lavapipe', 'swiftshader', 'swangle']),
  'hw.initialOrientation': enumAvdRule(['portrait', 'landscape']),
  'hw.lcd.density': boundedIntegerAvdRule(72, 1000, 'dpi'),
  'hw.lcd.vsync': boundedIntegerAvdRule(1, 1000, 'Hz'),
  'hw.ramSize': boundedIntegerAvdRule(1536, 8192, 'MB'),
  'hw.screen': enumAvdRule(['no-touch', 'touch', 'multi-touch']),
  'runtime.network.latency': enumAvdRule([
    'none',
    'gsm',
    'hscsd',
    'gprs',
    'edge',
    'umts',
    'hsdpa',
    'lte',
    'evdo',
    '5g',
  ]),
  'runtime.network.speed': enumAvdRule(['gsm', 'hscsd', 'gprs', 'edge', 'umts', 'hsdpa', 'lte', 'evdo', '5g', 'full']),
  'vm.heapSize': boundedIntegerAvdRule(16, 4096, 'MB'),
};

const YES_NO_AVD_RULE: AndroidAvdConfigRule = { help: 'true|false|yes|no', parse: yesNoAvdValue };

for (const key of [
  'hw.accelerometer',
  'hw.accelerometer_uncalibrated',
  'hw.audioInput',
  'hw.audioOutput',
  'hw.battery',
  'hw.dPad',
  'hw.gps',
  'hw.gpu.enabled',
  'hw.gyroscope',
  'hw.keyboard',
  'hw.mainKeys',
  'hw.rotaryInput',
  'hw.trackBall',
  'showDeviceFrame',
]) {
  ANDROID_AVD_CONFIG_RULES[key] = YES_NO_AVD_RULE;
}

export const ANDROID_AVD_CONFIG_KEYS: readonly string[] = Object.freeze(
  Object.keys(ANDROID_AVD_CONFIG_RULES).toSorted(),
);

export const ANDROID_AVD_CONFIG_HELP: readonly string[] = Object.freeze(
  ANDROID_AVD_CONFIG_KEYS.map((key) => `${key}: ${ANDROID_AVD_CONFIG_RULES[key]!.help}`),
);

function isSafeAndroidAvdConfigKey(key: string): boolean {
  return Object.hasOwn(ANDROID_AVD_CONFIG_RULES, key);
}

function normalizedAndroidAvdConfigEntry(key: unknown, value: unknown): [string, string] {
  if (typeof key !== 'string' || key !== key.trim() || !isSafeAndroidAvdConfigKey(key)) {
    throw new Error(
      `Unsupported android.avdConfig key ${JSON.stringify(key)}. Use a documented safe hardware override; identity, path, storage, image, snapshot, and boot-lifecycle keys are protected.`,
    );
  }
  if (typeof value === 'string' && /[\r\n\0]/.test(value)) {
    throw new Error(`Invalid android.avdConfig value for ${key}: expected one line.`);
  }
  try {
    return [key, ANDROID_AVD_CONFIG_RULES[key]!.parse(value)];
  } catch (error) {
    throw new Error(`Invalid android.avdConfig value for ${key}: ${String((error as Error)?.message || error)}.`, {
      cause: error,
    });
  }
}

export function parseAndroidAvdConfigIni(contents: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const lines = contents.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = String(lines[index] ?? '').trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new Error(`Invalid android.avdConfigFile line ${index + 1}: expected key=value.`);
    }
    const [key, value] = normalizedAndroidAvdConfigEntry(line.slice(0, separator), line.slice(separator + 1).trim());
    if (Object.hasOwn(entries, key)) {
      throw new Error(`Invalid android.avdConfigFile line ${index + 1}: duplicate key ${key}.`);
    }
    entries[key] = value;
  }
  return entries;
}

function pathEscapesRoot(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child);
}

export function androidAvdConfigSetting(settings: unknown, settingsRoot: string): Record<string, string> {
  if (!isPlainObject(settings) || !isPlainObject(settings.android)) return {};
  const android = settings.android;
  let entries: Record<string, string> = {};
  if ('avdConfigFile' in android) {
    if (
      typeof android.avdConfigFile !== 'string' ||
      !android.avdConfigFile.trim() ||
      android.avdConfigFile !== android.avdConfigFile.trim() ||
      /[\r\n\0]/.test(android.avdConfigFile) ||
      isAbsolute(android.avdConfigFile)
    ) {
      throw new Error(
        'Invalid android.avdConfigFile setting. Expected a relative file path inside the settings root (repository root, or project root outside Git).',
      );
    }
    try {
      const root = realpathSync(settingsRoot);
      const candidate = resolve(root, android.avdConfigFile);
      if (pathEscapesRoot(root, candidate)) throw new Error('path escapes the settings root');
      const path = realpathSync(candidate);
      if (pathEscapesRoot(root, path)) throw new Error('symlink target escapes the settings root');
      const stat = statSync(path);
      if (!stat.isFile()) throw new Error('path is not a regular file');
      if (stat.size > 64 * 1024) throw new Error('file exceeds 64 KiB');
      const contents = readFileSync(path, 'utf8');
      if (Buffer.byteLength(contents) > 64 * 1024) throw new Error('file exceeds 64 KiB');
      entries = parseAndroidAvdConfigIni(contents);
    } catch (error) {
      throw new Error(
        `Could not read valid android.avdConfigFile ${android.avdConfigFile}: ${String((error as Error)?.message || error)}`,
        { cause: error },
      );
    }
  }
  if ('avdConfig' in android) {
    if (!isPlainObject(android.avdConfig)) {
      throw new Error('Invalid android.avdConfig setting. Expected an object of native AVD key/value pairs.');
    }
    for (const [key, value] of Object.entries(android.avdConfig)) {
      const [normalizedKey, normalizedValue] = normalizedAndroidAvdConfigEntry(key, value);
      entries[normalizedKey] = normalizedValue;
    }
  }
  return entries;
}

export function androidAvdConfigSettingError(settings: unknown, projectPath: string): string | null {
  try {
    androidAvdConfigSetting(settings, projectPath);
    return null;
  } catch (error) {
    return String((error as Error)?.message || error);
  }
}

export function iosSimSlimProfileSetting(settings: unknown, settingsRoot: string): string | null {
  if (!isPlainObject(settings) || !isPlainObject(settings.ios) || !('simslimProfile' in settings.ios)) return null;
  const value = settings.ios.simslimProfile;
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    /[\r\n\0]/.test(value) ||
    isAbsolute(value)
  ) {
    throw new Error(
      'Invalid ios.simslimProfile setting. Expected a relative JSON file path inside the settings root (repository root, or project root outside Git).',
    );
  }
  try {
    const root = realpathSync(settingsRoot);
    const candidate = resolve(root, value);
    if (pathEscapesRoot(root, candidate)) throw new Error('path escapes the settings root');
    const path = realpathSync(candidate);
    if (pathEscapesRoot(root, path)) throw new Error('symlink target escapes the settings root');
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error('path is not a regular file');
    if (stat.size > 64 * 1024) throw new Error('file exceeds 64 KiB');
    return path;
  } catch (error) {
    throw new Error(`Could not read ios.simslimProfile ${value}: ${String((error as Error)?.message || error)}`, {
      cause: error,
    });
  }
}

export function iosSimSlimProfileSettingError(settings: unknown, settingsRoot: string): string | null {
  try {
    iosSimSlimProfileSetting(settings, settingsRoot);
    return null;
  } catch (error) {
    return String((error as Error)?.message || error);
  }
}

function iosString(settings: unknown, key: string): unknown {
  if (!isPlainObject(settings) || !isPlainObject(settings.ios)) return undefined;
  return settings.ios[key];
}

export function iosSigningIdentitySetting(settings: unknown): string | null {
  const raw = iosString(settings, 'signingIdentity');
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

export function iosSigningIdentitySettingError(settings: unknown): string | null {
  const raw = iosString(settings, 'signingIdentity');
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || raw.trim() === '' || /[\r\n\0]/.test(raw)) {
    return `Invalid ios.signingIdentity setting ${JSON.stringify(raw)}. Expected the identity name \`security find-identity -v -p codesigning\` prints, such as "Apple Development: Jane (TEAMID5678)".`;
  }
  return null;
}

const SIGNING_IDENTITY_SHA1 = /^[0-9A-Fa-f]{40}$/;

export function iosSigningIdentitySha1Setting(settings: unknown): string | null {
  const raw = iosString(settings, 'signingIdentitySha1');
  return typeof raw === 'string' && SIGNING_IDENTITY_SHA1.test(raw.trim()) ? raw.trim().toUpperCase() : null;
}

export function iosSigningIdentitySha1SettingError(settings: unknown): string | null {
  const raw = iosString(settings, 'signingIdentitySha1');
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !SIGNING_IDENTITY_SHA1.test(raw.trim())) {
    return `Invalid ios.signingIdentitySha1 setting ${JSON.stringify(raw)}. Expected the 40-character hex SHA-1 hash \`security find-identity -v -p codesigning\` prints beside the identity name.`;
  }
  return null;
}

// RCTBundleURLProvider.mm:70 serverRootWithHostPort prefixes the scheme itself
// and appends the compiled default port when the value carries no colon, so
// this setting holds a bare host and never a URL.
const LAN_HOST = /^(?!-)[A-Za-z0-9-]+(?:\.(?!-)[A-Za-z0-9-]+)*$/;

export function iosLanHostSetting(settings: unknown): string | null {
  const raw = iosString(settings, 'lanHost');
  return typeof raw === 'string' && LAN_HOST.test(raw.trim()) ? raw.trim() : null;
}

export function iosLanHostSettingError(settings: unknown): string | null {
  const raw = iosString(settings, 'lanHost');
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !LAN_HOST.test(raw.trim())) {
    return `Invalid ios.lanHost setting ${JSON.stringify(raw)}. Expected a bare address or hostname the phone can reach, such as "192.168.1.42" -- never a URL, a scheme, or a port.`;
  }
  return null;
}

export function worktreeDirSettingError(settings: unknown): string | null {
  if (!isPlainObject(settings) || !('worktreeDir' in settings)) return null;
  const raw = settings.worktreeDir;
  if (typeof raw !== 'string') {
    return `Invalid worktreeDir setting ${JSON.stringify(raw)}. Expected a string path.`;
  }
  return null;
}

export function unknownSettingKeys(settings: unknown, prefix = ''): string[] {
  if (!isPlainObject(settings)) return [];
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(settings)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) {
      if (OPEN_SETTINGS_OBJECTS.has(path)) continue;
      if (KNOWN_SETTINGS.has(path)) continue;
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
  const p = join(repoRoot, '.stim.json');
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

interface CacheSettingsLayer {
  settings: SettingsObject;
  baseDir: string | null;
}

function cacheBlock(layer: SettingsObject | null | undefined): SettingsObject | null {
  if (!isPlainObject(layer) || !isPlainObject(layer.cache)) return null;
  return layer.cache;
}

export function resolveCacheProviderConfig({
  projectPath,
  gitCommonDir,
  repoRoot,
}: {
  projectPath?: string | null;
  gitCommonDir?: string | null;
  repoRoot?: string | null;
}): CacheProviderConfig | null {
  const layers: CacheSettingsLayer[] = [
    { settings: projectPath ? getProjectSettings(projectPath) : {}, baseDir: projectPath ?? null },
    { settings: gitCommonDir ? getRepoSettings(gitCommonDir) : {}, baseDir: repoRoot ?? projectPath ?? null },
    { settings: readCommittedSettings(repoRoot), baseDir: repoRoot ?? null },
  ];

  let provider: string | null = null;
  let baseDir: string | null = null;
  for (const layer of layers) {
    const reference = cacheBlock(layer.settings)?.provider;
    if (typeof reference !== 'string' || reference.trim() === '' || layer.baseDir === null) continue;
    provider = reference.trim();
    baseDir = layer.baseDir;
    break;
  }
  if (provider === null || baseDir === null) return null;

  const options = mergeSettingsLayers(
    layers.map((layer) => {
      const block = cacheBlock(layer.settings)?.options;
      return isPlainObject(block) ? block : null;
    }),
  );
  return { provider, options, baseDir };
}

export function cacheProviderSettingError(settings: SettingsObject): string | null {
  const block = settings.cache;
  if (!isPlainObject(block)) {
    return block === undefined
      ? null
      : `Invalid cache setting ${JSON.stringify(block)}. Expected an object with provider and options.`;
  }
  if ('provider' in block && (typeof block.provider !== 'string' || block.provider.trim() === '')) {
    return `Invalid cache.provider setting ${JSON.stringify(block.provider)}. Expected a module path or package name.`;
  }
  if ('options' in block && !isPlainObject(block.options)) {
    return `Invalid cache.options setting ${JSON.stringify(block.options)}. Expected an object.`;
  }
  return null;
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
