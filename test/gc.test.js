import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatGcReport } from '../src/commands/gc.js';

test('reports orphans with sizes and a total', () => {
  const lines = formatGcReport({
    orphaned: [{ dir: '/dd/App-abc', workspacePath: '/gone/App.xcworkspace', bytes: 4617089843 }],
    skipped: [],
    deadProjects: [],
    totalBytes: 4617089843,
  }).join('\n');
  assert.match(lines, /App-abc/);
  assert.match(lines, /4\.3G/);
});

test('names skipped entries and why they were skipped', () => {
  const lines = formatGcReport({
    orphaned: [],
    skipped: [{ dir: '/dd/X', reason: 'volume /Volumes/ExternalSSD is not mounted' }],
    deadProjects: [],
    totalBytes: 0,
  }).join('\n');
  assert.match(lines, /not mounted/);
  assert.match(lines, /skipped/i);
});

test('says nothing to reclaim when everything is clean', () => {
  const lines = formatGcReport({ orphaned: [], skipped: [], deadProjects: [], totalBytes: 0 }).join('\n');
  assert.match(lines, /nothing to reclaim/i);
});

test('marks an unmeasured entry instead of printing a misleading 0K', () => {
  const lines = formatGcReport({
    orphaned: [
      { dir: '/dd/App-def', workspacePath: '/gone/App2.xcworkspace', bytes: 0, measured: false },
    ],
    skipped: [],
    deadProjects: [],
    totalBytes: 0,
  }).join('\n');
  assert.match(lines, /App-def/);
  assert.match(lines, /unmeasured/i);
  assert.match(lines, /lower bound/i);
});

test('lists dead project entries', () => {
  const lines = formatGcReport({
    orphaned: [],
    skipped: [],
    deadProjects: ['/gone/proj'],
    totalBytes: 0,
  }).join('\n');
  assert.match(lines, /\/gone\/proj/);
  assert.match(lines, /Dead project entries/);
});
