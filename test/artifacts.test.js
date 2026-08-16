import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDerivedDataInfo,
  volumeRootFor,
  classifyDerivedData,
} from '../src/artifacts.js';

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
