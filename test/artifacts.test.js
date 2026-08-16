import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDerivedDataInfo,
  volumeRootFor,
  classifyDerivedData,
  listDerivedDataEntries,
  isRealMount,
} from '../src/artifacts.js';
import { setExecutor, resetExecutor } from '../src/exec.js';

test('parses WorkspacePath and LastAccessedDate from plutil json', () => {
  const json = JSON.stringify({
    WorkspacePath: '/Volumes/ExternalSSD/Developer/app/ios/App.xcworkspace',
    LastAccessedDate: '2026-08-03T21:38:12Z',
  });
  const info = parseDerivedDataInfo(json);
  assert.equal(info.workspacePath, '/Volumes/ExternalSSD/Developer/app/ios/App.xcworkspace');
  assert.equal(info.lastAccessed instanceof Date, true);
});

test('returns null for unparseable or incomplete plist json', () => {
  assert.equal(parseDerivedDataInfo('not json'), null);
  assert.equal(parseDerivedDataInfo(JSON.stringify({ LastAccessedDate: '2026-01-01' })), null);
});

test('volumeRootFor identifies external and boot volumes', () => {
  assert.equal(volumeRootFor('/Volumes/ExternalSSD/Developer/app'), '/Volumes/ExternalSSD');
  assert.equal(volumeRootFor('/Users/j/Developer/app'), '/');
});

test('volumeRootFor normalizes case, doubled slashes, and dot components', () => {
  assert.equal(volumeRootFor('/volumes/ExternalSSD/Developer/app'), '/Volumes/ExternalSSD');
  assert.equal(volumeRootFor('//Volumes/ExternalSSD/Developer/app'), '/Volumes/ExternalSSD');
  assert.equal(volumeRootFor('/Volumes/./ExternalSSD/Developer/app'), '/Volumes/ExternalSSD');
  assert.equal(volumeRootFor('/Volumes/Other/../ExternalSSD/app'), '/Volumes/ExternalSSD');
});

test('classifies a missing workspace on a mounted volume as orphaned', () => {
  const result = classifyDerivedData(
    [{ dir: '/dd/App-abc', workspacePath: '/Volumes/ExternalSSD/gone/App.xcworkspace', exists: false }],
    { mountedVolumes: ['/', '/Volumes/ExternalSSD'] }
  );
  assert.deepEqual(result.orphaned.map(e => e.dir), ['/dd/App-abc']);
  assert.equal(result.skipped.length, 0);
});

test('skips rather than orphans when the volume is not mounted', () => {
  const result = classifyDerivedData(
    [{ dir: '/dd/App-abc', workspacePath: '/Volumes/ExternalSSD/x/App.xcworkspace', exists: false }],
    { mountedVolumes: ['/'] }
  );
  assert.equal(result.orphaned.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /not mounted/);
});

test('skips entries whose metadata could not be read', () => {
  const result = classifyDerivedData(
    [{ dir: '/dd/App-abc', workspacePath: null, exists: false }],
    { mountedVolumes: ['/'] }
  );
  assert.equal(result.orphaned.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /unreadable/);
});

test('an existing workspace is live, never orphaned', () => {
  const result = classifyDerivedData(
    [{ dir: '/dd/App-abc', workspacePath: '/live/App.xcworkspace', exists: true }],
    { mountedVolumes: ['/'] }
  );
  assert.deepEqual(result.live.map(e => e.dir), ['/dd/App-abc']);
  assert.equal(result.orphaned.length, 0);
});

test('olderThanDays keeps recently accessed orphans out of the result', () => {
  const now = new Date('2026-08-16T00:00:00Z');
  const entries = [
    { dir: '/dd/old', workspacePath: '/gone/A.xcworkspace', exists: false, lastAccessed: new Date('2026-07-01T00:00:00Z') },
    { dir: '/dd/new', workspacePath: '/gone/B.xcworkspace', exists: false, lastAccessed: new Date('2026-08-15T00:00:00Z') },
  ];
  const result = classifyDerivedData(entries, { mountedVolumes: ['/'], now, olderThanDays: 7 });
  assert.deepEqual(result.orphaned.map(e => e.dir), ['/dd/old']);
});

test('an entry whose existence was never checked is skipped, not orphaned', () => {
  const result = classifyDerivedData(
    [{ dir: '/dd/App-abc', workspacePath: '/Volumes/ExternalSSD/x/App.xcworkspace' }],
    { mountedVolumes: ['/', '/Volumes/ExternalSSD'] }
  );
  assert.equal(result.orphaned.length, 0);
  assert.equal(result.live.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /not checked/);
});

test('a non-numeric olderThanDays skips entries instead of orphaning everything', () => {
  const entries = [
    {
      dir: '/dd/App-abc',
      workspacePath: '/gone/App.xcworkspace',
      exists: false,
      lastAccessed: new Date('2020-01-01T00:00:00Z'),
    },
  ];
  const nanResult = classifyDerivedData(entries, { mountedVolumes: ['/'], olderThanDays: NaN });
  assert.equal(nanResult.orphaned.length, 0);
  assert.equal(nanResult.skipped.length, 1);
  assert.match(nanResult.skipped[0].reason, /olderThanDays/);

  const stringResult = classifyDerivedData(entries, { mountedVolumes: ['/'], olderThanDays: '30d' });
  assert.equal(stringResult.orphaned.length, 0);
  assert.equal(stringResult.skipped.length, 1);
  assert.match(stringResult.skipped[0].reason, /olderThanDays/);
});

test('an Invalid Date lastAccessed is skipped instead of silently disabling the age filter', () => {
  const entries = [
    {
      dir: '/dd/App-abc',
      workspacePath: '/gone/App.xcworkspace',
      exists: false,
      lastAccessed: new Date('garbage'),
    },
  ];
  const result = classifyDerivedData(entries, { mountedVolumes: ['/'], olderThanDays: 30 });
  assert.equal(result.orphaned.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /valid date/);
});

test('an Invalid Date `now` is skipped instead of silently disabling the age filter', () => {
  const entries = [
    {
      dir: '/dd/App-abc',
      workspacePath: '/gone/App.xcworkspace',
      exists: false,
      lastAccessed: new Date('2020-01-01T00:00:00Z'),
    },
  ];
  const result = classifyDerivedData(entries, {
    mountedVolumes: ['/'],
    olderThanDays: 30,
    now: new Date('garbage'),
  });
  assert.equal(result.orphaned.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /valid date/);
});

test('isRealMount treats a distinct st_dev as a genuine mount', () => {
  assert.equal(isRealMount(16777244, 16777234), true);
});

test('isRealMount treats a matching st_dev (symlink to boot volume) as not a real mount', () => {
  assert.equal(isRealMount(16777234, 16777234), false);
});

test('isRealMount refuses to guess when either dev is missing', () => {
  assert.equal(isRealMount(null, 16777234), false);
  assert.equal(isRealMount(16777234, null), false);
  assert.equal(isRealMount(undefined, undefined), false);
});

test('classifyDerivedData never orphans when mountedVolumes is empty or omitted', () => {
  const entries = [
    { dir: '/dd/App-abc', workspacePath: '/Volumes/ExternalSSD/gone/App.xcworkspace', exists: false },
  ];

  const emptyResult = classifyDerivedData(entries, { mountedVolumes: [] });
  assert.equal(emptyResult.orphaned.length, 0);
  assert.equal(emptyResult.skipped.length, 1);

  const omittedOptionResult = classifyDerivedData(entries, {});
  assert.equal(omittedOptionResult.orphaned.length, 0);
  assert.equal(omittedOptionResult.skipped.length, 1);

  const omittedOptionsResult = classifyDerivedData(entries);
  assert.equal(omittedOptionsResult.orphaned.length, 0);
  assert.equal(omittedOptionsResult.skipped.length, 1);
});

test('listDerivedDataEntries skips shared caches that have no info.plist', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-dd-'));
  try {
    for (const name of ['ModuleCache.noindex', 'SDKStatCaches.noindex', 'CompilationCache.noindex']) {
      mkdirSync(join(root, name));
    }
    mkdirSync(join(root, 'App-abcdef'));
    writeFileSync(join(root, 'App-abcdef', 'info.plist'), 'not a real plist, just needs to exist');

    setExecutor({
      run: () => {
        throw new Error('run should not be called by listDerivedDataEntries');
      },
      runQuiet: () => JSON.stringify({ WorkspacePath: '/Users/j/Developer/App/App.xcworkspace' }),
      spawn: () => {
        throw new Error('spawn should not be called by listDerivedDataEntries');
      },
    });

    const entries = listDerivedDataEntries(root);
    assert.deepEqual(entries.map(e => e.dir), [join(root, 'App-abcdef')]);
  } finally {
    resetExecutor();
    rmSync(root, { recursive: true, force: true });
  }
});

test('listDerivedDataEntries skips directories whose name has shell metacharacters, never shells out', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-dd-'));
  try {
    const dangerousName = 'App-$(touch pwned)';
    mkdirSync(join(root, dangerousName));
    writeFileSync(join(root, dangerousName, 'info.plist'), 'not a real plist, just needs to exist');

    setExecutor({
      run: () => {
        throw new Error('run should not be called for a name with shell metacharacters');
      },
      runQuiet: () => {
        throw new Error('runQuiet should not be called for a name with shell metacharacters');
      },
      spawn: () => {
        throw new Error('spawn should not be called for a name with shell metacharacters');
      },
    });

    const entries = listDerivedDataEntries(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].workspacePath, null);
    assert.equal(entries[0].volumeRoot, null);

    const result = classifyDerivedData(entries, { mountedVolumes: ['/'] });
    assert.equal(result.orphaned.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /shell metacharacters/);
  } finally {
    resetExecutor();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a workspace path under a symlinked ancestor pointing at an unmounted volume is skipped, not orphaned', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-dd-'));
  const homeDir = mkdtempSync(join(tmpdir(), 'rn-iso-home-'));
  try {
    mkdirSync(join(root, 'App-abcdef'));
    writeFileSync(join(root, 'App-abcdef', 'info.plist'), 'not a real plist, just needs to exist');

    // Simulate "/Users/janicduplessis/Developer" being a symlink onto a
    // volume that is not currently mounted: the symlink resolves, but its
    // target does not exist.
    const symlinkedAncestor = join(homeDir, 'Developer');
    symlinkSync('/Volumes/UnmountedTestVolume/Developer', symlinkedAncestor);
    const workspacePath = join(symlinkedAncestor, 'app/ios/App.xcworkspace');

    setExecutor({
      run: () => {
        throw new Error('run should not be called by listDerivedDataEntries');
      },
      runQuiet: () => JSON.stringify({ WorkspacePath: workspacePath }),
      spawn: () => {
        throw new Error('spawn should not be called by listDerivedDataEntries');
      },
    });

    const entries = listDerivedDataEntries(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].workspacePath, workspacePath);
    assert.equal(entries[0].exists, false);
    assert.equal(entries[0].volumeRoot, '/Volumes/UnmountedTestVolume');

    // The volume the symlink actually points at is not in the mounted set
    // (only the boot volume is): must be skipped, never orphaned, even
    // though the textual workspacePath itself starts with a plain /Users
    // path that a naive volumeRootFor() would call the boot volume.
    const result = classifyDerivedData(entries, { mountedVolumes: ['/'] });
    assert.equal(result.orphaned.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /not mounted/);
  } finally {
    resetExecutor();
    rmSync(root, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('a relative WorkspacePath is skipped, not orphaned, even though it looks gone', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-dd-'));
  try {
    mkdirSync(join(root, 'App-abcdef'));
    writeFileSync(join(root, 'App-abcdef', 'info.plist'), 'not a real plist, just needs to exist');

    setExecutor({
      run: () => {
        throw new Error('run should not be called by listDerivedDataEntries');
      },
      runQuiet: () => JSON.stringify({ WorkspacePath: 'Developer/app/ios/App.xcworkspace' }),
      spawn: () => {
        throw new Error('spawn should not be called by listDerivedDataEntries');
      },
    });

    const entries = listDerivedDataEntries(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].workspacePath, 'Developer/app/ios/App.xcworkspace');
    assert.equal(entries[0].volumeRoot, null);

    // A naive resolver would prepend "/" to each fabricated ancestor, find
    // nothing there, and treat the literal string as living on the boot
    // volume (which is always mounted) -- that must never happen.
    const result = classifyDerivedData(entries, { mountedVolumes: ['/'] });
    assert.equal(result.orphaned.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /not absolute/);
  } finally {
    resetExecutor();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a "~"-prefixed WorkspacePath is skipped, not orphaned, even though it looks gone', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-dd-'));
  try {
    mkdirSync(join(root, 'App-abcdef'));
    writeFileSync(join(root, 'App-abcdef', 'info.plist'), 'not a real plist, just needs to exist');

    setExecutor({
      run: () => {
        throw new Error('run should not be called by listDerivedDataEntries');
      },
      runQuiet: () => JSON.stringify({ WorkspacePath: '~/Developer/app/ios/App.xcworkspace' }),
      spawn: () => {
        throw new Error('spawn should not be called by listDerivedDataEntries');
      },
    });

    const entries = listDerivedDataEntries(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].workspacePath, '~/Developer/app/ios/App.xcworkspace');
    assert.equal(entries[0].volumeRoot, null);

    // normalize() leaves a leading "~" alone, so lstatSync('/~') throws
    // ENOENT and a naive resolver would return the literal "~/..." string,
    // which volumeRootFor then calls the boot volume (always mounted).
    const result = classifyDerivedData(entries, { mountedVolumes: ['/'] });
    assert.equal(result.orphaned.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /not absolute/);
  } finally {
    resetExecutor();
    rmSync(root, { recursive: true, force: true });
  }
});
