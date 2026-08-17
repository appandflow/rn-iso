import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resetExecutor } from '../src/exec.js';
import { detectPackageManager, findLockfile } from '../src/runner.js';

let tmpProj;

function makeProj(files) {
  tmpProj = mkdtempSync(join(tmpdir(), 'rn-iso-runner-'));
  for (const [rel, content] of Object.entries(files)) {
    const dest = join(tmpProj, rel);
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, content);
  }
  return tmpProj;
}

afterEach(() => {
  if (tmpProj) rmSync(tmpProj, { recursive: true, force: true });
  tmpProj = null;
  resetExecutor();
});

test('detectPackageManager picks based on lockfile', () => {
  const yarnRoot = makeProj({ 'yarn.lock': '' });
  assert.equal(detectPackageManager(yarnRoot), 'yarn');
  rmSync(yarnRoot, { recursive: true });

  const pnpmRoot = makeProj({ 'pnpm-lock.yaml': '' });
  assert.equal(detectPackageManager(pnpmRoot), 'pnpm');
  rmSync(pnpmRoot, { recursive: true });

  const bunRoot = makeProj({ 'bun.lock': '' });
  assert.equal(detectPackageManager(bunRoot), 'bun');
  rmSync(bunRoot, { recursive: true });

  const npmRoot = makeProj({ 'package-lock.json': '' });
  assert.equal(detectPackageManager(npmRoot), 'npm');
  rmSync(npmRoot, { recursive: true });

  const noLock = makeProj({ 'package.json': '{}' });
  assert.equal(detectPackageManager(noLock), 'npm'); // default
});

test('detectPackageManager walks up to find lockfile in monorepo root', () => {
  // Layout:
  //   /tmp/.../    <-- yarn.lock here (workspace root)
  //   /tmp/.../apps/mobile/  <-- our "project" (no lockfile of its own)
  const root = makeProj({
    'yarn.lock': '',
    'package.json': JSON.stringify({ workspaces: ['apps/*'] }),
    'apps/mobile/package.json': JSON.stringify({ name: 'mobile' }),
  });
  const projectRoot = join(root, 'apps/mobile');
  assert.equal(detectPackageManager(projectRoot), 'yarn');
});

test('findLockfile returns the lockfile dir and pm', () => {
  const root = makeProj({
    'pnpm-lock.yaml': '',
    'apps/mobile/package.json': '{}',
  });
  const found = findLockfile(join(root, 'apps/mobile'));
  assert.equal(found.pm, 'pnpm');
  assert.equal(found.dir, root);
});

test('findLockfile prefers nearest lockfile when nested ones exist', () => {
  // Some monorepos intentionally have nested lockfiles per package; pick the
  // closest one, not the workspace root's.
  const root = makeProj({
    'yarn.lock': '',
    'apps/mobile/pnpm-lock.yaml': '',
    'apps/mobile/package.json': '{}',
  });
  const found = findLockfile(join(root, 'apps/mobile'));
  assert.equal(found.pm, 'pnpm');
  assert.equal(found.dir, join(root, 'apps/mobile'));
});
