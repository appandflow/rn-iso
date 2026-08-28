import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CORE_URL = new URL('../index.ts', import.meta.url).href;
const CHILD_SCRIPT = `
import fs from 'node:fs';
const { registerCache } = await import(process.argv[1]);
if (process.env.RN_ISO_DELAY_MANIFEST_READ === '1') {
  const readFileSync = fs.readFileSync.bind(fs);
  fs.readFileSync = (...args) => {
    const value = readFileSync(...args);
    if (String(args[0]).endsWith('caches.json')) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
    }
    return value;
  };
}
fs.writeFileSync(process.env.RN_ISO_READY_FILE, '');
while (process.env.RN_ISO_GO_FILE && !fs.existsSync(process.env.RN_ISO_GO_FILE)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
registerCache({ dir: process.argv[2], name: process.argv[3], prune: 'entries', note: 'test' });
`;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rn-iso-core-manifest-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(file: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await delay(5);
  }
}

function registerInChild({
  dir,
  name,
  readyFile,
  goFile,
  delayRead = false,
}: {
  dir: string;
  name: string;
  readyFile: string;
  goFile?: string;
  delayRead?: boolean;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT, CORE_URL, dir, name], {
      env: {
        ...process.env,
        RN_ISO_HOME: home,
        RN_ISO_READY_FILE: readyFile,
        ...(goFile ? { RN_ISO_GO_FILE: goFile } : {}),
        ...(delayRead ? { RN_ISO_DELAY_MANIFEST_READ: '1' } : {}),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`registration child failed (${signal || code}): ${stderr}`));
    });
  });
}

test('cache registration waits for the manifest lock', async () => {
  const manifest = join(home, 'caches.json');
  const lock = `${manifest}.lock`;
  const ready = join(home, 'ready');
  mkdirSync(lock);

  const registration = registerInChild({ dir: join(home, 'cache-a'), name: 'a', readyFile: ready });
  await waitForFile(ready);
  await delay(100);
  const wroteWhileLocked = existsSync(manifest);
  rmSync(lock, { recursive: true, force: true });
  await registration;

  expect(wroteWhileLocked).toBe(false);
  expect(existsSync(manifest)).toBe(true);
});

test('concurrent cache registrations preserve every entry', async () => {
  const manifest = join(home, 'caches.json');
  const go = join(home, 'go');
  const count = 12;
  writeFileSync(manifest, JSON.stringify({ version: 1, caches: [] }));

  const registrations = Array.from({ length: count }, (_, index) => {
    const readyFile = join(home, `ready-${index}`);
    return {
      readyFile,
      done: registerInChild({
        dir: join(home, `cache-${index}`),
        name: `cache-${index}`,
        readyFile,
        goFile: go,
        delayRead: true,
      }),
    };
  });
  await Promise.all(registrations.map(({ readyFile }) => waitForFile(readyFile)));
  writeFileSync(go, '');
  await Promise.all(registrations.map(({ done }) => done));

  const parsed = JSON.parse(readFileSync(manifest, 'utf-8')) as { caches: Array<{ dir: string }> };
  expect(new Set(parsed.caches.map((entry) => entry.dir)).size).toBe(count);
});
