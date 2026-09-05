import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireBuildSlot,
  buildSlotPath,
  buildSlotsDir,
  listBuildSlots,
  releaseBuildSlot,
  tryAcquireBuildSlot,
} from '../engine/build-slots.ts';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-slots-'));
  process.env.STIM_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

const alwaysAlive = () => true;
const neverAlive = () => false;

describe('tryAcquireBuildSlot', () => {
  test('takes the first free slot and records the holder', () => {
    const got = tryAcquireBuildSlot({ max: 2, root: '/w/a', isAlive: alwaysAlive });
    assert(got);
    expect(got.acquired).toBe(true);
    expect(got.index).toBe(0);
    expect(existsSync(buildSlotPath(0))).toBeTruthy();
    const rec = JSON.parse(readFileSync(join(buildSlotPath(0), 'slot.json'), 'utf-8'));
    expect(rec.pid).toBe(process.pid);
    expect(rec.projectRoot).toBe('/w/a');
  });

  test('returns null when every slot is held by a LIVE builder', () => {
    for (const i of [0, 1]) {
      writeFileSync(join(mkslot(i), 'slot.json'), JSON.stringify({ pid: 999999, index: i }));
    }
    expect(tryAcquireBuildSlot({ max: 2, isAlive: alwaysAlive })).toBe(null);
  });

  test('reclaims a slot whose builder is DEAD (pid-liveness, not age)', () => {
    writeFileSync(join(mkslot(0), 'slot.json'), JSON.stringify({ pid: 999999, index: 0 }));
    writeFileSync(join(mkslot(1), 'slot.json'), JSON.stringify({ pid: 999998, index: 1 }));
    const got = tryAcquireBuildSlot({ max: 2, isAlive: neverAlive });
    assert(got);
    expect(got.acquired).toBe(true);
    expect(got.index).toBe(0);
  });
});

describe('releaseBuildSlot', () => {
  test('removes our slot', () => {
    const got = tryAcquireBuildSlot({ max: 1, isAlive: alwaysAlive });
    assert(got?.path);
    expect(releaseBuildSlot(got)).toBe(true);
    expect(existsSync(got.path)).toBe(false);
  });

  test('refuses to remove a slot another pid now holds', () => {
    const got = tryAcquireBuildSlot({ max: 1, isAlive: alwaysAlive });
    assert(got?.path);
    writeFileSync(join(got.path, 'slot.json'), JSON.stringify({ pid: 424242, index: 0 }));
    expect(releaseBuildSlot(got)).toBe(false);
    expect(existsSync(got.path)).toBeTruthy();
  });

  test('an unlimited handle releases to a no-op', () => {
    expect(releaseBuildSlot({ acquired: true, unlimited: true })).toBe(false);
  });
});

describe('acquireBuildSlot', () => {
  test('unlimited (max 0) acquires immediately without a slot on disk', async () => {
    const got = await acquireBuildSlot({ max: 0 });
    expect(got.unlimited).toBe(true);
    expect(existsSync(buildSlotsDir())).toBe(false);
  });
});

describe('listBuildSlots', () => {
  test('classifies slots by whether the builder is alive', () => {
    writeFileSync(join(mkslot(0), 'slot.json'), JSON.stringify({ pid: process.pid, index: 0, projectRoot: '/w/live' }));
    writeFileSync(join(mkslot(1), 'slot.json'), JSON.stringify({ pid: 999999, index: 1, projectRoot: '/w/dead' }));
    const slots = listBuildSlots({ isAlive: (pid) => pid === process.pid });
    const byIndex = Object.fromEntries(slots.map((s) => [s.index, s]));
    expect(byIndex[0].alive).toBe(true);
    expect(byIndex[1].alive).toBe(false);
    expect(byIndex[1].projectRoot).toBe('/w/dead');
  });
});

describe('waitForFile', () => {
  test('resolves once the file appears', async () => {
    const path = join(tmpHome, 'late');
    const timer = setTimeout(() => writeFileSync(path, ''), 30);
    try {
      await waitForFile(path);
    } finally {
      clearTimeout(timer);
    }
    expect(existsSync(path)).toBe(true);
  });

  test('gives up with a message naming the file it waited for', async () => {
    const path = join(tmpHome, 'never');
    await expect(waitForFile(path, 50)).rejects.toThrow(`timed out after 50ms waiting for ${path}`);
  });
});

describe('live: 2 slots, 3 processes', { timeout: 30_000 }, () => {
  test('the third process waits for a slot and gets one on release', async () => {
    const script = join(tmpHome, 'holder.mjs');
    const slotsUrl = new URL('../engine/build-slots.ts', import.meta.url).href;
    writeFileSync(
      script,
      [
        `const { acquireBuildSlot, releaseBuildSlot } = await import(${JSON.stringify(slotsUrl)});`,
        'const [id, dir] = process.argv.slice(2);',
        'const { writeFileSync, existsSync } = await import("node:fs");',
        'const { join } = await import("node:path");',
        'const handle = await acquireBuildSlot({ max: 2, root: "/w/" + id, intervalMs: 25, progressMs: 1e9 });',
        'writeFileSync(join(dir, "acquired-" + id), String(Date.now()));',
        'while (!existsSync(join(dir, "release-" + id))) {',
        '  await new Promise(r => setTimeout(r, 20));',
        '}',
        'releaseBuildSlot(handle);',
        'writeFileSync(join(dir, "released-" + id), String(Date.now()));',
      ].join('\n'),
    );

    const dir = tmpHome;
    const spawn = (id: string) =>
      new Promise<void>((resolve, reject) => {
        execFile(process.execPath, [script, id, dir], { env: { ...process.env, STIM_HOME: tmpHome } }, (err) =>
          err ? reject(err) : resolve(),
        );
      });

    const a = spawn('A');
    const b = spawn('B');
    await waitForFile(join(dir, 'acquired-A'));
    await waitForFile(join(dir, 'acquired-B'));

    const c = spawn('C');
    await new Promise((r) => setTimeout(r, 400));
    expect(existsSync(join(dir, 'acquired-C'))).toBe(false);

    writeFileSync(join(dir, 'release-A'), '1');
    await waitForFile(join(dir, 'acquired-C'));
    const releasedA = Number(readFileSync(join(dir, 'released-A'), 'utf-8'));
    const acquiredC = Number(readFileSync(join(dir, 'acquired-C'), 'utf-8'));
    expect(acquiredC >= releasedA).toBeTruthy();

    writeFileSync(join(dir, 'release-B'), '1');
    writeFileSync(join(dir, 'release-C'), '1');
    await Promise.all([a, b, c]);
  });
});

async function waitForFile(path: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function mkslot(i: number) {
  mkdirSync(buildSlotPath(i), { recursive: true });
  return buildSlotPath(i);
}
