import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const dist = join(fileURLToPath(import.meta.url), '..', '..', 'dist', 'index.mjs');

test('the timeout fires in a process with nothing else keeping the loop alive', async () => {
  expect(existsSync(dist)).toBe(true);

  const script = `
    const { callWithTimeout } = await import(${JSON.stringify(dist)});
    const outcome = await callWithTimeout(() => new Promise(() => {}), 150);
    process.stdout.write(JSON.stringify(outcome));
  `;

  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { timeout: 20_000 });
  expect(JSON.parse(stdout)).toEqual({ timedOut: true });
}, 30_000);
