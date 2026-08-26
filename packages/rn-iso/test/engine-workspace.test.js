// `ensureWorkspaceIgnored` -- the gitignore entry `init` used to write, now
// self-ensured by the commands that create the directory.
//
// The behaviours pinned here are the ones that made this worth moving out of a
// setup command: it is idempotent across every FORM of the entry git accepts
// (so re-running a command never appends a second copy), it creates the file
// when a repo has none, and an unwritable .gitignore is reported rather than
// thrown -- `start` must not die because a checkout is read-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureWorkspaceIgnored,
  listsWorkspaceDir,
  renderWorkspaceIgnoreBlock,
} from '../src/engine/workspace.ts';

function scratch(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-ws-ignore-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the block ignores the workspace dir and nothing else', () => {
  assert.match(renderWorkspaceIgnoreBlock(), /^\.rn-iso\/$/m);
});

// `/.rn-iso`, `.rn-iso` and `.rn-iso/` are ONE entry to git. Matching the
// literal template text instead would append a second form to a repo that
// already ignores the directory, forever.
test('every form git treats as the same entry counts as listed', () => {
  for (const form of ['.rn-iso', '.rn-iso/', '/.rn-iso', '/.rn-iso/', '  .rn-iso/  ']) {
    assert.equal(listsWorkspaceDir(`node_modules\n${form}\n`), true, `${form} should count`);
  }
});

test('a commented-out entry does not count, and neither does a longer path', () => {
  assert.equal(listsWorkspaceDir('# .rn-iso/\n'), false);
  assert.equal(listsWorkspaceDir('.rn-iso/logs\n'), false);
  assert.equal(listsWorkspaceDir(''), false);
  assert.equal(listsWorkspaceDir(null), false);
});

test('adds the entry to an existing .gitignore, once', () => {
  scratch(dir => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
    assert.equal(ensureWorkspaceIgnored(dir).added, true);
    const after = readFileSync(join(dir, '.gitignore'), 'utf-8');
    assert.match(after, /^node_modules$/m, 'what was already there stays');
    assert.match(after, /^\.rn-iso\/$/m);

    assert.equal(ensureWorkspaceIgnored(dir).added, false, 're-running adds nothing');
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf-8'), after);
  });
});

test('creates a .gitignore when the repo has none', () => {
  scratch(dir => {
    const result = ensureWorkspaceIgnored(dir);
    assert.equal(result.added, true);
    assert.equal(result.path, join(dir, '.gitignore'));
    assert.match(readFileSync(join(dir, '.gitignore'), 'utf-8'), /^\.rn-iso\/$/m);
  });
});

test('a file that does not end in a newline keeps its last line intact', () => {
  scratch(dir => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules');
    ensureWorkspaceIgnored(dir);
    const lines = readFileSync(join(dir, '.gitignore'), 'utf-8').split('\n');
    assert.equal(lines[0], 'node_modules');
    assert.ok(lines.includes('.rn-iso/'));
  });
});

// `start` calls this on the way to spawning a dev server. A read-only checkout
// is not a reason for that to fail.
test('an unwritable .gitignore comes back as an error, not a throw', () => {
  scratch(dir => {
    const path = join(dir, '.gitignore');
    writeFileSync(path, 'node_modules\n');
    chmodSync(path, 0o444);
    try {
      const result = ensureWorkspaceIgnored(dir);
      assert.equal(result.added, false);
      assert.ok(result.error, 'the failure is reported on the result');
    } finally {
      chmodSync(path, 0o644);
    }
    assert.ok(existsSync(path));
  });
});
