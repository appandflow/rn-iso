import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'release-prep.mjs');
const PACKAGE_DIRS = ['core', 'cache', 'metro', 'expo-build-cache', 'stim-cli'];

const runPrep = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8' });

const manifest = (dir) => JSON.parse(readFileSync(join(REPO, 'packages', dir, 'package.json'), 'utf8'));

test('--check accepts the repository as it stands', () => {
  const result = runPrep('--check');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /5 packages at \d+\.\d+\.\d+/);
  assert.match(result.stdout, /inter-package ranges, all workspace:/);
});

test('the five packages share one version and only workspace: ranges', () => {
  const versions = new Set(PACKAGE_DIRS.map((dir) => manifest(dir).version));
  assert.equal(versions.size, 1, `versions are not in lockstep: ${[...versions].join(', ')}`);

  for (const dir of PACKAGE_DIRS) {
    const pkg = manifest(dir);
    for (const group of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(pkg[group] ?? {})) {
        if (name !== 'stim-cli' && !name.startsWith('@stim-cli/')) continue;
        assert.match(range, /^workspace:/, `packages/${dir} ${group}.${name} is "${range}"`);
      }
    }
  }
});

test('a malformed version, a missing version, and the current version are all refused', () => {
  for (const args of [[], ['v1.2.3'], ['1.2'], ['1.2.3.4'], [manifest('core').version]]) {
    const result = runPrep(...args);
    assert.equal(result.status, 1, `expected a refusal for ${JSON.stringify(args)}`);
  }
  assert.equal(runPrep('--check').status, 0, 'a refused run must not change the manifests');
});

test('pnpm pack substitutes the workspace ranges the CLI ships with', () => {
  const out = mkdtempSync(join(tmpdir(), 'stim-release-prep-'));
  try {
    const packed = execFileSync('pnpm', ['pack', '--pack-destination', out], {
      cwd: join(REPO, 'packages', 'stim-cli'),
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .at(-1);
    const shipped = JSON.parse(execFileSync('tar', ['-xzOf', packed, 'package/package.json'], { encoding: 'utf8' }));
    const version = manifest('stim-cli').version;

    assert.equal(shipped.version, version);
    for (const name of ['@stim-cli/cache', '@stim-cli/core', '@stim-cli/metro']) {
      assert.equal(shipped.dependencies[name], `^${version}`);
    }
    assert.equal(shipped.devDependencies['@stim-cli/expo-build-cache'], version);
    assert.equal(JSON.stringify(shipped).includes('workspace:'), false, 'a workspace: range reached the tarball');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
