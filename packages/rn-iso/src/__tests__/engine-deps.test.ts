// engine/deps.js -- CocoaPods staleness (pure) and `pod install` (mocked
// executor: this suite never runs a real pod install).
//
// The three-outcome shape is the point of the pure half: "no CocoaPods in
// this project at all" must not read as "stale", or every Expo build would
// run a pod install with no Podfile to install from.
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEPS_ERROR, podsAreStale, readPodState, runPodInstall } from '../engine/deps.ts';

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rn-iso-deps-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const LOCK = 'PODFILE CHECKSUM: abc123\nCOCOAPODS: 1.15.2\n';

describe('podsAreStale', () => {
  test('identical lock and manifest are not stale', () => {
    expect(podsAreStale(LOCK, LOCK)).toEqual({ stale: false });
  });

  test('a differing manifest is stale, with the reason', () => {
    const result = podsAreStale(LOCK, 'PODFILE CHECKSUM: OLD\nCOCOAPODS: 1.15.2\n');
    expect(result.stale).toBe(true);
    expect(result.reason).toMatch(/differ/);
  });

  test('a missing Manifest.lock (no Pods installed) is stale', () => {
    const result = podsAreStale(LOCK, null);
    expect(result.stale).toBe(true);
    expect(result.reason).toMatch(/Manifest\.lock is missing/);
  });

  test('a Pods sandbox with no Podfile.lock describing it is stale', () => {
    const result = podsAreStale(null, LOCK);
    expect(result.stale).toBe(true);
    expect(result.reason).toMatch(/Podfile\.lock is missing/);
  });

  // The case that has to be its own outcome: an Expo project before prebuild,
  // or a project on Swift Package Manager, has neither file. Calling that
  // stale would schedule a pod install that cannot work.
  test('neither file present means no CocoaPods here, which is NOT stale', () => {
    expect(podsAreStale(null, null)).toEqual({ noPods: true, stale: false });
    expect(podsAreStale(undefined, undefined)).toEqual({ noPods: true, stale: false });
  });

  // CocoaPods writes both files itself, so a line-ending difference is a
  // checkout artifact, not a dependency change -- and treating it as one
  // reinstalls the sandbox on every single build, forever.
  test('line-ending and trailing-whitespace differences are not a dependency change', () => {
    expect(podsAreStale(LOCK, LOCK.replace(/\n/g, '\r\n'))).toEqual({ stale: false });
    expect(podsAreStale(LOCK, `${LOCK}\n\n`)).toEqual({ stale: false });
  });
});

describe('readPodState', () => {
  test('reports the two files and the Podfile, with absent files as null', () => {
    mkdirSync(join(root, 'ios'), { recursive: true });
    expect(readPodState(root)).toEqual({ hasPodfile: false, lockText: null, manifestText: null });

    writeFileSync(join(root, 'ios', 'Podfile'), "platform :ios, '15.1'\n");
    writeFileSync(join(root, 'ios', 'Podfile.lock'), LOCK);
    mkdirSync(join(root, 'ios', 'Pods'), { recursive: true });
    writeFileSync(join(root, 'ios', 'Pods', 'Manifest.lock'), LOCK);

    const state = readPodState(root);
    expect(state.hasPodfile).toBe(true);
    expect(podsAreStale(state.lockText, state.manifestText)).toEqual({ stale: false });
  });
});

// A child that streams the given lines and then exits with the given code.
function fakePodChild({ lines = [], code = 0, signal = null, error = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.pid = 4242;
  setImmediate(() => {
    for (const line of lines) child.stdout.emit('data', `${line}\n`);
    if (error) child.emit('error', error);
    else child.emit('exit', code, signal);
  });
  return child;
}

function collectingWriter() {
  const records = [];
  return { records, write: (r) => { records.push(r); return true; } };
}

describe('runPodInstall', () => {
  test('runs `pod install` with cwd ios/ and streams the transcript as build/debug records', async () => {
    mkdirSync(join(root, 'ios'), { recursive: true });
    const writer = collectingWriter();
    let spawned = null;
    const result = await runPodInstall(root, writer, {
      spawnFn: (cmd, args, opts) => {
        spawned = { cmd, args, opts };
        return fakePodChild({ lines: ['Analyzing dependencies', 'Pod installation complete!'] });
      },
      now: (() => { let t = 1000; return () => (t += 500); })(),
    });
    expect(result.ok).toBe(true);
    expect(spawned.cmd).toBe('pod');
    expect(spawned.args).toEqual(['install']);
    expect(spawned.opts.cwd).toBe(join(root, 'ios'));
    expect(writer.records.map(r => [r.src, r.level, r.msg])).toEqual([['build', 'debug', 'Analyzing dependencies'], ['build', 'debug', 'Pod installation complete!']]);
  });

  test('a non-zero exit comes back as {failed, lastLines}, never a throw', async () => {
    mkdirSync(join(root, 'ios'), { recursive: true });
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: () => fakePodChild({ lines: ['Analyzing dependencies', "[!] CocoaPods could not find compatible versions for pod \"RCT-Folly\""], code: 1 }),
    });
    expect(result.failed).toBe(true);
    expect(result.code).toBe(DEPS_ERROR);
    expect(result.reason).toMatch(/exit code 1/);
    expect(result.lastLines.join('\n')).toMatch(/could not find compatible versions/);
  });

  // The single most common cause, and it looks like a bare ENOENT unless it
  // is named: an agent that reads "spawn pod ENOENT" retries, one that reads
  // "install CocoaPods" stops.
  test('a missing `pod` binary is reported as a structured remedy, not an ENOENT', async () => {
    mkdirSync(join(root, 'ios'), { recursive: true });
    const err = new Error('spawn pod ENOENT');
    err.code = 'ENOENT';
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: () => { throw err; },
    });
    expect(result.failed).toBe(true);
    expect(result.code).toBe(DEPS_ERROR);
    expect(result.reason).toMatch(/CocoaPods is not installed/);
    expect(result.remedy).toMatch(/brew install cocoapods/);
  });

  test('an ENOENT delivered as a spawn `error` event is recognized the same way', async () => {
    mkdirSync(join(root, 'ios'), { recursive: true });
    const err = new Error('spawn pod ENOENT');
    err.code = 'ENOENT';
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: () => fakePodChild({ error: err }),
    });
    expect(result.reason).toMatch(/CocoaPods is not installed/);
  });

  test('refuses when there is no ios/ directory at all', async () => {
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: () => { throw new Error('must not spawn'); },
    });
    expect(result.failed).toBe(true);
    expect(result.reason).toMatch(/No ios\/ directory/);
  });
});
