import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { createHash } from 'node:crypto';
import { getExecutor } from './exec.ts';

const CARRY_SKIP_BASENAMES = new Set(['.DerivedData']);

export function isCarrySkipped(rel: string): boolean {
  return String(rel)
    .split('/')
    .some((seg) => CARRY_SKIP_BASENAMES.has(seg));
}

function pruneCarriedArtifacts(dest: string): void {
  const args = [dest, '-type', 'd', '('];
  let first = true;
  for (const name of CARRY_SKIP_BASENAMES) {
    if (!first) args.push('-o');
    args.push('-name', name);
    first = false;
  }
  args.push(')', '-prune', '-exec', 'rm', '-rf', '{}', '+');
  try {
    getExecutor().runFile('find', args);
  } catch {}
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

export function defaultWorktreeDir(root: string): string {
  return join(dirname(root), `${basename(root)}-worktrees`);
}

export function isValidWorktreeName(name: string): boolean {
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(name)) return false;
  if (name.includes('..') || name.endsWith('.')) return false;
  return name.split('/').every((segment) => !segment.startsWith('.') && !segment.endsWith('.lock'));
}

export function worktreePath({ worktreeDir, name }: { worktreeDir: string; name: string }): string {
  return join(worktreeDir, name.replaceAll('/', '+'));
}

export function defaultWorktreeLabel(name: string): string {
  if (!name.includes('/')) return name;
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 8);
  return `${digest}-${name.replaceAll('/', '-')}`;
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

export function readWorktreeInclude(root: string): string[] | null {
  return readPatternFile(join(root, '.worktreeinclude'));
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

export function listGitignoredFiles(root: string): string[] {
  const out = getExecutor().runFileQuiet('git', [
    '-C',
    root,
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
    '--',
    '.',
    ':(exclude,glob)**/node_modules/**',
  ]);
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => !f.endsWith('/'));
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
  const set = new Set<string>();
  for (const p of paths) {
    set.add(p);
    for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) set.add(p.slice(0, i));
  }
  return { known: true, covers: (rel) => set.has(rel) };
}

function refuseReason(guard: TrackedGuard, rel: string, destPath: string): 'tracked' | 'unverified' | null {
  if (guard.covers(rel)) return 'tracked';
  if (!guard.known && existsSync(destPath)) return 'unverified';
  return null;
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

export function carryOverFiles({
  root,
  target,
  patterns,
}: {
  root: string;
  target: string;
  patterns: string[] | null | undefined;
}): CarryResult {
  if (!patterns || patterns.length === 0) return { copied: [], skipped: [], failed: [] };
  const copied: string[] = [];
  const skipped: SkippedEntry[] = [];
  const failed: FailedEntry[] = [];
  const guard = trackedGuard(target);
  const nested = nestedWorktreePaths(root);
  for (const rel of listGitignoredFiles(root)) {
    if (isCarrySkipped(rel)) continue;
    if (overlapsNestedWorktree(rel, nested)) continue;
    if (!matchesInclude(rel, patterns)) continue;
    const from = join(root, rel);
    const to = join(target, rel);
    const reason = refuseReason(guard, rel, to);
    if (reason) {
      skipped.push({ file: rel, reason });
      continue;
    }
    try {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      copied.push(rel);
    } catch (e) {
      failed.push({ file: rel, error: String((e as Error)?.message || e) });
    }
  }
  return { copied, skipped, failed };
}

export function listGitignoredEntries(root: string, strict = false): string[] {
  const args = [
    '-C',
    root,
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
    '--no-empty-directory',
    ...(strict ? ['-z'] : []),
  ];
  const out = strict ? getExecutor().runFile('git', args) : getExecutor().runFileQuiet('git', args);
  if (!out) return [];
  return out
    .split(strict ? '\0' : '\n')
    .filter(Boolean)
    .map((e) => (e.endsWith('/') ? e.slice(0, -1) : e));
}

export function listCarryableIgnoredEntries(
  root: string,
  patterns: string[] | null | undefined,
  strict = false,
): string[] {
  const nested = nestedWorktreePaths(root);
  return listGitignoredEntries(root, strict).filter(
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

function publishMissingEntry(from: string, to: string): void {
  const stat = lstatSync(from);
  if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(from), to);
  } else if (stat.isFile()) {
    copyFileSync(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    utimesSync(to, stat.atime, stat.mtime);
  } else if (stat.isDirectory()) {
    mkdirSync(to, { mode: stat.mode | 0o700 });
    for (const name of readdirSync(from)) {
      if (!CARRY_SKIP_BASENAMES.has(name)) publishMissingEntry(join(from, name), join(to, name));
    }
    utimesSync(to, stat.atime, stat.mtime);
    chmodSync(to, stat.mode);
  } else {
    throw new Error(`Unsupported ignored entry: ${from}`);
  }
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
  preserveExisting = false,
}: {
  root: string;
  target: string;
  patterns: string[] | null | undefined;
  preserveExisting?: boolean;
}): CloneResult {
  const copied: string[] = [];
  const skipped: SkippedEntry[] = [];
  const failed: FailedEntry[] = [];
  let cloned = true;
  const guard = trackedGuard(target);
  if (preserveExisting && !guard.known) throw new Error("Could not list the destination's tracked files.");
  const nested = preserveExisting ? nestedWorktreePaths(target) : [];
  for (const rel of listCarryableIgnoredEntries(root, patterns, preserveExisting)) {
    const from = join(root, rel);
    const to = join(target, rel);
    let isDir = false;
    try {
      isDir = statSync(from).isDirectory();
    } catch {}
    let staging: string | undefined;
    try {
      const reason =
        refuseReason(guard, rel, to) ||
        (preserveExisting &&
          (overlapsNestedWorktree(rel, nested) ? 'nested worktree' : missingDestinationReason(target, rel)));
      if (reason) {
        skipped.push({ file: rel, reason });
        continue;
      }
      if (preserveExisting) staging = mkdtempSync(join(tmpdir(), '.stim-warm-'));
      const destination = staging ? join(staging, 'entry') : to;
      mkdirSync(dirname(destination), { recursive: true });
      try {
        getExecutor().runFile('cp', ['-Rc', from, destination]);
      } catch {
        if (staging) removeStagedEntry(destination);
        getExecutor().runFile('cp', ['-R', from, destination]);
        cloned = false;
      }
      if (isDir && !staging) pruneCarriedArtifacts(destination);
      if (staging) {
        const changed = missingDestinationReason(target, rel);
        if (changed) {
          skipped.push({ file: rel, reason: changed });
          continue;
        }
        mkdirSync(dirname(to), { recursive: true });
        publishMissingEntry(destination, to);
      }
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

export interface CarriedChanges {
  files: string[];
  applied: boolean;
  conflicted: boolean;
}

export function carryUncommittedChanges({ root, target }: { root: string; target: string }): CarriedChanges | null {
  const exec = getExecutor();
  const patch = exec.runFileQuiet('git', ['-C', root, 'diff', 'HEAD', '--binary']);
  if (patch === null || patch.trim() === '') return null;
  const files = (exec.runFileQuiet('git', ['-C', root, 'diff', 'HEAD', '--name-only']) || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const staging = mkdtempSync(join(tmpdir(), 'stim-carry-'));
  const patchFile = join(staging, 'uncommitted.patch');
  try {
    writeFileSync(patchFile, patch + (/^GIT binary patch$/m.test(patch) ? '\n\n' : '\n'));
    try {
      exec.runFile('git', ['-C', target, 'apply', '--check', patchFile]);
    } catch {
      return { files, applied: false, conflicted: true };
    }
    try {
      exec.runFile('git', ['-C', target, 'apply', patchFile]);
    } catch {
      return { files, applied: false, conflicted: true };
    }
    return { files, applied: true, conflicted: false };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
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

export function resolveRef(cwd: string, ref: string): string | null {
  try {
    const out = getExecutor().runFile('git', [
      '-C',
      cwd,
      'rev-parse',
      '--verify',
      '--quiet',
      '--short',
      '--end-of-options',
      `${ref}^{commit}`,
    ]);
    return out && out.trim() ? out.trim() : null;
  } catch {
    return null;
  }
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

function assertSafeWorktreePath(path: string): void {
  if (typeof path !== 'string' || path.startsWith('-')) {
    throw new Error(
      `Refusing worktree path ${JSON.stringify(path)}: a path beginning with "-" would be parsed as a git option.`,
    );
  }
  if (/[`$"\\]/.test(path)) {
    throw new Error(
      `Refusing worktree path ${JSON.stringify(path)}: it contains shell metacharacters that have no place in a path.`,
    );
  }
}

function assertSafeBaseRef(baseRef: string): void {
  if (typeof baseRef !== 'string' || baseRef.startsWith('-')) {
    throw new Error(
      `Refusing base ref ${JSON.stringify(baseRef)}: a ref beginning with "-" would be parsed as a git option.`,
    );
  }
}

export function addWorktree({
  path,
  branch,
  baseRef,
  createBranch,
}: {
  path: string;
  branch: string;
  baseRef: string;
  createBranch: boolean;
}): string {
  assertSafeWorktreePath(path);
  mkdirSync(dirname(path), { recursive: true });
  if (!createBranch) {
    getExecutor().runFile('git', ['worktree', 'add', '--', path, branch], { env: { LC_ALL: 'C' } });
    return path;
  }
  assertSafeBaseRef(baseRef);
  getExecutor().runFile('git', ['worktree', 'add', '-b', branch, '--', path, baseRef], { env: { LC_ALL: 'C' } });
  return path;
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

export function resolveBaseRef(cwd: string, baseRef: string): string {
  if (baseRef === 'head') return 'HEAD';
  const head = getExecutor().runFileQuiet('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'origin/HEAD']);
  if (head) return head.trim();
  console.error('warning: origin/HEAD not found; falling back to HEAD as the base ref.');
  return 'HEAD';
}
