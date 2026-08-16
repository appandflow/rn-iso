import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDerivedDataInfo,
  volumeRootFor,
  classifyDerivedData,
  listDerivedDataEntries,
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
