// The iOS build engine: discovery, scheme selection, argv, product location,
// and buildIos end to end.
//
// The file has three layers, and the split is deliberate.
//
// 1. PURE FUNCTIONS, exhaustively. Every decision the engine makes is a
//    function of data, so all of them are tested without a toolchain.
// 2. MOCKED EXECUTOR, for the argv and the streaming contract. This is where
//    the production destination (`-destination id=<udid>`) is pinned, because
//    the live tests below deliberately do not use it -- they must not create
//    or boot a simulator.
// 3. A REAL xcodebuild, against a scratch Xcode project this file writes to a
//    temp directory. CLAUDE.md item 9: a mocked executor proves the right
//    call was made and can never prove the toolchain accepts it. Three bugs
//    shipped on the worktree branch with right-shaped mocks. So the success
//    path, the failure path, `-list -json`, and the binary-plist bundle-id
//    read are each driven through a real Xcode once.
//
// The scratch project is written here rather than checked in as a fixture so
// that what the live tests build is visible beside what they assert. It is a
// single Objective-C file with no UIKit: enough to produce a real .app with a
// real Info.plist, and small enough to build in about two seconds.
import assert from 'node:assert';
import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import type { NdjsonRecord, NdjsonWriter } from '../ndjson.ts';
import { createNdjsonWriter, parseNdjsonText } from '../ndjson.ts';
import {
  buildIos,
  discoverXcodeProject,
  findAppBundle,
  listSchemes,
  parseBundleId,
  parseSchemeList,
  pickAppBundle,
  pickScheme,
  pickXcodeProject,
  productsDir,
  readBundleId,
  resolveScheme,
  tailLines,
  xcodebuildArgs,
} from '../engine/xcode.ts';

// --- captured from the real tool --------------------------------------
//
// `xcodebuild -list -json` verbatim, both container forms, from the scratch
// project below. The two shapes differ: a workspace listing has no targets
// and no configurations, so a parser that reaches for `project` finds
// undefined and a parser that reaches for either finds the schemes.
const REAL_PROJECT_LIST_JSON = `{
  "project" : {
    "configurations" : [
      "Debug",
      "Release"
    ],
    "name" : "Scratch",
    "schemes" : [
      "Scratch"
    ],
    "targets" : [
      "Scratch"
    ]
  }
}`;

const REAL_WORKSPACE_LIST_JSON = `{
  "workspace" : {
    "name" : "Scratch",
    "schemes" : [
      "Scratch"
    ]
  }
}`;

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'rn-iso-xcode-'));
});
afterEach(() => {
  resetExecutor();
  rmSync(tmp, { recursive: true, force: true });
});

function recordingWriter(file = '/dev/null/not-used'): NdjsonWriter & { records: NdjsonRecord[] } {
  const records: NdjsonRecord[] = [];
  return {
    file,
    records,
    write(record: unknown) {
      records.push(record as NdjsonRecord);
      return true;
    },
    close() {
      return { file, written: records.length, dropped: 0, lastError: null };
    },
    written: 0,
    dropped: 0,
    lastError: null,
  };
}

function fakeChild() {
  const child: any = new EventEmitter();
  child.pid = 424242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

// A minimal project on disk: enough shape for discovery, no Xcode required.
function stubProject(root: string, { workspace = false, project = true, name = 'App' } = {}) {
  const ios = join(root, 'ios');
  mkdirSync(ios, { recursive: true });
  if (project) mkdirSync(join(ios, `${name}.xcodeproj`));
  if (workspace) mkdirSync(join(ios, `${name}.xcworkspace`));
  return ios;
}

describe('pickXcodeProject', () => {
  test('a workspace wins over a project, because CocoaPods links through it', () => {
    // Building the .xcodeproj of a pods project links no Pods target: the
    // best case is a link failure and the worst is an app that launches and
    // then cannot find its native modules.
    expect(pickXcodeProject(['App.xcodeproj', 'App.xcworkspace', 'Podfile'])).toEqual({
      kind: 'workspace',
      flag: '-workspace',
      file: 'App.xcworkspace',
      name: 'App',
    });
  });

  test('with no workspace, the project is the answer', () => {
    expect(pickXcodeProject(['App.xcodeproj', 'Podfile', 'App'])).toEqual({
      kind: 'project',
      flag: '-project',
      file: 'App.xcodeproj',
      name: 'App',
    });
  });

  test('among several workspaces, the one named after a project beside it wins', () => {
    const picked = pickXcodeProject(['Other.xcworkspace', 'App.xcworkspace', 'App.xcodeproj']);
    assert(picked);
    expect(picked.file).toBe('App.xcworkspace');
  });

  test('with no name to match, the choice is alphabetical so it never varies between runs', () => {
    const workspace = pickXcodeProject(['b.xcworkspace', 'a.xcworkspace']);
    assert(workspace);
    expect(workspace.file).toBe('a.xcworkspace');
    const project = pickXcodeProject(['b.xcodeproj', 'a.xcodeproj']);
    assert(project);
    expect(project.file).toBe('a.xcodeproj');
  });

  test('nothing buildable is null, not a throw', () => {
    expect(pickXcodeProject(['Podfile', 'Pods'])).toBe(null);
    expect(pickXcodeProject([])).toBe(null);
    expect(pickXcodeProject(null)).toBe(null);
    expect(pickXcodeProject([undefined, 42])).toBe(null);
  });
});

describe('discoverXcodeProject', () => {
  test('finds the workspace and reports the flag, the container dir and the full path', () => {
    stubProject(tmp, { workspace: true });
    expect(discoverXcodeProject(tmp)).toEqual({
      kind: 'workspace',
      flag: '-workspace',
      file: 'App.xcworkspace',
      name: 'App',
      dir: join(tmp, 'ios'),
      path: join(tmp, 'ios', 'App.xcworkspace'),
    });
  });

  test('no ios/ directory is an error naming prebuild, not an exception', () => {
    const { error } = discoverXcodeProject(tmp);
    assert(error);
    expect(error.code).toBe('RN_ISO_BUILD_FAILED');
    expect(error.message).toMatch(/No ios\/ directory/);
    expect(error.remedy).toMatch(/expo prebuild -p ios/);
  });

  test('an ios/ directory with nothing buildable in it says exactly that', () => {
    mkdirSync(join(tmp, 'ios'), { recursive: true });
    writeFileSync(join(tmp, 'ios', 'Podfile'), 'platform :ios');
    const { error } = discoverXcodeProject(tmp);
    assert(error);
    expect(error.code).toBe('RN_ISO_BUILD_FAILED');
    expect(error.message).toMatch(/contains no \.xcworkspace and no \.xcodeproj/);
    expect(error.remedy).toMatch(/prebuild/);
  });
});

describe('parseSchemeList', () => {
  test('reads a real project listing', () => {
    expect(parseSchemeList(REAL_PROJECT_LIST_JSON)).toEqual({ name: 'Scratch', schemes: ['Scratch'] });
  });

  test('reads a real workspace listing, which carries neither targets nor configurations', () => {
    expect(parseSchemeList(REAL_WORKSPACE_LIST_JSON)).toEqual({ name: 'Scratch', schemes: ['Scratch'] });
  });

  test('survives whatever xcodebuild prints before the JSON', () => {
    // Package resolution, a simulator note, or xcodebuild's own NSLog all land
    // on the same stream first. JSON.parse of the whole thing would throw.
    const noisy = [
      'Resolve Package Graph',
      'Resolved source packages:',
      '2026-08-25 13:18:28.966 xcodebuild[94932:16893065] Writing error result bundle',
      REAL_WORKSPACE_LIST_JSON,
    ].join('\n');
    expect(parseSchemeList(noisy)).toEqual({ name: 'Scratch', schemes: ['Scratch'] });
  });

  test('garbage is the empty listing rather than a parse error reaching the user', () => {
    const empty = { name: null, schemes: [] };
    expect(parseSchemeList('not json at all')).toEqual(empty);
    expect(parseSchemeList('{ broken')).toEqual(empty);
    expect(parseSchemeList('{}')).toEqual(empty);
    expect(parseSchemeList('{"project":{"name":"A"}}')).toEqual({ name: 'A', schemes: [] });
    expect(parseSchemeList('')).toEqual(empty);
    expect(parseSchemeList(null)).toEqual(empty);
  });

  test('non-string schemes are dropped rather than carried into an argv', () => {
    expect(parseSchemeList('{"project":{"name":"A","schemes":["Ok","",null,7]}}')).toEqual({
      name: 'A',
      schemes: ['Ok'],
    });
  });
});

describe('pickScheme', () => {
  test('the scheme named after the container wins, which is every generated RN project', () => {
    expect(pickScheme(['MyApp', 'MyApp-tvOS', 'MyAppTests'], 'MyApp')).toBe('MyApp');
  });

  test('a case difference still matches, because Xcode is not case sensitive about this', () => {
    expect(pickScheme(['myapp'], 'MyApp')).toBe('myapp');
  });

  test('with no name match, the only non-test scheme is the answer', () => {
    expect(pickScheme(['Runner', 'RunnerTests', 'RunnerUITests'], 'SomethingElse')).toBe('Runner');
  });

  test('several plausible schemes is null, NOT the first one', () => {
    // Guessing here builds the tvOS target or a staging variant and installs
    // it four minutes later. RN_ISO_NO_SCHEME is worth more than a coin flip.
    expect(pickScheme(['App-staging', 'App-production'], 'Unrelated')).toBe(null);
  });

  test('a project whose only scheme is a test scheme has nothing to build', () => {
    expect(pickScheme(['AppTests'], 'Unrelated')).toBe(null);
  });

  test('but an exact match still wins even when the name looks like a test scheme', () => {
    expect(pickScheme(['AppTests'], 'AppTests')).toBe('AppTests');
  });

  test('no schemes is null, and so is nonsense input', () => {
    expect(pickScheme([], 'App')).toBe(null);
    expect(pickScheme(null, 'App')).toBe(null);
    expect(pickScheme(['App'], null)).toBe('App');
  });
});

describe('listSchemes and resolveScheme', () => {
  const project = { flag: '-project', path: '/p/ios/App.xcodeproj', name: 'App', dir: '/p/ios' };

  test('runs xcodebuild -list -json through runFile, so a path with a space stays one argument', () => {
    const calls: [string, string[] | undefined][] = [];
    setExecutor({
      run: () => '',
      runQuiet: () => null,
      runFile: (file, args) => {
        calls.push([file, args]);
        return REAL_PROJECT_LIST_JSON;
      },
      spawn: () => {},
    });
    expect(listSchemes(project)).toEqual({ name: 'Scratch', schemes: ['Scratch'] });
    expect(calls).toEqual([['xcodebuild', ['-project', '/p/ios/App.xcodeproj', '-list', '-json']]]);
  });

  test('a tool failure is null, which is not the same as a listing with no schemes', () => {
    setExecutor({
      run: () => '',
      runQuiet: () => null,
      spawn: () => {},
      runFile: () => {
        throw new Error('xcodebuild: error: unable to read project');
      },
    });
    expect(listSchemes(project)).toBe(null);
  });

  test('resolveScheme maps a failed listing to RN_ISO_NO_SCHEME with the command to run', () => {
    setExecutor({
      run: () => '',
      runQuiet: () => null,
      spawn: () => {},
      runFile: () => {
        throw new Error('boom');
      },
    });
    const { error } = resolveScheme(project);
    assert(error);
    expect(error.code).toBe('RN_ISO_NO_SCHEME');
    expect(error.message).toMatch(/Could not list schemes/);
    expect(error.remedy).toMatch(/-list/);
  });

  test('resolveScheme names the schemes it did find when none of them is buildable', () => {
    setExecutor({
      run: () => '',
      runQuiet: () => null,
      spawn: () => {},
      runFile: () => '{"project":{"name":"App","schemes":["one","two"]}}',
    });
    const { error } = resolveScheme(project);
    assert(error);
    expect(error.code).toBe('RN_ISO_NO_SCHEME');
    expect(error.message).toMatch(/schemes: one, two/);
    expect(error.remedy).toMatch(/Shared/);
  });

  test('resolveScheme returns the scheme and the full list on success', () => {
    setExecutor({
      run: () => '',
      runQuiet: () => null,
      spawn: () => {},
      runFile: () => REAL_PROJECT_LIST_JSON,
    });
    expect(resolveScheme({ ...project, name: 'Scratch' })).toEqual({
      scheme: 'Scratch',
      schemes: ['Scratch'],
    });
  });
});

describe('xcodebuildArgs', () => {
  const project = { flag: '-workspace', path: '/p/ios/App.xcworkspace' };

  test('is exactly the invocation the plan specifies, in order', () => {
    expect(
      xcodebuildArgs({ project, scheme: 'App', udid: 'BF2A-1234', derivedDataPath: '/p/.rn-iso/derived-data' }),
    ).toEqual([
      '-workspace',
      '/p/ios/App.xcworkspace',
      '-scheme',
      'App',
      '-configuration',
      'Debug',
      '-sdk',
      'iphonesimulator',
      '-destination',
      'id=BF2A-1234',
      '-derivedDataPath',
      '/p/.rn-iso/derived-data',
      'build',
    ]);
  });

  test('an explicit destination replaces the udid one, for a build with no device', () => {
    const args = xcodebuildArgs({
      project,
      scheme: 'App',
      udid: 'BF2A-1234',
      destination: 'generic/platform=iOS Simulator',
      derivedDataPath: '/dd',
    });
    expect(args[args.indexOf('-destination') + 1]).toBe('generic/platform=iOS Simulator');
  });

  test('extra args land before the `build` action, where xcodebuild expects options', () => {
    const args = xcodebuildArgs({
      project,
      scheme: 'App',
      udid: 'u',
      derivedDataPath: '/dd',
      extraArgs: ['-quiet'],
    });
    expect(args.slice(-2)).toEqual(['-quiet', 'build']);
  });
});

describe('locating the product', () => {
  test('productsDir mirrors the layout xcodebuild writes under -derivedDataPath', () => {
    expect(productsDir('/p/.rn-iso/derived-data')).toBe('/p/.rn-iso/derived-data/Build/Products/Debug-iphonesimulator');
    expect(productsDir('/dd', { configuration: 'Release', sdk: 'iphoneos' })).toBe(
      '/dd/Build/Products/Release-iphoneos',
    );
  });

  test('pickAppBundle prefers the app named after the scheme', () => {
    // An extension or watch app puts more than one .app in the directory and
    // a flat listing cannot tell which one is the top level bundle.
    expect(pickAppBundle(['App.app', 'AppWidget.app', 'App.dSYM'], 'App')).toBe('App.app');
  });

  test('with one .app the name does not matter, and with none it is null', () => {
    expect(pickAppBundle(['Something.app'], 'Other')).toBe('Something.app');
    expect(pickAppBundle(['App.dSYM', 'App.swiftmodule'], 'App')).toBe(null);
    expect(pickAppBundle([], null)).toBe(null);
    expect(pickAppBundle(null, null)).toBe(null);
  });

  test('several unmatched apps still resolve deterministically', () => {
    expect(pickAppBundle(['b.app', 'a.app'], 'nope')).toBe('a.app');
  });

  test('findAppBundle joins onto a real directory, and a missing one is null', () => {
    const dir = join(tmp, 'Products');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'App.app'));
    expect(findAppBundle(dir, 'App')).toBe(join(dir, 'App.app'));
    expect(findAppBundle(join(tmp, 'does-not-exist'), 'App')).toBe(null);
  });
});

describe('reading the bundle id', () => {
  test('parseBundleId takes the identifier out of plutil JSON', () => {
    expect(parseBundleId('{"CFBundleIdentifier":"com.example.app","CFBundleName":"App"}')).toBe('com.example.app');
  });

  test('anything else is null, so the caller reports a build failure with a remedy', () => {
    expect(parseBundleId('{"CFBundleName":"App"}')).toBe(null);
    expect(parseBundleId('{"CFBundleIdentifier":""}')).toBe(null);
    expect(parseBundleId('{"CFBundleIdentifier":42}')).toBe(null);
    expect(parseBundleId('not json')).toBe(null);
    expect(parseBundleId(null)).toBe(null);
  });

  test('readBundleId asks plutil first, with the .plist path', () => {
    const calls: [string, string[] | undefined][] = [];
    setExecutor({
      run: () => '',
      runQuiet: () => null,
      spawn: () => {},
      runFile: (file, args) => {
        calls.push([file, args]);
        return '{"CFBundleIdentifier":"com.example.app"}';
      },
    });
    expect(readBundleId('/dd/App.app')).toBe('com.example.app');
    expect(calls).toEqual([['plutil', ['-convert', 'json', '-o', '-', '/dd/App.app/Info.plist']]]);
  });

  test('falls back to `defaults read`, which takes the path WITHOUT the extension', () => {
    const calls: string[] = [];
    setExecutor({
      run: () => '',
      runQuiet: () => null,
      spawn: () => {},
      runFile: (file, args) => {
        calls.push(file);
        if (file === 'plutil') throw new Error('plutil missing');
        return 'com.example.fallback\n';
      },
    });
    expect(readBundleId('/dd/App.app')).toBe('com.example.fallback');
    expect(calls).toEqual(['plutil', 'defaults']);
  });

  test('both failing is null rather than a throw out of a build', () => {
    setExecutor({
      run: () => '',
      runQuiet: () => null,
      spawn: () => {},
      runFile: () => {
        throw new Error('nope');
      },
    });
    expect(readBundleId('/dd/App.app')).toBe(null);
  });
});

describe('tailLines', () => {
  test('returns the last non-empty lines, which is the caller fallback when extraction finds nothing', () => {
    expect(tailLines(['a', '', 'b', '   ', 'c', 'd', 'e', 'f'], 3)).toEqual(['d', 'e', 'f']);
    expect(tailLines(['only'], 5)).toEqual(['only']);
    expect(tailLines([], 5)).toEqual([]);
    expect(tailLines(null, 5)).toEqual([]);
  });
});

describe('buildIos with a mocked executor', () => {
  // Everything a build needs except an actual Xcode: a project on disk, a
  // scheme listing, a fake child to drive, and a plutil that answers.
  function harness(
    root: string,
    { child, listing = '{"project":{"name":"App","schemes":["App"]}}', bundleId = 'com.example.app' }: any = {},
  ) {
    const spawnCalls: { cmd: string; args: readonly string[] | undefined; opts: SpawnOptions | undefined }[] = [];
    setExecutor({
      run: () => '',
      runQuiet: () => null,
      runFile: (file, args) => {
        if (file === 'xcodebuild') return listing;
        if (file === 'plutil') {
          if (bundleId === null) throw new Error('plutil: cannot read');
          return JSON.stringify({ CFBundleIdentifier: bundleId });
        }
        throw new Error(`unexpected runFile ${file} ${args.join(' ')}`);
      },
      spawn: (cmd, args, opts) => {
        spawnCalls.push({ cmd, args, opts });
        return child;
      },
    });
    stubProject(root, { name: 'App' });
    return spawnCalls;
  }

  function makeProduct(derivedDataPath: string, name = 'App') {
    const dir = productsDir(derivedDataPath);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, `${name}.app`), { recursive: true });
    return join(dir, `${name}.app`);
  }

  test('composes the production invocation: -destination id=<udid>, into the workspace derived data', async () => {
    // The live tests below build with a generic destination because they must
    // not create a simulator. THIS is where the destination an actual `rn-iso
    // ios` run uses is pinned.
    const child = fakeChild();
    const spawnCalls = harness(tmp, { child });
    const dd = join(tmp, '.rn-iso', 'derived-data');
    const promise = buildIos({ root: tmp, udid: 'BF2A-1111-2222', logWriter: recordingWriter() });

    expect(spawnCalls.length).toBe(1);
    const { cmd, args, opts } = spawnCalls[0];
    assert(opts);
    expect(cmd).toBe('xcodebuild');
    expect(args).toEqual([
      '-project',
      join(tmp, 'ios', 'App.xcodeproj'),
      '-scheme',
      'App',
      '-configuration',
      'Debug',
      '-sdk',
      'iphonesimulator',
      '-destination',
      'id=BF2A-1111-2222',
      '-derivedDataPath',
      dd,
      'build',
    ]);
    expect(opts.cwd).toBe(join(tmp, 'ios'));
    expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(opts.detached).toBe(false);
    // Without this xcodebuild block-buffers into a pipe and the whole
    // transcript arrives at exit, which silently un-does the streaming.
    assert(opts.env);
    expect(opts.env.NSUnbufferedIO).toBe('YES');

    makeProduct(dd);
    child.emit('close', 0, null);
    await promise;
  });

  test('every transcript line reaches the writer BEFORE the build exits', async () => {
    // The whole point: an agent tails this file during a four-minute build.
    // A version that collected output and wrote it at exit would pass every
    // other test in this file.
    const child = fakeChild();
    harness(tmp, { child });
    const writer = recordingWriter();
    const dd = join(tmp, 'dd');
    const promise = buildIos({ root: tmp, udid: 'u', logWriter: writer, derivedDataPath: dd });

    expect(writer.records.map((r) => r.event)).toEqual(['build_start']);

    child.stdout.emit('data', 'CompileC main.o\nCompile');
    child.stdout.emit('data', 'Swift App.swift\n');
    child.stderr.emit('data', 'note: from stderr\n');

    const streamed = writer.records.filter((r) => r.level === 'debug');
    expect(streamed.map((r) => r.msg)).toEqual(['CompileC main.o', 'CompileSwift App.swift', 'note: from stderr']);
    expect(streamed.every((r) => r.src === 'build')).toBeTruthy();

    makeProduct(dd);
    child.emit('close', 0, null);
    await promise;
  });

  test('a line left unterminated by a dying child is still recorded', async () => {
    const child = fakeChild();
    harness(tmp, { child });
    const writer = recordingWriter();
    const promise = buildIos({ root: tmp, udid: 'u', logWriter: writer, derivedDataPath: join(tmp, 'dd') });
    child.stdout.emit('data', 'error: died mid-line with no newline');
    child.emit('close', 65, null);
    const result: any = await promise;
    expect(result.failed).toBe(true);
    expect(result.diagnostics.map((d: { message: string }) => d.message)).toEqual(['died mid-line with no newline']);
  });

  test('blank lines are kept for extraction and dropped from the log', async () => {
    const child = fakeChild();
    harness(tmp, { child });
    const writer = recordingWriter();
    const dd = join(tmp, 'dd');
    const promise = buildIos({ root: tmp, udid: 'u', logWriter: writer, derivedDataPath: dd });
    child.stdout.emit('data', 'one\n\n\ntwo\n');
    makeProduct(dd);
    child.emit('close', 0, null);
    const result: any = await promise;
    expect(result.transcriptLines).toBe(4);
    expect(writer.records.filter((r) => r.level === 'debug').length).toBe(2);
  });

  test('success returns the app, its bundle id and the elapsed time', async () => {
    const child = fakeChild();
    harness(tmp, { child, bundleId: 'com.example.app' });
    const dd = join(tmp, 'dd');
    const app = makeProduct(dd);
    const writer = recordingWriter();
    let clock = 1000;
    const promise = buildIos({
      root: tmp,
      udid: 'u',
      logWriter: writer,
      derivedDataPath: dd,
      now: () => clock,
    });
    clock = 161500;
    child.emit('close', 0, null);
    const result: any = await promise;

    expect(result.failed).toBe(undefined);
    expect(result.appPath).toBe(app);
    expect(result.bundleId).toBe('com.example.app');
    expect(result.durationMs).toBe(160500);
    expect(result.scheme).toBe('App');
    const done = writer.records.find((r) => r.event === 'build_done');
    assert(done);
    expect(done.level).toBe('info');
    expect(done.msg).toMatch(/BUILD SUCCEEDED/);
  });

  test('a failed build is a return value, never a throw, and carries the extracted diagnostic', async () => {
    const child = fakeChild();
    harness(tmp, { child });
    const writer = recordingWriter();
    const promise = buildIos({ root: tmp, udid: 'u', logWriter: writer, derivedDataPath: join(tmp, 'dd') });
    child.stdout.emit(
      'data',
      [
        'CompileC /dd/main.o /src/App/AppDelegate.m normal arm64',
        "/src/App/AppDelegate.m:42:8: error: cannot find 'Foo' in scope",
        '1 error generated.',
        '** BUILD FAILED **',
        '',
      ].join('\n'),
    );
    child.emit('close', 65, null);
    const result: any = await promise;

    expect(result.failed).toBe(true);
    expect(result.code).toBe('RN_ISO_BUILD_FAILED');
    expect(result.exitCode).toBe(65);
    expect(result.diagnostics).toEqual([
      { file: '/src/App/AppDelegate.m', line: 42, column: 8, message: "cannot find 'Foo' in scope" },
    ]);
    expect(result.truncated).toBe(0);

    // Contract 1: diagnostics land in the same file as the transcript, at
    // level error, so `logs --errors` finds them without a second source.
    const errors = writer.records.filter((r) => r.level === 'error');
    expect(errors.map((r) => r.msg)).toEqual(["/src/App/AppDelegate.m:42:8: cannot find 'Foo' in scope"]);
    expect(errors[0].src).toBe('build');
  });

  test('more than ten diagnostics are capped, and the rest are counted', async () => {
    const child = fakeChild();
    harness(tmp, { child });
    const writer = recordingWriter();
    const promise = buildIos({ root: tmp, udid: 'u', logWriter: writer, derivedDataPath: join(tmp, 'dd') });
    const lines = Array.from({ length: 13 }, (_, i) => `/src/File${i}.m:${i + 1}:1: error: broken ${i}`);
    child.stdout.emit('data', `${lines.join('\n')}\n** BUILD FAILED **\n`);
    child.emit('close', 65, null);
    const result: any = await promise;
    expect(result.diagnostics.length).toBe(10);
    expect(result.truncated).toBe(3);
    expect(writer.records.filter((r) => r.level === 'error').length).toBe(10);
  });

  test('an unrecognizable failure says so and hands back the log tail', async () => {
    const child = fakeChild();
    harness(tmp, { child });
    const writer = recordingWriter();
    const promise = buildIos({ root: tmp, udid: 'u', logWriter: writer, derivedDataPath: join(tmp, 'dd') });
    child.stdout.emit('data', 'something\nwent\n\nwrong\nsomehow\nentirely\n');
    child.emit('close', 70, null);
    const result: any = await promise;
    expect(result.diagnostics).toEqual([]);
    expect(result.tail).toEqual(['something', 'went', 'wrong', 'somehow', 'entirely']);
    const errors = writer.records.filter((r) => r.level === 'error');
    expect(errors[0].msg).toMatch(/no recognizable diagnostic/);
  });

  test('no ios/ directory fails before anything is spawned', async () => {
    const child = fakeChild();
    const spawnCalls = harness(join(tmp, 'elsewhere'), { child });
    const writer = recordingWriter();
    const result: any = await buildIos({ root: join(tmp, 'nothing-here'), udid: 'u', logWriter: writer });
    expect(result.failed).toBe(true);
    expect(result.code).toBe('RN_ISO_BUILD_FAILED');
    expect(result.diagnostics[0].remedy).toMatch(/prebuild/);
    expect(spawnCalls).toEqual([]);
    expect(writer.records.filter((r) => r.level === 'error').length).toBe(1);
  });

  test('an unresolvable scheme fails as RN_ISO_NO_SCHEME before anything is spawned', async () => {
    const child = fakeChild();
    const spawnCalls = harness(tmp, { child, listing: '{"project":{"name":"App","schemes":["one","two"]}}' });
    const result: any = await buildIos({ root: tmp, udid: 'u', logWriter: recordingWriter() });
    expect(result.failed).toBe(true);
    expect(result.code).toBe('RN_ISO_NO_SCHEME');
    expect(spawnCalls).toEqual([]);
  });

  test('a spawn that throws (no Xcode) is a failure with a remedy, not an exception', async () => {
    stubProject(tmp, { name: 'App' });
    setExecutor({
      run: () => '',
      runQuiet: () => null,
      runFile: () => '{"project":{"name":"App","schemes":["App"]}}',
      spawn: () => {
        throw Object.assign(new Error('spawn xcodebuild ENOENT'), { code: 'ENOENT' });
      },
    });
    const result: any = await buildIos({ root: tmp, udid: 'u', logWriter: recordingWriter() });
    expect(result.failed).toBe(true);
    expect(result.diagnostics[0].message).toMatch(/Could not run xcodebuild/);
    expect(result.diagnostics[0].remedy).toMatch(/xcode-select/);
  });

  test('an asynchronous spawn error resolves the build instead of hanging it', async () => {
    // A child that emits `error` may never emit `close`. Waiting only for
    // close would leave the caller awaiting forever.
    const child = fakeChild();
    harness(tmp, { child });
    const promise = buildIos({ root: tmp, udid: 'u', logWriter: recordingWriter(), derivedDataPath: join(tmp, 'dd') });
    child.emit('error', new Error('spawn xcodebuild EACCES'));
    const result: any = await promise;
    expect(result.failed).toBe(true);
    expect(result.diagnostics[0].message).toMatch(/EACCES/);
  });

  test('a build that succeeds without producing an app is a failure, not a success with no path', async () => {
    const child = fakeChild();
    harness(tmp, { child });
    const promise = buildIos({ root: tmp, udid: 'u', logWriter: recordingWriter(), derivedDataPath: join(tmp, 'dd') });
    child.emit('close', 0, null);
    const result: any = await promise;
    expect(result.failed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.diagnostics[0].message).toMatch(/no \.app is in/);
  });

  test('an app with no readable bundle id is a build failure, not an install failure three steps later', async () => {
    const child = fakeChild();
    harness(tmp, { child, bundleId: null });
    const dd = join(tmp, 'dd');
    makeProduct(dd);
    const promise = buildIos({ root: tmp, udid: 'u', logWriter: recordingWriter(), derivedDataPath: dd });
    child.emit('close', 0, null);
    const result: any = await promise;
    expect(result.failed).toBe(true);
    expect(result.diagnostics[0].message).toMatch(/No readable CFBundleIdentifier/);
  });

  test('programmer errors throw, because they are bugs in the caller and not build outcomes', async () => {
    const writer = recordingWriter();
    await expect(() => buildIos({ udid: 'u', logWriter: writer } as any)).rejects.toThrow(TypeError);
    await expect(() => buildIos({ root: tmp, udid: 'u' } as any)).rejects.toThrow(TypeError);
    await expect(() => buildIos({ root: tmp, udid: 'u', logWriter: {} as any })).rejects.toThrow(TypeError);
    await expect(() => buildIos({ root: tmp, logWriter: writer })).rejects.toThrow(TypeError);
  });
});

// --- the scratch Xcode project the live tests build ---------------------
//
// A hand-written pbxproj rather than a generated one: there is no supported
// command that creates an .xcodeproj from a script, and `xcodegen` is not a
// dependency this repo is going to take on for one test. Code signing is off
// and the only source file is Objective-C with no UIKit, so the build needs
// no team, no simulator and about two seconds.
const SCRATCH_PBXPROJ = `// !$*UTF8*$!
{
archiveVersion = 1;
classes = {
};
objectVersion = 54;
objects = {
AA00000000000000000001  = {isa = PBXBuildFile; fileRef = AA00000000000000000002 ; };
AA00000000000000000002  = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.objc; path = main.m; sourceTree = "<group>"; };
AA00000000000000000003  = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };
AA00000000000000000004  = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = Scratch.app; sourceTree = BUILT_PRODUCTS_DIR; };
AA00000000000000000005  = {
isa = PBXFrameworksBuildPhase;
buildActionMask = 2147483647;
files = (
);
runOnlyForDeploymentPostprocessing = 0;
};
AA00000000000000000006 = {
isa = PBXGroup;
children = (
AA00000000000000000007 ,
AA00000000000000000008 ,
);
sourceTree = "<group>";
};
AA00000000000000000007  = {
isa = PBXGroup;
children = (
AA00000000000000000002 ,
AA00000000000000000003 ,
);
path = Scratch;
sourceTree = "<group>";
};
AA00000000000000000008  = {
isa = PBXGroup;
children = (
AA00000000000000000004 ,
);
name = Products;
sourceTree = "<group>";
};
AA00000000000000000009  = {
isa = PBXNativeTarget;
buildConfigurationList = AA0000000000000000000A ;
buildPhases = (
AA0000000000000000000B ,
AA00000000000000000005 ,
AA0000000000000000000C ,
);
buildRules = (
);
dependencies = (
);
name = Scratch;
productName = Scratch;
productReference = AA00000000000000000004 ;
productType = "com.apple.product-type.application";
};
AA0000000000000000000D  = {
isa = PBXProject;
attributes = {
BuildIndependentTargetsInParallel = 1;
LastUpgradeCheck = 1600;
};
buildConfigurationList = AA0000000000000000000E ;
compatibilityVersion = "Xcode 14.0";
developmentRegion = en;
hasScannedForEncodings = 0;
knownRegions = (
en,
Base,
);
mainGroup = AA00000000000000000006;
productRefGroup = AA00000000000000000008 ;
projectDirPath = "";
projectRoot = "";
targets = (
AA00000000000000000009 ,
);
};
AA0000000000000000000C  = {
isa = PBXResourcesBuildPhase;
buildActionMask = 2147483647;
files = (
);
runOnlyForDeploymentPostprocessing = 0;
};
AA0000000000000000000B  = {
isa = PBXSourcesBuildPhase;
buildActionMask = 2147483647;
files = (
AA00000000000000000001 ,
);
runOnlyForDeploymentPostprocessing = 0;
};
AA0000000000000000000F  = {
isa = XCBuildConfiguration;
buildSettings = {
ALWAYS_SEARCH_USER_PATHS = NO;
CLANG_ENABLE_OBJC_ARC = YES;
CODE_SIGNING_ALLOWED = NO;
CODE_SIGNING_REQUIRED = NO;
CODE_SIGN_IDENTITY = "";
COPY_PHASE_STRIP = NO;
DEBUG_INFORMATION_FORMAT = dwarf;
GCC_OPTIMIZATION_LEVEL = 0;
IPHONEOS_DEPLOYMENT_TARGET = 15.0;
ONLY_ACTIVE_ARCH = YES;
SDKROOT = iphoneos;
};
name = Debug;
};
AA00000000000000000010  = {
isa = XCBuildConfiguration;
buildSettings = {
ALWAYS_SEARCH_USER_PATHS = NO;
CLANG_ENABLE_OBJC_ARC = YES;
CODE_SIGNING_ALLOWED = NO;
CODE_SIGNING_REQUIRED = NO;
CODE_SIGN_IDENTITY = "";
COPY_PHASE_STRIP = NO;
IPHONEOS_DEPLOYMENT_TARGET = 15.0;
SDKROOT = iphoneos;
};
name = Release;
};
AA00000000000000000011  = {
isa = XCBuildConfiguration;
buildSettings = {
GENERATE_INFOPLIST_FILE = NO;
INFOPLIST_FILE = Scratch/Info.plist;
PRODUCT_BUNDLE_IDENTIFIER = com.rniso.scratch;
PRODUCT_NAME = Scratch;
TARGETED_DEVICE_FAMILY = "1,2";
};
name = Debug;
};
AA00000000000000000012  = {
isa = XCBuildConfiguration;
buildSettings = {
GENERATE_INFOPLIST_FILE = NO;
INFOPLIST_FILE = Scratch/Info.plist;
PRODUCT_BUNDLE_IDENTIFIER = com.rniso.scratch;
PRODUCT_NAME = Scratch;
TARGETED_DEVICE_FAMILY = "1,2";
};
name = Release;
};
AA0000000000000000000E  = {
isa = XCConfigurationList;
buildConfigurations = (
AA0000000000000000000F ,
AA00000000000000000010 ,
);
defaultConfigurationIsVisible = 0;
defaultConfigurationName = Release;
};
AA0000000000000000000A  = {
isa = XCConfigurationList;
buildConfigurations = (
AA00000000000000000011 ,
AA00000000000000000012 ,
);
defaultConfigurationIsVisible = 0;
defaultConfigurationName = Release;
};
};
rootObject = AA0000000000000000000D ;
}`;

// Shared, in xcshareddata, because that is the only kind of scheme
// `xcodebuild -list` is guaranteed to report -- which is exactly the failure
// resolveScheme's remedy tells a user to fix.
const SCRATCH_SCHEME = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "1600" version = "1.7">
   <BuildAction parallelizeBuildables = "YES" buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry buildForTesting = "YES" buildForRunning = "YES" buildForProfiling = "YES" buildForArchiving = "YES" buildForAnalyzing = "YES">
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "AA00000000000000000009"
               BuildableName = "Scratch.app"
               BlueprintName = "Scratch"
               ReferencedContainer = "container:Scratch.xcodeproj">
            </BuildableReference>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <LaunchAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle = "0" useCustomWorkingDirectory = "NO" ignoresPersistentStateOnLaunch = "NO" debugDocumentVersioning = "YES" debugServiceExtension = "internal" allowLocationSimulation = "YES">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         <BuildableReference
            BuildableIdentifier = "primary"
            BlueprintIdentifier = "AA00000000000000000009"
            BuildableName = "Scratch.app"
            BlueprintName = "Scratch"
            ReferencedContainer = "container:Scratch.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>
   </LaunchAction>
</Scheme>`;

const SCRATCH_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>$(EXECUTABLE_NAME)</string>
	<key>CFBundleIdentifier</key>
	<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
	<key>CFBundleName</key>
	<string>$(PRODUCT_NAME)</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>UILaunchScreen</key>
	<dict/>
</dict>
</plist>`;

const WORKING_MAIN = `#import <Foundation/Foundation.h>

int main(int argc, char *argv[]) {
  @autoreleasepool {
    NSLog(@"scratch");
  }
  return 0;
}
`;

// One undeclared identifier, on a line and column this file asserts on.
const BROKEN_MAIN = `#import <Foundation/Foundation.h>

int main(int argc, char *argv[]) {
  @autoreleasepool {
    NSLog(@"%@", rnIsoDeliberatelyUndefined);
  }
  return 0;
}
`;

function writeScratchProject(root: string, { main = WORKING_MAIN, workspace = false } = {}) {
  const ios = join(root, 'ios');
  const proj = join(ios, 'Scratch.xcodeproj');
  mkdirSync(join(proj, 'xcshareddata', 'xcschemes'), { recursive: true });
  mkdirSync(join(ios, 'Scratch'), { recursive: true });
  writeFileSync(join(proj, 'project.pbxproj'), SCRATCH_PBXPROJ);
  writeFileSync(join(proj, 'xcshareddata', 'xcschemes', 'Scratch.xcscheme'), SCRATCH_SCHEME);
  writeFileSync(join(ios, 'Scratch', 'Info.plist'), SCRATCH_INFO_PLIST);
  writeFileSync(join(ios, 'Scratch', 'main.m'), main);
  if (workspace) {
    const ws = join(ios, 'Scratch.xcworkspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(
      join(ws, 'contents.xcworkspacedata'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<Workspace version = "1.0">\n   <FileRef location = "group:Scratch.xcodeproj"></FileRef>\n</Workspace>\n',
    );
  }
  return ios;
}

// Through the executor like everything else, so this file imports no
// child_process of its own (CLAUDE.md, "Single exec wrapper"). Evaluated at
// module load, when the default executor is still the active one.
function xcodebuildAvailable() {
  if (process.platform !== 'darwin') return false;
  return getExecutor().runQuiet('xcodebuild -version') !== null;
}

const LIVE = xcodebuildAvailable() ? false : 'xcodebuild is not available on this machine';

// CLAUDE.md item 9. Every one of these drives the DEFAULT executor: real
// spawn, real xcodebuild, real product on disk, real binary Info.plist.
//
// The destination is `generic/platform=iOS Simulator` rather than a udid
// because these tests must not create, boot or touch a simulator (the
// ownership rule: rn-iso only ever uses devices it created). The udid form
// that production uses is pinned by the mocked test above; what these prove
// is that the REST of the argv is a command xcodebuild accepts, that its
// products land where productsDir() says, and that its diagnostics are shaped
// the way errors-xcode.js expects.
const LIVE_DESTINATION = 'generic/platform=iOS Simulator';

describe('buildIos against a real xcodebuild', { skip: LIVE as any }, () => {
  test('discovers the workspace and resolves its scheme through a real -list -json', () => {
    resetExecutor();
    writeScratchProject(tmp, { workspace: true });
    const project = discoverXcodeProject(tmp);
    expect(project.kind).toBe('workspace');
    expect(project.path).toBe(join(tmp, 'ios', 'Scratch.xcworkspace'));
    // Real xcodebuild, real JSON, real parse.
    expect(resolveScheme(project)).toEqual({ scheme: 'Scratch', schemes: ['Scratch'] });
  });

  test('builds for real: the .app lands where productsDir says and its binary plist is readable', async () => {
    resetExecutor();
    writeScratchProject(tmp);
    const logFile = join(tmp, '.rn-iso', 'logs', 'build-ios.ndjson');
    const writer = createNdjsonWriter(logFile);
    const result: any = await buildIos({
      root: tmp,
      udid: 'unused-with-an-explicit-destination',
      destination: LIVE_DESTINATION,
      logWriter: writer,
    });
    writer.close();

    expect(result.failed).toBe(undefined);
    expect(result.scheme).toBe('Scratch');
    expect(result.appPath).toBe(
      join(tmp, '.rn-iso', 'derived-data', 'Build', 'Products', 'Debug-iphonesimulator', 'Scratch.app'),
    );
    expect(existsSync(result.appPath)).toBeTruthy();
    // A built Info.plist is a BINARY plist: this is the assertion that
    // catches reading it as text or as XML.
    expect(result.bundleId).toBe('com.rniso.scratch');
    expect(result.durationMs > 0).toBeTruthy();

    const records = parseNdjsonText(readFileSync(logFile, 'utf-8'));
    expect(records[0].event).toBe('build_start');
    expect(records[0].msg).toMatch(/^xcodebuild -project .*-derivedDataPath .* build$/);
    const transcript = records.filter((r) => r.level === 'debug');
    expect(transcript.length > 20).toBeTruthy();
    expect(transcript.every((r) => r.src === 'build')).toBeTruthy();
    expect(transcript.some((r) => r.msg?.includes('BUILD SUCCEEDED'))).toBeTruthy();
    expect(records.at(-1)?.event).toBe('build_done');
    expect(records.filter((r) => r.level === 'error').length).toBe(0);
  });

  test('fails for real: a broken source file becomes one diagnostic with file, line and column', async () => {
    resetExecutor();
    writeScratchProject(tmp, { main: BROKEN_MAIN });
    const logFile = join(tmp, '.rn-iso', 'logs', 'build-ios.ndjson');
    const writer = createNdjsonWriter(logFile);
    const result: any = await buildIos({
      root: tmp,
      udid: 'unused-with-an-explicit-destination',
      destination: LIVE_DESTINATION,
      logWriter: writer,
    });
    writer.close();

    expect(result.failed).toBe(true);
    expect(result.code).toBe('RN_ISO_BUILD_FAILED');
    expect(result.exitCode).toBe(65);
    // Exactly one: clang reports the same error for each architecture slice
    // and the recap after ** BUILD FAILED ** quotes the CompileC line again.
    expect(result.diagnostics.length).toBe(1);
    const [diagnostic] = result.diagnostics;
    expect(diagnostic.file).toBe(join(tmp, 'ios', 'Scratch', 'main.m'));
    expect(diagnostic.line).toBe(5);
    expect(diagnostic.column).toBe(18);
    expect(diagnostic.message).toMatch(/use of undeclared identifier 'rnIsoDeliberatelyUndefined'/);
    expect(diagnostic.remedy).toBe(undefined);
    expect(result.truncated).toBe(0);
    // The tail is what a caller prints when extraction finds nothing. Here
    // it is xcodebuild's own recap, which is the right fallback and also
    // shows why the recap must NOT be extracted: it names the same file
    // once per architecture slice.
    expect(result.tail.length).toBe(5);
    expect(result.tail.at(-1)).toMatch(/^\(\d+ failures\)$/);

    const records = parseNdjsonText(readFileSync(logFile, 'utf-8'));
    const errors = records.filter((r) => r.level === 'error');
    expect(errors.length).toBe(1);
    expect(errors[0].msg).toMatch(/main\.m:5:18: use of undeclared identifier/);
    expect(records.some((r) => r.level === 'debug' && r.msg?.includes('** BUILD FAILED **'))).toBeTruthy();
  });
});
