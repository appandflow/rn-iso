import { existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
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
export function volumeRootFor(path) {
  const m = String(path).match(/^(\/Volumes\/[^/]+)/);
  return m ? m[1] : '/';
}

export function listMountedVolumes() {
  const roots = ['/'];
  let rootDev;
  try {
    rootDev = statSync('/').dev;
  } catch {
    // Can't stat the boot volume at all; nothing else can be verified either.
    return roots;
  }
  try {
    for (const name of readdirSync('/Volumes')) {
      const path = join('/Volumes', name);
      let st;
      try {
        st = statSync(path);
      } catch {
        // Stale directory left behind by an unclean unplug: not a real mount.
        continue;
      }
      // A distinct st_dev proves a genuine mount. Same dev as / means the
      // entry is just a symlink to the boot volume (e.g. "Macintosh HD").
      if (st.dev !== rootDev) {
        roots.push(path);
      }
    }
  } catch {
    // No /Volumes (or unreadable). The boot volume is still mounted.
  }
  return roots;
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
    const out = exec.runQuiet(`plutil -convert json -o - "${plist}"`);
    const info = out ? parseDerivedDataInfo(out) : null;
    entries.push({
      dir,
      workspacePath: info?.workspacePath || null,
      lastAccessed: info?.lastAccessed || null,
      exists: info?.workspacePath ? existsSync(info.workspacePath) : false,
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
      skipped.push({ ...entry, reason: 'unreadable info.plist' });
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
    const volume = volumeRootFor(entry.workspacePath);
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
