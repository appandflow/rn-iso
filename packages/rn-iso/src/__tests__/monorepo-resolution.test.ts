// Node resolution, not path joining.
//
// One mistake produced four bugs, and both real repos it was found on are
// monorepos that HOIST: neither a pnpm workspace nor a yarn-workspaces one
// puts `expo` (or its .bin shim) under the app's own node_modules. Every test
// here runs against a scratch workspace built to that shape --
//
//   <ws>/node_modules/expo/{package.json,bin/cli}   the hoisted package
//   <ws>/node_modules/.bin/expo                     the hoisted shim
//   <ws>/packages/app/                              the app, with NO node_modules
//
// -- because a mock cannot fail the way the real thing did: every one of these
// paths existed, and rn-iso reported "run npm install" at a fully installed
// repo.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runDoctor } from '../doctor.ts';
import { detectIsExpo, isPackageResolvable, resolvePackageJson } from '../project.ts';
import { MODE_BARE, MODE_EXPO, runSupervisor } from '../supervisor/run.ts';
import { expoBinFromPackage, expoBinPath, findBinUpward } from '../supervisor/server-expo.ts';

let home: string;
let ws: string;
let app: string;

// The hoisted install, as an installer would leave it.
function write(path: string, text: string, { exec = false } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (exec) chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rn-iso-home-'));
  process.env.RN_ISO_HOME = home;
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'rn-iso-mono-')));
  app = join(ws, 'packages', 'app');

  write(join(ws, 'package.json'), JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }));
  write(
    join(ws, 'node_modules', 'expo', 'package.json'),
    JSON.stringify({
      name: 'expo',
      version: '57.0.8',
      bin: { expo: 'bin/cli', fingerprint: 'bin/fingerprint' },
    }),
  );
  write(join(ws, 'node_modules', 'expo', 'bin', 'cli'), '#!/usr/bin/env node\n', { exec: true });
  write(join(ws, 'node_modules', '.bin', 'expo'), '#!/bin/sh\n', { exec: true });

  // The app: `expo` in dependencies, app.json WITHOUT the expo wrapper key
  // (Expo accepts that, and a real repo ships it), and no `ios` script at all.
  write(
    join(app, 'package.json'),
    JSON.stringify({
      name: '@ws/app',
      dependencies: { expo: '^57.0.8', 'expo-dev-client': '~57.0.9', react: '19.0.0' },
    }),
  );
  write(
    join(app, 'app.json'),
    JSON.stringify({
      name: 'app',
      platforms: ['ios', 'android'],
      plugins: ['expo-dev-client'],
      extra: { eas: { projectId: '439cfc57-af9a-461c-9d3c-89b985233942' } },
    }),
  );
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

describe("finding the project's expo binary", () => {
  test('resolves the HOISTED package from an app with no node_modules of its own', () => {
    // The bug: join(app, 'node_modules', '.bin', 'expo') does not exist here,
    // and never does in a monorepo.
    expect(resolvePackageJson(app, 'expo')).toBe(join(ws, 'node_modules', 'expo', 'package.json'));
    expect(expoBinPath(app)).toBe(join(ws, 'node_modules', 'expo', 'bin', 'cli'));
  });

  test("derives the executable from the package's own bin field, not a guessed path", () => {
    const pkg = join(ws, 'node_modules', 'expo', 'package.json');
    expect(expoBinFromPackage(pkg)).toBe(join(ws, 'node_modules', 'expo', 'bin', 'cli'));
    // The string form of `bin` is the other half of the field's shape.
    write(join(ws, 'node_modules', 'other', 'package.json'), JSON.stringify({ name: 'other', bin: 'cli.js' }));
    write(join(ws, 'node_modules', 'other', 'cli.js'), '#!/usr/bin/env node\n', { exec: true });
    expect(expoBinFromPackage(join(ws, 'node_modules', 'other', 'package.json'), 'other')).toBe(
      join(ws, 'node_modules', 'other', 'cli.js'),
    );
  });

  test('a bin file that is not executable falls through to the .bin shim', () => {
    chmodSync(join(ws, 'node_modules', 'expo', 'bin', 'cli'), 0o644);
    expect(expoBinPath(app)).toBe(join(ws, 'node_modules', '.bin', 'expo'));
  });

  test('the .bin walk reaches the WORKSPACE root, not just the project', () => {
    expect(findBinUpward(app, 'expo')).toBe(join(ws, 'node_modules', '.bin', 'expo'));
    expect(findBinUpward(app, 'nothing-like-this')).toBe(null);
  });

  test('a project that really has no expo resolves to null, so the caller can say so honestly', () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'rn-iso-bare-')));
    try {
      write(join(bare, 'package.json'), JSON.stringify({ name: 'bare' }));
      expect(expoBinPath(bare)).toBe(null);
      expect(isPackageResolvable(bare, 'expo')).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('detectIsExpo on a hoisted workspace', () => {
  test('an app with a wrapper-less app.json and no ios script still reads as Expo', () => {
    // The false negative that was fatal: detected as bare, the supervisor
    // hosts Metro in-process, serves no Expo manifest, and the dev-client app
    // dies on "Couldn't parse the manifest".
    expect(detectIsExpo(app)).toBe(true);
  });

  test('the app.json shape alone carries it when nothing is installed yet', () => {
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'rn-iso-fresh-')));
    try {
      write(join(fresh, 'package.json'), JSON.stringify({ name: 'app', dependencies: { expo: '^57.0.0' } }));
      write(
        join(fresh, 'app.json'),
        JSON.stringify({ name: 'app', plugins: ['expo-dev-client'], extra: { eas: { projectId: 'x' } } }),
      );
      expect(isPackageResolvable(fresh, 'expo')).toBe(false);
      expect(detectIsExpo(fresh)).toBe(true);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test('a committed native project says so through use_expo_modules!', () => {
    const native = realpathSync(mkdtempSync(join(tmpdir(), 'rn-iso-native-')));
    try {
      write(join(native, 'package.json'), JSON.stringify({ name: 'app', dependencies: { expo: '^57.0.0' } }));
      write(join(native, 'ios', 'Podfile'), "require 'json'\ntarget 'App' do\n  use_expo_modules!\nend\n");
      expect(detectIsExpo(native)).toBe(true);
    } finally {
      rmSync(native, { recursive: true, force: true });
    }
  });

  test('an explicit react-native run-ios script still wins: a bare project stays bare', () => {
    write(
      join(app, 'package.json'),
      JSON.stringify({
        name: '@ws/app',
        dependencies: { expo: '^57.0.8' },
        scripts: { ios: 'react-native run-ios' },
      }),
    );
    expect(detectIsExpo(app)).toBe(false);
  });
});

// CLAUDE.md's promise: one project never reads as expo in one command and bare
// in another. The two readers that would disagree most expensively are the
// supervisor (which picks the dev server) and doctor (which picks its
// findings), so they are both asserted against the SAME directory.
describe('detectIsExpo is the single source', () => {
  test('the supervisor picks the expo dev server for the project doctor treats as Expo', async () => {
    let startedExpo = false;
    const exited = [];
    await runSupervisor({
      root: app,
      port: 8199,
      attachSignals: false,
      onExit: (code) => exited.push(code),
      startExpo: async () => {
        startedExpo = true;
        return { mode: MODE_EXPO, serverPid: 4242, onExit() {}, async close() {} };
      },
      startBare: async () => {
        throw new Error('a project detected as Expo must NOT get the bare in-process server');
      },
    });
    expect(startedExpo).toBe(true);
    expect(JSON.parse(readState()).supervisor.mode).toBe(MODE_EXPO);

    // doctor reads the same detector: its Expo-only findings apply here.
    // (`expo-dev-client` IS in this fixture's deps, and a MISSING provider is
    // deliberately not a finding any more -- so the Expo-only finding this
    // fixture is given to fire is the still-under-experiments note, which the
    // bare branch suppresses along with the rest.)
    write(
      join(app, 'app.json'),
      JSON.stringify({
        name: 'app',
        platforms: ['ios', 'android'],
        plugins: ['expo-dev-client'],
        experiments: { buildCacheProvider: { plugin: '@rn-iso/expo-build-cache' } },
        extra: { eas: { projectId: '439cfc57-af9a-461c-9d3c-89b985233942' } },
      }),
    );
    const titles = runDoctor(app).map((f) => f.title);
    expect(titles.some((t) => /build.?cache.?provider/i.test(t))).toBeTruthy();
  });

  test('and a bare project gets the bare server and none of the Expo findings', async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'rn-iso-bare-')));
    try {
      write(join(bare, 'package.json'), JSON.stringify({ name: 'bare', dependencies: { 'react-native': '0.81.0' } }));
      let startedBare = false;
      await runSupervisor({
        root: bare,
        port: 8198,
        attachSignals: false,
        onExit: () => {},
        startBare: async () => {
          startedBare = true;
          return { mode: MODE_BARE, serverPid: null, onExit() {}, async close() {} };
        },
        startExpo: async () => {
          throw new Error('a bare project must not spawn `expo start`');
        },
      });
      expect(startedBare).toBe(true);
      const titles = runDoctor(bare).map((f) => f.title);
      expect(!titles.some((t) => /build.?cache.?provider|expo-dev-client/i.test(t))).toBeTruthy();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

function readState() {
  return readFileSync(join(app, '.rn-iso', 'state.json'), 'utf-8');
}
