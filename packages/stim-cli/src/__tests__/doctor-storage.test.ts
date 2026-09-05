import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkStorageLayout } from '../doctor-storage.ts';
import { apkOutputsDir } from '../engine/gradle.ts';
import { workspaceDerivedData } from '../paths.ts';

let base: string;
let project: string;
let cache: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-storage-test-')));
  project = join(base, 'project');
  cache = join(base, 'cache');
  mkdirSync(project);
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  vi.stubEnv('STIM_BUILD_CACHE', cache);
  vi.stubEnv('STIM_TMPDIR', undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

test('doctor distinguishes Android project output from iOS workspace output', () => {
  const output = apkOutputsDir(project);
  const findings = checkStorageLayout(project, {
    platform: 'android',
    device: (path) => (path === output ? 2 : 1),
    stagingRoot: (path) => path,
  });
  expect(findings.map((finding) => finding.title)).toEqual(['Android build-cache storage crosses filesystems']);
  expect(findings[0]?.detail).toContain(output);
  expect(findings[0]?.detail).toContain(cache);
  expect(findings[0]?.fix).toContain('STIM_BUILD_CACHE');
  expect(checkStorageLayout(project, { platform: 'ios', device: () => 1, stagingRoot: (path) => path })).toEqual([]);
});

test('doctor detects iOS output/cache and configured staging mismatches separately', () => {
  const output = join(workspaceDerivedData(project), 'Build', 'Products');
  const findings = checkStorageLayout(project, {
    platform: 'ios',
    device: (path) => (path === cache ? 2 : 1),
    stagingRoot: () => base,
  });
  expect(findings.map((finding) => finding.title)).toEqual([
    'Cached app/APK staging crosses filesystems',
    'iOS build-cache storage crosses filesystems',
  ]);
  expect(findings[1]?.detail).toContain(output);
});

test('an explicit override on another volume warns for warm and artifact preparation', () => {
  const staging = join(base, 'override');
  const findings = checkStorageLayout(project, {
    platform: 'ios',
    device: (path) => (path === staging ? 2 : 1),
    stagingRoot: () => staging,
  });
  expect(findings.map((finding) => finding.title)).toEqual([
    'Worktree staging crosses filesystems',
    'Cached app/APK staging crosses filesystems',
    'iOS device app staging crosses filesystems',
  ]);
  expect(findings.every((finding) => finding.level === 'cost' && finding.fix?.includes('STIM_TMPDIR'))).toBe(true);
});

test('an invalid machine override produces a finding instead of a healthy report', () => {
  mkdirSync(process.env.STIM_HOME!);
  writeFileSync(join(process.env.STIM_HOME!, 'config.json'), JSON.stringify({ tempDir: 'relative' }));
  const findings = checkStorageLayout(project);
  expect(findings.map((finding) => finding.title)).toEqual(['Could not resolve temporary storage']);
  expect(findings[0]?.detail).toMatch(/absolute directory/);
});
