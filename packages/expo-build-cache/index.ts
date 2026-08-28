import fs from 'node:fs';
import path from 'node:path';
import { buildCacheRoot, buildCacheKey, registerCache } from '@rn-iso/core';
import type { BuildRunOptions as RunOptions } from '@rn-iso/core';

export { buildCacheKey };

let registeredDir: string | null = null;
import { execFileSync } from 'node:child_process';

export function cacheRoot(): string {
  return buildCacheRoot();
}

function entryDir(platform: string, key: string): string {
  return path.join(cacheRoot(), platform, key);
}

function shortKey(key: string, fingerprintHash: string): string {
  return `${String(fingerprintHash).slice(0, 12)}${key.slice(String(fingerprintHash).length)}`;
}

function artifactIn(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  let found;
  try {
    found = fs.readdirSync(dir).find((f) => f.endsWith('.app') || f.endsWith('.apk'));
  } catch {
    return null;
  }
  return found ? path.join(dir, found) : null;
}

function registerOnce(): void {
  const root = cacheRoot();
  if (registeredDir === root) return;
  registeredDir = root;
  registerCache({
    dir: root,
    name: 'Expo build cache',
    prune: 'entries',
    entriesDepth: 2,
    note: 'built .app/.apk keyed on the native fingerprint',
  });
}

export async function resolveBuildCache({
  platform,
  fingerprintHash,
  runOptions,
}: {
  platform: string;
  fingerprintHash: string;
  runOptions?: RunOptions;
}): Promise<string | null> {
  registerOnce();
  const key = buildCacheKey(platform, fingerprintHash, runOptions);
  const hit = artifactIn(entryDir(platform, key));
  if (hit) {
    console.log(`[build-cache] hit ${platform} ${shortKey(key, fingerprintHash)}`);
    try {
      fs.utimesSync(path.dirname(hit), new Date(), new Date());
    } catch {}
    return hit;
  }
  console.log(`[build-cache] miss ${platform} ${shortKey(key, fingerprintHash)}`);
  return null;
}

export async function uploadBuildCache({
  platform,
  fingerprintHash,
  buildPath,
  runOptions,
}: {
  platform: string;
  fingerprintHash: string;
  buildPath?: string;
  runOptions?: RunOptions;
}): Promise<string | null> {
  registerOnce();
  if (!buildPath || !fs.existsSync(buildPath)) return null;

  const key = buildCacheKey(platform, fingerprintHash, runOptions);
  const dest = entryDir(platform, key);
  if (artifactIn(dest)) return artifactIn(dest);

  const staging = `${dest}.staging-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    execFileSync('cp', ['-c', '-R', buildPath, path.join(staging, path.basename(buildPath))]);
  } catch {
    execFileSync('cp', ['-R', buildPath, path.join(staging, path.basename(buildPath))]);
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  try {
    fs.renameSync(staging, dest);
  } catch {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  console.log(`[build-cache] stored ${platform} ${shortKey(key, fingerprintHash)}`);
  return artifactIn(dest);
}
