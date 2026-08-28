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
import { metroShimPath, metroStoreConfirmedRoot } from '../supervisor/metro-store.ts';

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

// THE SHAPE THE FIELD ACTUALLY HAS (issue #73). Babel's ESM->CJS output
// defines every export with `Object.defineProperty(exports, name, { get })`,
// which leaves it enumerable, non-configurable and setter-less -- measured
// identical on metro-config 0.84.4 and 0.87.0. Assignment throws and
// defineProperty throws "Cannot redefine property", so a shim that MUTATES the
// namespace can never apply to any current Metro. Every case below that proves
// the substitute works uses this installer, not the plain one above.
//
// `extras` names extra exports, each a LAZY getter that appends its own
// name to a file when it is evaluated -- which is how the laziness case
// observes that requiring the module evaluated nothing.
function installBabelMetroConfig({
  stores = "[{ _root: '/project/own/store' }]",
  extras = [] as string[],
  loadConfigValue = null as string | null,
} = {}) {
  const real = `async function loadConfig(argv) {
      return { __argv: argv, cacheStores: ${stores} };
    }`;
  // The non-configurable accessor, or (for the one refusal case) the
  // non-configurable, non-writable DATA property a get trap may not lie about.
  const define = loadConfigValue
    ? `Object.defineProperty(exports, 'loadConfig', { value: ${loadConfigValue}, enumerable: true, writable: false, configurable: false });`
    : `Object.defineProperty(exports, 'loadConfig', { enumerable: true, get: function () { return real; } });`;
  const extraDefs = extras
    .map(
      (name) => `Object.defineProperty(exports, '${name}', { enumerable: true, get: function () {
           require('node:fs').appendFileSync(process.env.EVAL_LOG, '${name}\\n');
           return function ${name}() { return '${name}-result'; };
         } });`,
    )
    .join('\n');
  installModule(
    'metro-config',
    `Object.defineProperty(exports, '__esModule', { value: true });
     const real = ${real};
     ${define}
     ${extraDefs}\n`,
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

// The generic form of the two runners below: any script, with the shim
// --require'd, and BOTH streams captured. A real child process every time, for
// the reason in this file's header.
function runScript(
  script: string,
  { store = '/cache/shimtest', env = {} }: { store?: string | null; env?: Record<string, string> } = {},
) {
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
    env: childEnv(store, env),
  });
  return JSON.parse(raw) as { code: number; out: string; err: string };
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

  // --- the substitute, against the shape metro-config actually has ---------
  //
  // These are the cases the old mutate-the-namespace shim failed in the field:
  // a non-configurable accessor export cannot be assigned to and cannot be
  // redefined, so the ONLY way to hand a consumer a wrapped loadConfig is to
  // hand it a different object.

  test('a non-configurable accessor loadConfig is wrapped, with no warning at all', () => {
    installBabelMetroConfig();
    installMetroCache();
    const result = runChildCapturingStderr();
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ roots: ['/project/own/store', '/cache/shimtest'] });
    // The old shim's whole failure was one warning line here. The success line
    // is the only thing on stderr now.
    expect(result.err.split('\n').filter((l) => l.startsWith('warning:'))).toEqual([]);
  });

  test('the substitute forwards every other export, and reads as the same namespace', () => {
    installBabelMetroConfig({ extras: ['mergeConfig', 'getDefaultConfig'] });
    installMetroCache();
    const script = `
      const ns = require('metro-config');
      console.log(JSON.stringify({
        keys: Object.keys(ns),
        hasLoadConfig: 'loadConfig' in ns,
        hasMerge: 'mergeConfig' in ns,
        hasNothing: 'notAnExport' in ns,
        merged: ns.mergeConfig(),
        defaults: ns.getDefaultConfig(),
        // Identity is stable across requires: consumers store and compare it.
        sameOnSecondRequire: ns === require('metro-config'),
        // ...and so is the wrapper, which consumers bind.
        loadConfigStable: ns.loadConfig === ns.loadConfig,
        loadConfigIsWrapper: ns.loadConfig !== Object.getOwnPropertyDescriptor(ns, 'loadConfig').get.call(ns),
        // The descriptor CANNOT be rewritten for a non-configurable accessor
        // (the proxy invariant throws), so it reports the target's -- reading
        // it must not blow up, and it must still say "enumerable accessor".
        descriptor: (() => {
          const d = Object.getOwnPropertyDescriptor(ns, 'loadConfig');
          return { enumerable: d.enumerable, configurable: d.configurable, hasGet: !!d.get };
        })(),
      }));
    `;
    const result = runScript(script, { env: { EVAL_LOG: join(project, 'evaluated.txt') } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({
      keys: ['loadConfig', 'mergeConfig', 'getDefaultConfig'],
      hasLoadConfig: true,
      hasMerge: true,
      hasNothing: false,
      merged: 'mergeConfig-result',
      defaults: 'getDefaultConfig-result',
      sameOnSecondRequire: true,
      loadConfigStable: true,
      loadConfigIsWrapper: true,
      descriptor: { enumerable: true, configurable: false, hasGet: true },
    });
  });

  // THE REASON THE SUBSTITUTE IS A PROXY AND NOT A SHALLOW COPY. `{ ...ns }`
  // would also produce a namespace we could put our loadConfig on -- and it
  // would evaluate every lazy getter Babel emitted, loading modules the Expo
  // CLI may never have asked for. Only the properties somebody reads may run.
  test('laziness is preserved: requiring through the shim evaluates no other getter', () => {
    installBabelMetroConfig({ extras: ['mergeConfig', 'getDefaultConfig'] });
    installMetroCache();
    const log = join(project, 'evaluated.txt');
    const script = `
      const fs = require('node:fs');
      const read = () => (fs.existsSync(process.env.EVAL_LOG) ? fs.readFileSync(process.env.EVAL_LOG, 'utf-8').trim().split('\\n').filter(Boolean) : []);
      const ns = require('metro-config');
      const afterRequire = read();
      // Even a full Object.keys walk must not evaluate anything: ownKeys and
      // getOwnPropertyDescriptor forward, and neither reads a value.
      Object.keys(ns);
      const afterKeys = read();
      ns.loadConfig;
      const afterLoadConfig = read();
      ns.mergeConfig;
      const afterMerge = read();
      console.log(JSON.stringify({ afterRequire, afterKeys, afterLoadConfig, afterMerge }));
    `;
    const result = runScript(script, { env: { EVAL_LOG: log } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({
      afterRequire: [],
      afterKeys: [],
      // Reading loadConfig evaluates loadConfig's getter only.
      afterLoadConfig: [],
      afterMerge: ['mergeConfig'],
    });
  });

  // THE FAILURE PATH, restated for the substitute: when it cannot be built,
  // the module the consumer gets is the REAL one, unchanged, and the dev
  // server runs on the cache it would have had.
  test('a loadConfig a proxy may not lie about is one warning and the untouched module', () => {
    installBabelMetroConfig({ loadConfigValue: 'real' });
    installMetroCache();
    const script = `
      const ns = require('metro-config');
      const d = Object.getOwnPropertyDescriptor(ns, 'loadConfig');
      ns.loadConfig({ cwd: process.cwd() }).then((config) => {
        console.log(JSON.stringify({
          untouched: ns.loadConfig === d.value,
          roots: (config.cacheStores || []).map((s) => s && s._root),
        }));
      });
    `;
    const result = runScript(script);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ untouched: true, roots: ['/project/own/store'] });
    const warnings = result.err.split('\n').filter((l) => l.startsWith('warning:'));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('cannot be substituted');
  });

  // --- the success line, which is the only honest record of the outcome -----

  test('the shim announces the store ONCE, whatever loadConfig is called', () => {
    installBabelMetroConfig();
    installMetroCache();
    const script = `
      const { loadConfig } = require('metro-config');
      Promise.all([loadConfig({}), loadConfig({}), loadConfig({})]).then(() => console.log('done'));
    `;
    const result = runScript(script);
    expect(result.code).toBe(0);
    const announced = result.err.split('\n').filter((l) => l.startsWith('rn-iso-metro-store:'));
    expect(announced).toEqual(['rn-iso-metro-store: sharing Metro transforms through /cache/shimtest']);
    // AND the supervisor's parser agrees with what the real shim wrote. The
    // prefix is duplicated in two files that cannot import each other (the
    // shim may have no dependencies), so this is the only thing standing
    // between a reworded line and a confirmation that silently stops arriving.
    expect(metroStoreConfirmedRoot(announced[0] as string)).toBe('/cache/shimtest');
  });

  // The line the supervisor turns into cache_store_added is only ever written
  // when the store really is in the config -- a failed substitution says
  // nothing but the warning.
  test('a shim that could not apply announces nothing', () => {
    installBabelMetroConfig();
    // No metro-cache, so there is no FileStore to add.
    const result = runChildCapturingStderr();
    expect(result.code).toBe(0);
    expect(result.err).not.toContain('rn-iso-metro-store:');
    expect(result.err).toContain('warning: rn-iso could not share');
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
