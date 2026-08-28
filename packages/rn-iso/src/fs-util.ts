import { lstatSync, readdirSync, readlinkSync, statSync } from 'fs';
import { dirname, join, normalize } from 'path';
import { getExecutor } from './exec.ts';

export function volumeRootFor(path: string): string {
  const normalized = normalize(String(path));
  const m = normalized.match(/^\/volumes\/([^/]+)/i);
  return m ? `/Volumes/${m[1]}` : '/';
}

function resolveWorkspaceRealish(workspacePath: string): string | null {
  const raw = String(workspacePath);
  if (!raw.startsWith('/')) return null;
  let current = raw;
  const MAX_HOPS = 40;
  for (let hops = 0; hops < MAX_HOPS; hops++) {
    const normalized = normalize(current);
    const segments = normalized.split('/').filter(Boolean);
    let prefix = '';
    let followedSymlink = false;
    for (const segment of segments) {
      prefix += `/${segment}`;
      let st;
      try {
        st = lstatSync(prefix);
      } catch (err) {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return normalized;
        }
        return null;
      }
      if (st.isSymbolicLink()) {
        let target;
        try {
          target = readlinkSync(prefix);
        } catch {
          return null;
        }
        const resolvedTarget = target.startsWith('/') ? target : normalize(join(dirname(prefix), target));
        const rest = normalized.slice(prefix.length);
        current = `${resolvedTarget}${rest}`;
        followedSymlink = true;
        break;
      }
    }
    if (!followedSymlink) {
      return normalized;
    }
  }
  return null;
}

export function isRealMount(entryDev: number | null | undefined, rootDev: number | null | undefined): boolean {
  return entryDev != null && rootDev != null && entryDev !== rootDev;
}

export function listMountedVolumes({ statFn = statSync }: { statFn?: typeof statSync } = {}): string[] {
  const roots = ['/'];
  let rootDev: number;
  try {
    rootDev = statFn('/').dev;
  } catch {
    return roots;
  }
  try {
    for (const name of readdirSync('/Volumes')) {
      const path = join('/Volumes', name);
      let entryDev;
      try {
        entryDev = statFn(path).dev;
      } catch {
        continue;
      }
      if (isRealMount(entryDev, rootDev)) {
        roots.push(path);
      }
    }
  } catch {}
  return roots;
}

function resolveVolumeRoot(path: string): string | null {
  const realish = resolveWorkspaceRealish(path);
  return realish === null ? null : volumeRootFor(realish);
}

export function isOnMountedVolume(path: string, mountedVolumes?: string[]): boolean {
  const mounted = new Set(mountedVolumes || listMountedVolumes());
  const volume = resolveVolumeRoot(path);
  if (volume === null) return false;
  return mounted.has(volume);
}

const SHELL_METACHARS = /[`$"\\]/;

export function directorySize(dir: string): number {
  if (SHELL_METACHARS.test(dir)) return 0;
  const out = getExecutor().runQuiet(`du -sk "${dir}"`);
  if (!out) return 0;
  const kb = parseInt(out.split(/\s+/)[0] ?? '', 10);
  return isNaN(kb) ? 0 : kb * 1024;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}M`;
  return `${Math.round(bytes / 1024)}K`;
}
