import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  volumeRootFor,
  isRealMount,
  isOnMountedVolume,
} from '../src/fs-util.ts';

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

// Carried over from the symlink case test/artifacts.test.js used to cover
// through listDerivedDataEntries. The producer is gone, but the symlink
// resolution behind isOnMountedVolume is the whole reason this half of
// artifacts.js survived, and findReclaimablePort and gc gate destructive
// work on it -- so the coverage moves here rather than disappearing with the
// DerivedData classifier.
test('isOnMountedVolume resolves a symlinked ancestor instead of classifying the raw path text', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'rn-iso-fsutil-'));
  try {
    // Simulate a home-folder path that is itself a symlink onto a volume that
    // is not currently mounted: the symlink resolves, but its target does not
    // exist. A naive volumeRootFor() on the textual path would call this the
    // always-mounted boot volume.
    const symlinkedAncestor = join(homeDir, 'Developer');
    symlinkSync('/Volumes/UnmountedTestVolume/Developer', symlinkedAncestor);
    const projectPath = join(symlinkedAncestor, 'app');

    assert.equal(volumeRootFor(projectPath), '/', 'the raw path text looks like the boot volume');
    assert.equal(isOnMountedVolume(projectPath, ['/']), false, 'the volume it really lives on is not mounted');
    assert.equal(
      isOnMountedVolume(projectPath, ['/', '/Volumes/UnmountedTestVolume']),
      true,
      'the same path is on a mounted volume once that volume is in the set'
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('isOnMountedVolume confirms a plain boot-volume path', () => {
  assert.equal(isOnMountedVolume(tmpdir(), ['/']), true);
});

// Fail closed: anything that cannot be proven mounted is reported as not
// mounted, because every caller uses this to gate a destructive action.
test('isOnMountedVolume returns false for a path it cannot resolve', () => {
  assert.equal(isOnMountedVolume('relative/path/app', ['/']), false);
  assert.equal(isOnMountedVolume('~/Developer/app', ['/']), false);
  assert.equal(isOnMountedVolume('/Volumes/RnIsoTestVolumeThatDoesNotExist/app', ['/']), false);
});
