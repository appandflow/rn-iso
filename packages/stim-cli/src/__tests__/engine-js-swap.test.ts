import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JS_BUNDLE_NAME,
  bundleCommand,
  detectEntryFile,
  hermesEnabledFromProperties,
  hermescArgs,
  hermescPath,
  pickEntryFile,
  readHermesEnabled,
  swapJsBundle,
} from '../engine/js-swap.ts';
import { makeChildProcess, makeExecutor, makeWriter } from './_factories.ts';

describe('hermescPath', () => {
  const root = '/proj';
  const modern = '/proj/node_modules/hermes-compiler/hermesc/osx-bin/hermesc';
  const pods = '/proj/ios/Pods/hermes-engine/destroot/bin/hermesc';
  const legacy = '/proj/node_modules/react-native/sdks/hermesc/osx-bin/hermesc';

  test('prefers the hermes-compiler package (RN 0.8x), then Pods, then the legacy sdks path', () => {
    expect(hermescPath(root, { exists: (p) => p === modern || p === legacy })).toBe(modern);
    expect(hermescPath(root, { exists: (p) => p === pods })).toBe(pods);
    expect(hermescPath(root, { exists: (p) => p === legacy })).toBe(legacy);
  });

  test('nothing found answers the legacy path, whose absence the caller already guards', () => {
    expect(hermescPath(root, { exists: () => false })).toBe(legacy);
  });
});

describe('hermesEnabledFromProperties', () => {
  test('default is enabled: no file, no key, unparseable JSON', () => {
    expect(hermesEnabledFromProperties(null)).toBe(true);
    expect(hermesEnabledFromProperties('{}')).toBe(true);
    expect(hermesEnabledFromProperties('not json at all')).toBe(true);
    expect(hermesEnabledFromProperties('[]')).toBe(true);
  });

  test('only the string "false" (or a hand-edited boolean false) disables it', () => {
    expect(hermesEnabledFromProperties('{"hermesEnabled":"false"}')).toBe(false);
    expect(hermesEnabledFromProperties('{"hermesEnabled":false}')).toBe(false);
    expect(hermesEnabledFromProperties('{"hermesEnabled":"true"}')).toBe(true);
    expect(hermesEnabledFromProperties('{"hermesEnabled":"FALSE"}')).toBe(true);
  });

  test('readHermesEnabled defaults to enabled when ios/Podfile.properties.json is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-swap-'));
    try {
      expect(readHermesEnabled(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('pickEntryFile', () => {
  test('prefers index.js, then the TS variants, in the CLI resolution order', () => {
    expect(pickEntryFile(['App.tsx', 'index.js', 'index.ts'])).toBe('index.js');
    expect(pickEntryFile(['index.tsx', 'index.ts'])).toBe('index.ts');
    expect(pickEntryFile(['index.tsx'])).toBe('index.tsx');
  });

  test('falls back to index.js when nothing matches (bundle would default to it anyway)', () => {
    expect(pickEntryFile([])).toBe('index.js');
    expect(pickEntryFile(['App.js'])).toBe('index.js');
    expect(pickEntryFile(null)).toBe('index.js');
  });

  test('detectEntryFile survives an unreadable root', () => {
    expect(detectEntryFile('/nope/never/here')).toBe('index.js');
  });
});

describe('bundleCommand', () => {
  test("expo: the project's own `expo export:embed`, fixed argv, --dev false", () => {
    expect(
      bundleCommand({ isExpo: true, entryFile: 'index.js', bundleOutput: '/t/main.jsbundle', assetsDest: '/t/assets' }),
    ).toEqual({
      file: 'npx',
      args: [
        'expo',
        'export:embed',
        '--platform',
        'ios',
        '--dev',
        'false',
        '--bundle-output',
        '/t/main.jsbundle',
        '--assets-dest',
        '/t/assets',
      ],
    });
  });

  test("bare: the project's own `react-native bundle` with the detected entry file", () => {
    expect(
      bundleCommand({
        isExpo: false,
        entryFile: 'index.ts',
        bundleOutput: '/t/main.jsbundle',
        assetsDest: '/t/assets',
      }),
    ).toEqual({
      file: 'npx',
      args: [
        'react-native',
        'bundle',
        '--platform',
        'ios',
        '--dev',
        'false',
        '--entry-file',
        'index.ts',
        '--bundle-output',
        '/t/main.jsbundle',
        '--assets-dest',
        '/t/assets',
      ],
    });
  });
});

describe('hermesc', () => {
  test("the compiler is the PROJECT's own, and the argv is -emit-binary -out", () => {
    expect(hermescPath('/w/app')).toBe('/w/app/node_modules/react-native/sdks/hermesc/osx-bin/hermesc');
    expect(hermescArgs({ bundle: '/t/main.jsbundle', out: '/t/main.jsbundle.hbc' })).toEqual([
      '-emit-binary',
      '-out',
      '/t/main.jsbundle.hbc',
      '/t/main.jsbundle',
    ]);
  });
});

let root: string;
let tmp: string;
const cachedApp = '/cache/ios/k-release-sim/Fixture.app';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-swap-root-'));
  tmp = mkdtempSync(join(tmpdir(), 'stim-swap-tmp-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

function makeBundleChild(code = 0): ChildProcess {
  const child = makeChildProcess();
  setImmediate(() => {
    child.stdout?.emit('data', 'Writing bundle output...\n');
    child.emit('exit', code, null);
  });
  return child;
}

interface Call {
  op: string;
  file?: string;
  args?: string[];
}

function harness({ bundleExit = 0, failOn = null as string | null, hermescExists = true, bundleWritten = true } = {}) {
  const calls: Call[] = [];
  const appCopy = join(tmp, 'Fixture.app');
  const bundleOutput = join(tmp, JS_BUNDLE_NAME);
  const exec = makeExecutor({
    runFile: (file, args = []) => {
      calls.push({ op: 'runFile', file, args });
      if (failOn && (file === failOn || args[0] === failOn)) throw new Error(`${failOn} blew up`);
      return '';
    },
  });
  const spawnFn = (cmd: string, args: string[], _opts: Record<string, unknown>) => {
    calls.push({ op: 'spawn', file: cmd, args });
    return makeBundleChild(bundleExit);
  };
  const exists = (p: string) => {
    if (p === hermescPath(root)) return hermescExists;
    if (p === bundleOutput) return bundleWritten;
    return existsSync(p);
  };
  const writer = makeWriter();
  const run = (overrides: Record<string, unknown> = {}) =>
    swapJsBundle({
      root,
      isExpo: true,
      cachedAppPath: cachedApp,
      logWriter: writer,
      exec,
      spawnFn,
      mkdtemp: () => tmp,
      exists,
      heartbeatMs: 0,
      ...overrides,
    });
  return { calls, run, appCopy, bundleOutput, writer };
}

describe('swapJsBundle', () => {
  test('the order IS the product: copy aside, bundle, hermesc, replace, re-sign -- and the cache entry is never written', async () => {
    const { calls, run, appCopy, bundleOutput } = harness();
    const result = await run();
    expect(result.ok).toBe(true);
    expect(result.appPath).toBe(appCopy);
    expect(result.tmpDir).toBe(tmp);
    expect(result.hermes).toBe(true);

    const shape = calls.map((c) => c.file);
    expect(shape).toEqual(['cp', 'npx', hermescPath(root), 'mv', 'cp', 'cp', 'codesign']);

    const copyAside = calls[0];
    expect(copyAside?.args).toEqual(['-c', '-R', cachedApp, appCopy]);
    const bundle = calls[1];
    expect(bundle?.args?.slice(0, 2)).toEqual(['expo', 'export:embed']);
    expect(bundle?.args).toContain(bundleOutput);
    const codesign = calls.at(-1);
    expect(codesign?.args).toEqual(['--force', '--sign', '-', appCopy]);
    for (const call of calls.slice(1)) {
      expect(call.args ?? []).not.toContain(cachedApp);
    }
  });

  test('bare project: the bundle step is `react-native bundle` with the detected entry file', async () => {
    const { calls, run } = harness();
    const result = await run({ isExpo: false });
    expect(result.ok).toBe(true);
    const bundle = calls.find((c) => c.op === 'spawn');
    expect(bundle?.args?.slice(0, 2)).toEqual(['react-native', 'bundle']);
    expect(bundle?.args).toContain('--entry-file');
  });

  test('hermes off (Podfile.properties.json says "false") skips hermesc entirely', async () => {
    const { calls, run } = harness();
    const result = await run({ hermesEnabled: false });
    expect(result.ok).toBe(true);
    expect(result.hermes).toBe(false);
    expect(calls.some((c) => c.file === hermescPath(root))).toBe(false);
  });

  test('hermesc missing is the GUARD, not a failure: plain JS bundle plus a note', async () => {
    const { calls, run } = harness({ hermescExists: false });
    const result = await run();
    expect(result.ok).toBe(true);
    expect(result.hermes).toBe(false);
    expect(result.note).toMatch(/hermesc not found/);
    expect(calls.some((c) => c.file === hermescPath(root))).toBe(false);
    expect(calls.at(-1)?.file).toBe('codesign');
  });

  test('a failed bundle command is a return value naming the step, and nothing downstream runs', async () => {
    const { calls, run } = harness({ bundleExit: 1 });
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.step).toBe('bundle');
    expect(result.lastLines).toEqual(['Writing bundle output...']);
    expect(existsSync(tmp)).toBe(false);
    expect(calls.some((c) => c.file === 'codesign')).toBe(false);
  });

  test('a bundle that exits 0 without writing the file is still a bundle failure', async () => {
    const { run } = harness({ bundleWritten: false });
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.step).toBe('bundle');
    expect(result.reason).toMatch(/wrote no main\.jsbundle/);
  });

  test('a hermesc crash fails at the hermesc step', async () => {
    const { run } = harness({ failOn: hermescPath(root) });
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.step).toBe('hermesc');
  });

  test('a codesign failure fails at the codesign step -- an unsigned swap is never handed back', async () => {
    const { run } = harness({ failOn: 'codesign' });
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.step).toBe('codesign');
    expect(result.appPath).toBeUndefined();
  });

  test('the clone-first copy falls back to a plain cp -R when -c is refused', async () => {
    const calls: Call[] = [];
    let first = true;
    const exec = makeExecutor({
      runFile: (file, args = []) => {
        calls.push({ op: 'runFile', file, args });
        if (file === 'cp' && first) {
          first = false;
          throw new Error('cp: -c not supported');
        }
        return '';
      },
    });
    const { run } = harness();
    const result = await run({ exec });
    expect(result.ok).toBe(true);
    expect(calls[0]?.args?.[0]).toBe('-c');
    expect(calls[1]?.args).toEqual(['-R', cachedApp, join(tmp, 'Fixture.app')]);
  });
});
