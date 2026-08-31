import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setExecutor, resetExecutor } from '../exec.ts';
import { directorySize, volumeRootFor, isRealMount, isOnMountedVolume } from '../fs-util.ts';

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

test('isOnMountedVolume resolves a symlinked ancestor instead of classifying the raw path text', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'stim-fsutil-'));
  try {
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

test('isOnMountedVolume returns false for a path it cannot resolve', () => {
  expect(isOnMountedVolume('relative/path/app', ['/'])).toBe(false);
  expect(isOnMountedVolume('~/Developer/app', ['/'])).toBe(false);
  expect(isOnMountedVolume('/Volumes/StimTestVolumeThatDoesNotExist/app', ['/'])).toBe(false);
});

test('directorySize forwards its optional timeout and contains a timeout failure', () => {
  let seenTimeout: number | undefined;
  let seenArgs: string[] | undefined;
  setExecutor({
    runFile(_file, args, options) {
      seenArgs = args;
      seenTimeout = options?.timeoutMs;
      throw new Error('timed out');
    },
  });
  try {
    expect(directorySize('/tmp/stim-avd', { timeoutMs: 5000 })).toBe(0);
    expect(seenArgs).toEqual(['-sk', '/tmp/stim-avd']);
    expect(seenTimeout).toBe(5000);
  } finally {
    resetExecutor();
  }
});
