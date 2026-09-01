import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'release-prep.mjs');
const PACKAGE_DIRS = ['core', 'cache', 'metro', 'expo-build-cache', 'stim-cli'];
const ACCEPTED_RANGES = new Set(['workspace:^', 'workspace:~', 'workspace:*']);

const manifestIn = (root, dir) => join(root, 'packages', dir, 'package.json');
const readManifest = (root, dir) => JSON.parse(readFileSync(manifestIn(root, dir), 'utf8'));
const versionsIn = (root) => PACKAGE_DIRS.map((dir) => readManifest(root, dir).version);

const runPrep = (root, ...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, RELEASE_PREP_ROOT: root },
  });

// A workspace pnpm can resolve without the network: every importer the lockfile
// names, and no dependency versions to re-resolve because the internal edges are
// `workspace:` ranges and `link:` targets.
const makeWorkspace = () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-release-prep-'));
  mkdirSync(join(root, 'website'), { recursive: true });
  for (const file of ['pnpm-workspace.yaml', 'pnpm-lock.yaml']) cpSync(join(REPO, file), join(root, file));
  cpSync(join(REPO, 'website', 'package.json'), join(root, 'website', 'package.json'));
  for (const dir of PACKAGE_DIRS) {
    mkdirSync(join(root, 'packages', dir), { recursive: true });
    cpSync(join(REPO, 'packages', dir, 'package.json'), manifestIn(root, dir));
  }
  const rootManifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  delete rootManifest.scripts.preinstall;
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(rootManifest, null, 2)}\n`);
  return root;
};

const withWorkspace = (body) => {
  const root = makeWorkspace();
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('--check accepts the repository as it stands', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /5 packages at \d+\.\d+\.\d+/);
  assert.match(result.stdout, /inter-package ranges, all workspace:/);
});

test('the five packages share one version and only bare workspace: ranges', () => {
  const versions = new Set(PACKAGE_DIRS.map((dir) => readManifest(REPO, dir).version));
  assert.equal(versions.size, 1, `versions are not in lockstep: ${[...versions].join(', ')}`);

  for (const dir of PACKAGE_DIRS) {
    const pkg = readManifest(REPO, dir);
    for (const group of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(pkg[group] ?? {})) {
        if (name !== 'stim-cli' && !name.startsWith('@stim-cli/')) continue;
        assert.equal(ACCEPTED_RANGES.has(range), true, `packages/${dir} ${group}.${name} is "${range}"`);
      }
    }
  }
});

test('a bump rewrites all five versions and leaves the lockfile alone', () => {
  withWorkspace((root) => {
    const before = readManifest(root, 'core').version;
    const lockBefore = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');

    const result = runPrep(root, '99.0.0');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      versionsIn(root),
      Array.from({ length: 5 }, () => '99.0.0'),
    );
    assert.notEqual(before, '99.0.0');

    const cli = readManifest(root, 'stim-cli');
    assert.equal(cli.dependencies['@stim-cli/core'], 'workspace:^', 'the bump must not touch the ranges');
    assert.equal(
      readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'),
      lockBefore,
      'a version bump must not move the lockfile',
    );
    assert.equal(runPrep(root, '--check').status, 0, result.stderr);
  });
});

test('a malformed, non-increasing, or missing version is refused without touching a manifest', () => {
  withWorkspace((root) => {
    const before = versionsIn(root);
    for (const args of [[], ['v1.2.3'], ['1.2'], ['1.2.3.4'], ['01.2.3'], ['0.0.1'], [before[0]]]) {
      const result = runPrep(root, ...args);
      assert.equal(result.status, 1, `expected a refusal for ${JSON.stringify(args)}`);
      assert.deepEqual(versionsIn(root), before, `${JSON.stringify(args)} changed a manifest`);
    }
  });
});

test('a manifest the bump cannot rewrite leaves every version where it was', () => {
  withWorkspace((root) => {
    const before = versionsIn(root);
    writeFileSync(manifestIn(root, 'stim-cli'), '{ "name": "stim-cli" }\n');

    const result = runPrep(root, '99.0.0');
    assert.equal(result.status, 1, result.stdout);
    assert.deepEqual(
      PACKAGE_DIRS.slice(0, 4).map((dir) => readManifest(root, dir).version),
      before.slice(0, 4),
      'the other four manifests must not be left bumped',
    );
  });
});

test('pnpm pack substitutes the workspace ranges the CLI ships with', () => {
  const out = mkdtempSync(join(tmpdir(), 'stim-release-pack-'));
  try {
    const packed = execFileSync('pnpm', ['pack', '--pack-destination', out], {
      cwd: join(REPO, 'packages', 'stim-cli'),
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .at(-1);
    const shipped = JSON.parse(execFileSync('tar', ['-xzOf', packed, 'package/package.json'], { encoding: 'utf8' }));
    const version = readManifest(REPO, 'stim-cli').version;

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
