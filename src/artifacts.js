import { existsSync, lstatSync, readdirSync, readlinkSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, normalize } from 'path';
import { getExecutor } from './exec.js';

export function derivedDataRoot() {
  return join(homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');
}

export function parseDerivedDataInfo(plistJson) {
  let data;
  try {
    data = JSON.parse(plistJson);
  } catch {
    return null;
  }
  const workspacePath = data?.WorkspacePath;
  if (typeof workspacePath !== 'string' || workspacePath.length === 0) return null;
  const raw = data.LastAccessedDate;
  const lastAccessed = raw ? new Date(raw) : null;
  return {
    workspacePath,
    lastAccessed: lastAccessed && !isNaN(lastAccessed.getTime()) ? lastAccessed : null,
  };
}

// "/Volumes/Foo/bar" -> "/Volumes/Foo"; anything else is on the boot volume.
// Case-insensitive on the "/Volumes/" segment and normalized first so
// "/volumes/Foo", "//Volumes/Foo", and "/Volumes/./Foo" all resolve to the
// same canonical root as "/Volumes/Foo" and compare equal to what
// listMountedVolumes() produces.
export function volumeRootFor(path) {
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
function resolveWorkspaceRealish(workspacePath) {
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
        if (err && err.code === 'ENOENT') {
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
        const resolvedTarget = target.startsWith('/')
          ? target
          : normalize(join(dirname(prefix), target));
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
export function isRealMount(entryDev, rootDev) {
  return entryDev != null && rootDev != null && entryDev !== rootDev;
}

export function listMountedVolumes({ statFn = statSync } = {}) {
  const roots = ['/'];
  let rootDev;
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
function resolveVolumeRoot(path) {
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
// gates a destructive action on "is this project's volume mounted" (prune,
// gc's project sweep) goes through the same resolution instead of
// re-introducing the textual-only bug in a second place. Ambiguity (an
// unresolvable symlinked ancestor) returns false, the safe direction: an
// unconfirmed volume must never be treated as mounted.
export function isOnMountedVolume(path, mountedVolumes) {
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

// Impure. `plutil -convert json` fails outright on a real Xcode info.plist
// because LastAccessedDate is stored as a plist <date>, which JSON cannot
// represent. Per-key -extract does not have that problem, so this pulls just
// the two keys we need. Note: `plutil -extract <key>` on a missing key does
// NOT fail cleanly -- it prints an error string like "<path>: Could not
// extract value, error: No value at that key path or invalid key path:
// NoSuchKey" and still exits with output on stdout, so callers must validate
// the returned value rather than trust that a non-null return means success.
function extractPlistValue(exec, plist, key) {
  const out = exec.runQuiet(`plutil -extract ${key} raw -o - "${plist}"`);
  return typeof out === 'string' ? out : null;
}

export function listDerivedDataEntries(root = derivedDataRoot()) {
  const exec = getExecutor();
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const plist = join(dir, 'info.plist');
    if (!existsSync(plist)) {
      // Shared caches like ModuleCache.noindex have no info.plist. They belong
      // to no project and must never be classified.
      continue;
    }
    if (SHELL_METACHARS.test(dir) || SHELL_METACHARS.test(plist)) {
      entries.push({
        dir,
        workspacePath: null,
        lastAccessed: null,
        exists: false,
        volumeRoot: null,
        reason: 'directory name contains shell metacharacters',
      });
      continue;
    }
    // The error string plutil prints for a missing key never starts with
    // "/", so this doubles as the "did extraction actually succeed" check.
    const rawWorkspacePath = extractPlistValue(exec, plist, 'WorkspacePath');
    const workspacePathValid = typeof rawWorkspacePath === 'string' && rawWorkspacePath.startsWith('/');
    const rawLastAccessed = extractPlistValue(exec, plist, 'LastAccessedDate');
    const plistJson = JSON.stringify({
      WorkspacePath: workspacePathValid ? rawWorkspacePath : undefined,
      LastAccessedDate: rawLastAccessed || undefined,
    });
    const info = parseDerivedDataInfo(plistJson);
    const workspacePath = info?.workspacePath || null;
    let volumeRoot;
    let unresolvedReason;
    if (workspacePath) {
      volumeRoot = resolveVolumeRoot(workspacePath);
      if (volumeRoot === null) {
        unresolvedReason = workspacePath.startsWith('/')
          ? 'could not resolve a symlinked ancestor of the workspace path'
          : 'workspace path in info.plist is not absolute';
      }
    }
    entries.push({
      dir,
      workspacePath,
      lastAccessed: info?.lastAccessed || null,
      exists: workspacePath ? existsSync(workspacePath) : false,
      volumeRoot,
      ...(unresolvedReason ? { unresolvedReason } : {}),
    });
  }
  return entries;
}

// Pure. Every branch that cannot prove a directory is orphaned puts it in
// `skipped`, never in `orphaned`.
export function classifyDerivedData(entries, { mountedVolumes, now, olderThanDays } = {}) {
  const mounted = new Set(mountedVolumes || []);
  const olderThanDaysIsSet = olderThanDays != null;
  const olderThanDaysValid =
    !olderThanDaysIsSet || (typeof olderThanDays === 'number' && Number.isFinite(olderThanDays));
  const orphaned = [];
  const live = [];
  const skipped = [];

  for (const entry of entries) {
    if (!entry.workspacePath) {
      skipped.push({ ...entry, reason: entry.reason || 'unreadable info.plist' });
      continue;
    }
    if (entry.exists === true) {
      live.push(entry);
      continue;
    }
    if (entry.exists !== false) {
      // Existence was never checked (undefined), not confirmed gone (false).
      // Failing open here would delete live build output.
      skipped.push({ ...entry, reason: 'workspace existence was not checked' });
      continue;
    }
    // A symlinked ancestor (e.g. a home-folder path that is itself a symlink
    // onto an external volume) can only be resolved by the impure producer.
    // entry.volumeRoot === null means either it tried and could not resolve
    // one of those ancestors, or workspacePath was not absolute to begin
    // with (relative, or "~"-prefixed) -- don't fall back to a textual guess
    // in either case.
    if (entry.volumeRoot === null) {
      skipped.push({
        ...entry,
        reason: entry.unresolvedReason || 'could not resolve a symlinked ancestor of the workspace path',
      });
      continue;
    }
    const volume = entry.volumeRoot != null ? entry.volumeRoot : volumeRootFor(entry.workspacePath);
    if (!mounted.has(volume)) {
      // The workspace looks gone only because its disk is not attached.
      // Deleting here would destroy live build output.
      skipped.push({ ...entry, reason: `volume ${volume} is not mounted` });
      continue;
    }
    if (olderThanDaysIsSet) {
      if (!olderThanDaysValid) {
        skipped.push({ ...entry, reason: 'olderThanDays must be a finite number' });
        continue;
      }
      if (!entry.lastAccessed) {
        skipped.push({ ...entry, reason: 'no LastAccessedDate to age-filter on' });
        continue;
      }
      const ageDays = ((now || new Date()) - entry.lastAccessed) / 86400000;
      if (!Number.isFinite(ageDays)) {
        // An Invalid Date on either side of the subtraction yields NaN,
        // which makes every "< olderThanDays" comparison false. Failing
        // open here would silently disable the age filter.
        skipped.push({ ...entry, reason: 'lastAccessed or now is not a valid date' });
        continue;
      }
      if (ageDays < olderThanDays) {
        live.push(entry);
        continue;
      }
    }
    orphaned.push(entry);
  }

  return { orphaned, live, skipped };
}

export function findDerivedDataFor(projectPath, root = derivedDataRoot()) {
  const prefix = projectPath.endsWith('/') ? projectPath : `${projectPath}/`;
  return listDerivedDataEntries(root).filter(
    e => e.workspacePath && (e.workspacePath === projectPath || e.workspacePath.startsWith(prefix))
  );
}

export function findOrphanedDerivedData({ olderThanDays } = {}) {
  return classifyDerivedData(listDerivedDataEntries(), {
    mountedVolumes: listMountedVolumes(),
    now: new Date(),
    olderThanDays,
  });
}

export function directorySize(dir) {
  if (SHELL_METACHARS.test(dir)) return 0;
  const out = getExecutor().runQuiet(`du -sk "${dir}"`);
  if (!out) return 0;
  const kb = parseInt(out.split(/\s+/)[0], 10);
  return isNaN(kb) ? 0 : kb * 1024;
}

export function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}M`;
  return `${Math.round(bytes / 1024)}K`;
}
