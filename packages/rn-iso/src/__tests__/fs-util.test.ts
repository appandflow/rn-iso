import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { volumeRootFor, isRealMount, isOnMountedVolume } from '../fs-util.ts';

test('volumeRootFor identifies external and boot volumes', () => {
  expect(volumeRootFor('/Volumes/ExternalSSD/Developer/app')).toBe('/Volumes/ExternalSSD');
  expect(volumeRootFor('/Users/j/Developer/app')).toBe('/');
});

test('volumeRootFor normalizes case, doubled slashes, and dot components', () => {
  expect(volumeRootFor('/volumes/ExternalSSD/Developer/app')).toBe('/Volumes/ExternalSSD');
  expect(volumeRootFor('//Volumes/ExternalSSD/Developer/app')).toBe('/Volumes/ExternalSSD');
  expect(volumeRootFor('/Volumes/./ExternalSSD/Developer/app')).toBe('/Volumes/ExternalSSD');
  expect(volumeRootFor('/Volumes/Other/../ExternalSSD/app')).toBe('/Volumes/ExternalSSD');
});

test('isRealMount treats a distinct st_dev as a genuine mount', () => {
  expect(isRealMount(16777244, 16777234)).toBe(true);
});

test('isRealMount treats a matching st_dev (symlink to boot volume) as not a real mount', () => {
  expect(isRealMount(16777234, 16777234)).toBe(false);
});

test('isRealMount refuses to guess when either dev is missing', () => {
  expect(isRealMount(null, 16777234)).toBe(false);
  expect(isRealMount(16777234, null)).toBe(false);
  expect(isRealMount(undefined, undefined)).toBe(false);
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

    expect(volumeRootFor(projectPath)).toBe('/');
    expect(isOnMountedVolume(projectPath, ['/'])).toBe(false);
    expect(isOnMountedVolume(projectPath, ['/', '/Volumes/UnmountedTestVolume'])).toBe(true);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('isOnMountedVolume confirms a plain boot-volume path', () => {
  expect(isOnMountedVolume(tmpdir(), ['/'])).toBe(true);
});

// Fail closed: anything that cannot be proven mounted is reported as not
// mounted, because every caller uses this to gate a destructive action.
test('isOnMountedVolume returns false for a path it cannot resolve', () => {
  expect(isOnMountedVolume('relative/path/app', ['/'])).toBe(false);
  expect(isOnMountedVolume('~/Developer/app', ['/'])).toBe(false);
  expect(isOnMountedVolume('/Volumes/RnIsoTestVolumeThatDoesNotExist/app', ['/'])).toBe(false);
});
