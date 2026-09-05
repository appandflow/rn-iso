import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { filesystemDevice, makeTemporaryDirectory, temporaryRoot } from '../temporary.ts';

const volume = vi.hoisted(() => ({ path: '' }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    statSync: (...args: Parameters<typeof fs.statSync>) => {
      const stat = fs.statSync(...args);
      if (
        stat &&
        typeof stat.dev === 'number' &&
        volume.path &&
        !relative(volume.path, String(args[0])).startsWith('..')
      )
        stat.dev += 1;
      return stat;
    },
  };
});

let base: string;
let near: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-temporary-test-')));
  const internal = join(base, 'internal');
  volume.path = join(base, 'volume');
  near = join(volume.path, 'main', 'nested', 'linked');
  mkdirSync(internal);
  mkdirSync(near, { recursive: true });
  writeFileSync(join(volume.path, 'main', '.git'), 'gitdir: elsewhere');
  writeFileSync(join(near, '.git'), 'gitdir: elsewhere');
  vi.stubEnv('TMPDIR', internal);
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  vi.stubEnv('STIM_TMPDIR', undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  volume.path = '';
  rmSync(base, { recursive: true, force: true });
});

test('default staging stays on the target volume outside nested Git working trees', () => {
  const staging = makeTemporaryDirectory(near, '.stim-warm-');
  expect(temporaryRoot(near)).toBe(volume.path);
  expect(filesystemDevice(staging)).toBe(filesystemDevice(near));
  expect(filesystemDevice(staging)).not.toBe(filesystemDevice(tmpdir()));
  expect(lstatSync(staging).mode & 0o777).toBe(0o700);
});

test('a safe system temporary directory on the same volume remains usable', () => {
  vi.stubEnv('TMPDIR', volume.path);
  expect(temporaryRoot(near)).toBe(volume.path);
});

test('no safe directory on the target volume refuses instead of spilling to system temp', () => {
  writeFileSync(join(volume.path, '.git'), 'gitdir: elsewhere');
  expect(() => makeTemporaryDirectory(near, '.stim-warm-')).toThrow(/No writable temporary directory/);
});

test('machine tempDir can be created, and STIM_TMPDIR overrides it', () => {
  mkdirSync(process.env.STIM_HOME!);
  const configured = join(volume.path, 'custom', 'temp');
  writeFileSync(join(process.env.STIM_HOME!, 'config.json'), JSON.stringify({ tempDir: configured }));
  expect(temporaryRoot(near)).toBe(configured);
  const staging = makeTemporaryDirectory(near, 'stim-app-');
  expect(lstatSync(staging).isDirectory()).toBe(true);
  vi.stubEnv('STIM_TMPDIR', tmpdir());
  expect(temporaryRoot(near)).toBe(tmpdir());
});

test.each(['', 'relative'])('invalid override %j refuses rather than being ignored', (override) => {
  vi.stubEnv('STIM_TMPDIR', override);
  expect(() => temporaryRoot(near)).toThrow(/absolute directory/);
});

test('overrides and symlinks into a working tree cannot expose staged secrets', () => {
  const alias = join(base, 'alias');
  symlinkSync(near, alias);
  vi.stubEnv('STIM_TMPDIR', join(alias, 'new-temp'));
  expect(() => temporaryRoot(near)).toThrow(/outside Git working trees/);
  expect(filesystemDevice(join(alias, 'missing', 'file'))).toBe(filesystemDevice(near));
});

test('a dangling symlink cannot be mistaken for its parent filesystem', () => {
  const alias = join(base, 'unmounted');
  symlinkSync(join(base, 'absent-volume'), alias);
  expect(() => filesystemDevice(join(alias, 'file'))).toThrow(/ENOENT/);
});

test('app staging cannot modify or recursively copy the source bundle', () => {
  const app = join(volume.path, 'Fixture.app');
  mkdirSync(app);
  const staging = makeTemporaryDirectory(app, 'stim-app-');
  expect(temporaryRoot(app)).toBe(volume.path);
  expect(relative(app, staging).startsWith('..')).toBe(true);
  vi.stubEnv('STIM_TMPDIR', join(app, 'temp'));
  expect(() => temporaryRoot(app)).toThrow(/must not be inside/);
});
