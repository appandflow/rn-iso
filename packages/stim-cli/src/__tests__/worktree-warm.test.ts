import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { cloneIgnoredEntries, warmWorktreePaths } from '../worktree.ts';
import { Command } from 'commander';
import { registerWarm } from '../commands/worktree.ts';

const publication = vi.hoisted(() => ({
  beforePublish: null as ((path: string) => void) | null,
  beforeLink: null as ((from: string, to: string) => void) | null,
  beforeMkdir: null as ((path: string) => void) | null,
  stagingPaths: [] as string[],
}));
vi.mock('fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs')>();
  return {
    ...fs,
    mkdtempSync: (prefix: string) => {
      const path = fs.mkdtempSync(prefix);
      if (prefix.endsWith('.stim-warm-')) publication.stagingPaths.push(path);
      return path;
    },
    mkdirSync: (path: string, options?: import('fs').MakeDirectoryOptions) => {
      publication.beforeMkdir?.(path);
      return fs.mkdirSync(path, options);
    },
    copyFileSync: (from: string, to: string, mode?: number) => {
      publication.beforePublish?.(to);
      return fs.copyFileSync(from, to, mode);
    },
    linkSync: (from: string, to: string) => {
      publication.beforePublish?.(to);
      publication.beforeLink?.(from, to);
      return fs.linkSync(from, to);
    },
  };
});

let base: string;
let root: string;
let target: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).trim();
}

function write(dir: string, rel: string, value: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), value);
}

beforeEach(() => {
  publication.stagingPaths = [];
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-test-warm-')));
  root = join(base, 'main');
  target = join(base, 'linked');
  process.env.STIM_HOME = join(base, 'home');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  write(root, '.gitignore', 'node_modules/\nios/Pods/\nios/build/\n.env*\nlocal/\n.worktrees/\n.DerivedData/\n');
  write(root, 'package.json', '{"name":"warm-fixture"}\n');
  write(root, 'ios/Podfile.lock', 'branch pods\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  git(root, 'worktree', 'add', '-qb', 'linked', target);
});

afterEach(() => {
  resetExecutor();
  publication.beforePublish = null;
  publication.beforeLink = null;
  publication.beforeMkdir = null;
  process.exitCode = 0;
  delete process.env.STIM_HOME;
  rmSync(base, { recursive: true, force: true });
  for (const path of publication.stagingPaths) rmSync(path, { recursive: true, force: true });
});

function warm() {
  return cloneIgnoredEntries({ root, target, patterns: [] });
}

test('missing-only copy preserves existing directories, files, and dangling symlinks wholesale', () => {
  write(root, 'node_modules/new/index.js', 'source package');
  write(root, '.env', 'source env');
  write(root, '.env.local', 'source local');
  write(target, 'node_modules/own/index.js', 'destination package');
  write(target, '.env', 'destination env');
  symlinkSync('absent-env', join(target, '.env.local'));
  const result = warm();
  expect(result.copied).toEqual([]);
  expect(result.failed).toEqual([]);
  expect(result.skipped).toHaveLength(3);
  expect(readFileSync(join(target, '.env'), 'utf-8')).toBe('destination env');
  expect(readlinkSync(join(target, '.env.local'))).toBe('absent-env');
  expect(readdirSync(join(target, 'node_modules'))).toEqual(['own']);
});

test('missing-only copy refuses destination symlink ancestors', () => {
  write(root, 'ios/Pods/Manifest.lock', 'source pods');
  rmSync(join(target, 'ios'), { recursive: true });
  const outside = join(base, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(target, 'ios'));
  const result = warm();
  expect(result.copied).toEqual([]);
  expect(result.skipped).toEqual([{ file: 'ios/Pods', reason: 'symlink ancestor: ios' }]);
  expect(readdirSync(outside)).toEqual([]);
});

test('missing-only copy skips registered nested worktrees and their ignored parents on either side', () => {
  const sourceNested = join(root, '.worktrees', 'source');
  const targetNested = join(target, 'local', 'linked');
  git(root, 'worktree', 'add', '-qb', 'source-nested', sourceNested);
  git(root, 'worktree', 'add', '-qb', 'target-nested', targetNested);
  write(root, '.worktrees/other.txt', 'source sibling');
  write(root, 'local/source.txt', 'must not enter target parent');
  const result = warm();
  expect(result.copied).toEqual([]);
  expect(existsSync(join(target, '.worktrees'))).toBe(false);
  expect(existsSync(join(target, 'local/source.txt'))).toBe(false);
  expect(git(targetNested, 'branch', '--show-current')).toBe('target-nested');
});

test('missing-only copy discards partial clone output before byte-copy fallback', () => {
  write(root, 'node_modules/pkg/index.js', 'source package');
  const real = getExecutor();
  setExecutor({
    ...real,
    runFile(file, args, opts) {
      if (file === 'cp' && args[0] === '-Rc') {
        write(args[2], 'partial', 'failed clone');
        throw new Error('clone not supported');
      }
      return real.runFile(file, args, opts);
    },
  });
  const result = warm();
  expect(result.failed).toEqual([]);
  expect(result.cloned).toBe(false);
  expect(result.copied).toEqual(['node_modules']);
  expect(readdirSync(join(target, 'node_modules'))).toEqual(['pkg']);
  expect(readFileSync(join(target, 'node_modules/pkg/index.js'), 'utf-8')).toBe('source package');
  expect(publication.stagingPaths.every((path) => !existsSync(path))).toBe(true);
});

test.each(['file', 'empty directory', 'dangling symlink'])(
  'missing-only copy preserves a concurrently created %s',
  (kind) => {
    write(root, 'node_modules/pkg/index.js', 'source package');
    const real = getExecutor();
    setExecutor({
      ...real,
      runFile(file, args, opts) {
        const result = real.runFile(file, args, opts);
        if (file === 'cp') {
          if (kind === 'file') writeFileSync(join(target, 'node_modules'), 'concurrent file');
          else if (kind === 'empty directory') mkdirSync(join(target, 'node_modules'));
          else symlinkSync('missing-packages', join(target, 'node_modules'));
        }
        return result;
      },
    });
    const result = warm();
    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual([{ file: 'node_modules', reason: 'exists' }]);
    const actual =
      kind === 'file'
        ? readFileSync(join(target, 'node_modules'), 'utf-8')
        : kind === 'empty directory'
          ? readdirSync(join(target, 'node_modules'))
          : readlinkSync(join(target, 'node_modules'));
    const expected = kind === 'file' ? 'concurrent file' : kind === 'empty directory' ? [] : 'missing-packages';
    expect(actual).toEqual(expected);
  },
);

test('failed missing-only copies leave no partial destination and retain their error', () => {
  write(root, 'node_modules/pkg/index.js', 'source package');
  const real = getExecutor();
  setExecutor({
    ...real,
    runFile(file, args, opts) {
      if (file === 'cp') {
        write(args[2], 'partial', 'incomplete');
        throw new Error('copy failed');
      }
      return real.runFile(file, args, opts);
    },
  });
  const result = warm();
  expect(result.copied).toEqual([]);
  expect(result.failed).toEqual([{ file: 'node_modules', error: 'copy failed' }]);
  expect(existsSync(join(target, 'node_modules'))).toBe(false);
  expect(publication.stagingPaths.every((path) => !existsSync(path))).toBe(true);
});

test('missing-only copy preserves relative symlinks without linking files back to the source', () => {
  write(root, 'node_modules/pkg/index.js', 'source package');
  const source = join(root, 'node_modules/pkg/index.js');
  const destination = join(target, 'node_modules/pkg/index.js');
  linkSync(source, join(root, 'node_modules/pkg/sibling.js'));
  symlinkSync('pkg', join(root, 'node_modules/alias'));
  const result = warm();
  expect(result.failed).toEqual([]);
  expect(readlinkSync(join(target, 'node_modules/alias'))).toBe('pkg');
  const published = lstatSync(destination);
  expect(published.ino).not.toBe(lstatSync(source).ino);
  expect(published.nlink).toBe(1);
  expect(lstatSync(join(target, 'node_modules/pkg/sibling.js')).ino).not.toBe(published.ino);
  expect(publication.stagingPaths.every((path) => !existsSync(path))).toBe(true);
  write(target, 'node_modules/pkg/index.js', 'edited destination');
  expect(readFileSync(source, 'utf-8')).toBe('source package');
  expect(readFileSync(join(target, 'node_modules/pkg/sibling.js'), 'utf-8')).toBe('source package');
  writeFileSync(source, 'edited source');
  expect(readFileSync(destination, 'utf-8')).toBe('edited destination');
});

test.skipIf(process.platform !== 'darwin')(
  'publication reuses the private staged inode and preserves timestamps',
  () => {
    write(root, '.env', 'source config');
    const source = join(root, '.env');
    utimesSync(source, new Date('2020-01-01'), new Date('2021-01-01'));
    let staged: ReturnType<typeof lstatSync> | undefined;
    publication.beforeLink = (from) => {
      expect(from).toBe(join(publication.stagingPaths[0]!, 'entry'));
      staged = lstatSync(from);
      expect(staged.ino).not.toBe(lstatSync(source).ino);
    };
    const result = warm();
    expect(result.failed).toEqual([]);
    const published = lstatSync(join(target, '.env'));
    expect(staged).toBeDefined();
    expect(published.ino).toBe(staged?.ino);
    expect(published.atimeMs).toBe(staged?.atimeMs);
    expect(published.mtimeMs).toBe(staged?.mtimeMs);
    expect(published.nlink).toBe(1);
    expect(publication.stagingPaths.every((path) => !existsSync(path))).toBe(true);
  },
);

test.skipIf(process.platform !== 'darwin')('cross-volume publication copies independently and reports fallback', () => {
  write(root, 'node_modules/pkg/index.js', 'source package');
  publication.beforeLink = () => {
    throw Object.assign(new Error('cross-volume link'), { code: 'EXDEV' });
  };
  const result = warm();
  expect(result.failed).toEqual([]);
  expect(result.copied).toEqual(['node_modules']);
  expect(result.cloned).toBe(false);
  write(target, 'node_modules/pkg/index.js', 'edited destination');
  expect(readFileSync(join(root, 'node_modules/pkg/index.js'), 'utf-8')).toBe('source package');
  expect(publication.stagingPaths.every((path) => !existsSync(path))).toBe(true);
});

test.skipIf(process.platform !== 'darwin')('publication refuses link errors other than cross-volume failures', () => {
  write(root, '.env', 'source config');
  publication.beforeLink = () => {
    throw Object.assign(new Error('link permission refused'), { code: 'EPERM' });
  };
  const result = warm();
  expect(result.copied).toEqual([]);
  expect(result.failed).toEqual([{ file: '.env', error: 'link permission refused' }]);
  expect(existsSync(join(target, '.env'))).toBe(false);
  expect(publication.stagingPaths.every((path) => !existsSync(path))).toBe(true);
});

async function runWarm(cwd: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((value) => stdout.push(String(value)));
  const error = vi.spyOn(console, 'error').mockImplementation((value) => stderr.push(String(value)));
  const previous = process.cwd();
  try {
    process.chdir(cwd);
    const command = new Command();
    registerWarm(command);
    await command.parseAsync(['warm'], { from: 'user' });
    return { stdout, stderr: stderr.join('\n'), code: process.exitCode || 0 };
  } finally {
    process.chdir(previous);
    log.mockRestore();
    error.mockRestore();
  }
}

test.each(['file', 'dangling symlink'])('publication preserves a late %s and earlier published files', (kind) => {
  write(root, 'node_modules/a.js', 'source a');
  write(root, 'node_modules/b.js', 'source b');
  publication.beforePublish = (path) => {
    if (path === join(target, 'node_modules/b.js')) {
      if (kind === 'file') writeFileSync(path, 'concurrent b');
      else symlinkSync('missing-b', path);
    }
  };
  const result = warm();
  expect(result.copied).toEqual([]);
  expect(result.failed).toHaveLength(1);
  expect(result.failed[0]?.error).toMatch(/EEXIST/);
  expect(readFileSync(join(target, 'node_modules/a.js'), 'utf-8')).toBe('source a');
  const actual =
    kind === 'file'
      ? readFileSync(join(target, 'node_modules/b.js'), 'utf-8')
      : readlinkSync(join(target, 'node_modules/b.js'));
  expect(actual).toBe(kind === 'file' ? 'concurrent b' : 'missing-b');
  expect(existsSync(join(target, 'node_modules/missing-b'))).toBe(false);
});

test('warm identifies canonical main and linked roots from a symlinked subdirectory', () => {
  const alias = join(base, 'alias');
  symlinkSync(target, alias);
  expect(warmWorktreePaths(join(alias, 'ios'))).toEqual({ root, target, common: join(root, '.git') });
});

test('warm rejects the main checkout and non-repositories without changing them', async () => {
  write(root, '.env', 'source env');
  const main = await runWarm(root);
  expect(main.code).toBe(1);
  expect(main.stdout).toEqual([]);
  expect(main.stderr).toMatch(/linked worktree, not the main checkout/);
  process.exitCode = 0;
  const outside = await runWarm(base);
  expect(outside.code).toBe(1);
  expect(outside.stderr).toMatch(/Not a git repository/);
});

test('warm refuses an unregistered target, missing main checkout, or mismatched Git common directory', () => {
  const real = getExecutor();
  for (const kind of ['unregistered', 'missing main', 'different common']) {
    setExecutor({
      ...real,
      runFileQuiet(file, args, opts) {
        if (kind === 'unregistered' && args.includes('worktree') && args.includes('list')) {
          return `worktree ${root}\nbranch refs/heads/main\n`;
        }
        if (kind === 'missing main' && args.includes('--git-dir') && args[1] === root) return null;
        if (
          kind === 'different common' &&
          args.at(-1) === '--git-common-dir' &&
          !args.includes('--git-dir') &&
          args[1] === root
        ) {
          return base;
        }
        return real.runFileQuiet(file, args, opts);
      },
    });
    expect(() => warmWorktreePaths(target)).toThrow(/Could not/);
  }
});

test('warm copies main ignored state but preserves the linked branch and tracked edits', async () => {
  write(root, 'node_modules/pkg/index.js', 'main dependency');
  write(root, '.env', 'main env');
  write(root, 'package.json', '{"name":"dirty-main"}\n');
  write(target, 'package.json', '{"name":"dirty-linked"}\n');
  write(target, '.env.local', 'linked local env');
  const result = await runWarm(join(target, 'ios'));
  expect(result.code).toBe(0);
  expect(result.stdout).toEqual([]);
  expect(result.stderr).toMatch(/complete: 2 ignored entries copied/);
  expect(readFileSync(join(target, '.env'), 'utf-8')).toBe('main env');
  expect(readFileSync(join(target, '.env.local'), 'utf-8')).toBe('linked local env');
  expect(readFileSync(join(target, 'package.json'), 'utf-8')).toBe('{"name":"dirty-linked"}\n');
  expect(git(target, 'branch', '--show-current')).toBe('linked');
  expect(existsSync(join(base, 'home/config.json'))).toBe(false);
  expect((await runWarm(target)).stderr).toMatch(/complete: 0 ignored entries copied, 2 kept, 0 failed/);
});

test('warm reads main exclusion settings and lets its nonempty pattern file replace them', async () => {
  write(root, '.env', 'source env');
  write(root, '.env.local', 'source local');
  write(root, '.stim.json', '{"worktree":{"exclude":[".env"]}}');
  write(target, '.stim.json', '{"worktree":{"exclude":[".env.local"]}}');
  const settings = await runWarm(target);
  expect(settings.code).toBe(0);
  expect(existsSync(join(target, '.env'))).toBe(false);
  expect(readFileSync(join(target, '.env.local'), 'utf-8')).toBe('source local');
  rmSync(join(target, '.env.local'));
  write(root, '.worktreeexclude', '.env.local\n');
  const patterns = await runWarm(target);
  expect(patterns.code).toBe(0);
  expect(readFileSync(join(target, '.env'), 'utf-8')).toBe('source env');
  expect(existsSync(join(target, '.env.local'))).toBe(false);
});

test('warm reports copy failures with nonzero status and no ready claim', async () => {
  write(root, '.env', 'source env');
  const real = getExecutor();
  setExecutor({
    ...real,
    runFile(file, args, opts) {
      if (file === 'cp') throw new Error('disk full');
      return real.runFile(file, args, opts);
    },
  });
  const result = await runWarm(target);
  expect(result.code).toBe(1);
  expect(result.stdout).toEqual([]);
  expect(result.stderr).toMatch(/could not copy .env: disk full/);
  expect(result.stderr).toMatch(/incomplete: 0 ignored entries copied, 0 kept, 1 failed/);
  expect(result.stderr).not.toMatch(/ready|warmed/);
});

test('warm refuses unreadable source or destination inventories instead of reporting an empty success', async () => {
  const real = getExecutor();
  for (const kind of ['ignored', 'tracked']) {
    process.exitCode = 0;
    setExecutor({
      ...real,
      runFile(file, args, opts) {
        if (kind === 'ignored' && args.includes('--ignored')) throw new Error('ignored inventory failed');
        return real.runFile(file, args, opts);
      },
      runFileQuiet(file, args, opts) {
        if (kind === 'tracked' && args.includes('ls-files') && !args.includes('--ignored')) return null;
        return real.runFileQuiet(file, args, opts);
      },
    });
    const result = await runWarm(target);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Could not warm/);
    expect(result.stderr).not.toMatch(/complete:/);
  }
});

test('warm reports carried dependency and Pods lockfile mismatches against the linked branch', async () => {
  write(root, 'package-lock.json', 'main lock');
  write(target, 'package-lock.json', 'linked lock');
  write(root, 'node_modules/pkg/index.js', 'source package');
  write(root, 'ios/Pods/Manifest.lock', 'main pods');
  const result = await runWarm(target);
  expect(result.code).toBe(0);
  expect(result.stderr).toMatch(/carried dependencies may be stale.*package-lock.json/);
  expect(result.stderr).toMatch(/carried ios\/Pods does not match/);
  expect(readFileSync(join(target, 'ios/Podfile.lock'), 'utf-8')).toBe('branch pods\n');
});

test('warm copies literal ignored filenames and skips excluded derived data', () => {
  write(root, '.env with "quotes"', 'literal env');
  write(root, 'node_modules/pkg/.DerivedData/large', 'skip');
  write(root, 'node_modules/pkg/index.js', 'package');
  const result = warm();
  expect(result.failed).toEqual([]);
  expect(readFileSync(join(target, '.env with "quotes"'), 'utf-8')).toBe('literal env');
  expect(existsSync(join(target, 'node_modules/pkg/.DerivedData'))).toBe(false);
});

test('exclusive directory publication preserves an empty directory created after the final precheck', () => {
  write(root, 'node_modules/pkg/index.js', 'source package');
  publication.beforeMkdir = (path) => {
    if (path === join(target, 'node_modules')) {
      publication.beforeMkdir = null;
      mkdirSync(path);
    }
  };
  const result = warm();
  expect(result.copied).toEqual([]);
  expect(result.failed[0]?.error).toMatch(/EEXIST/);
  expect(readdirSync(join(target, 'node_modules'))).toEqual([]);
});

test('missing-only copy preserves executable file modes', () => {
  write(root, 'node_modules/pkg/bin', '#!/bin/sh\nexit 0\n');
  chmodSync(join(root, 'node_modules/pkg/bin'), 0o755);
  const result = warm();
  expect(result.failed).toEqual([]);
  expect(lstatSync(join(target, 'node_modules/pkg/bin')).mode & 0o777).toBe(0o755);
});

test('warm copies read-only directories, preserves their modes, and removes staging', async () => {
  write(root, 'node_modules/pkg/index.js', 'read-only package');
  write(root, 'node_modules/pkg/.DerivedData/large', 'excluded');
  chmodSync(join(root, 'node_modules/pkg'), 0o555);
  try {
    const result = await runWarm(target);
    expect(result.code).toBe(0);
    expect(readFileSync(join(target, 'node_modules/pkg/index.js'), 'utf-8')).toBe('read-only package');
    expect(lstatSync(join(target, 'node_modules/pkg')).mode & 0o777).toBe(0o555);
    expect(existsSync(join(target, 'node_modules/pkg/.DerivedData'))).toBe(false);
    expect(publication.stagingPaths.every((path) => !existsSync(path))).toBe(true);
  } finally {
    chmodSync(join(root, 'node_modules/pkg'), 0o755);
    for (const entry of [
      join(target, 'node_modules'),
      ...publication.stagingPaths.map((path) => join(path, 'entry')),
    ]) {
      const pkg = join(entry, 'pkg');
      if (existsSync(pkg)) chmodSync(pkg, 0o755);
    }
  }
});

test('missing-only copy does not restore a deleted tracked file from ignored main state', () => {
  write(target, '.env', 'tracked linked env');
  git(target, 'add', '-f', '.env');
  git(target, 'commit', '-qm', 'track linked env');
  rmSync(join(target, '.env'));
  write(root, '.env', 'ignored main env');
  const result = warm();
  expect(result.copied).toEqual([]);
  expect(result.skipped).toEqual([{ file: '.env', reason: 'tracked' }]);
  expect(existsSync(join(target, '.env'))).toBe(false);
});

test('warm copies project-owned .stim directories unless the main exclusion file skips them', async () => {
  write(root, '.gitignore', readFileSync(join(root, '.gitignore'), 'utf-8') + '.stim/\n');
  write(root, '.stim/project.json', 'root project data');
  write(root, 'apps/mobile/.stim/project.json', 'nested project data');
  write(root, '.worktreeexclude', '/.stim\n');
  const result = await runWarm(target);
  expect(result.code).toBe(0);
  expect(existsSync(join(target, '.stim'))).toBe(false);
  expect(readFileSync(join(target, 'apps/mobile/.stim/project.json'), 'utf-8')).toBe('nested project data');
});

test('staging ignored files never exposes their contents to Git status or git add', async () => {
  write(root, '.env', 'source secret');
  const observations: { status: string; add: string; staged: string }[] = [];
  const real = getExecutor();
  setExecutor({
    ...real,
    runFile(file, args, opts) {
      const result = real.runFile(file, args, opts);
      if (file === 'cp') {
        observations.push({
          status: git(target, 'status', '--porcelain', '--untracked-files=all'),
          add: git(target, 'add', '--dry-run', '--all'),
          staged: readFileSync(args[2], 'utf-8'),
        });
      }
      return result;
    },
  });
  const result = await runWarm(target);
  expect(result.code).toBe(0);
  expect(observations).toEqual([{ status: '', add: '', staged: 'source secret' }]);
  expect(publication.stagingPaths.map((path) => realpathSync(dirname(path)))).toEqual([realpathSync(tmpdir())]);
  expect(publication.stagingPaths.every((path) => !existsSync(path))).toBe(true);
  expect(readFileSync(join(target, '.env'), 'utf-8')).toBe('source secret');
});

test('warm preserves a deleted tracked file when main has ignored descendants at that path', () => {
  write(root, 'local/README', 'main readme');
  git(root, 'add', '-f', 'local/README');
  git(root, 'commit', '-qm', 'track main local readme');
  write(root, 'local/data.cache', 'main cache');
  write(target, 'local', 'linked tracked file');
  git(target, 'add', '-f', 'local');
  git(target, 'commit', '-qm', 'track local file');
  rmSync(join(target, 'local'));
  const result = warm();
  expect(result.copied).toEqual([]);
  expect(result.skipped).toEqual([{ file: 'local/data.cache', reason: 'tracked' }]);
  expect(result.failed).toEqual([]);
  expect(existsSync(join(target, 'local'))).toBe(false);
  expect(git(target, 'diff', '--name-status')).toBe('D\tlocal');
});

test('warm permits ignored siblings under a directory containing tracked files', () => {
  write(root, 'local/README', 'main readme');
  git(root, 'add', '-f', 'local/README');
  git(root, 'commit', '-qm', 'track main local readme');
  write(root, 'local/data.cache', 'main cache');
  write(target, 'local/README', 'linked readme');
  git(target, 'add', '-f', 'local/README');
  git(target, 'commit', '-qm', 'track linked local readme');
  const result = warm();
  expect(result.copied).toEqual(['local/data.cache']);
  expect(result.skipped).toEqual([]);
  expect(result.failed).toEqual([]);
  expect(readFileSync(join(target, 'local/data.cache'), 'utf-8')).toBe('main cache');
  expect(readFileSync(join(target, 'local/README'), 'utf-8')).toBe('linked readme');
});
