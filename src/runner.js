import { existsSync } from 'fs';
import { join, dirname, resolve } from 'path';

const LOCKFILES = [
  // Order matters: most specific / modern first. If a project has multiple
  // lockfiles (e.g., during a migration), the first match wins.
  { name: 'bun.lock', pm: 'bun' },
  { name: 'bun.lockb', pm: 'bun' },
  { name: 'pnpm-lock.yaml', pm: 'pnpm' },
  { name: 'yarn.lock', pm: 'yarn' },
  { name: 'package-lock.json', pm: 'npm' },
];

// Walk up from startDir looking for a lockfile. In monorepos the lockfile
// lives at the workspace root, several levels above any individual package.
// Returns { dir, pm } or null if no lockfile is found before the filesystem
// root.
export function findLockfile(startDir) {
  let dir = resolve(startDir);
  while (true) {
    for (const { name, pm } of LOCKFILES) {
      if (existsSync(join(dir, name))) return { dir, pm };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Detect package manager from lockfiles, walking up for monorepos.
// Defaults to npm when no lockfile is found anywhere up the tree.
export function detectPackageManager(projectRoot) {
  return findLockfile(projectRoot)?.pm || 'npm';
}
