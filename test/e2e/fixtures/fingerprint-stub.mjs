// A small @expo/fingerprint-compatible leaf hasher for the fast cross-platform
// E2E. Production imports @expo/fingerprint directly; this function is injected
// through fingerprintProject's test seam so the suite stays deterministic and
// does not spend minutes invoking native project discovery for every assertion.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ALL_PLATFORMS = ['ios', 'android'];
const IGNORED_SEGMENTS = new Set(['.git', 'node_modules']);

function walk(dir, acc, root) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
    if (IGNORED_SEGMENTS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc, root);
    } else if (entry.isFile()) {
      let contents = '';
      try {
        contents = readFileSync(full, 'utf-8');
      } catch {
        contents = `<<unreadable:${statSync(full).size}>>`;
      }
      acc.push([relative(root, full).split('\\').join('/'), contents]);
    }
  }
}

/**
 * @param {string} projectRoot
 * @param {{ platforms?: string[] }} [options]
 * @returns {Promise<{ hash: string, sources: Array<{ type: string, filePath: string }> }>}
 */
export async function createFingerprintAsync(projectRoot, options = {}) {
  const platforms = Array.isArray(options?.platforms) && options.platforms.length ? options.platforms : ALL_PLATFORMS;
  const files = [['package.json', safeRead(join(projectRoot, 'package.json'))]];
  for (const platform of platforms) {
    walk(join(projectRoot, platform), files, projectRoot);
  }

  const sortedFiles = files.toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const hasher = createHash('sha256');
  // Scope goes into the hash too, so an ['android'] fingerprint can never
  // collide with an ['ios'] one even for a project whose two native trees
  // happen to be byte-identical.
  hasher.update(`platforms:${[...platforms].toSorted().join(',')}\n`);
  for (const [path, contents] of sortedFiles) {
    hasher.update(path);
    hasher.update('\0');
    hasher.update(contents);
    hasher.update('\0');
  }
  return {
    hash: hasher.digest('hex'),
    sources: sortedFiles.map(([filePath]) => ({ type: 'file', filePath })),
  };
}

function safeRead(path) {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}
