import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

let home;
let cacheDir;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rn-iso-reg-home-'));
  cacheDir = mkdtempSync(join(tmpdir(), 'rn-iso-reg-cache-'));
  process.env.RN_ISO_HOME = home;
  process.env.RN_ISO_BUILD_CACHE = cacheDir;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
  delete process.env.RN_ISO_BUILD_CACHE;
});

// The documented way to use the CLI is `npx rn-iso`, so it is usually NOT a
// dependency of the project. Registering through it meant registration silently
// never happened for most users -- a real build populated 45 MB of cache and
// `gc` still reported no cache.
test('registers itself with no rn-iso installed', async () => {
  delete require_.cache[require_.resolve('../index.js')];
  const bc = require_('../index.js');
  await bc.resolveBuildCache({ platform: 'ios', fingerprintHash: 'deadbeef' });

  const manifest = JSON.parse(readFileSync(join(home, 'caches.json'), 'utf-8'));
  const entry = manifest.caches.find(c => c.dir === cacheDir);
  assert.ok(entry, 'the cache must appear in the manifest');
  assert.equal(entry.prune, 'entries', 'entries are independent directories keyed by fingerprint');
});

// resolveBuildCache runs on every build, so registration must not accumulate.
test('repeated registration updates rather than duplicating', async () => {
  delete require_.cache[require_.resolve('../index.js')];
  const bc = require_('../index.js');
  await bc.resolveBuildCache({ platform: 'ios', fingerprintHash: 'a' });
  await bc.resolveBuildCache({ platform: 'ios', fingerprintHash: 'b' });

  const manifest = JSON.parse(readFileSync(join(home, 'caches.json'), 'utf-8'));
  assert.equal(manifest.caches.filter(c => c.dir === cacheDir).length, 1);
});

// A cache that cannot announce itself must still work: an unwritable manifest
// is a housekeeping problem, not a build failure.
test('an unwritable manifest does not break the cache', async () => {
  process.env.RN_ISO_HOME = '/dev/null/nope';
  delete require_.cache[require_.resolve('../index.js')];
  const bc = require_('../index.js');
  const result = await bc.resolveBuildCache({ platform: 'ios', fingerprintHash: 'x' });
  assert.equal(result, null, 'a miss is still a miss');
  assert.equal(existsSync('/dev/null/nope'), false);
});
