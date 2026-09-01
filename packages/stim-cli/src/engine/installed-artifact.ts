import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getExecutor, type Executor } from '../exec.ts';

const READ_CHUNK_BYTES = 1024 * 1024;

const DEVICE_PATH_TIMEOUT_MS = 30000;

const DEVICE_HASH_TIMEOUT_MS = 120000;

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function parseInstalledApkPath(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const paths: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('package:')) continue;
    const path = line.slice('package:'.length);
    if (path.startsWith('/')) paths.push(path);
  }
  return paths.length === 1 ? paths[0]! : null;
}

export function parseDeviceSha256(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const first = text.trim().split(/\s+/)[0] ?? '';
  return SHA256_HEX.test(first) ? first : null;
}

export function parseAppContainerPath(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length === 1 && lines[0]!.startsWith('/') ? lines[0]! : null;
}

export function artifactsMatch(local: string | null, installed: string | null): boolean {
  return Boolean(local) && local === installed;
}

export function hashFile(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    for (;;) {
      const read = readSync(fd, buffer, 0, READ_CHUNK_BYTES, null);
      if (read <= 0) break;
      digest.update(buffer.subarray(0, read));
    }
    return digest.digest('hex');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

export function hashBundle(dir: string): string | null {
  const digest = createHash('sha256');
  const walk = (abs: string, rel: string): boolean => {
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return false;
    }
    for (const name of names.toSorted()) {
      const child = join(abs, name);
      const path = rel === '' ? name : `${rel}/${name}`;
      let stat;
      try {
        stat = lstatSync(child);
      } catch {
        return false;
      }
      if (stat.isDirectory()) {
        if (!walk(child, path)) return false;
        continue;
      }
      if (!stat.isFile()) return false;
      const file = hashFile(child);
      if (file === null) return false;
      digest.update(`${path}\0${file}\n`);
    }
    return true;
  };
  return walk(dir, '') ? digest.digest('hex') : null;
}

export function deviceHoldsApk(
  { serial, packageName, apkPath }: { serial: string; packageName: string; apkPath: string },
  { exec = null }: { exec?: Executor | null } = {},
): boolean {
  const e = exec || getExecutor();
  let path: string | null;
  try {
    path = parseInstalledApkPath(
      e.runFile('adb', ['-s', serial, 'shell', 'pm', 'path', packageName], { timeoutMs: DEVICE_PATH_TIMEOUT_MS }),
    );
  } catch {
    return false;
  }
  if (!path) return false;
  let installed: string | null;
  try {
    installed = parseDeviceSha256(
      e.runFile('adb', ['-s', serial, 'shell', 'sha256sum', path], { timeoutMs: DEVICE_HASH_TIMEOUT_MS }),
    );
  } catch {
    return false;
  }
  if (!installed) return false;
  return artifactsMatch(hashFile(apkPath), installed);
}

export function deviceHoldsBundle(
  { udid, bundleId, appPath }: { udid: string; bundleId: string; appPath: string },
  { exec = null }: { exec?: Executor | null } = {},
): boolean {
  const e = exec || getExecutor();
  let container: string | null;
  try {
    container = parseAppContainerPath(
      e.runFile('xcrun', ['simctl', 'get_app_container', udid, bundleId], { timeoutMs: DEVICE_PATH_TIMEOUT_MS }),
    );
  } catch {
    return false;
  }
  if (!container) return false;
  const installed = hashBundle(container);
  if (!installed) return false;
  return artifactsMatch(hashBundle(appPath), installed);
}
