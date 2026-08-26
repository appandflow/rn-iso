// Volume detection and directory sizing: the half of the former
// src/artifacts.js that outlived the DerivedData classifier.
//
// The mounted-volume guard protects two different things, and only one of
// them went away. Guarding DerivedData CLASSIFICATION stopped being
// necessary once build output moved inside the workspace -- there is no
// global directory left to reverse-map back to a project. Guarding the
// PROJECT REGISTRY did not: findReclaimablePort (ports.js) and gc's
// dead-entry sweep both refuse to act on a project whose volume is merely
// unplugged, because removing its entry drops its device claim and orphans a
// real simulator. See CLAUDE.md item 8: on doubt, skip, don't delete.
import { lstatSync, readdirSync, readlinkSync, statSync } from 'fs';
import { dirname, join, normalize } from 'path';
import { getExecutor } from './exec.ts';

// "/Volumes/Foo/bar" -> "/Volumes/Foo"; anything else is on the boot volume.
// Case-insensitive on the "/Volumes/" segment and normalized first so
// "/volumes/Foo", "//Volumes/Foo", and "/Volumes/./Foo" all resolve to the
// same canonical root as "/Volumes/Foo" and compare equal to what
// listMountedVolumes() produces.
export function volumeRootFor(path: string): string {
  const normalized = normalize(String(path));
  const m = normalized.match(/^\/volumes\/([^/]+)/i);
  return m ? `/Volumes/${m[1]}` : '/';
}

// Impure. Walks the ancestors of `workspacePath`, following any symlinks it
// finds via readlinkSync (never realpathSync/statSync on the target: the
// whole point is to work when the target volume is unmounted and would make
// those calls fail). Returns the normalized, symlink-resolved path, or null
// if an ancestor is a symlink whose target could not be determined (a real
// error, not just a missing target) -- callers must not guess in that case.
// Also returns null for a non-absolute workspacePath (a relative path, or
// one starting with "~"): the segment walk below only ever lstats fabricated
// absolute prefixes built by prepending "/", so a relative input would be
// checked against paths that have nothing to do with it, and volumeRootFor
// would then misclassify the literal string as living on the boot volume.
function resolveWorkspaceRealish(workspacePath: string): string | null {
  const raw = String(workspacePath);
  if (!raw.startsWith('/')) return null;
  let current = raw;
  const MAX_HOPS = 40; // guard against symlink cycles
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
          // This ancestor simply does not exist (a deleted project, or a
          // path beyond an unmounted volume's mount point). Nothing further
          // to resolve; use the path as-is from here.
          return normalized;
        }
        // Some other error (permission denied, IO error, ...): we cannot
        // tell whether this ancestor is a symlink. Don't guess.
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
  // Too many hops (symlink cycle); refuse to guess.
  return null;
}

// Pure. A distinct st_dev proves a genuine mount. Same dev as / means the
// entry is just a symlink to the boot volume (e.g. "Macintosh HD"), or the
// stat failed outright (a stale directory left behind by an unclean unplug).
export function isRealMount(entryDev: number | null | undefined, rootDev: number | null | undefined): boolean {
  return entryDev != null && rootDev != null && entryDev !== rootDev;
}

export function listMountedVolumes({ statFn = statSync }: { statFn?: typeof statSync } = {}): string[] {
  const roots = ['/'];
  let rootDev: number;
  try {
    rootDev = statFn('/').dev;
  } catch {
    // Can't stat the boot volume at all; nothing else can be verified either.
    return roots;
  }
  try {
    for (const name of readdirSync('/Volumes')) {
      const path = join('/Volumes', name);
      let entryDev;
      try {
        entryDev = statFn(path).dev;
      } catch {
        // Stale directory left behind by an unclean unplug: not a real mount.
        continue;
      }
      if (isRealMount(entryDev, rootDev)) {
        roots.push(path);
      }
    }
  } catch {
    // No /Volumes (or unreadable). The boot volume is still mounted.
  }
  return roots;
}

// Resolves symlinked ancestors of `path` the same way the DerivedData
// producer below does (see resolveWorkspaceRealish) and returns the
// mounted-volume root for the result, or null if an ancestor symlink could
// not be resolved.
function resolveVolumeRoot(path: string): string | null {
  const realish = resolveWorkspaceRealish(path);
  return realish === null ? null : volumeRootFor(realish);
}

// Impure. True only when `path`'s volume is confirmed mounted right now.
// A bare volumeRootFor(path) is a TEXTUAL classification: a path reached
// through a symlink (e.g. a home-folder symlink onto an external volume --
// `/Users/x/Developer` -> `/Volumes/ExternalSSD/Developer` on this machine)
// resolves to "/" and looks like it is always on the boot volume, even when
// it is not. That is the exact bug CLAUDE.md #9 documents for the artifact
// sweep, and listDerivedDataEntries below already resolves symlinks before
// classifying -- this extracts that same logic so any OTHER caller that
// gates a destructive action on "is this project's volume mounted" (gc's
// project sweep, findReclaimablePort) goes through the same resolution instead of
// re-introducing the textual-only bug in a second place. Ambiguity (an
// unresolvable symlinked ancestor) returns false, the safe direction: an
// unconfirmed volume must never be treated as mounted.
export function isOnMountedVolume(path: string, mountedVolumes?: string[]): boolean {
  const mounted = new Set(mountedVolumes || listMountedVolumes());
  const volume = resolveVolumeRoot(path);
  if (volume === null) return false;
  return mounted.has(volume);
}

// Inside double quotes in a /bin/sh -c string, `$(...)` and backticks still
// expand and `\` still escapes. A directory name carrying any of these is
// never shelled out to -- skipping is always the safe direction, since an
// unmeasured directory is never deleted.
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
