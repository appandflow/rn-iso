import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEPS_ERROR,
  extractPodDiagnostics,
  podsAreStale,
  readPodState,
  runPodInstall,
  podEnv,
  readRubyVersion,
} from '../engine/deps.ts';
import { makeChildProcess, makeError, makeWriter } from './_factories.ts';

type WriteRecord = { src: string; level: string; msg: string };

type SpawnCall = { cmd: string; args: string[]; opts: Record<string, unknown> };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-deps-'));
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

  test('neither file present means no CocoaPods here, which is NOT stale', () => {
    expect(podsAreStale(null, null)).toEqual({ noPods: true, stale: false });
    expect(podsAreStale(undefined, undefined)).toEqual({ noPods: true, stale: false });
  });

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

function fakePodChild({
  lines = [],
  code = 0,
  signal = null,
  error = null,
}: {
  lines?: string[];
  code?: number;
  signal?: NodeJS.Signals | null;
  error?: Error | null;
} = {}) {
  const child = makeChildProcess({ pid: 4242 });
  setImmediate(() => {
    for (const line of lines) child.stdout?.emit('data', `${line}\n`);
    if (error) child.emit('error', error);
    else child.emit('exit', code, signal);
  });
  return child;
}

function collectingWriter() {
  const records: WriteRecord[] = [];
  const writer = makeWriter({
    write: (r: WriteRecord) => {
      records.push(r);
      return true;
    },
  });
  return Object.assign(writer, { records });
}

describe('podEnv (#43, #44)', () => {
  test('defaults a UTF-8 locale without touching one the caller set', () => {
    const env = podEnv('/repo', { env: { PATH: '/usr/bin' }, home: '/home/u', exists: () => false });
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.LC_ALL).toBe('en_US.UTF-8');
    const kept = podEnv('/repo', {
      env: { PATH: '/usr/bin', LANG: 'fr_CA.UTF-8' },
      home: '/home/u',
      exists: () => false,
    });
    expect(kept.LANG).toBe('fr_CA.UTF-8');
    expect(kept.LC_ALL).toBe('fr_CA.UTF-8');
  });

  test('prepends a pinned ruby that a version manager has installed', () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.ruby-version'), 'ruby-3.3.10\n');
    const rvmBin = '/home/u/.rvm/rubies/ruby-3.3.10/bin';
    const rvmGems = '/home/u/.rvm/gems/ruby-3.3.10';
    const env = podEnv(root, {
      env: { PATH: '/usr/bin' },
      home: '/home/u',
      exists: (p) => p === rvmBin || p === rvmGems,
    });
    expect(env.PATH).toBe(`${rvmBin}:/usr/bin`);
    expect(env.GEM_HOME).toBe(rvmGems);
    const none = podEnv(root, { env: { PATH: '/usr/bin' }, home: '/home/u', exists: () => false });
    expect(none.PATH).toBe('/usr/bin');
    expect(none.GEM_HOME).toBeUndefined();
  });

  test('readRubyVersion strips the ruby- prefix and returns null when unpinned', () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.ruby-version'), '3.4.1\n');
    expect(readRubyVersion(root)).toBe('3.4.1');
    rmSync(join(root, '.ruby-version'));
    expect(readRubyVersion(root)).toBe(null);
  });
});

describe('runPodInstall', () => {
  test('runs `pod install` with cwd ios/ and streams the transcript as build/debug records', async () => {
    mkdirSync(join(root, 'ios'), { recursive: true });
    const writer = collectingWriter();
    const spawnCalls: SpawnCall[] = [];
    const result = await runPodInstall(root, writer, {
      spawnFn: (cmd, args, opts) => {
        spawnCalls.push({ cmd, args, opts });
        return fakePodChild({ lines: ['Analyzing dependencies', 'Pod installation complete!'] });
      },
      now: (() => {
        let t = 1000;
        return () => (t += 500);
      })(),
    });
    expect(result.ok).toBe(true);
    const spawned = spawnCalls[0];
    assert(spawned);
    expect(spawned.cmd).toBe('pod');
    expect(spawned.args).toEqual(['install']);
    expect(spawned.opts.cwd).toBe(join(root, 'ios'));
    expect(writer.records.map((r) => [r.src, r.level, r.msg])).toEqual([
      ['build', 'debug', 'Analyzing dependencies'],
      ['build', 'debug', 'Pod installation complete!'],
    ]);
  });

  test('a slow pod install emits `pods` heartbeats while the child runs', async () => {
    mkdirSync(join(root, 'ios'), { recursive: true });
    const beats: string[] = [];
    const child = makeChildProcess({ pid: 4242 });
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: () => {
        setImmediate(() => child.stdout?.emit('data', 'Installing FlipperKit (0.125.3)\n'));
        setTimeout(() => child.emit('exit', 0, null), 120);
        return child;
      },
      heartbeatMs: 25,
      onHeartbeat: (l: string) => beats.push(l),
    });
    expect(result.ok).toBe(true);
    expect(beats.length >= 1).toBe(true);
    expect(beats[0]).toMatch(/^ {2}pods\s+still running \(/);
    expect(beats[0]).toMatch(/Installing FlipperKit/);
  });

  test('a non-zero exit comes back as {failed, lastLines}, never a throw', async () => {
    mkdirSync(join(root, 'ios'), { recursive: true });
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: () =>
        fakePodChild({
          lines: ['Analyzing dependencies', '[!] CocoaPods could not find compatible versions for pod "RCT-Folly"'],
          code: 1,
        }),
    });
    expect(result.failed).toBe(true);
    expect(result.code).toBe(DEPS_ERROR);
    expect(result.reason).toMatch(/exit code 1/);
    assert(result.lastLines);
    expect(result.lastLines.join('\n')).toMatch(/could not find compatible versions/);
  });

  test('a missing `pod` binary is reported as a structured remedy, not an ENOENT', async () => {
    mkdirSync(join(root, 'ios'), { recursive: true });
    const err = makeError('spawn pod ENOENT', { code: 'ENOENT' });
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: () => {
        throw err;
      },
    });
    expect(result.failed).toBe(true);
    expect(result.code).toBe(DEPS_ERROR);
    expect(result.reason).toMatch(/CocoaPods is not installed/);
    expect(result.remedy).toMatch(/brew install cocoapods/);
  });

  test('an ENOENT delivered as a spawn `error` event is recognized the same way', async () => {
    mkdirSync(join(root, 'ios'), { recursive: true });
    const err = makeError('spawn pod ENOENT', { code: 'ENOENT' });
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: () => fakePodChild({ error: err }),
    });
    expect(result.reason).toMatch(/CocoaPods is not installed/);
  });

  test('refuses when there is no ios/ directory at all', async () => {
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: () => {
        throw new Error('must not spawn');
      },
    });
    expect(result.failed).toBe(true);
    expect(result.reason).toMatch(/No ios\/ directory/);
  });

  test('the anchored [!] diagnostic survives a transcript whose tail is all noise', async () => {
    mkdirSync(join(root, 'ios'), { recursive: true });
    const noise = Array.from({ length: 25 }, (_, i) => `Installing SomePod-${i} (1.0.${i})`);
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: () =>
        fakePodChild({
          lines: [
            'Analyzing dependencies',
            '[!] Unable to find a specification for `ExpoModulesCore` depended upon by `Expo`',
            ...noise,
          ],
          code: 1,
        }),
    });
    expect(result.failed).toBe(true);
    expect(result.diagnosticSource).toBe('cocoapods');
    assert(result.diagnosticLines);
    expect(result.diagnosticLines[0]).toMatch(/Unable to find a specification/);
    assert(result.lastLines);
    expect(result.lastLines.join('\n')).not.toMatch(/Unable to find a specification/);
  });

  test('a transcript with no recognizable marker falls back to the tail', async () => {
    mkdirSync(join(root, 'ios'), { recursive: true });
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: () => fakePodChild({ lines: ['Analyzing dependencies', 'Something went wrong'], code: 1 }),
    });
    expect(result.failed).toBe(true);
    expect(result.diagnosticSource).toBe('tail');
    expect(result.diagnosticLines).toEqual([]);
    assert(result.lastLines);
    expect(result.lastLines.join('\n')).toMatch(/Something went wrong/);
  });
});

describe('runPodInstall through bundler (#137)', () => {
  const COCOAPODS_LOCK = [
    'GEM',
    '  remote: https://rubygems.org/',
    '  specs:',
    '    activesupport (7.2.3.2)',
    '    cocoapods (1.15.2)',
    '      cocoapods-core (= 1.15.2)',
    '    cocoapods-core (1.15.2)',
    '',
    'DEPENDENCIES',
    '  cocoapods (~> 1.15)',
    '',
  ].join('\n');

  const FASTLANE_LOCK = [
    'GEM',
    '  remote: https://rubygems.org/',
    '  specs:',
    '    fastlane (2.219.0)',
    '',
    'DEPENDENCIES',
    '  fastlane',
    '',
  ].join('\n');

  function pinnedProject({ lock = COCOAPODS_LOCK }: { lock?: string | null } = {}) {
    mkdirSync(join(root, 'ios'), { recursive: true });
    writeFileSync(join(root, 'Gemfile'), "source 'https://rubygems.org'\ngem 'cocoapods'\n");
    if (lock !== null) writeFileSync(join(root, 'Gemfile.lock'), lock);
  }

  function router(
    calls: SpawnCall[],
    replies: Record<string, () => ReturnType<typeof fakePodChild>>,
  ): (cmd: string, args: string[], opts: Record<string, unknown>) => ReturnType<typeof fakePodChild> {
    return (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const key = [cmd, ...args].join(' ');
      const reply = replies[key];
      if (!reply) throw new Error(`unexpected spawn: ${key}`);
      return reply();
    };
  }

  const ok = () => fakePodChild({ lines: ['Pod installation complete!'] });

  test('a Gemfile with a Gemfile.lock checks the bundle, then pods through bundler', async () => {
    pinnedProject();
    const calls: SpawnCall[] = [];
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: router(calls, {
        'bundle check --dry-run': () => fakePodChild({ lines: ['The Gemfile dependencies are satisfied'] }),
        'bundle exec pod install': ok,
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.command).toBe('bundle exec pod install');
    expect(calls.map((c) => [c.cmd, ...c.args].join(' '))).toEqual([
      'bundle check --dry-run',
      'bundle exec pod install',
    ]);
    expect(calls[0]?.opts.cwd).toBe(root);
    expect(calls[1]?.opts.cwd).toBe(join(root, 'ios'));
  });

  test('bundler never gets to write the lockfile: --dry-run on check, BUNDLE_FROZEN on every spawn', async () => {
    pinnedProject();
    const calls: SpawnCall[] = [];
    await runPodInstall(root, collectingWriter(), {
      spawnFn: router(calls, {
        'bundle check --dry-run': () => fakePodChild({ code: 1, lines: ['The following gems are missing'] }),
        'bundle install': ok,
        'bundle exec pod install': ok,
      }),
    });
    expect(calls.map((c) => [c.cmd, ...c.args].join(' '))).toEqual([
      'bundle check --dry-run',
      'bundle install',
      'bundle exec pod install',
    ]);
    for (const call of calls) {
      const env = call.opts.env as NodeJS.ProcessEnv;
      expect(env.BUNDLE_FROZEN).toBe('true');
      expect(env.BUNDLE_GEMFILE).toBe(join(root, 'Gemfile'));
      expect(env.FORCE_COLOR).toBe('0');
      expect(env.CLICOLOR).toBe('0');
    }
  });

  test('a missing-gems check installs the bundle at the Gemfile, with `gems` heartbeats', async () => {
    pinnedProject();
    const beats: string[] = [];
    const child = makeChildProcess({ pid: 99 });
    const calls: SpawnCall[] = [];
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: router(calls, {
        'bundle check --dry-run': () => fakePodChild({ code: 1 }),
        'bundle install': () => {
          setImmediate(() => child.stdout?.emit('data', 'Fetching cocoapods 1.16.2\n'));
          setTimeout(() => child.emit('exit', 0, null), 120);
          return child;
        },
        'bundle exec pod install': ok,
      }),
      heartbeatMs: 25,
      onHeartbeat: (l: string) => beats.push(l),
    });
    expect(result.ok).toBe(true);
    expect(calls[1]?.opts.cwd).toBe(root);
    expect(beats[0]).toMatch(/^ {2}gems\s+still running \(/);
    expect(beats[0]).toMatch(/Fetching cocoapods/);
  });

  test('a Gemfile with no Gemfile.lock stays on plain `pod install`, so nothing writes a lockfile', async () => {
    pinnedProject({ lock: null });
    const calls: SpawnCall[] = [];
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: router(calls, { 'pod install': ok }),
    });
    expect(result.ok).toBe(true);
    expect(result.command).toBe('pod install');
    expect(calls.map((c) => c.cmd)).toEqual(['pod']);
  });

  test('a lockfile that pins fastlane but no pods stays on plain `pod install`, with no note', async () => {
    pinnedProject({ lock: FASTLANE_LOCK });
    const calls: SpawnCall[] = [];
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: router(calls, { 'pod install': ok }),
    });
    expect(result.ok).toBe(true);
    expect(result.command).toBe('pod install');
    expect(result.notes).toEqual([]);
    expect(calls.map((c) => c.cmd)).toEqual(['pod']);
    const env = calls[0]?.opts.env as NodeJS.ProcessEnv;
    expect(env.BUNDLE_FROZEN).toBe(undefined);
    expect(env.BUNDLE_GEMFILE).toBe(undefined);
    expect(env.FORCE_COLOR).toBe('0');
  });

  test('cocoapods pulled in as a transitive spec still counts as pinned', async () => {
    pinnedProject({
      lock: [
        'GEM',
        '  specs:',
        '    cocoapods-bin (0.8.0)',
        '      cocoapods (>= 1.10)',
        '    cocoapods (1.15.2)',
        '',
      ].join('\n'),
    });
    const calls: SpawnCall[] = [];
    await runPodInstall(root, collectingWriter(), {
      spawnFn: router(calls, { 'bundle check --dry-run': ok, 'bundle exec pod install': ok }),
    });
    expect(calls.map((c) => c.cmd)).toEqual(['bundle', 'bundle']);
  });

  test('an unreadable or malformed Gemfile.lock falls back to plain `pod install` instead of throwing', async () => {
    pinnedProject({ lock: '\u0000 not a lockfile' });
    const calls: SpawnCall[] = [];
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: router(calls, { 'pod install': ok }),
    });
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual(['pod']);

    rmSync(join(root, 'Gemfile.lock'), { force: true });
    mkdirSync(join(root, 'Gemfile.lock'));
    const second = await runPodInstall(root, collectingWriter(), {
      spawnFn: router([], { 'pod install': ok }),
    });
    expect(second.ok).toBe(true);
    expect(second.command).toBe('pod install');
  });

  test('no `bundle` on PATH falls back to plain `pod install` with a note, not a failure', async () => {
    pinnedProject();
    const calls: SpawnCall[] = [];
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        if (cmd === 'bundle') throw makeError('spawn bundle ENOENT', { code: 'ENOENT' });
        return ok();
      },
    });
    expect(result.ok).toBe(true);
    expect(result.command).toBe('pod install');
    expect(result.failed).toBe(undefined);
    expect(result.notes?.join('\n')).toMatch(/`bundle` is not on PATH/);
    expect(calls.map((c) => c.cmd)).toEqual(['bundle', 'pod']);
    const podEnvOnly = calls[1]?.opts.env as NodeJS.ProcessEnv;
    expect(podEnvOnly.BUNDLE_FROZEN).toBe(undefined);
    expect(podEnvOnly.BUNDLE_GEMFILE).toBe(undefined);
  });

  test('a failed `bundle install` fails the run with STIM_DEPS_FAILED and never runs pods', async () => {
    pinnedProject();
    writeFileSync(join(root, '.ruby-version'), 'ruby-3.4.1\n');
    const calls: SpawnCall[] = [];
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: router(calls, {
        'bundle check --dry-run': () => fakePodChild({ code: 1 }),
        'bundle install': () =>
          fakePodChild({ code: 5, lines: ["Could not find gem 'activesupport (= 7.1.3)' in locally installed gems."] }),
      }),
    });
    expect(result.failed).toBe(true);
    expect(result.code).toBe(DEPS_ERROR);
    expect(result.reason).toMatch(/`bundle install` failed \(exit code 5\)/);
    expect(result.remedy).toMatch(/ruby 3\.4\.1/);
    expect(result.remedy).toMatch(/bundle install/);
    assert(result.lastLines);
    expect(result.lastLines.join('\n')).toMatch(/Could not find gem/);
    expect(calls.map((c) => c.cmd)).toEqual(['bundle', 'bundle']);
  });

  test('a lockfile bundler refuses to rewrite is reported as frozen mode, not as a missing gem', async () => {
    pinnedProject();
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: router([], {
        'bundle check --dry-run': () => fakePodChild({ code: 1 }),
        'bundle install': () =>
          fakePodChild({
            code: 16,
            lines: [
              "The dependencies in your gemfile changed, but the lockfile can't be updated because frozen mode is set",
              'You have added to the Gemfile:',
              '* json',
            ],
          }),
      }),
    });
    expect(result.failed).toBe(true);
    expect(result.remedy).toMatch(/BUNDLE_FROZEN/);
    expect(result.remedy).toMatch(new RegExp(`cd ${root} && bundle install`.replace(/[$^*+?.()|[\]{}\\]/g, '\\$&')));
  });

  test('a frozen-mode refusal from `bundle exec pod install` gets the same remedy', async () => {
    pinnedProject();
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: router([], {
        'bundle check --dry-run': () => fakePodChild({ lines: ['satisfied'] }),
        'bundle exec pod install': () =>
          fakePodChild({
            code: 1,
            lines: [
              "definition.rb:469:in 'ensure_equivalent_gemfile_and_lockfile': the lockfile can't be updated because frozen mode is set (Bundler::ProductionError)",
            ],
          }),
      }),
    });
    expect(result.failed).toBe(true);
    expect(result.command).toBe('bundle exec pod install');
    expect(result.reason).toMatch(/`bundle exec pod install` failed \(exit code 1\)/);
    expect(result.remedy).toMatch(/BUNDLE_FROZEN/);
  });

  test('a bundle without the pinned pod binary points at the bundle that is actually loaded', async () => {
    pinnedProject();
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: router([], {
        'bundle check --dry-run': () => fakePodChild({ lines: ['satisfied'] }),
        'bundle exec pod install': () =>
          fakePodChild({
            code: 1,
            lines: [
              "can't find executable pod for gem cocoapods. cocoapods is not currently included in the bundle, perhaps you meant to add it to your Gemfile? (Gem::Exception)",
            ],
          }),
      }),
    });
    expect(result.failed).toBe(true);
    expect(result.remedy).toMatch(/resolves cocoapods/);
    expect(result.remedy).toMatch(/belong to a different Gemfile/);
    expect(result.remedy).toMatch(/bundle exec pod --version/);
    expect(result.remedy).not.toMatch(/remove .*Gemfile\.lock/);
  });

  test('an ENOENT at the pod step in the bundler branch names `bundle`, not CocoaPods', async () => {
    pinnedProject();
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: (_cmd, args) => {
        if (args[0] === 'check') return fakePodChild({ lines: ['satisfied'] });
        throw makeError('spawn bundle ENOENT', { code: 'ENOENT' });
      },
    });
    expect(result.failed).toBe(true);
    expect(result.code).toBe(DEPS_ERROR);
    expect(result.reason).toMatch(/Bundler is not installed/);
    expect(result.reason).not.toMatch(/CocoaPods is not installed/);
    expect(result.remedy).toMatch(/gem install bundler/);
  });

  test('`bundle install` reports the project-local BUNDLE_PATH it filled, and only that', async () => {
    pinnedProject();
    mkdirSync(join(root, '.bundle'), { recursive: true });
    writeFileSync(join(root, '.bundle', 'config'), 'BUNDLE_PATH: "vendor/bundle"\nBUNDLE_FORCE_RUBY_PLATFORM: 1\n');
    const withPath = await runPodInstall(root, collectingWriter(), {
      spawnFn: router([], {
        'bundle check --dry-run': () => fakePodChild({ code: 1 }),
        'bundle install': ok,
        'bundle exec pod install': ok,
      }),
    });
    expect(withPath.notes?.join('\n')).toMatch(/gems in vendor\/bundle\//);
    expect(withPath.notes?.join('\n')).toMatch(/Gemfile\.lock itself is never written/);

    writeFileSync(join(root, '.bundle', 'config'), 'BUNDLE_PATH: "/opt/gems"\n');
    const outside = await runPodInstall(root, collectingWriter(), {
      spawnFn: router([], {
        'bundle check --dry-run': () => fakePodChild({ code: 1 }),
        'bundle install': ok,
        'bundle exec pod install': ok,
      }),
    });
    expect(outside.notes).toEqual([]);

    writeFileSync(join(root, '.bundle', 'config'), 'BUNDLE_PATH: "~/gems-probe"\n');
    const home = await runPodInstall(root, collectingWriter(), {
      spawnFn: router([], {
        'bundle check --dry-run': () => fakePodChild({ code: 1 }),
        'bundle install': ok,
        'bundle exec pod install': ok,
      }),
    });
    expect(home.notes).toEqual([]);
  });

  test('a BUNDLE_PATH from the environment is reported as the environment, not as a config file', async () => {
    pinnedProject();
    const previous = process.env.BUNDLE_PATH;
    process.env.BUNDLE_PATH = 'vendor/bundle';
    try {
      const result = await runPodInstall(root, collectingWriter(), {
        spawnFn: router([], {
          'bundle check --dry-run': () => fakePodChild({ code: 1 }),
          'bundle install': ok,
          'bundle exec pod install': ok,
        }),
      });
      expect(result.notes?.join('\n')).toMatch(/BUNDLE_PATH environment variable/);
      expect(result.notes?.join('\n')).not.toMatch(/\.bundle\/config/);
    } finally {
      if (previous === undefined) delete process.env.BUNDLE_PATH;
      else process.env.BUNDLE_PATH = previous;
    }
  });
});

describe('extractPodDiagnostics', () => {
  test('a fatal [!] mid-transcript beats the deferred warnings flushed after it (case 1)', () => {
    const warnings = ['expo-sensors', 'expo-splash-screen', 'expo-store-review', 'expo-system-ui', 'expo-video'].map(
      (pkg) => `[!] [Expo] ${pkg} was not linked: requires iOS 16.4 but app targets 16.0`,
    );
    const transcript = [
      'Analyzing dependencies',
      'Fetching podspec for `hermes-engine` from `../node_modules/react-native/sdks/hermes-engine`',
      '[!] Unable to find a specification for `ExpoModulesCore` depended upon by `Expo`',
      '',
      'You have either:',
      ' * out-of-date source repos which you can update with `pod repo update` or with `pod install --repo-update`.',
      ' * mistyped the name or version.',
      ...warnings,
    ].join('\n');
    const extracted = extractPodDiagnostics(transcript);
    assert(extracted);
    expect(extracted.source).toBe('cocoapods');
    expect(extracted.lines[0]).toBe('[!] Unable to find a specification for `ExpoModulesCore` depended upon by `Expo`');
    expect(extracted.lines.join('\n')).not.toMatch(/You have either/);
    expect(extracted.lines).toHaveLength(1 + warnings.length);
  });

  test('a resolver conflict block is captured whole, generic advice excluded (case 3)', () => {
    const block = [
      '[!] CocoaPods could not find compatible versions for pod "GoogleUtilities":',
      '  In snapshot (Podfile.lock):',
      '    GoogleUtilities (= 13.6.1)',
      '  In Podfile:',
      '    FirebaseCoreInternal was resolved to 9.6.0, which depends on',
      '      GoogleUtilities (= 13.6.3)',
    ];
    const transcript = [
      'Analyzing dependencies',
      ...block,
      '',
      'You have either:',
      ' * out-of-date source repos which you can update with `pod repo update` or with `pod install --repo-update`.',
      ' * changed the constraints of dependency `GoogleUtilities` inside your development pod.',
    ].join('\n');
    const extracted = extractPodDiagnostics(transcript);
    assert(extracted);
    expect(extracted.source).toBe('cocoapods');
    expect(extracted.lines).toEqual(block);
  });

  test('a Ruby crash extracts the exception head and its prologue, never the frames (case 2)', () => {
    const rubyRoot = '/opt/homebrew/Cellar/ruby/3.4.1/lib/ruby/3.4.0';
    const transcript = [
      'Could not find proper version of cocoapods (1.15.2) in any of the sources',
      'Run `bundle install` to install missing gems.',
      `${rubyRoot}/rubygems/specification.rb:1408:in 'Gem::Specification.gem': Could not find 'minitest' (>= 5.1) among 81 total gem(s) (Gem::MissingSpecError)`,
      `\tfrom ${rubyRoot}/rubygems.rb:239:in 'block in Gem.find_and_activate_spec_for_exe'`,
      `\tfrom ${rubyRoot}/rubygems.rb:238:in 'Thread::Mutex#synchronize'`,
      `\tfrom ${rubyRoot}/rubygems.rb:238:in 'Gem.find_and_activate_spec_for_exe'`,
      `\tfrom ${rubyRoot}/rubygems.rb:282:in 'Gem.activate_and_load_bin_path'`,
      "\tfrom /opt/homebrew/bin/pod:25:in '<main>'",
    ].join('\n');
    const extracted = extractPodDiagnostics(transcript);
    assert(extracted);
    expect(extracted.source).toBe('ruby');
    expect(extracted.lines).toEqual([
      'Could not find proper version of cocoapods (1.15.2) in any of the sources',
      'Run `bundle install` to install missing gems.',
      `${rubyRoot}/rubygems/specification.rb:1408:in 'Gem::Specification.gem': Could not find 'minitest' (>= 5.1) among 81 total gem(s) (Gem::MissingSpecError)`,
    ]);
  });

  test('the pre-3.4 backtick quoting of a Ruby head is recognized too', () => {
    const transcript = [
      "/usr/lib/ruby/2.6.0/rubygems/core_ext/kernel_require.rb:54:in `require': cannot load such file -- cocoapods (LoadError)",
      "\tfrom /usr/lib/ruby/2.6.0/rubygems/core_ext/kernel_require.rb:54:in `require'",
      "\tfrom /usr/local/bin/pod:23:in `<main>'",
    ].join('\n');
    const extracted = extractPodDiagnostics(transcript);
    assert(extracted);
    expect(extracted.source).toBe('ruby');
    expect(extracted.lines).toEqual([
      "/usr/lib/ruby/2.6.0/rubygems/core_ext/kernel_require.rb:54:in `require': cannot load such file -- cocoapods (LoadError)",
    ]);
  });

  test('an unrecognized transcript returns null, explicitly, so the caller tails', () => {
    expect(extractPodDiagnostics('Analyzing dependencies\nSomething broke')).toBeNull();
    expect(extractPodDiagnostics('')).toBeNull();
  });

  test('the cap falls on the warnings at the end, never the error at the front', () => {
    const transcript = [
      '[!] The one line that matters',
      ...Array.from({ length: 20 }, (_, i) => `[!] [Expo] package-${i} was not linked: requires iOS 16.4`),
    ].join('\n');
    const extracted = extractPodDiagnostics(transcript);
    assert(extracted);
    expect(extracted.lines).toHaveLength(16);
    expect(extracted.lines[0]).toBe('[!] The one line that matters');
    expect(extracted.lines[15]).toBe('(+6 more [!] lines in the build log)');
  });
});
