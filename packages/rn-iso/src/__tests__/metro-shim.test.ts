// The Expo half of the shared Metro transform cache: the CJS shim rn-iso
// --requires into the project's own `expo start`.
//
// EVERY CASE HERE RUNS THE SHIM IN A REAL CHILD NODE PROCESS, against a fake
// metro-config / metro-cache pair on disk. That is deliberate and it is the
// same reasoning as CLAUDE.md item 9: the shim's whole job is to intercept a
// require() inside somebody else's process, and no in-process mock can prove
// that the interception happens where the Expo CLI's own require would land.
// It patches Module._load, it resolves metro-cache relative to whichever
// metro-config was actually loaded, and it must never throw -- all three are
// only observable from the outside.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { metroShimPath } from '../supervisor/metro-store.ts';

let project: string;
let shim: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'rn-iso-shim-'));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'shimtest' }));
  const found = metroShimPath();
  if (!found) throw new Error('the shim is missing from this checkout');
  shim = found;
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

function installModule(name: string, source: string) {
  const dir = join(project, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }));
  writeFileSync(join(dir, 'index.js'), source);
}

// A metro-config whose loadConfig returns whatever cacheStores the "project"
// configured, so the append is observable in the resolved config.
function installMetroConfig(stores = "[{ _root: '/project/own/store' }]") {
  installModule(
    'metro-config',
    `exports.loadConfig = async function loadConfig(argv) {
       return { __argv: argv, cacheStores: ${stores} };
     };\n`,
  );
}

function installMetroCache() {
  installModule(
    'metro-cache',
    `class FileStore {
       constructor(options) { this._root = options.root; }
     }
     exports.FileStore = FileStore;\n`,
  );
}

// The script the child runs: load metro-config the way the Expo CLI does, call
// loadConfig, and print what came back.
const DRIVER = `
  const { loadConfig } = require('metro-config');
  loadConfig({ cwd: process.cwd() }).then((config) => {
    console.log(JSON.stringify({ roots: (config.cacheStores || []).map((s) => s && s._root) }));
  });
`;

// NODE_PATH is stripped from every child here. The test runner sets it to its
// own pnpm store, which contains a real metro-cache -- so a child that
// inherited it would resolve one from OUTSIDE the fake project and the
// "metro-cache is missing" case could never be reached.
function childEnv(store: string | null, extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...(store === null ? {} : { RN_ISO_METRO_STORE: store }),
    RN_ISO_PROJECT_ROOT: project,
    ...extra,
  };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  return env;
}

function runChild({
  store = '/cache/shimtest',
  env = {},
}: { store?: string | null; env?: Record<string, string> } = {}) {
  const child = execFileSync(process.execPath, ['--require', shim, '-e', DRIVER], {
    cwd: project,
    encoding: 'utf-8',
    env: childEnv(store, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { stdout: child.toString() };
}

// execFileSync throws on a non-zero exit and does not hand back stderr on
// success, so the cases that assert the WARNING run the child with stderr
// captured into stdout instead.
function runChildCapturingStderr(store: string | null = '/cache/shimtest') {
  const script = `
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(process.execPath, ['--require', ${JSON.stringify(shim)}, '-e', ${JSON.stringify(DRIVER)}], {
      cwd: process.cwd(), encoding: 'utf-8',
    });
    console.log(JSON.stringify({ code: r.status, out: r.stdout, err: r.stderr }));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: project,
    encoding: 'utf-8',
    env: childEnv(store),
  });
  return JSON.parse(out) as { code: number; out: string; err: string };
}

describe('the metro-config shim, in a real child process', () => {
  test("appends the store to the config metro-config returns, keeping the project's own", () => {
    installMetroConfig();
    installMetroCache();
    const { stdout } = runChild();
    expect(JSON.parse(stdout)).toEqual({ roots: ['/project/own/store', '/cache/shimtest'] });
  });

  test('a config with no cacheStores at all gets exactly ours', () => {
    installMetroConfig('undefined');
    installMetroCache();
    expect(JSON.parse(runChild().stdout)).toEqual({ roots: ['/cache/shimtest'] });
  });

  test('a store already pointing at our root is not added twice', () => {
    installMetroConfig("[{ _root: '/cache/shimtest' }]");
    installMetroCache();
    expect(JSON.parse(runChild().stdout)).toEqual({ roots: ['/cache/shimtest'] });
  });

  // The kill switch reaches the shim as an unset variable, and an unset
  // variable must mean "do nothing", not "guess a path".
  test('no RN_ISO_METRO_STORE means the shim changes nothing and says nothing', () => {
    installMetroConfig();
    installMetroCache();
    const result = runChildCapturingStderr(null);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ roots: ['/project/own/store'] });
    expect(result.err).toBe('');
  });

  // THE FAIL-SOFT PATH, which is the whole reason this injection is allowed to
  // exist: a shim that cannot apply costs a cache, never a dev server.
  test('an unresolvable metro-cache leaves the dev server working and writes ONE warning line', () => {
    installMetroConfig();
    // No metro-cache installed at all.
    const result = runChildCapturingStderr();
    expect(result.code).toBe(0);
    // The config still resolved, with the project's own stores untouched.
    expect(JSON.parse(result.out)).toEqual({ roots: ['/project/own/store'] });
    const lines = result.err.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    // "warning:" leads on purpose: server-expo infers a record's level from
    // the line's first word, so this lands in the timeline as a warn.
    expect(lines[0]?.startsWith('warning: rn-iso could not share')).toBe(true);
    expect(lines[0]).toContain('metro-cache is not resolvable');
  });

  test('a metro-config with no loadConfig is a warning, not a crash', () => {
    installModule('metro-config', 'exports.notLoadConfig = 1;\n');
    installMetroCache();
    const script = "require('metro-config'); console.log('survived');";
    const outer = `
      const { spawnSync } = require('node:child_process');
      const r = spawnSync(process.execPath, ['--require', ${JSON.stringify(shim)}, '-e', ${JSON.stringify(script)}], {
        cwd: process.cwd(), encoding: 'utf-8',
      });
      console.log(JSON.stringify({ code: r.status, out: r.stdout, err: r.stderr }));
    `;
    const raw = execFileSync(process.execPath, ['-e', outer], {
      cwd: project,
      encoding: 'utf-8',
      env: childEnv('/cache/shimtest'),
    });
    const result = JSON.parse(raw) as { code: number; out: string; err: string };
    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe('survived');
    expect(result.err).toContain('exports no loadConfig()');
  });

  // Nothing else in the process may be disturbed: the shim hooks every
  // require, so a require of anything but metro-config has to pass through
  // untouched.
  test('every other require is unaffected', () => {
    installMetroConfig();
    installMetroCache();
    const script = "const p = require('node:path'); console.log(p.join('a', 'b'));";
    const out = execFileSync(process.execPath, ['--require', shim, '-e', script], {
      cwd: project,
      encoding: 'utf-8',
      env: childEnv('/cache/shimtest'),
    });
    expect(out.trim()).toBe(join('a', 'b'));
  });
});
