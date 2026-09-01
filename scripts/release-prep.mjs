// The five packages share one version (RELEASE.md section 0) and declare their
// edges to each other with pnpm's `workspace:` protocol, which pnpm substitutes
// with the real version at pack time. So a release bumps five `version` fields
// and nothing else.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repositoryRoot = process.env.RELEASE_PREP_ROOT ?? join(import.meta.dirname, '..');
const packageDirs = ['core', 'cache', 'metro', 'expo-build-cache', 'stim-cli'];
const versionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*)?$/;
const acceptedRanges = new Set(['workspace:^', 'workspace:~', 'workspace:*']);
const usage = 'usage: node scripts/release-prep.mjs <X.Y.Z[-rc.N]>\n       node scripts/release-prep.mjs --check';

const fail = (message) => {
  process.stderr.write(`release-prep: ${message}\n`);
  process.exit(1);
};

const manifestPath = (dir) => join(repositoryRoot, 'packages', dir, 'package.json');
const readManifestText = (dir) => {
  try {
    return readFileSync(manifestPath(dir), 'utf8');
  } catch (error) {
    return fail(`cannot read ${manifestPath(dir)}: ${error.message}`);
  }
};
const readManifest = (dir) => {
  const text = readManifestText(dir);
  try {
    return JSON.parse(text);
  } catch (error) {
    return fail(`${manifestPath(dir)} is not valid JSON: ${error.message}`);
  }
};

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
      // A `workspace:` range carrying its own semver (`workspace:^1.2.3`) is
      // still a hand-maintained number, which is the thing this replaces.
      if (!acceptedRanges.has(range)) {
        problems.push(`packages/${dir} ${group}.${name} is "${range}", not one of ${[...acceptedRanges].join(', ')}`);
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

const parseVersion = (version) => {
  const [core, prerelease] = version.split('-');
  return { core: core.split('.').map(Number), prerelease: prerelease ? prerelease.split('.') : null };
};

// Semver precedence, enough for X.Y.Z and X.Y.Z-rc.N: a prerelease sorts below
// its release, and prerelease identifiers compare numerically when both are
// numeric, otherwise as strings.
const compareVersions = (left, right) => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) - Number(y);
    return x < y ? -1 : 1;
  }
  return 0;
};

const bumped = (dir, current, next) => {
  const text = readManifestText(dir);
  const matches = text.match(/^ {2}"version": "[^"]*",$/gm) ?? [];
  if (matches.length !== 1 || matches[0] !== `  "version": "${current}",`) {
    fail(`packages/${dir}/package.json has no single top-level "version": "${current}" line to rewrite`);
  }
  return { dir, before: text, after: text.replace(matches[0], `  "version": "${next}",`) };
};

const pnpm = (args) => {
  execFileSync('pnpm', args, { cwd: repositoryRoot, stdio: ['ignore', 'inherit', 'inherit'] });
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
if (compareVersions(target, before.version) <= 0) {
  fail(`${target} does not come after ${before.version}, which the five packages already carry`);
}

// Every manifest is validated and its new text computed before anything is
// written, and the originals go back if the install or the re-audit fails, so a
// refusal never leaves the five versions half-bumped.
const rewrites = packageDirs.map((dir) => bumped(dir, before.version, target));
for (const { dir, after } of rewrites) writeFileSync(manifestPath(dir), after);

const restore = (message) => {
  for (const { dir, before: original } of rewrites) writeFileSync(manifestPath(dir), original);
  fail(`${message}\nthe five manifests were restored to ${before.version}`);
};

try {
  pnpm(['install', '--lockfile-only']);
  pnpm(['install', '--frozen-lockfile', '--lockfile-only']);
} catch {
  restore('pnpm could not refresh the lockfile for the bumped manifests');
}

const after = audit();
if (after.problems.length > 0) restore(after.problems.join('\n'));
if (after.version !== target) restore(`the manifests read ${after.version} after the bump, not ${target}`);

process.stdout.write(`\nrelease-prep: ${before.version} -> ${target}\n`);
for (const dir of packageDirs) process.stdout.write(`  ${`packages/${dir}`.padEnd(28)}${target}\n`);
process.stdout.write(
  `  ${'inter-package ranges'.padEnd(28)}${after.ranges} workspace: ranges, substituted at pack time\n`,
);
process.stdout.write(`  ${'pnpm-lock.yaml'.padEnd(28)}still matches the manifests\n`);
process.stdout.write('\nNext: RELEASE.md section 2, step 2.\n');
