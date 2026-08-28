import { vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home;
let cacheDir;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-cli-reg-home-'));
  cacheDir = mkdtempSync(join(tmpdir(), 'stim-cli-reg-cache-'));
  process.env.STIM_CLI_HOME = home;
  process.env.STIM_CLI_BUILD_CACHE = cacheDir;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
  delete process.env.STIM_CLI_HOME;
  delete process.env.STIM_CLI_BUILD_CACHE;
});

test('registers itself with no stim-cli installed', async () => {
  vi.resetModules();
  const bc = await import('../index.ts');
  await bc.resolveBuildCache({ platform: 'ios', fingerprintHash: 'deadbeef' });

  const manifest = JSON.parse(readFileSync(join(home, 'caches.json'), 'utf-8'));
  const entry = manifest.caches.find((c) => c.dir === cacheDir);
  expect(entry).toBeTruthy();
  expect(entry.prune).toBe('entries');
});

test('repeated registration updates rather than duplicating', async () => {
  vi.resetModules();
  const bc = await import('../index.ts');
  await bc.resolveBuildCache({ platform: 'ios', fingerprintHash: 'a' });
  await bc.resolveBuildCache({ platform: 'ios', fingerprintHash: 'b' });

  const manifest = JSON.parse(readFileSync(join(home, 'caches.json'), 'utf-8'));
  expect(manifest.caches.filter((c) => c.dir === cacheDir).length).toBe(1);
});

test('an unwritable manifest does not break the cache', async () => {
  process.env.STIM_CLI_HOME = '/dev/null/nope';
  vi.resetModules();
  const bc = await import('../index.ts');
  const result = await bc.resolveBuildCache({ platform: 'ios', fingerprintHash: 'x' });
  expect(result).toBe(null);
  expect(existsSync('/dev/null/nope')).toBe(false);
});
