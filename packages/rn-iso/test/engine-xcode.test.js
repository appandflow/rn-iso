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
import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, resetExecutor, setExecutor } from '../src/exec.ts';
import { createNdjsonWriter, parseNdjsonText } from '../src/ndjson.ts';
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
} from '../src/engine/xcode.ts';

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

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'rn-iso-xcode-'));
});
afterEach(() => {
  resetExecutor();
  rmSync(tmp, { recursive: true, force: true });
});

function recordingWriter(file = '/dev/null/not-used') {
  const records = [];
  return {
    file,
    records,
    write(record) { records.push(record); return true; },
    close() { return { file, written: records.length, dropped: 0, lastError: null }; },
  };
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 424242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

// A minimal project on disk: enough shape for discovery, no Xcode required.
function stubProject(root, { workspace = false, project = true, name = 'App' } = {}) {
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
    assert.deepEqual(pickXcodeProject(['App.xcodeproj', 'App.xcworkspace', 'Podfile']), {
      kind: 'workspace',
      flag: '-workspace',
      file: 'App.xcworkspace',
      name: 'App',
    });
  });

  test('with no workspace, the project is the answer', () => {
    assert.deepEqual(pickXcodeProject(['App.xcodeproj', 'Podfile', 'App']), {
      kind: 'project',
      flag: '-project',
      file: 'App.xcodeproj',
      name: 'App',
    });
  });

  test('among several workspaces, the one named after a project beside it wins', () => {
    const picked = pickXcodeProject(['Other.xcworkspace', 'App.xcworkspace', 'App.xcodeproj']);
    assert.equal(picked.file, 'App.xcworkspace');
  });

  test('with no name to match, the choice is alphabetical so it never varies between runs', () => {
    assert.equal(pickXcodeProject(['b.xcworkspace', 'a.xcworkspace']).file, 'a.xcworkspace');
    assert.equal(pickXcodeProject(['b.xcodeproj', 'a.xcodeproj']).file, 'a.xcodeproj');
  });

  test('nothing buildable is null, not a throw', () => {
    assert.equal(pickXcodeProject(['Podfile', 'Pods']), null);
    assert.equal(pickXcodeProject([]), null);
    assert.equal(pickXcodeProject(null), null);
    assert.equal(pickXcodeProject([undefined, 42]), null);
  });
});

describe('discoverXcodeProject', () => {
  test('finds the workspace and reports the flag, the container dir and the full path', () => {
    stubProject(tmp, { workspace: true });
    assert.deepEqual(discoverXcodeProject(tmp), {
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
    assert.equal(error.code, 'RN_ISO_BUILD_FAILED');
    assert.match(error.message, /No ios\/ directory/);
    assert.match(error.remedy, /expo prebuild -p ios/);
  });

  test('an ios/ directory with nothing buildable in it says exactly that', () => {
    mkdirSync(join(tmp, 'ios'), { recursive: true });
    writeFileSync(join(tmp, 'ios', 'Podfile'), 'platform :ios');
    const { error } = discoverXcodeProject(tmp);
    assert.equal(error.code, 'RN_ISO_BUILD_FAILED');
    assert.match(error.message, /contains no \.xcworkspace and no \.xcodeproj/);
    assert.match(error.remedy, /prebuild/);
  });
});

describe('parseSchemeList', () => {
  test('reads a real project listing', () => {
    assert.deepEqual(parseSchemeList(REAL_PROJECT_LIST_JSON), { name: 'Scratch', schemes: ['Scratch'] });
  });

  test('reads a real workspace listing, which carries neither targets nor configurations', () => {
    assert.deepEqual(parseSchemeList(REAL_WORKSPACE_LIST_JSON), { name: 'Scratch', schemes: ['Scratch'] });
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
    assert.deepEqual(parseSchemeList(noisy), { name: 'Scratch', schemes: ['Scratch'] });
  });

  test('garbage is the empty listing rather than a parse error reaching the user', () => {
    const empty = { name: null, schemes: [] };
    assert.deepEqual(parseSchemeList('not json at all'), empty);
    assert.deepEqual(parseSchemeList('{ broken'), empty);
    assert.deepEqual(parseSchemeList('{}'), empty);
    assert.deepEqual(parseSchemeList('{"project":{"name":"A"}}'), { name: 'A', schemes: [] });
    assert.deepEqual(parseSchemeList(''), empty);
    assert.deepEqual(parseSchemeList(null), empty);
  });

  test('non-string schemes are dropped rather than carried into an argv', () => {
    assert.deepEqual(parseSchemeList('{"project":{"name":"A","schemes":["Ok","",null,7]}}'), {
      name: 'A',
      schemes: ['Ok'],
    });
  });
});

describe('pickScheme', () => {
  test('the scheme named after the container wins, which is every generated RN project', () => {
    assert.equal(pickScheme(['MyApp', 'MyApp-tvOS', 'MyAppTests'], 'MyApp'), 'MyApp');
  });

  test('a case difference still matches, because Xcode is not case sensitive about this', () => {
    assert.equal(pickScheme(['myapp'], 'MyApp'), 'myapp');
  });

  test('with no name match, the only non-test scheme is the answer', () => {
    assert.equal(pickScheme(['Runner', 'RunnerTests', 'RunnerUITests'], 'SomethingElse'), 'Runner');
  });

  test('several plausible schemes is null, NOT the first one', () => {
    // Guessing here builds the tvOS target or a staging variant and installs
    // it four minutes later. RN_ISO_NO_SCHEME is worth more than a coin flip.
    assert.equal(pickScheme(['App-staging', 'App-production'], 'Unrelated'), null);
  });

  test('a project whose only scheme is a test scheme has nothing to build', () => {
    assert.equal(pickScheme(['AppTests'], 'Unrelated'), null);
  });

  test('but an exact match still wins even when the name looks like a test scheme', () => {
    assert.equal(pickScheme(['AppTests'], 'AppTests'), 'AppTests');
  });

  test('no schemes is null, and so is nonsense input', () => {
    assert.equal(pickScheme([], 'App'), null);
    assert.equal(pickScheme(null, 'App'), null);
    assert.equal(pickScheme(['App'], null), 'App', 'a single scheme still resolves with no name');
  });
});

describe('listSchemes and resolveScheme', () => {
  const project = { flag: '-project', path: '/p/ios/App.xcodeproj', name: 'App', dir: '/p/ios' };

  test('runs xcodebuild -list -json through runFile, so a path with a space stays one argument', () => {
    const calls = [];
    setExecutor({
      run: () => '',
      runQuiet: () => null,
      runFile: (file, args) => { calls.push([file, args]); return REAL_PROJECT_LIST_JSON; },
      spawn: () => {},
    });
    assert.deepEqual(listSchemes(project), { name: 'Scratch', schemes: ['Scratch'] });
    assert.deepEqual(calls, [['xcodebuild', ['-project', '/p/ios/App.xcodeproj', '-list', '-json']]]);
  });

  test('a tool failure is null, which is not the same as a listing with no schemes', () => {
    setExecutor({
      run: () => '', runQuiet: () => null, spawn: () => {},
      runFile: () => { throw new Error('xcodebuild: error: unable to read project'); },
    });
    assert.equal(listSchemes(project), null);
  });

  test('resolveScheme maps a failed listing to RN_ISO_NO_SCHEME with the command to run', () => {
    setExecutor({
      run: () => '', runQuiet: () => null, spawn: () => {},
      runFile: () => { throw new Error('boom'); },
    });
    const { error } = resolveScheme(project);
    assert.equal(error.code, 'RN_ISO_NO_SCHEME');
    assert.match(error.message, /Could not list schemes/);
    assert.match(error.remedy, /-list/);
  });

  test('resolveScheme names the schemes it did find when none of them is buildable', () => {
    setExecutor({
      run: () => '', runQuiet: () => null, spawn: () => {},
      runFile: () => '{"project":{"name":"App","schemes":["one","two"]}}',
    });
    const { error } = resolveScheme(project);
    assert.equal(error.code, 'RN_ISO_NO_SCHEME');
    assert.match(error.message, /schemes: one, two/);
    assert.match(error.remedy, /Shared/);
  });

  test('resolveScheme returns the scheme and the full list on success', () => {
    setExecutor({
      run: () => '', runQuiet: () => null, spawn: () => {},
      runFile: () => REAL_PROJECT_LIST_JSON,
    });
    assert.deepEqual(resolveScheme({ ...project, name: 'Scratch' }), {
      scheme: 'Scratch',
      schemes: ['Scratch'],
    });
  });
});

describe('xcodebuildArgs', () => {
  const project = { flag: '-workspace', path: '/p/ios/App.xcworkspace' };

  test('is exactly the invocation the plan specifies, in order', () => {
    assert.deepEqual(
      xcodebuildArgs({ project, scheme: 'App', udid: 'BF2A-1234', derivedDataPath: '/p/.rn-iso/derived-data' }),
      [
        '-workspace', '/p/ios/App.xcworkspace',
        '-scheme', 'App',
        '-configuration', 'Debug',
        '-sdk', 'iphonesimulator',
        '-destination', 'id=BF2A-1234',
        '-derivedDataPath', '/p/.rn-iso/derived-data',
        'build',
      ]
    );
  });

  test('an explicit destination replaces the udid one, for a build with no device', () => {
    const args = xcodebuildArgs({
      project, scheme: 'App', udid: 'BF2A-1234',
      destination: 'generic/platform=iOS Simulator',
      derivedDataPath: '/dd',
    });
    assert.equal(args[args.indexOf('-destination') + 1], 'generic/platform=iOS Simulator');
  });

  test('extra args land before the `build` action, where xcodebuild expects options', () => {
    const args = xcodebuildArgs({
      project, scheme: 'App', udid: 'u', derivedDataPath: '/dd',
      extraArgs: ['-quiet'],
    });
    assert.deepEqual(args.slice(-2), ['-quiet', 'build']);
  });
});

describe('locating the product', () => {
  test('productsDir mirrors the layout xcodebuild writes under -derivedDataPath', () => {
    assert.equal(
      productsDir('/p/.rn-iso/derived-data'),
      '/p/.rn-iso/derived-data/Build/Products/Debug-iphonesimulator'
    );
    assert.equal(
      productsDir('/dd', { configuration: 'Release', sdk: 'iphoneos' }),
      '/dd/Build/Products/Release-iphoneos'
    );
  });

  test('pickAppBundle prefers the app named after the scheme', () => {
    // An extension or watch app puts more than one .app in the directory and
    // a flat listing cannot tell which one is the top level bundle.
    assert.equal(pickAppBundle(['App.app', 'AppWidget.app', 'App.dSYM'], 'App'), 'App.app');
  });

  test('with one .app the name does not matter, and with none it is null', () => {
    assert.equal(pickAppBundle(['Something.app'], 'Other'), 'Something.app');
    assert.equal(pickAppBundle(['App.dSYM', 'App.swiftmodule'], 'App'), null);
    assert.equal(pickAppBundle([], null), null);
    assert.equal(pickAppBundle(null, null), null);
  });

  test('several unmatched apps still resolve deterministically', () => {
    assert.equal(pickAppBundle(['b.app', 'a.app'], 'nope'), 'a.app');
  });

  test('findAppBundle joins onto a real directory, and a missing one is null', () => {
    const dir = join(tmp, 'Products');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'App.app'));
    assert.equal(findAppBundle(dir, 'App'), join(dir, 'App.app'));
    assert.equal(findAppBundle(join(tmp, 'does-not-exist'), 'App'), null);
  });
});

describe('reading the bundle id', () => {
  test('parseBundleId takes the identifier out of plutil JSON', () => {
    assert.equal(parseBundleId('{"CFBundleIdentifier":"com.example.app","CFBundleName":"App"}'), 'com.example.app');
  });

  test('anything else is null, so the caller reports a build failure with a remedy', () => {
    assert.equal(parseBundleId('{"CFBundleName":"App"}'), null);
    assert.equal(parseBundleId('{"CFBundleIdentifier":""}'), null);
    assert.equal(parseBundleId('{"CFBundleIdentifier":42}'), null);
    assert.equal(parseBundleId('not json'), null);
    assert.equal(parseBundleId(null), null);
  });

  test('readBundleId asks plutil first, with the .plist path', () => {
    const calls = [];
    setExecutor({
      run: () => '', runQuiet: () => null, spawn: () => {},
      runFile: (file, args) => { calls.push([file, args]); return '{"CFBundleIdentifier":"com.example.app"}'; },
    });
    assert.equal(readBundleId('/dd/App.app'), 'com.example.app');
    assert.deepEqual(calls, [['plutil', ['-convert', 'json', '-o', '-', '/dd/App.app/Info.plist']]]);
  });

  test('falls back to `defaults read`, which takes the path WITHOUT the extension', () => {
    const calls = [];
    setExecutor({
      run: () => '', runQuiet: () => null, spawn: () => {},
      runFile: (file, args) => {
        calls.push(file);
        if (file === 'plutil') throw new Error('plutil missing');
        return 'com.example.fallback\n';
      },
    });
    assert.equal(readBundleId('/dd/App.app'), 'com.example.fallback');
    assert.deepEqual(calls, ['plutil', 'defaults']);
  });

  test('both failing is null rather than a throw out of a build', () => {
    setExecutor({
      run: () => '', runQuiet: () => null, spawn: () => {},
      runFile: () => { throw new Error('nope'); },
    });
    assert.equal(readBundleId('/dd/App.app'), null);
  });
});

describe('tailLines', () => {
  test('returns the last non-empty lines, which is the caller fallback when extraction finds nothing', () => {
    assert.deepEqual(tailLines(['a', '', 'b', '   ', 'c', 'd', 'e', 'f'], 3), ['d', 'e', 'f']);
    assert.deepEqual(tailLines(['only'], 5), ['only']);
    assert.deepEqual(tailLines([], 5), []);
    assert.deepEqual(tailLines(null, 5), []);
  });
});

describe('buildIos with a mocked executor', () => {
  // Everything a build needs except an actual Xcode: a project on disk, a
  // scheme listing, a fake child to drive, and a plutil that answers.
  function harness(root, { child, listing = '{"project":{"name":"App","schemes":["App"]}}', bundleId = 'com.example.app' } = {}) {
    const spawnCalls = [];
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
      spawn: (cmd, args, opts) => { spawnCalls.push({ cmd, args, opts }); return child; },
    });
    stubProject(root, { name: 'App' });
    return spawnCalls;
  }

  function makeProduct(derivedDataPath, name = 'App') {
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

    assert.equal(spawnCalls.length, 1);
    const { cmd, args, opts } = spawnCalls[0];
    assert.equal(cmd, 'xcodebuild');
    assert.deepEqual(args, [
      '-project', join(tmp, 'ios', 'App.xcodeproj'),
      '-scheme', 'App',
      '-configuration', 'Debug',
      '-sdk', 'iphonesimulator',
      '-destination', 'id=BF2A-1111-2222',
      '-derivedDataPath', dd,
      'build',
    ]);
    assert.equal(opts.cwd, join(tmp, 'ios'), 'runs where a human would run it');
    assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(opts.detached, false);
    // Without this xcodebuild block-buffers into a pipe and the whole
    // transcript arrives at exit, which silently un-does the streaming.
    assert.equal(opts.env.NSUnbufferedIO, 'YES');

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

    assert.deepEqual(
      writer.records.map(r => r.event),
      ['build_start'],
      'the exact command is the first thing in the log'
    );

    child.stdout.emit('data', 'CompileC main.o\nCompile');
    child.stdout.emit('data', 'Swift App.swift\n');
    child.stderr.emit('data', 'note: from stderr\n');

    const streamed = writer.records.filter(r => r.level === 'debug');
    assert.deepEqual(streamed.map(r => r.msg), ['CompileC main.o', 'CompileSwift App.swift', 'note: from stderr']);
    assert.ok(streamed.every(r => r.src === 'build'), 'Contract 1: src is build');

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
    const result = await promise;
    assert.equal(result.failed, true);
    assert.deepEqual(result.diagnostics.map(d => d.message), ['died mid-line with no newline']);
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
    const result = await promise;
    assert.equal(result.transcriptLines, 4);
    assert.equal(writer.records.filter(r => r.level === 'debug').length, 2);
  });

  test('success returns the app, its bundle id and the elapsed time', async () => {
    const child = fakeChild();
    harness(tmp, { child, bundleId: 'com.example.app' });
    const dd = join(tmp, 'dd');
    const app = makeProduct(dd);
    const writer = recordingWriter();
    let clock = 1000;
    const promise = buildIos({
      root: tmp, udid: 'u', logWriter: writer, derivedDataPath: dd,
      now: () => clock,
    });
    clock = 161500;
    child.emit('close', 0, null);
    const result = await promise;

    assert.equal(result.failed, undefined);
    assert.equal(result.appPath, app);
    assert.equal(result.bundleId, 'com.example.app');
    assert.equal(result.durationMs, 160500);
    assert.equal(result.scheme, 'App');
    const done = writer.records.find(r => r.event === 'build_done');
    assert.equal(done.level, 'info');
    assert.match(done.msg, /BUILD SUCCEEDED/);
  });

  test('a failed build is a return value, never a throw, and carries the extracted diagnostic', async () => {
    const child = fakeChild();
    harness(tmp, { child });
    const writer = recordingWriter();
    const promise = buildIos({ root: tmp, udid: 'u', logWriter: writer, derivedDataPath: join(tmp, 'dd') });
    child.stdout.emit('data', [
      'CompileC /dd/main.o /src/App/AppDelegate.m normal arm64',
      "/src/App/AppDelegate.m:42:8: error: cannot find 'Foo' in scope",
      '1 error generated.',
      '** BUILD FAILED **',
      '',
    ].join('\n'));
    child.emit('close', 65, null);
    const result = await promise;

    assert.equal(result.failed, true);
    assert.equal(result.code, 'RN_ISO_BUILD_FAILED');
    assert.equal(result.exitCode, 65);
    assert.deepEqual(result.diagnostics, [
      { file: '/src/App/AppDelegate.m', line: 42, column: 8, message: "cannot find 'Foo' in scope" },
    ]);
    assert.equal(result.truncated, 0);

    // Contract 1: diagnostics land in the same file as the transcript, at
    // level error, so `logs --errors` finds them without a second source.
    const errors = writer.records.filter(r => r.level === 'error');
    assert.deepEqual(errors.map(r => r.msg), ["/src/App/AppDelegate.m:42:8: cannot find 'Foo' in scope"]);
    assert.equal(errors[0].src, 'build');
  });

  test('more than ten diagnostics are capped, and the rest are counted', async () => {
    const child = fakeChild();
    harness(tmp, { child });
    const writer = recordingWriter();
    const promise = buildIos({ root: tmp, udid: 'u', logWriter: writer, derivedDataPath: join(tmp, 'dd') });
    const lines = Array.from({ length: 13 }, (_, i) => `/src/File${i}.m:${i + 1}:1: error: broken ${i}`);
    child.stdout.emit('data', `${lines.join('\n')}\n** BUILD FAILED **\n`);
    child.emit('close', 65, null);
    const result = await promise;
    assert.equal(result.diagnostics.length, 10);
    assert.equal(result.truncated, 3);
    assert.equal(writer.records.filter(r => r.level === 'error').length, 10);
  });

  test('an unrecognizable failure says so and hands back the log tail', async () => {
    const child = fakeChild();
    harness(tmp, { child });
    const writer = recordingWriter();
    const promise = buildIos({ root: tmp, udid: 'u', logWriter: writer, derivedDataPath: join(tmp, 'dd') });
    child.stdout.emit('data', 'something\nwent\n\nwrong\nsomehow\nentirely\n');
    child.emit('close', 70, null);
    const result = await promise;
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.tail, ['something', 'went', 'wrong', 'somehow', 'entirely'],
      'five non-empty lines, blanks skipped');
    const errors = writer.records.filter(r => r.level === 'error');
    assert.match(errors[0].msg, /no recognizable diagnostic/);
  });

  test('no ios/ directory fails before anything is spawned', async () => {
    const child = fakeChild();
    const spawnCalls = harness(join(tmp, 'elsewhere'), { child });
    const writer = recordingWriter();
    const result = await buildIos({ root: join(tmp, 'nothing-here'), udid: 'u', logWriter: writer });
    assert.equal(result.failed, true);
    assert.equal(result.code, 'RN_ISO_BUILD_FAILED');
    assert.match(result.diagnostics[0].remedy, /prebuild/);
    assert.deepEqual(spawnCalls, []);
    assert.equal(writer.records.filter(r => r.level === 'error').length, 1);
  });

  test('an unresolvable scheme fails as RN_ISO_NO_SCHEME before anything is spawned', async () => {
    const child = fakeChild();
    const spawnCalls = harness(tmp, { child, listing: '{"project":{"name":"App","schemes":["one","two"]}}' });
    const result = await buildIos({ root: tmp, udid: 'u', logWriter: recordingWriter() });
    assert.equal(result.failed, true);
    assert.equal(result.code, 'RN_ISO_NO_SCHEME');
    assert.deepEqual(spawnCalls, []);
  });

  test('a spawn that throws (no Xcode) is a failure with a remedy, not an exception', async () => {
    stubProject(tmp, { name: 'App' });
    setExecutor({
      run: () => '', runQuiet: () => null,
      runFile: () => '{"project":{"name":"App","schemes":["App"]}}',
      spawn: () => { throw Object.assign(new Error('spawn xcodebuild ENOENT'), { code: 'ENOENT' }); },
    });
    const result = await buildIos({ root: tmp, udid: 'u', logWriter: recordingWriter() });
    assert.equal(result.failed, true);
    assert.match(result.diagnostics[0].message, /Could not run xcodebuild/);
    assert.match(result.diagnostics[0].remedy, /xcode-select/);
  });

  test('an asynchronous spawn error resolves the build instead of hanging it', async () => {
    // A child that emits `error` may never emit `close`. Waiting only for
    // close would leave the caller awaiting forever.
    const child = fakeChild();
    harness(tmp, { child });
    const promise = buildIos({ root: tmp, udid: 'u', logWriter: recordingWriter(), derivedDataPath: join(tmp, 'dd') });
    child.emit('error', new Error('spawn xcodebuild EACCES'));
    const result = await promise;
    assert.equal(result.failed, true);
    assert.match(result.diagnostics[0].message, /EACCES/);
  });

  test('a build that succeeds without producing an app is a failure, not a success with no path', async () => {
    const child = fakeChild();
    harness(tmp, { child });
    const promise = buildIos({ root: tmp, udid: 'u', logWriter: recordingWriter(), derivedDataPath: join(tmp, 'dd') });
    child.emit('close', 0, null);
    const result = await promise;
    assert.equal(result.failed, true);
    assert.equal(result.exitCode, 0);
    assert.match(result.diagnostics[0].message, /no \.app is in/);
  });

  test('an app with no readable bundle id is a build failure, not an install failure three steps later', async () => {
    const child = fakeChild();
    harness(tmp, { child, bundleId: null });
    const dd = join(tmp, 'dd');
    makeProduct(dd);
    const promise = buildIos({ root: tmp, udid: 'u', logWriter: recordingWriter(), derivedDataPath: dd });
    child.emit('close', 0, null);
    const result = await promise;
    assert.equal(result.failed, true);
    assert.match(result.diagnostics[0].message, /No readable CFBundleIdentifier/);
  });

  test('programmer errors throw, because they are bugs in the caller and not build outcomes', async () => {
    const writer = recordingWriter();
    await assert.rejects(() => buildIos({ udid: 'u', logWriter: writer }), TypeError);
    await assert.rejects(() => buildIos({ root: tmp, udid: 'u' }), TypeError);
    await assert.rejects(() => buildIos({ root: tmp, udid: 'u', logWriter: {} }), TypeError);
    await assert.rejects(() => buildIos({ root: tmp, logWriter: writer }), TypeError);
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

function writeScratchProject(root, { main = WORKING_MAIN, workspace = false } = {}) {
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
    writeFileSync(join(ws, 'contents.xcworkspacedata'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<Workspace version = "1.0">\n   <FileRef location = "group:Scratch.xcodeproj"></FileRef>\n</Workspace>\n');
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

describe('buildIos against a real xcodebuild', { skip: LIVE }, () => {
  test('discovers the workspace and resolves its scheme through a real -list -json', () => {
    resetExecutor();
    writeScratchProject(tmp, { workspace: true });
    const project = discoverXcodeProject(tmp);
    assert.equal(project.kind, 'workspace', 'the workspace beside the project wins');
    assert.equal(project.path, join(tmp, 'ios', 'Scratch.xcworkspace'));
    // Real xcodebuild, real JSON, real parse.
    assert.deepEqual(resolveScheme(project), { scheme: 'Scratch', schemes: ['Scratch'] });
  });

  test('builds for real: the .app lands where productsDir says and its binary plist is readable', async () => {
    resetExecutor();
    writeScratchProject(tmp);
    const logFile = join(tmp, '.rn-iso', 'logs', 'build-ios.ndjson');
    const writer = createNdjsonWriter(logFile);
    const result = await buildIos({
      root: tmp,
      udid: 'unused-with-an-explicit-destination',
      destination: LIVE_DESTINATION,
      logWriter: writer,
    });
    writer.close();

    assert.equal(result.failed, undefined, `expected a successful build, got ${JSON.stringify(result.diagnostics)}`);
    assert.equal(result.scheme, 'Scratch');
    assert.equal(result.appPath, join(tmp, '.rn-iso', 'derived-data', 'Build', 'Products', 'Debug-iphonesimulator', 'Scratch.app'));
    assert.ok(existsSync(result.appPath), 'the app xcodebuild wrote is where productsDir predicted');
    // A built Info.plist is a BINARY plist: this is the assertion that
    // catches reading it as text or as XML.
    assert.equal(result.bundleId, 'com.rniso.scratch');
    assert.ok(result.durationMs > 0);

    const records = parseNdjsonText(readFileSync(logFile, 'utf-8'));
    assert.equal(records[0].event, 'build_start');
    assert.match(records[0].msg, /^xcodebuild -project .*-derivedDataPath .* build$/);
    const transcript = records.filter(r => r.level === 'debug');
    assert.ok(transcript.length > 20, `expected a real transcript, got ${transcript.length} lines`);
    assert.ok(transcript.every(r => r.src === 'build'));
    assert.ok(transcript.some(r => r.msg.includes('BUILD SUCCEEDED')), 'the transcript is the real one');
    assert.equal(records.at(-1).event, 'build_done');
    assert.equal(records.filter(r => r.level === 'error').length, 0);
  });

  test('fails for real: a broken source file becomes one diagnostic with file, line and column', async () => {
    resetExecutor();
    writeScratchProject(tmp, { main: BROKEN_MAIN });
    const logFile = join(tmp, '.rn-iso', 'logs', 'build-ios.ndjson');
    const writer = createNdjsonWriter(logFile);
    const result = await buildIos({
      root: tmp,
      udid: 'unused-with-an-explicit-destination',
      destination: LIVE_DESTINATION,
      logWriter: writer,
    });
    writer.close();

    assert.equal(result.failed, true);
    assert.equal(result.code, 'RN_ISO_BUILD_FAILED');
    assert.equal(result.exitCode, 65);
    // Exactly one: clang reports the same error for each architecture slice
    // and the recap after ** BUILD FAILED ** quotes the CompileC line again.
    assert.equal(result.diagnostics.length, 1, JSON.stringify(result.diagnostics));
    const [diagnostic] = result.diagnostics;
    assert.equal(diagnostic.file, join(tmp, 'ios', 'Scratch', 'main.m'));
    assert.equal(diagnostic.line, 5);
    assert.equal(diagnostic.column, 18);
    assert.match(diagnostic.message, /use of undeclared identifier 'rnIsoDeliberatelyUndefined'/);
    assert.equal(diagnostic.remedy, undefined, 'a compile error has no mechanical remedy to name');
    assert.equal(result.truncated, 0);
    // The tail is what a caller prints when extraction finds nothing. Here
    // it is xcodebuild's own recap, which is the right fallback and also
    // shows why the recap must NOT be extracted: it names the same file
    // once per architecture slice.
    assert.equal(result.tail.length, 5);
    assert.match(result.tail.at(-1), /^\(\d+ failures\)$/);

    const records = parseNdjsonText(readFileSync(logFile, 'utf-8'));
    const errors = records.filter(r => r.level === 'error');
    assert.equal(errors.length, 1);
    assert.match(errors[0].msg, /main\.m:5:18: use of undeclared identifier/);
    assert.ok(
      records.some(r => r.level === 'debug' && r.msg.includes('** BUILD FAILED **')),
      'the full transcript is still on disk, which is what the diagnostic replaces on stdout'
    );
  });
});
