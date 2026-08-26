// `ensureWorkspaceIgnored` -- the gitignore entry `init` used to write, now
// self-ensured by the commands that create the directory.
//
// The behaviours pinned here are the ones that made this worth moving out of a
// setup command: it is idempotent across every FORM of the entry git accepts
// (so re-running a command never appends a second copy), it creates the file
// when a repo has none, and an unwritable .gitignore is reported rather than
// thrown -- `start` must not die because a checkout is read-only.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureWorkspaceIgnored, listsWorkspaceDir, renderWorkspaceIgnoreBlock } from '../engine/workspace.ts';

function scratch(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-ws-ignore-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the block ignores the workspace dir and nothing else', () => {
  expect(renderWorkspaceIgnoreBlock()).toMatch(/^\.rn-iso\/$/m);
});

// `/.rn-iso`, `.rn-iso` and `.rn-iso/` are ONE entry to git. Matching the
// literal template text instead would append a second form to a repo that
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

test('adds the entry to an existing .gitignore, once', () => {
  scratch((dir) => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
    expect(ensureWorkspaceIgnored(dir).added).toBe(true);
    const after = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(after).toMatch(/^node_modules$/m);
    expect(after).toMatch(/^\.rn-iso\/$/m);

    expect(ensureWorkspaceIgnored(dir).added).toBe(false);
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toBe(after);
  });
});

test('creates a .gitignore when the repo has none', () => {
  scratch((dir) => {
    const result = ensureWorkspaceIgnored(dir);
    expect(result.added).toBe(true);
    expect(result.path).toBe(join(dir, '.gitignore'));
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toMatch(/^\.rn-iso\/$/m);
  });
});

test('a file that does not end in a newline keeps its last line intact', () => {
  scratch((dir) => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules');
    ensureWorkspaceIgnored(dir);
    const lines = readFileSync(join(dir, '.gitignore'), 'utf-8').split('\n');
    expect(lines[0]).toBe('node_modules');
    expect(lines.includes('.rn-iso/')).toBeTruthy();
  });
});

// `start` calls this on the way to spawning a dev server. A read-only checkout
// is not a reason for that to fail.
test('an unwritable .gitignore comes back as an error, not a throw', () => {
  scratch((dir) => {
    const path = join(dir, '.gitignore');
    writeFileSync(path, 'node_modules\n');
    chmodSync(path, 0o444);
    try {
      const result = ensureWorkspaceIgnored(dir);
      expect(result.added).toBe(false);
      expect(result.error).toBeTruthy();
    } finally {
      chmodSync(path, 0o644);
    }
    expect(existsSync(path)).toBeTruthy();
  });
});
