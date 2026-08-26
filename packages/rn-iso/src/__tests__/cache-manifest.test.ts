import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { register, readManifest, registeredCaches, unregister, manifestPath } from '../cache-manifest.ts';

let tmpHome;
let cacheDir;
beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-manifest-'));
  process.env.RN_ISO_HOME = tmpHome;
  cacheDir = mkdtempSync(join(tmpdir(), 'rn-iso-cachedir-'));
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

// Registration is what a metro.config.js or a build-cache provider calls, and
// those run on every build -- so doing it twice must not accumulate entries.
test('registering the same directory twice updates it instead of duplicating it', () => {
  register({ dir: cacheDir, name: 'first' });
  register({ dir: cacheDir, name: 'second', note: 'changed my mind' });
  const caches = readManifest().caches;
  expect(caches.length).toBe(1);
  expect(caches[0].name).toBe('second');
  expect(caches[0].note).toBe('changed my mind');
});

// The prune contract is the whole reason gc can act on a registration, so an
// unrecognised value must not silently become a licence to delete entries out
// of an index-backed store.
test('prune defaults to entries and only accepts atomic as the alternative', () => {
  register({ dir: cacheDir });
  expect(readManifest().caches[0].prune).toBe('entries');

  register({ dir: cacheDir, prune: 'atomic' });
  expect(readManifest().caches[0].prune).toBe('atomic');

  register({ dir: cacheDir, prune: 'something-else' });
  expect(readManifest().caches[0].prune).toBe('entries');
});

test('a leading ~ is expanded, so a registration made from any cwd resolves the same', () => {
  register({ dir: '~/.rn-iso-tilde-test' });
  expect(readManifest().caches[0].dir).toBe(join(homedir(), '.rn-iso-tilde-test'));
});

// A cache someone deleted by hand should not be reported as a 0-byte entry --
// but it must stay in the manifest, because the next build recreates it and
// re-registering should not become the user's job.
test('registeredCaches hides a directory that is gone but keeps it on file', () => {
  register({ dir: cacheDir, name: 'real' });
  register({ dir: join(tmpdir(), 'rn-iso-never-existed'), name: 'ghost' });
  const live = registeredCaches();
  expect(live.map((c) => c.name)).toEqual(['real']);
  expect(readManifest().caches.length).toBe(2);
});

test('unregister reports whether it removed anything', () => {
  register({ dir: cacheDir });
  expect(unregister(cacheDir)).toBe(true);
  expect(unregister(cacheDir)).toBe(false);
});

// A corrupt manifest must not take gc down with it: the caches it described are
// still on disk, and the cost of ignoring it is that they go back to being
// invisible until something registers them again.
test('a corrupt manifest reads as empty rather than throwing', () => {
  mkdirSync(tmpHome, { recursive: true });
  writeFileSync(manifestPath(), '{ this is not json');
  expect(readManifest().caches).toEqual([]);
  expect(registeredCaches()).toEqual([]);
});

test('a registration needs a directory', () => {
  expect(() => register({ name: 'nameless' })).toThrow(/needs a `dir`/);
});

// The depth is what stops gc from treating <root>/ios as one entry and removing
// every iOS build with it, so an unusable value must fall back to the flat
// default rather than being carried through.
test('entriesDepth defaults to 1 and rejects anything that is not a usable depth', () => {
  register({ dir: cacheDir });
  expect(readManifest().caches[0].entriesDepth).toBe(1);

  register({ dir: cacheDir, entriesDepth: 2 });
  expect(readManifest().caches[0].entriesDepth).toBe(2);
  expect(registeredCaches()[0].entriesDepth).toBe(2);

  for (const bad of [0, -1, 1.5, 'two', null]) {
    register({ dir: cacheDir, entriesDepth: bad });
    expect(readManifest().caches[0].entriesDepth).toBe(1);
  }
});

// A metro.config.js and a build-cache provider both register on every build, and
// several worktrees build at once. A reader must never catch the manifest
// half-written, and the write must not leave temporary files behind.
test('a registration replaces the manifest atomically and leaves no temp file', () => {
  register({ dir: cacheDir, name: 'first' });
  register({ dir: join(tmpdir(), 'rn-iso-second'), name: 'second' });
  unregister(cacheDir);

  const leftovers = readdirSync(dirname(manifestPath())).filter((n) => n.includes('tmp'));
  expect(leftovers).toEqual([]);
  expect(readManifest().caches.map((c) => c.name)).toEqual(['second']);
});
