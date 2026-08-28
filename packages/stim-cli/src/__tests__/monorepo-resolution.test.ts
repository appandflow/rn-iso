import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runDoctor } from '../doctor.ts';
import { workspaceStateFile } from '../paths.ts';
import { detectIsExpo, isPackageResolvable, resolvePackageJson } from '../project.ts';
import { MODE_BARE, MODE_EXPO, runSupervisor } from '../supervisor/run.ts';
import { expoBinFromPackage, expoBinPath, findBinUpward } from '../supervisor/server-expo.ts';

let home: string;
let ws: string;
let app: string;

function write(path: string, text: string, { exec = false } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (exec) chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-cli-home-'));
  process.env.STIM_CLI_HOME = home;
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'stim-cli-mono-')));
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
  delete process.env.STIM_CLI_HOME;
});

describe("finding the project's expo binary", () => {
  test('resolves the HOISTED package from an app with no node_modules of its own', () => {
    expect(resolvePackageJson(app, 'expo')).toBe(join(ws, 'node_modules', 'expo', 'package.json'));
    expect(expoBinPath(app)).toBe(join(ws, 'node_modules', 'expo', 'bin', 'cli'));
  });

  test("derives the executable from the package's own bin field, not a guessed path", () => {
    const pkg = join(ws, 'node_modules', 'expo', 'package.json');
    expect(expoBinFromPackage(pkg)).toBe(join(ws, 'node_modules', 'expo', 'bin', 'cli'));
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
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'stim-cli-bare-')));
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
    expect(detectIsExpo(app)).toBe(true);
  });

  test('the app.json shape alone carries it when nothing is installed yet', () => {
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'stim-cli-fresh-')));
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
    const native = realpathSync(mkdtempSync(join(tmpdir(), 'stim-cli-native-')));
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

    write(
      join(app, 'app.json'),
      JSON.stringify({
        name: 'app',
        platforms: ['ios', 'android'],
        plugins: ['expo-dev-client'],
        experiments: { buildCacheProvider: { plugin: '@stim-cli/expo-build-cache' } },
        extra: { eas: { projectId: '439cfc57-af9a-461c-9d3c-89b985233942' } },
      }),
    );
    const titles = runDoctor(app).map((f) => f.title);
    expect(titles.some((t) => /build.?cache.?provider/i.test(t))).toBeTruthy();
  });

  test('and a bare project gets the bare server and none of the Expo findings', async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'stim-cli-bare-')));
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
  return readFileSync(workspaceStateFile(app), 'utf-8');
}
