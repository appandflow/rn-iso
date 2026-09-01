// The five packages share one version (RELEASE.md section 0) and declare their
// edges to each other with pnpm's `workspace:` protocol, which pnpm substitutes
// with the real version at pack time. So a release bumps five `version` fields
// and nothing else.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repositoryRoot = join(import.meta.dirname, '..');
const packageDirs = ['core', 'cache', 'metro', 'expo-build-cache', 'stim-cli'];
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const usage = 'usage: node scripts/release-prep.mjs <X.Y.Z[-rc.N]>\n       node scripts/release-prep.mjs --check';

const fail = (message) => {
  process.stderr.write(`release-prep: ${message}\n`);
  process.exit(1);
};

const manifestPath = (dir) => join(repositoryRoot, 'packages', dir, 'package.json');
const readManifestText = (dir) => readFileSync(manifestPath(dir), 'utf8');
const readManifest = (dir) => JSON.parse(readManifestText(dir));

const internalRanges = (manifest) => {
  const found = [];
  for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(manifest[group] ?? {})) {
      if (name === 'stim-cli' || name.startsWith('@stim-cli/')) found.push({ group, name, range });
    }
  }
  return found;
};

const audit = () => {
  const problems = [];
  const versions = new Map();
  let ranges = 0;
  for (const dir of packageDirs) {
    const manifest = readManifest(dir);
    versions.set(dir, manifest.version);
    for (const { group, name, range } of internalRanges(manifest)) {
      ranges += 1;
      if (!range.startsWith('workspace:')) {
        problems.push(`packages/${dir} ${group}.${name} is "${range}", not a workspace: range`);
      }
    }
  }
  const distinct = new Set(versions.values());
  if (distinct.size !== 1) {
    const listed = [...versions].map(([dir, version]) => `packages/${dir}=${version}`).join(' ');
    problems.push(`the five versions are not in lockstep: ${listed}`);
  }
  return { problems, version: distinct.size === 1 ? [...distinct][0] : null, ranges };
};

const setVersion = (dir, current, next) => {
  const text = readManifestText(dir);
  const matches = text.match(/^ {2}"version": "[^"]*",$/gm) ?? [];
  if (matches.length !== 1 || matches[0] !== `  "version": "${current}",`) {
    fail(`packages/${dir}/package.json has no single top-level "version": "${current}" line to rewrite`);
  }
  writeFileSync(manifestPath(dir), text.replace(matches[0], `  "version": "${next}",`));
};

const pnpm = (args) => {
  try {
    execFileSync('pnpm', args, { cwd: repositoryRoot, stdio: ['ignore', 'inherit', 'inherit'] });
  } catch {
    fail(`pnpm ${args.join(' ')} failed`);
  }
};

const [target] = process.argv.slice(2);
if (!target || target === '--help' || target === '-h') {
  process.stdout.write(`${usage}\n`);
  process.exit(target ? 0 : 1);
}

const before = audit();

if (target === '--check') {
  for (const problem of before.problems) process.stderr.write(`release-prep: ${problem}\n`);
  if (before.problems.length > 0) process.exit(1);
  process.stdout.write(`release-prep: ${packageDirs.length} packages at ${before.version}\n`);
  process.stdout.write(`release-prep: ${before.ranges} inter-package ranges, all workspace:\n`);
  process.exit(0);
}

if (!versionPattern.test(target)) {
  fail(`"${target}" is not a version. Use X.Y.Z or X.Y.Z-rc.N, with no leading "v".\n${usage}`);
}
if (before.problems.length > 0) {
  for (const problem of before.problems) process.stderr.write(`release-prep: ${problem}\n`);
  fail('refusing to bump an inconsistent tree');
}
if (before.version === target) fail(`the five packages are already at ${target}`);

for (const dir of packageDirs) setVersion(dir, before.version, target);
pnpm(['install', '--lockfile-only']);
pnpm(['install', '--frozen-lockfile', '--lockfile-only']);

const after = audit();
for (const problem of after.problems) process.stderr.write(`release-prep: ${problem}\n`);
if (after.problems.length > 0) process.exit(1);
if (after.version !== target) fail(`the manifests read ${after.version} after the bump, not ${target}`);

process.stdout.write(`\nrelease-prep: ${before.version} -> ${target}\n`);
for (const dir of packageDirs) process.stdout.write(`  packages/${dir} ${' '.repeat(18 - dir.length)}${target}\n`);
process.stdout.write(`  inter-package ranges  ${after.ranges} workspace: ranges, substituted at pack time\n`);
process.stdout.write('  pnpm-lock.yaml        in sync with the manifests\n');
process.stdout.write('\nNext: RELEASE.md section 2, step 2.\n');
