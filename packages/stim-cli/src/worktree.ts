import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
} from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { getExecutor } from './exec.ts';
import { makeTemporaryDirectory } from './temporary.ts';

const CARRY_SKIP_BASENAMES = new Set(['.DerivedData']);

export function isCarrySkipped(rel: string): boolean {
  return String(rel)
    .split('/')
    .some((seg) => CARRY_SKIP_BASENAMES.has(seg));
}

export function gitCommonDir(cwd: string): string | null {
  const out = getExecutor().runFileQuiet('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  return out ? out.trim() : null;
}

export function isMainWorkingTree(path: string): boolean {
  const out = getExecutor().runFileQuiet('git', [
    '-C',
    path,
    'rev-parse',
    '--path-format=absolute',
    '--git-dir',
    '--git-common-dir',
  ]);
  if (!out) return false;
  const [gitDir, commonDir] = out
    .trim()
    .split('\n')
    .map((line) => line.trim());
  return Boolean(gitDir) && gitDir === commonDir;
}

export function repoRoot(cwd: string): string | null {
  const out = getExecutor().runFileQuiet('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
  return out ? out.trim() : null;
}

export function warmWorktreePaths(cwd: string): { root: string; target: string; common: string } {
  const currentRoot = repoRoot(cwd);
  if (!currentRoot) throw new Error('Not a git repository.');
  const target = realpathSync(currentRoot);
  if (isMainWorkingTree(target)) {
    throw new Error('Run stim worktree warm from a linked worktree, not the main checkout.');
  }
  const entries = listWorktrees(target);
  const current = entries.find((entry) => canonicalPath(entry.path) === target);
  const main = entries.find((entry) => isMainWorkingTree(entry.path));
  if (!current || !main) throw new Error('Could not identify the linked worktree and its main checkout.');
  const root = realpathSync(main.path);
  const sourceRoot = repoRoot(root);
  const sourceCommon = gitCommonDir(root);
  const targetCommon = gitCommonDir(target);
  if (
    root === target ||
    !sourceRoot ||
    realpathSync(sourceRoot) !== root ||
    !sourceCommon ||
    !targetCommon ||
    realpathSync(sourceCommon) !== realpathSync(targetCommon)
  ) {
    throw new Error('Could not verify that the main checkout belongs to this linked worktree.');
  }
  return { root, target, common: realpathSync(targetCommon) };
}

export function matchesInclude(path: string, patterns: string[] | null | undefined): boolean {
  for (const pattern of patterns || []) {
    const rooted = pattern.startsWith('/');
    const body = rooted ? pattern.slice(1) : pattern;
    const escaped = body
      .replace(/[.+^${}()|[\]\\?]/g, '\\$&')
      .replace(/\*\*\//g, '::GLOBSTAR::')
      .replace(/\*/g, '[^/]+')
      .replace(/::GLOBSTAR::/g, '(?:.*/)?')
      .replace(/\\\?/g, '[^/]');
    const anchor = rooted ? '^' : '(^|/)';
    const re = new RegExp(`${anchor}${escaped}$`);
    if (re.test(path)) return true;
  }
  return false;
}

export function readWorktreeExclude(root: string): string[] | null {
  return readPatternFile(join(root, '.worktreeexclude'));
}

function readPatternFile(p: string): string[] | null {
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function nestedWorktreePaths(root: string): string[] {
  const source = canonicalPath(root);
  const paths = new Set<string>();
  const out = getExecutor().runFileQuiet('git', ['-C', root, 'worktree', 'list', '--porcelain']);
  if (out === null) {
    throw new Error('Could not list Git worktrees. Refusing to carry ignored files.');
  }
  for (const entry of parseWorktrees(out)) {
    const rel = relative(source, canonicalPath(entry.path));
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    paths.add(rel.split(sep).join('/'));
  }
  return [...paths];
}

function overlapsNestedWorktree(rel: string, nestedPaths: string[]): boolean {
  const path = String(rel).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  return nestedPaths.some(
    (nested) => path === nested || path.startsWith(`${nested}/`) || nested.startsWith(`${path}/`),
  );
}

export function listTrackedPaths(dir: string): string[] | null {
  const out = getExecutor().runFileQuiet('git', ['-C', dir, 'ls-files', '-z']);
  if (out === null) return null;
  return out.split('\0').filter(Boolean);
}

interface TrackedGuard {
  known: boolean;
  covers(rel: string): boolean;
}

function trackedGuard(dir: string): TrackedGuard {
  const paths = listTrackedPaths(dir);
  if (paths === null) return { known: false, covers: () => false };
  const entries = new Set(paths);
  const covered = new Set(paths);
  for (const p of paths) {
    for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) covered.add(p.slice(0, i));
  }
  return {
    known: true,
    covers: (rel) => {
      if (covered.has(rel)) return true;
      for (let i = rel.indexOf('/'); i !== -1; i = rel.indexOf('/', i + 1)) {
        if (entries.has(rel.slice(0, i))) return true;
      }
      return false;
    },
  };
}

interface SkippedEntry {
  file: string;
  reason: string;
}
interface FailedEntry {
  file: string;
  error: string;
}
interface CarryResult {
  copied: string[];
  skipped: SkippedEntry[];
  failed: FailedEntry[];
}

export function listGitignoredEntries(root: string): string[] {
  const args = [
    '-C',
    root,
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
    '--no-empty-directory',
    '-z',
  ];
  const out = getExecutor().runFile('git', args);
  if (!out) return [];
  return out
    .split('\0')
    .filter(Boolean)
    .map((e) => (e.endsWith('/') ? e.slice(0, -1) : e));
}

export function listCarryableIgnoredEntries(root: string, patterns: string[] | null | undefined): string[] {
  const nested = nestedWorktreePaths(root);
  return listGitignoredEntries(root).filter(
    (rel) => !isCarrySkipped(rel) && !overlapsNestedWorktree(rel, nested) && !matchesInclude(rel, patterns),
  );
}

interface CloneResult extends CarryResult {
  cloned: boolean;
}

function missingDestinationReason(target: string, rel: string): string | null {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(0, i).join('/');
    const stat = lstatSync(join(target, parent), { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) return `symlink ancestor: ${parent}`;
    if (stat && !stat.isDirectory()) return `non-directory ancestor: ${parent}`;
  }
  return lstatSync(join(target, rel), { throwIfNoEntry: false }) ? 'exists' : null;
}

function publishMissingEntry(from: string, to: string): boolean {
  let cloned = true;
  const stat = lstatSync(from);
  if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(from), to);
  } else if (stat.isFile()) {
    if (process.platform === 'darwin') {
      // libuv has no macOS clonefile backend: https://github.com/libuv/libuv/pull/3987.
      try {
        linkSync(from, to);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw error;
        cloned = false;
      }
    }
    if (process.platform !== 'darwin' || !cloned) {
      copyFileSync(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    }
    utimesSync(to, stat.atime, stat.mtime);
  } else if (stat.isDirectory()) {
    mkdirSync(to, { mode: stat.mode | 0o700 });
    for (const name of readdirSync(from)) {
      if (!CARRY_SKIP_BASENAMES.has(name) && !publishMissingEntry(join(from, name), join(to, name))) {
        cloned = false;
      }
    }
    utimesSync(to, stat.atime, stat.mtime);
    chmodSync(to, stat.mode);
  } else {
    throw new Error(`Unsupported ignored entry: ${from}`);
  }
  return cloned;
}

function removeStagedEntry(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat?.isDirectory()) {
    chmodSync(path, stat.mode | 0o700);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) removeStagedEntry(join(path, entry.name));
    }
  }
  rmSync(path, { recursive: true, force: true });
}

export function cloneIgnoredEntries({
  root,
  target,
  patterns,
}: {
  root: string;
  target: string;
  patterns: string[] | null | undefined;
}): CloneResult {
  const copied: string[] = [];
  const skipped: SkippedEntry[] = [];
  const failed: FailedEntry[] = [];
  let cloned = true;
  const guard = trackedGuard(target);
  if (!guard.known) throw new Error("Could not list the destination's tracked files.");
  const nested = nestedWorktreePaths(target);
  for (const rel of listCarryableIgnoredEntries(root, patterns)) {
    const from = join(root, rel);
    const to = join(target, rel);
    let staging: string | undefined;
    try {
      const reason = guard.covers(rel)
        ? 'tracked'
        : overlapsNestedWorktree(rel, nested)
          ? 'nested worktree'
          : missingDestinationReason(target, rel);
      if (reason) {
        skipped.push({ file: rel, reason });
        continue;
      }
      staging = makeTemporaryDirectory(target, '.stim-warm-');
      const destination = join(staging, 'entry');
      try {
        getExecutor().runFile('cp', ['-Rc', from, destination]);
      } catch {
        removeStagedEntry(destination);
        getExecutor().runFile('cp', ['-R', from, destination]);
        cloned = false;
      }
      const changed = missingDestinationReason(target, rel);
      if (changed) {
        skipped.push({ file: rel, reason: changed });
        continue;
      }
      mkdirSync(dirname(to), { recursive: true });
      if (!publishMissingEntry(destination, to)) cloned = false;
      copied.push(rel);
    } catch (e) {
      failed.push({ file: rel, error: String((e as Error)?.message || e) });
    } finally {
      if (staging) removeStagedEntry(staging);
    }
  }
  return { copied, skipped, failed, cloned };
}

export function podsOutOfSync(
  target: string,
  copiedEntries: string[] | null | undefined,
  { read = readFileSync }: { read?: typeof readFileSync } = {},
): { dir: string; reason: 'missing' | 'mismatch' }[] {
  const problems: { dir: string; reason: 'missing' | 'mismatch' }[] = [];
  for (const rel of copiedEntries || []) {
    if (rel !== 'Pods' && !rel.endsWith('/Pods')) continue;
    const iosDir = rel === 'Pods' ? '' : rel.slice(0, -'/Pods'.length);
    const manifest = join(target, rel, 'Manifest.lock');
    const podfileLock = join(target, iosDir, 'Podfile.lock');
    if (!existsSync(manifest)) continue;
    if (!existsSync(podfileLock)) {
      problems.push({ dir: iosDir || '.', reason: 'missing' });
      continue;
    }
    try {
      if (read(manifest, 'utf-8') !== read(podfileLock, 'utf-8')) {
        problems.push({ dir: iosDir || '.', reason: 'mismatch' });
      }
    } catch {}
  }
  return problems;
}

const LOCKFILE_NAMES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];

export function depsOutOfSync(
  root: string,
  target: string,
  copiedEntries: string[] | null | undefined,
  { read = readFileSync }: { read?: typeof readFileSync } = {},
): { dir: string; lockfile: string }[] {
  const problems: { dir: string; lockfile: string }[] = [];
  for (const rel of copiedEntries || []) {
    if (rel !== 'node_modules' && !rel.endsWith('/node_modules')) continue;
    const dir = rel === 'node_modules' ? '' : rel.slice(0, -'/node_modules'.length);
    for (const name of LOCKFILE_NAMES) {
      const source = join(root, dir, name);
      const branch = join(target, dir, name);
      if (!existsSync(source) || !existsSync(branch)) continue;
      try {
        if (read(source, 'utf-8') !== read(branch, 'utf-8')) {
          problems.push({ dir: dir || '.', lockfile: name });
        }
      } catch {}
      break;
    }
  }
  return problems;
}

const FINGERPRINT_INPUT_FILES = ['app.json', 'app.config.ts', 'app.config.js', 'app.config.mjs', 'package.json'];

export function dirtyFingerprintFiles(root: string): string[] {
  const out = getExecutor().runFileQuiet('git', [
    '-C',
    root,
    'status',
    '--porcelain',
    '--',
    ...FINGERPRINT_INPUT_FILES,
  ]);
  if (out === null || out.trim() === '') return [];
  return out
    .split('\n')
    .map((line) => normalizePorcelainLine(line.trimEnd()))
    .filter((line) => line !== '')
    .map((line) => line.slice(3).trim())
    .filter((path) => path !== '');
}

export function hasUncommittedWork(dir: string): boolean | null {
  const out = getExecutor().runFileQuiet('git', ['-C', dir, 'status', '--porcelain']);
  if (out === null) return null;
  return out.trim().length > 0;
}

export function dirtyPaths(dir: string, { limit = 10 }: { limit?: number } = {}): string[] {
  const out = getExecutor().runFileQuiet('git', ['-C', dir, 'status', '--porcelain']);
  if (out === null) return [];
  const lines = out
    .split('\n')
    .map((l) => normalizePorcelainLine(l.trimEnd()))
    .filter(Boolean);
  return lines.slice(0, limit);
}

function normalizePorcelainLine(line: string): string {
  if (line === '' || line[2] === ' ') return line;
  return ` ${line}`;
}

export function restoreFile(dir: string, file: string): boolean {
  return getExecutor().runFileQuiet('git', ['-C', dir, 'checkout', '--', file]) !== null;
}

export function isPodInstallChurn(paths: string[] | null | undefined): boolean {
  if (!paths || paths.length === 0) return false;
  return paths.every((line) => /(?:^|\/)(?:Podfile\.lock|project\.pbxproj)$/.test(line.slice(3).trim()));
}

const SAFE_BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;

export function unpushedCommits(dir: string): string[] | null {
  const exec = getExecutor();
  const branch = exec.runFileQuiet('git', ['-C', dir, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
  const own = branch === null ? '' : branch.trim();
  const protection =
    own && SAFE_BRANCH_NAME.test(own) ? ['--remotes', `--exclude=${own}`, '--branches'] : ['--remotes'];
  if (!own && exec.runFileQuiet('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']) === 'HEAD') {
    protection.push('--branches');
  }
  const out = exec.runFileQuiet('git', ['-C', dir, 'log', '--oneline', 'HEAD', '--not', ...protection]);
  if (out === null) return null;
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export function hasRemote(dir: string): boolean {
  const out = getExecutor().runFileQuiet('git', ['-C', dir, 'remote']);
  return Boolean(out && out.trim().length > 0);
}

export function branchExists(cwd: string, branch: string): boolean {
  const out = getExecutor().runFileQuiet('git', [
    '-C',
    cwd,
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ]);
  return Boolean(out);
}

export function resolveFullRef(cwd: string, ref: string): string | null {
  try {
    const out = getExecutor().runFile('git', [
      '-C',
      cwd,
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${ref}^{commit}`,
    ]);
    return out && out.trim() ? out.trim() : null;
  } catch {
    return null;
  }
}

export function removeWorktree(path: string, { force = false }: { force?: boolean } = {}): void {
  const args = ['-C', path, 'worktree', 'remove', ...(force ? ['--force'] : []), '--', path];
  getExecutor().runFile('git', args);
}

export function deleteBranch(cwd: string, branch: string, expectedSha: string): void {
  if (!SAFE_BRANCH_NAME.test(branch) || branch.startsWith('-')) {
    throw new Error(`Refusing branch ${JSON.stringify(branch)}: it is not a safe local branch name.`);
  }
  getExecutor().runFile('git', ['-C', cwd, 'update-ref', '-d', `refs/heads/${branch}`, expectedSha]);
}

export interface WorktreeEntry {
  path: string;
  branch?: string;
}

function parseWorktrees(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) entries.push(current as WorktreeEntry);
      current = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace('refs/heads/', '');
    }
  }
  if (current.path) entries.push(current as WorktreeEntry);
  return entries;
}

export function listWorktrees(cwd: string): WorktreeEntry[] {
  const out = getExecutor().runFileQuiet('git', ['-C', cwd, 'worktree', 'list', '--porcelain']);
  return out ? parseWorktrees(out) : [];
}
