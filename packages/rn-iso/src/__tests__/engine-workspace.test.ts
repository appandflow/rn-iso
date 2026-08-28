// `ensureWorkspaceIgnored` -- the ignore entry `init` used to write, now
// self-ensured by the commands that create the directory, and (since #79)
// written to this clone's `.git/info/exclude` instead of the project's
// `.gitignore`.
//
// The behaviours pinned here are the ones that made this worth moving: it never
// touches a TRACKED file, so `git status` stays empty (the real-repo test at the
// bottom is the whole point of the change); it asks GIT whether the directory is
// already ignored rather than reading one file and guessing; it resolves the
// exclude file through `--git-common-dir`, so one write covers the main checkout
// and every worktree; it does nothing at all outside a repo; and an unwritable
// exclude file is reported rather than thrown -- `start` must not die because a
// checkout is read-only.
import { execSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetExecutor, setExecutor } from '../exec.ts';
import {
  ensureWorkspaceIgnored,
  gitIgnoresWorkspaceDir,
  listsWorkspaceDir,
  renderWorkspaceIgnoreBlock,
} from '../engine/workspace.ts';

function scratch(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-ws-ignore-'));
  try {
    fn(dir);
  } finally {
    resetExecutor();
    rmSync(dir, { recursive: true, force: true });
  }
}

// A stand-in for the two git questions this module asks. `commonDir` is what
// `rev-parse --git-common-dir` answers (null = not a repo); `ignored` is
// `check-ignore`'s verdict, which runQuiet reports as a string or null.
function gitStub({ commonDir, ignored = false }: { commonDir: string | null; ignored?: boolean }) {
  setExecutor({
    runQuiet: (cmd: string) => {
      if (cmd.includes('--git-common-dir')) return commonDir;
      if (cmd.includes('check-ignore')) return ignored ? '.rn-iso' : null;
      return null;
    },
  });
}

test('the block ignores the workspace dir and nothing else', () => {
  expect(renderWorkspaceIgnoreBlock()).toMatch(/^\.rn-iso\/$/m);
});

// `/.rn-iso`, `.rn-iso` and `.rn-iso/` are ONE entry to git. Matching the
// literal template text instead would append a second form to a file that
// already ignores the directory, forever.
test('every form git treats as the same entry counts as listed', () => {
  for (const form of ['.rn-iso', '.rn-iso/', '/.rn-iso', '/.rn-iso/', '  .rn-iso/  ']) {
    expect(listsWorkspaceDir(`node_modules\n${form}\n`)).toBe(true);
  }
});

test('a commented-out entry does not count, and neither does a longer path', () => {
  expect(listsWorkspaceDir('# .rn-iso/\n')).toBe(false);
  expect(listsWorkspaceDir('.rn-iso/logs\n')).toBe(false);
  expect(listsWorkspaceDir('')).toBe(false);
  expect(listsWorkspaceDir(null)).toBe(false);
});

// Only a definite "ignored" is an answer: exit 1 (not ignored) and exit 128
// (not a repo) both come back from runQuiet as null. And the queried path
// carries a TRAILING SLASH, without which git reads it as a file and the
// directory-only pattern `.rn-iso/` never matches (see the real-repo case for
// a committed .gitignore entry below, which is what this buys).
test('gitIgnoresWorkspaceDir asks check-ignore about a DIRECTORY, and only a definite yes counts', () => {
  const cmds: string[] = [];
  setExecutor({
    runQuiet: (cmd: string) => {
      cmds.push(cmd);
      return '.rn-iso/';
    },
  });
  expect(gitIgnoresWorkspaceDir('/anywhere')).toBe(true);
  expect(cmds[0]).toMatch(/check-ignore \.rn-iso\/$/);

  gitStub({ commonDir: null, ignored: false });
  expect(gitIgnoresWorkspaceDir('/anywhere')).toBe(false);
  resetExecutor();
});

test('adds the entry to an existing exclude file, once', () => {
  scratch((dir: string) => {
    const gitDir = join(dir, '.git');
    const exclude = join(gitDir, 'info', 'exclude');
    mkdirSync(join(gitDir, 'info'), { recursive: true });
    writeFileSync(exclude, '# git ls-files --others --exclude-from=.git/info/exclude\n');
    gitStub({ commonDir: gitDir });

    const first = ensureWorkspaceIgnored(dir);
    expect(first.added).toBe(true);
    expect(first.path).toBe(exclude);
    const after = readFileSync(exclude, 'utf-8');
    expect(after).toMatch(/^# git ls-files/m);
    expect(after).toMatch(/^\.rn-iso\/$/m);

    // The second run reaches the content check even with check-ignore still
    // saying no, which is what keeps a stuck git from appending forever.
    expect(ensureWorkspaceIgnored(dir).added).toBe(false);
    expect(readFileSync(exclude, 'utf-8')).toBe(after);
  });
});

test('creates info/exclude when the git dir has none', () => {
  scratch((dir: string) => {
    const gitDir = join(dir, '.git');
    mkdirSync(gitDir, { recursive: true });
    gitStub({ commonDir: gitDir });

    const result = ensureWorkspaceIgnored(dir);
    expect(result.added).toBe(true);
    expect(result.path).toBe(join(gitDir, 'info', 'exclude'));
    expect(readFileSync(join(gitDir, 'info', 'exclude'), 'utf-8')).toMatch(/^\.rn-iso\/$/m);
  });
});

test('a file that does not end in a newline keeps its last line intact', () => {
  scratch((dir: string) => {
    const gitDir = join(dir, '.git');
    const exclude = join(gitDir, 'info', 'exclude');
    mkdirSync(join(gitDir, 'info'), { recursive: true });
    writeFileSync(exclude, '*.local');
    gitStub({ commonDir: gitDir });

    ensureWorkspaceIgnored(dir);
    const lines = readFileSync(exclude, 'utf-8').split('\n');
    expect(lines[0]).toBe('*.local');
    expect(lines.includes('.rn-iso/')).toBeTruthy();
  });
});

// A committed `.gitignore` entry, a parent's, an existing exclude line: all one
// question, and git is the only thing that can answer it. Write nothing, say
// nothing.
test('already ignored: nothing is written', () => {
  scratch((dir: string) => {
    const gitDir = join(dir, '.git');
    mkdirSync(gitDir, { recursive: true });
    gitStub({ commonDir: gitDir, ignored: true });

    const result = ensureWorkspaceIgnored(dir);
    expect(result.added).toBe(false);
    expect(result.error).toBe(null);
    expect(result.path).toBe(join(gitDir, 'info', 'exclude'));
    expect(existsSync(join(gitDir, 'info'))).toBe(false);
  });
});

// Outside a repo there is no `git status` to keep readable and no exclude file
// to write into, so the whole operation is a silent no-op: `path` is null, which
// is what keeps `start` from printing anything.
test('not a git repo: nothing is written and nothing is said', () => {
  scratch((dir: string) => {
    gitStub({ commonDir: null });
    const result = ensureWorkspaceIgnored(dir);
    expect(result).toEqual({ path: null, added: false, error: null });
    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
  });
});

// The whole reason the path is asked of git: `--git-common-dir` answers
// RELATIVE to the -C directory in a main checkout and ABSOLUTE from a linked
// worktree, and both answers name the one file every worktree of the repo
// reads. Building `<root>/.git/info/exclude` by hand would write into a
// worktree's gitdir FILE instead.
test('a worktree and its main checkout resolve the same exclude file', () => {
  scratch((base: string) => {
    const repo = join(base, 'repo');
    const wt = join(base, 'wt');
    const gitDir = join(repo, '.git');
    mkdirSync(join(gitDir, 'info'), { recursive: true });
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.git'), `gitdir: ${join(gitDir, 'worktrees', 'wt')}\n`);

    setExecutor({
      runQuiet: (cmd: string) => {
        if (cmd.includes('check-ignore')) return null;
        // Exactly what real git prints from each place.
        if (cmd.includes(JSON.stringify(repo))) return '.git';
        return gitDir;
      },
    });

    const fromWorktree = ensureWorkspaceIgnored(wt);
    const fromMain = ensureWorkspaceIgnored(repo);
    expect(fromWorktree.path).toBe(join(gitDir, 'info', 'exclude'));
    expect(fromMain.path).toBe(fromWorktree.path);
    // One write covers both: the second call finds the entry already there.
    expect(fromWorktree.added).toBe(true);
    expect(fromMain.added).toBe(false);
    expect(existsSync(join(wt, '.git', 'info'))).toBe(false);
  });
});

// `start` calls this on the way to spawning a dev server. A read-only checkout
// is not a reason for that to fail.
test('an unwritable exclude file comes back as an error, not a throw', () => {
  scratch((dir: string) => {
    const gitDir = join(dir, '.git');
    const exclude = join(gitDir, 'info', 'exclude');
    mkdirSync(join(gitDir, 'info'), { recursive: true });
    writeFileSync(exclude, '*.local\n');
    chmodSync(exclude, 0o444);
    gitStub({ commonDir: gitDir });
    try {
      const result = ensureWorkspaceIgnored(dir);
      expect(result.added).toBe(false);
      expect(result.error).toBeTruthy();
    } finally {
      chmodSync(exclude, 0o644);
    }
    expect(readFileSync(exclude, 'utf-8')).toBe('*.local\n');
  });
});

// ---------------------------------------------------------------------------
// Against real git. A mocked executor proves the arguments are shaped right; it
// cannot prove `git` accepts them, that `check-ignore` honours what was written,
// or -- the assertion this whole change exists for -- that `git status` stays
// EMPTY afterwards.
// ---------------------------------------------------------------------------

function realRepo(fn: (repo: string, base: string) => void) {
  // realpath'd: on macOS the temp dir sits under the `/var` -> `/private/var`
  // symlink, and git answers `--git-common-dir` from a worktree with the
  // resolved path. Comparing the raw text would fail for a reason that has
  // nothing to do with this module (item 6).
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'rn-iso-ws-real-')));
  const repo = join(base, 'repo');
  try {
    resetExecutor();
    mkdirSync(repo, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: repo, encoding: 'utf-8' });
    git('git init -q');
    git('git config user.email test@example.com');
    git('git config user.name test');
    writeFileSync(join(repo, 'package.json'), '{}');
    git('git add -A');
    git('git commit -q -m init');
    fn(repo, base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const porcelain = (dir: string) => execSync('git status --porcelain', { cwd: dir, encoding: 'utf-8' }).trim();
const checkIgnore = (dir: string) => {
  try {
    execSync('git check-ignore .rn-iso/', { cwd: dir, encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

// THE POINT OF #79. Before it, this same sequence left ` M .gitignore` (or
// `?? .gitignore`) behind -- a tracked-file write an agent had to notice, carry
// into a worktree and eventually commit. Now the tree is byte-for-byte clean
// with a full `.rn-iso/` on disk.
test('against a real repo: the entry lands in .git/info/exclude and git status stays empty', () => {
  realRepo((repo) => {
    expect(checkIgnore(repo)).toBe(false);

    const result = ensureWorkspaceIgnored(repo);
    expect(result.added).toBe(true);
    expect(result.error).toBe(null);
    expect(result.path).toBe(join(repo, '.git', 'info', 'exclude'));

    // Exactly what `start` does next: fill the directory.
    mkdirSync(join(repo, '.rn-iso', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.rn-iso', 'state.json'), '{}');

    // Git honours the exclude file exactly as it would a .gitignore entry...
    expect(checkIgnore(repo)).toBe(true);
    // ...and NOTHING is dirty: no .gitignore, no .rn-iso/, nothing to commit.
    expect(porcelain(repo)).toBe('');
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);

    // Idempotent against real git: the second run sees its own entry.
    expect(ensureWorkspaceIgnored(repo).added).toBe(false);
    expect(readFileSync(result.path as string, 'utf-8').match(/^\.rn-iso\/$/gm)?.length).toBe(1);
  });
});

// The common-dir claim, settled by real git rather than by a stub: the write
// happens through a LINKED WORKTREE, whose `.git` is a FILE, and it is the MAIN
// checkout's exclude file that ends up carrying it -- so every worktree of the
// repo, present and future, is covered by that one write.
test('against a real repo: a write from a linked worktree covers the whole repo', () => {
  realRepo((repo, base) => {
    const wt = join(base, 'wt');
    execSync(`git worktree add -q "${wt}" -b feat-exclude`, { cwd: repo, encoding: 'utf-8' });
    // The trap this resolution exists to avoid: a worktree's `.git` is a FILE.
    expect(statSync(join(wt, '.git')).isFile()).toBe(true);
    expect(readFileSync(join(wt, '.git'), 'utf-8')).toMatch(/^gitdir: /);

    const result = ensureWorkspaceIgnored(wt);
    expect(result.added).toBe(true);
    expect(result.path).toBe(join(repo, '.git', 'info', 'exclude'));

    mkdirSync(join(wt, '.rn-iso', 'logs'), { recursive: true });
    mkdirSync(join(repo, '.rn-iso', 'logs'), { recursive: true });

    // Both trees ignore it, and both stay clean, off the one write.
    expect(checkIgnore(wt)).toBe(true);
    expect(checkIgnore(repo)).toBe(true);
    expect(porcelain(wt)).toBe('');
    expect(porcelain(repo)).toBe('');

    // And the main checkout has nothing left to do.
    expect(ensureWorkspaceIgnored(repo).added).toBe(false);
  });
});

// A repo that already ignores the directory -- the committed `.gitignore` case
// #79 promises to leave alone. Real git is what makes this worth asserting:
// `check-ignore` is what sees the committed entry, and the exclude file must
// come out untouched.
test('against a real repo: a committed .gitignore entry means no write at all', () => {
  realRepo((repo) => {
    writeFileSync(join(repo, '.gitignore'), '.rn-iso/\n');
    execSync('git add -A && git commit -q -m ignore', { cwd: repo, encoding: 'utf-8' });
    // The directory does NOT exist yet -- which is always true at the moment
    // `start` calls this, and is exactly when a slash-less check-ignore query
    // answers "not ignored" and writes a redundant exclude line.
    expect(existsSync(join(repo, '.rn-iso'))).toBe(false);
    const exclude = join(repo, '.git', 'info', 'exclude');
    const before = existsSync(exclude) ? readFileSync(exclude, 'utf-8') : null;

    const result = ensureWorkspaceIgnored(repo);
    expect(result.added).toBe(false);
    expect(result.error).toBe(null);
    expect(existsSync(exclude) ? readFileSync(exclude, 'utf-8') : null).toBe(before);
    expect(porcelain(repo)).toBe('');
  });
});

// Outside a repo, against real git this time: `rev-parse` exits 128 and the
// whole operation is a no-op. The scratch dir is under the OS temp dir, which
// is not inside any checkout.
test('against real git: a directory that is not in a repo is left completely alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-ws-norepo-'));
  try {
    resetExecutor();
    const result = ensureWorkspaceIgnored(dir);
    expect(result).toEqual({ path: null, added: false, error: null });
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
    expect(existsSync(join(dir, '.git'))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
