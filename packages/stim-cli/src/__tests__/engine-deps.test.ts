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
  root = mkdtempSync(join(tmpdir(), 'stim-cli-deps-'));
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
    expect(beats[0]).toMatch(/^pods\s+still running \(/);
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
