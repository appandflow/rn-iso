import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';
import {
  appProjectProblem,
  declaresAppDependency,
  findProjectRoot,
  detectIsExpo,
  detectBundleId,
  detectAndroidPackage,
  resolveRegisteredProject,
  projectShortcut,
} from '../project.ts';
import { upsertProject, getProject } from '../config.ts';

const FIXTURES = resolve(import.meta.dirname, 'fixtures');
const EXPO_PROJ = join(FIXTURES, 'sample-expo-project');
const BARE_PROJ = join(FIXTURES, 'sample-bare-project');

test('findProjectRoot walks up from cwd to find package.json', () => {
  const nested = join(EXPO_PROJ, 'src');
  expect(findProjectRoot(nested)).toBe(EXPO_PROJ);
});

test('findProjectRoot returns null when no package.json found', () => {
  expect(findProjectRoot('/')).toBe(null);
});

test('declaresAppDependency accepts react-native or expo from either dependency block', () => {
  expect(declaresAppDependency({ dependencies: { 'react-native': '0.81.0' } })).toBe(true);
  expect(declaresAppDependency({ dependencies: { expo: '~54.0.0' } })).toBe(true);
  expect(declaresAppDependency({ devDependencies: { 'react-native': '0.81.0' } })).toBe(true);
});

test('declaresAppDependency rejects a package.json that depends on neither', () => {
  expect(declaresAppDependency({ name: 'monorepo', dependencies: { typescript: '5.9.3' } })).toBe(false);
  expect(declaresAppDependency({ scripts: { ios: 'expo run:ios' } })).toBe(false);
  expect(declaresAppDependency(null)).toBe(false);
  expect(declaresAppDependency('not an object')).toBe(false);
});

test('appProjectProblem stays silent for an app, reading the nearest package.json', () => {
  expect(appProjectProblem(EXPO_PROJ)).toBe(null);
  expect(appProjectProblem(BARE_PROJ)).toBe(null);
});

test('appProjectProblem names the package.json of a directory that is not an app', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'stim-app-'));
  try {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'monorepo', devDependencies: { vitest: '5' } }));
    const problem = appProjectProblem(tmp);
    expect(problem?.kind).toBe('not-an-app');
    expect(problem?.message).toContain(join(tmp, 'package.json'));
    expect(problem?.message).toMatch(/neither react-native nor expo/);
    expect(problem?.remedy).toMatch(/app directory/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('appProjectProblem separates a package.json that does not parse from one with no app dependency', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'stim-app-'));
  try {
    writeFileSync(join(tmp, 'package.json'), '{ "name": "app", "dependencies": { "react-native": "0.81.0"');
    const problem = appProjectProblem(tmp);
    expect(problem?.kind).toBe('unreadable');
    expect(problem?.message).toContain(join(tmp, 'package.json'));
    expect(problem?.message).toMatch(/is not valid JSON/);
    expect(problem?.message).not.toMatch(/neither react-native nor expo/);
    expect(problem?.remedy).toMatch(/Fix the JSON/);
    expect(problem?.remedy).not.toMatch(/app directory/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('detectIsExpo true when expo deps + app.json has expo block', () => {
  expect(detectIsExpo(EXPO_PROJ)).toBe(true);
});

test('detectIsExpo false when expo is not in dependencies', () => {
  expect(detectIsExpo(BARE_PROJ)).toBe(false);
});

test('detectIsExpo trusts the ios script: react-native script wins even with expo dep', async () => {
  const tmp = mkdtempSync(join((await import('os')).tmpdir(), 'stim-detect-'));
  try {
    writeFileSync(
      join(tmp, 'package.json'),
      JSON.stringify({
        dependencies: { expo: '54.0.33' },
        scripts: { ios: "react-native run-ios --simulator='iPhone 16 Pro'" },
      }),
    );
    expect(detectIsExpo(tmp)).toBe(false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('detectIsExpo trusts the ios script: expo run:ios wins', async () => {
  const tmp = mkdtempSync(join((await import('os')).tmpdir(), 'stim-detect-'));
  try {
    writeFileSync(
      join(tmp, 'package.json'),
      JSON.stringify({
        dependencies: { 'react-native': '0.74.0' },
        scripts: { ios: 'expo run:ios' },
      }),
    );
    expect(detectIsExpo(tmp)).toBe(true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('detectBundleId reads ios.bundleIdentifier from app.json', () => {
  expect(detectBundleId(EXPO_PROJ)).toBe('com.example.sample');
});

test('detectBundleId falls back to pbxproj when app config has no bundle id', () => {
  expect(detectBundleId(BARE_PROJ)).toBe('me.sample');
});

test('detectAndroidPackage reads android.package from app.json', () => {
  expect(detectAndroidPackage(EXPO_PROJ)).toBe('com.example.sample');
});

test('detectAndroidPackage falls back to android/app/build.gradle (namespace)', () => {
  expect(detectAndroidPackage(BARE_PROJ)).toBe('me.sample');
});

let tmpHome: string;
beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-resolve-'));
  process.env.STIM_HOME = tmpHome;
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('resolveRegisteredProject finds a project by absolute path', () => {
  upsertProject('/Users/x/Developer/agent-1', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  const r = resolveRegisteredProject('/Users/x/Developer/agent-1');
  expect(r.found).toBe('/Users/x/Developer/agent-1');
});

test('resolveRegisteredProject matches by basename when unambiguous', () => {
  upsertProject('/Users/x/Developer/agent-1', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  const r = resolveRegisteredProject('agent-1');
  expect(r.found).toBe('/Users/x/Developer/agent-1');
});

test('resolveRegisteredProject matches by an explicit --label', () => {
  upsertProject('/Users/x/Developer/anything', { bundleId: 'a', androidPackage: 'a', isExpo: false, label: 'agent-2' });
  const r = resolveRegisteredProject('agent-2');
  expect(r.found).toBe('/Users/x/Developer/anything');
});

test('resolveRegisteredProject prefers a project label over a colliding basename', () => {
  upsertProject('/a/agent-x', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  upsertProject('/b/other', { bundleId: 'b', androidPackage: 'b', isExpo: false, label: 'agent-x' });
  const r = resolveRegisteredProject('agent-x');
  expect(r.found).toBe(null);
  expect(r.error).toMatch(/Multiple projects/);
});

test('resolveRegisteredProject errors with collision when two basenames match', () => {
  upsertProject('/a/agent-1', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  upsertProject('/b/agent-1', { bundleId: 'b', androidPackage: 'b', isExpo: false });
  const r = resolveRegisteredProject('agent-1');
  expect(r.found).toBe(null);
  expect(r.error).toMatch(/Multiple projects/);
});

test('resolveRegisteredProject errors when shortcut does not match anything', () => {
  upsertProject('/Users/x/Developer/agent-1', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  const r = resolveRegisteredProject('nope');
  expect(r.found).toBe(null);
  expect(r.error).toMatch(/No registered project/);
});

test('resolveRegisteredProject errors when path does not match anything', () => {
  upsertProject('/Users/x/Developer/agent-1', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  const r = resolveRegisteredProject('/no/such/path');
  expect(r.found).toBe(null);
  expect(r.error).toMatch(/No registered project/);
});

test('projectShortcut inherits the enclosing worktree label so same-basename app dirs stay unique', () => {
  upsertProject('/repo-worktrees/feat-a', { label: 'feat-a', worktreeRoot: true });
  upsertProject('/repo-worktrees/feat-b', { label: 'feat-b', worktreeRoot: true });

  const appDirA = '/repo-worktrees/feat-a/apps/tlon-mobile';
  const appDirB = '/repo-worktrees/feat-b/apps/tlon-mobile';
  upsertProject(appDirA, {});
  upsertProject(appDirB, {});

  const shortcutA = projectShortcut(appDirA, getProject(appDirA));
  const shortcutB = projectShortcut(appDirB, getProject(appDirB));

  expect(shortcutA).toBe('feat-a/tlon-mobile');
  expect(shortcutB).toBe('feat-b/tlon-mobile');
  expect(shortcutA).not.toBe(shortcutB);
});

test('projectShortcut returns the worktree label itself for the worktree root', () => {
  upsertProject('/repo-worktrees/feat-a', { label: 'feat-a', worktreeRoot: true });
  expect(projectShortcut('/repo-worktrees/feat-a', getProject('/repo-worktrees/feat-a'))).toBe('feat-a');
});

test('projectShortcut prefers an explicit label over worktree inheritance', () => {
  upsertProject('/repo-worktrees/feat-a', { label: 'feat-a', worktreeRoot: true });
  const appDir = '/repo-worktrees/feat-a/apps/tlon-mobile';
  upsertProject(appDir, { label: 'custom' });
  expect(projectShortcut(appDir, getProject(appDir))).toBe('custom');
});

test('projectShortcut falls back to the basename when not inside any registered worktree', () => {
  expect(projectShortcut('/Users/x/Developer/standalone', null)).toBe('standalone');
});
