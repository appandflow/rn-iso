import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { metroCacheRoot, sharedStoreRoot, tagSharedStore } from '@stim-cli/core';
import { register } from '../cache-manifest.ts';

type FileStoreCtor = new (options: { root: string }) => object;

export function metroStoreName(root: string): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    const name = (pkg as { name?: unknown } | null)?.name;
    if (typeof name === 'string' && name.trim() !== '') return name;
  } catch {}
  return 'app';
}

export function metroStoreRoot(root: string): string {
  return metroCacheRoot(metroStoreName(root));
}

export function registerMetroStore(storeRoot: string): void {
  try {
    register({
      dir: storeRoot,
      name: 'Metro transform cache',
      prune: 'entries',
      entriesDepth: 2,
      note: 'shared Metro transforms, installed by stim-cli start; no eviction of its own',
    });
  } catch {}
}

export function hasStoreAt(stores: unknown, storeRoot: string): boolean {
  if (!Array.isArray(stores)) return false;
  return stores.some((s) => sharedStoreRoot(s) === storeRoot);
}

export interface StoreAppendResult {
  added: boolean;
  storeRoot: string;
  reason?: string;
}

export function appendCacheStore(
  config: { cacheStores?: unknown } | null | undefined,
  { storeRoot, FileStore }: { storeRoot: string; FileStore: FileStoreCtor },
): StoreAppendResult {
  if (!config || typeof config !== 'object') return { added: false, storeRoot, reason: 'no config to add it to' };
  const stores = config.cacheStores;
  if (typeof stores === 'function') {
    const original = stores as (cache: unknown) => unknown;
    config.cacheStores = (cache: unknown) => {
      const resolved = original(cache);
      return (Array.isArray(resolved) ? resolved : []).concat([
        tagSharedStore(new FileStore({ root: storeRoot }), storeRoot),
      ]);
    };
    return { added: true, storeRoot };
  }
  if (hasStoreAt(stores, storeRoot)) {
    return { added: false, storeRoot, reason: 'a store already points at it' };
  }
  const existing = Array.isArray(stores) ? stores : [];
  config.cacheStores = [...existing, tagSharedStore(new FileStore({ root: storeRoot }), storeRoot)];
  return { added: true, storeRoot };
}

const EXPO_ADAPTER_FILE = 'expo-metro-config.cjs';

export function expoMetroConfigPath(fromUrl: string = import.meta.url): string | null {
  const here = dirname(fileURLToPath(fromUrl));
  for (const rel of ['../shim', '../../shim']) {
    const candidate = resolve(here, rel, EXPO_ADAPTER_FILE);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const STORE_OK_PREFIX = 'stim-cli-metro-store: sharing Metro transforms through ';

export function metroStoreConfirmedRoot(line: string): string | null {
  if (!line.startsWith(STORE_OK_PREFIX)) return null;
  const root = line.slice(STORE_OK_PREFIX.length).trim();
  return root === '' ? null : root;
}

export function expoMetroStoreEnv({
  root,
  storeRoot,
  adapterPath,
  existingOverride,
}: {
  root: string;
  storeRoot: string;
  adapterPath: string;
  existingOverride?: string | null;
}): Record<string, string> {
  return {
    EXPO_OVERRIDE_METRO_CONFIG: adapterPath,
    STIM_CLI_METRO_STORE: storeRoot,
    STIM_CLI_PROJECT_ROOT: root,
    ...(existingOverride ? { STIM_CLI_EXPO_METRO_CONFIG: existingOverride } : {}),
  };
}
