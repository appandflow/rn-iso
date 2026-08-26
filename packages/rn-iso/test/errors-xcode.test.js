// Transcript -> diagnostics. This file is the reason `rn-iso ios` can print a
// compiler error instead of a build log, so it is tested against transcripts
// that a real xcodebuild really produced rather than against strings written
// from memory.
//
// Every REAL_* fixture below was captured from Xcode 26.6 (build 17F113) on
// macOS 26.5 by building a scratch iOS app project created for this purpose:
// a single Objective-C target, deliberately broken one way per capture, built
// with the same argv src/engine/xcode.js composes. They are trimmed to the
// interesting window, and the two places where a 1300-to-2300 character clang
// argv sat are marked `[argv elided]` -- nothing else is edited, including the
// indentation, which is load-bearing: xcodebuild indents echoed commands by
// four spaces and that is what separates a compiler's output from a
// compiler's argv.
//
// Recording them matters because the formats are not documented and DO move:
// the linker's undefined-symbol header changed spelling in Xcode 15, and
// "error:" arrives with a file, with a project path, with a tool name in
// front, or with nothing at all depending on who is speaking.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DIAGNOSTICS,
  capDiagnostics,
  describeDiagnostic,
  extractXcodeDiagnostics,
} from '../src/engine/errors-xcode.ts';

const REAL_COMPILE_FAILURE = [
  'CompileC /tmp/rn-iso-xc/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Objects-normal/arm64/main.o /tmp/rn-iso-xc/Scratch/main.m normal arm64 objective-c com.apple.compilers.llvm.clang.1_0.compiler (in target \'Scratch\' from project \'Scratch\')',
  '    cd /tmp/rn-iso-xc',
  '    ',
  '    Using response file: /tmp/rn-iso-xc/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Objects-normal/arm64/e6072d4f65d7061329687fe24e3d63a7-common-args.resp',
  '    ',
  '    /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang -x  [argv elided] cratch.build/Objects-normal/arm64/main.o',
  '/tmp/rn-iso-xc/Scratch/main.m:5:18: error: use of undeclared identifier \'undefinedThing\'',
  '    5 |     NSLog(@"%@", undefinedThing);',
  '      |                  ^~~~~~~~~~~~~~',
  '/tmp/rn-iso-xc/Scratch/main.m:6:19: error: implicit conversion of \'int\' to \'NSString *\' is disallowed with ARC',
  '    6 |     NSString *s = 42;',
  '      |                   ^~',
  '2 errors generated.',
  '',
  '** BUILD FAILED **',
  '',
  '',
  'The following build commands failed:',
  '\tCompileC /tmp/rn-iso-xc/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Objects-normal/arm64/main.o /tmp/rn-iso-xc/Scratch/main.m normal arm64 objective-c com.apple.compilers.llvm.clang.1_0.compiler (in target \'Scratch\' from project \'Scratch\')',
  '\tBuilding project Scratch with scheme Scratch and configuration Debug',
  '(2 failures)',
].join('\n');

const REAL_LINK_FAILURE = [
  'Ld /tmp/rn-iso-xc/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Objects-normal/arm64/Binary/Scratch normal arm64 (in target \'Scratch\' from project \'Scratch\')',
  '    cd /tmp/rn-iso-xc',
  '    /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang -Xl [argv elided] uild/Objects-normal/arm64/Binary/Scratch',
  'Undefined symbols for architecture arm64:',
  '  "_rnIsoMissingFunction", referenced from:',
  '      _main in main.o',
  'ld: symbol(s) not found for architecture arm64',
  '/tmp/rn-iso-xc/Scratch.xcodeproj: Scratch: clang: error: linker command failed with exit code 1 (use -v to see invocation)',
  '',
  'Ld /tmp/rn-iso-xc/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Objects-normal/x86_64/Binary/Scratch normal x86_64 (in target \'Scratch\' from project \'Scratch\')',
  '    cd /tmp/rn-iso-xc',
  '    /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang -Xl [argv elided] ild/Objects-normal/x86_64/Binary/Scratch',
  'Undefined symbols for architecture x86_64:',
  '  "_rnIsoMissingFunction", referenced from:',
  '      _main in main.o',
  '',
  '** BUILD FAILED **',
  '',
  '',
  'The following build commands failed:',
  '\tLd /tmp/rn-iso-xc/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Objects-normal/arm64/Binary/Scratch normal arm64 (in target \'Scratch\' from project \'Scratch\')',
  '\tBuilding project Scratch with scheme Scratch and configuration Debug',
  '(2 failures)',
].join('\n');

const REAL_PODS_FAILURE = [
  '',
  'PhaseScriptExecution [CP]\\ Check\\ Pods\\ Manifest.lock /tmp/rn-iso-xc-pods/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Script-AA00000000000000000020.sh (in target \'Scratch\' from project \'Scratch\')',
  '    cd /tmp/rn-iso-xc-pods',
  '    /bin/sh -c /tmp/rn-iso-xc-pods/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Script-AA00000000000000000020.sh',
  'error: The sandbox is not in sync with the Podfile.lock. Run \'pod install\' or update your CocoaPods installation.',
  '',
  'ProcessInfoPlistFile /tmp/rn-iso-xc-pods/dd/Build/Products/Debug-iphonesimulator/Scratch.app/Info.plist /tmp/rn-iso-xc-pods/Scratch/Info.plist (in target \'Scratch\' from project \'Scratch\')',
  '    cd /tmp/rn-iso-xc-pods',
  '    builtin-infoPlistUtility /tmp/rn-iso-xc-pods/Scratch/Info.plist -producttype com.apple.product-type.application -genpkginfo /tmp/rn-iso-xc-pods/dd/Build/Products/Debug-iphonesimulator/Scratch.app/PkgInfo -expandbuildsettings -format binary -platform iphonesimulator -o /tmp/rn-iso-xc-pods/dd/Build/Products/Debug-iphonesimulator/Scratch.app/Info.plist',
  '',
  'warning: Run script build phase \'[CP] Check Pods Manifest.lock\' will be run during every build because it does not specify any outputs. To address this issue, either add output dependencies to the script phase, or configure it to run in every build by unchecking "Based on dependency analysis" in the script phase. (in target \'Scratch\' from project \'Scratch\')',
  '** BUILD FAILED **',
  '',
].join('\n');

const REAL_SIGNING_FAILURE = [
  'Build description signature: 5aff88b39ca8e2b9798e399e4ba14334',
  'Build description path: /tmp/rn-iso-xc/dd-dev/Build/Intermediates.noindex/XCBuildData/5aff88b39ca8e2b9798e399e4ba14334.xcbuilddata',
  '/tmp/rn-iso-xc/Scratch.xcodeproj: error: No profiles for \'com.rniso.scratch\' were found: Xcode couldn\'t find any iOS App Development provisioning profiles matching \'com.rniso.scratch\'. Automatic signing is disabled and unable to generate a profile. To enable automatic signing, pass -allowProvisioningUpdates to xcodebuild. (in target \'Scratch\' from project \'Scratch\')',
  '** BUILD FAILED **',
  '',
].join('\n');

const REAL_SCHEME_FAILURE = [
  'Command line invocation:',
  '    /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -project Scratch.xcodeproj -scheme NoSuchScheme -configuration Debug -sdk iphonesimulator build',
  '',
  'Build settings from command line:',
  '    SDKROOT = iphonesimulator26.5',
  '',
  '2026-08-25 13:18:28.966 xcodebuild[94932:16893065] Writing error result bundle to /var/folders/4g/960y2hbs4z73qw_nddslgmgh0000gn/T/ResultBundle_2026-25-08_13-18-0028.xcresult',
  'xcodebuild: error: The project named "Scratch" does not contain a scheme named "NoSuchScheme". The "-list" option can be used to find the names of the schemes in the project.',
  '',
].join('\n');

const REAL_SUCCESS_TAIL = [
  'RegisterExecutionPolicyException /tmp/rn-iso-xc/dd/Build/Products/Debug-iphonesimulator/Scratch.app (in target \'Scratch\' from project \'Scratch\')',
  '    cd /tmp/rn-iso-xc',
  '    builtin-RegisterExecutionPolicyException /tmp/rn-iso-xc/dd/Build/Products/Debug-iphonesimulator/Scratch.app',
  '',
  'Validate /tmp/rn-iso-xc/dd/Build/Products/Debug-iphonesimulator/Scratch.app (in target \'Scratch\' from project \'Scratch\')',
  '    cd /tmp/rn-iso-xc',
  '    builtin-validationUtility /tmp/rn-iso-xc/dd/Build/Products/Debug-iphonesimulator/Scratch.app -shallow-bundle -infoplist-subpath Info.plist',
  '',
  'Touch /tmp/rn-iso-xc/dd/Build/Products/Debug-iphonesimulator/Scratch.app (in target \'Scratch\' from project \'Scratch\')',
  '    cd /tmp/rn-iso-xc',
  '    /usr/bin/touch -c /tmp/rn-iso-xc/dd/Build/Products/Debug-iphonesimulator/Scratch.app',
  '',
  '** BUILD SUCCEEDED **',
  '',
].join('\n');


describe('real transcripts', () => {
  test('a clang compile failure yields file, line, column and message, and nothing else', () => {
    const found = extractXcodeDiagnostics(REAL_COMPILE_FAILURE);
    assert.deepEqual(found, [
      {
        file: '/tmp/rn-iso-xc/Scratch/main.m',
        line: 5,
        column: 18,
        message: "use of undeclared identifier 'undefinedThing'",
      },
      {
        file: '/tmp/rn-iso-xc/Scratch/main.m',
        line: 6,
        column: 19,
        message: "implicit conversion of 'int' to 'NSString *' is disallowed with ARC",
      },
    ]);
  });

  test('the CompileC command line repeated in the failure recap is not a diagnostic', () => {
    // xcodebuild quotes whole build commands back after ** BUILD FAILED **.
    // In this capture they are tab-indented, so rule 1 already excludes them;
    // the terminator below is the second line of defence, because that
    // indentation is not a documented format.
    assert.ok(REAL_COMPILE_FAILURE.includes('The following build commands failed:'));
    assert.equal(extractXcodeDiagnostics(REAL_COMPILE_FAILURE).length, 2);
  });

  test('nothing after ** BUILD FAILED ** is extracted, whatever its indentation', () => {
    // Everything past the terminator is a recap of diagnostics already
    // reported. Depending on the recap staying tab-indented forever would put
    // one Xcode release between this module and reporting every failed
    // build's own command line back as an error.
    const transcript = [
      '/a/b.m:1:1: error: the real one',
      '** BUILD FAILED **',
      'The following build commands failed:',
      'CompileC /dd/b.o /a/b.m normal arm64 objective-c',
      'error: a recap line at column zero',
    ].join('\n');
    assert.deepEqual(extractXcodeDiagnostics(transcript).map(d => d.message), ['the real one']);
  });

  test('a link failure reports the missing symbol ONCE across both simulator slices', () => {
    // The transcript carries the identical undefined symbol twice, under
    // "for architecture arm64" and "for architecture x86_64". An agent has one
    // symbol to add, not two.
    const found = extractXcodeDiagnostics(REAL_LINK_FAILURE);
    assert.deepEqual(found.map(d => d.message), [
      'Undefined symbol: _rnIsoMissingFunction',
      'ld: symbol(s) not found for architecture arm64',
      'linker command failed with exit code 1 (use -v to see invocation)',
    ]);
    // The clang line names the project rather than a source file, so the
    // project path is the only location there is -- and it is a path, so it
    // survives, where the "Scratch: clang:" that follows it does not.
    assert.equal(found[2].file, '/tmp/rn-iso-xc/Scratch.xcodeproj');
    assert.equal(found[0].file, undefined, 'the linker names no file');
  });

  test('the CocoaPods sandbox error carries the remedy that fixes it', () => {
    const found = extractXcodeDiagnostics(REAL_PODS_FAILURE);
    assert.equal(found.length, 1);
    assert.match(found[0].message, /The sandbox is not in sync with the Podfile\.lock/);
    assert.match(found[0].remedy, /pod install/);
    assert.equal(found[0].file, undefined);
  });

  test('the run-script warning in that same transcript is not promoted to an error', () => {
    // It sits between the error and ** BUILD FAILED ** and starts at column 0
    // exactly like the error does. Only the word tells them apart.
    assert.ok(REAL_PODS_FAILURE.includes('warning: Run script build phase'));
    assert.equal(extractXcodeDiagnostics(REAL_PODS_FAILURE).length, 1);
  });

  test('a signing failure is recognized as one, and told it should not be signing', () => {
    const found = extractXcodeDiagnostics(REAL_SIGNING_FAILURE);
    assert.equal(found.length, 1);
    assert.equal(found[0].file, '/tmp/rn-iso-xc/Scratch.xcodeproj');
    assert.match(found[0].message, /No profiles for 'com\.rniso\.scratch' were found/);
    assert.match(found[0].remedy, /simulator, which needs no signing/);
  });

  test('an xcodebuild invocation error survives its own timestamped log line', () => {
    // `xcodebuild: error:` has no file and no line, and the transcript around
    // it contains an NSLog-formatted line ("... xcodebuild[94932:16893065]
    // Writing error result bundle ...") that contains the word error and must
    // not be picked up.
    const found = extractXcodeDiagnostics(REAL_SCHEME_FAILURE);
    assert.equal(found.length, 1);
    assert.match(found[0].message, /does not contain a scheme named "NoSuchScheme"/);
    assert.match(found[0].remedy, /xcodebuild -list/);
    assert.equal(found[0].file, undefined);
  });

  test('a successful build yields no diagnostics at all', () => {
    assert.deepEqual(extractXcodeDiagnostics(REAL_SUCCESS_TAIL), []);
  });
});

describe('what is and is not a diagnostic', () => {
  test('an indented command line is never one, however much it says error', () => {
    // Synthetic, because the scratch project's own clang argv happens not to
    // contain the substring -- a real RN build's does (a -Werror flag, a
    // source path with "error" in its name, a --serialize-diagnostics target).
    // This is rule 1 of the module: promoting noise sends an agent to edit a
    // file that compiles.
    const transcript = [
      'CompileC /dd/Foo.o /src/Foo.m normal arm64 objective-c',
      '    cd /project',
      '    /usr/bin/clang -Werror -o /build/paths/with/error: -c /src/Foo.m',
      '        error: this one is indented too',
    ].join('\n');
    assert.deepEqual(extractXcodeDiagnostics(transcript), []);
  });

  test('ld: warning is excluded, ld: anything else is not', () => {
    const transcript = [
      'ld: warning: ignoring duplicate libraries: -lc++',
      'ld: framework not found Foo',
    ].join('\n');
    assert.deepEqual(extractXcodeDiagnostics(transcript), [
      { message: 'ld: framework not found Foo' },
    ]);
  });

  test('the Xcode 15+ linker spelling of an undefined symbol is recognized too', () => {
    // "ld: Undefined symbols:" rather than "Undefined symbols for
    // architecture arm64:". A machine mid-Xcode-upgrade produces both.
    const transcript = [
      'ld: Undefined symbols:',
      '  _RCTRegisterModule, referenced from:',
      '      -[AppDelegate application:didFinishLaunchingWithOptions:] in AppDelegate.o',
      '',
      'clang: error: linker command failed with exit code 1',
    ].join('\n');
    assert.deepEqual(extractXcodeDiagnostics(transcript).map(d => d.message), [
      'Undefined symbol: _RCTRegisterModule',
      'linker command failed with exit code 1',
    ]);
  });

  test('a Swift diagnostic without a column keeps its line and omits the column', () => {
    const transcript = '/app/ios/App/AppDelegate.swift:42: error: cannot find \'Foo\' in scope';
    assert.deepEqual(extractXcodeDiagnostics(transcript), [
      { file: '/app/ios/App/AppDelegate.swift', line: 42, message: "cannot find 'Foo' in scope" },
    ]);
  });

  test('`fatal error:` is the same diagnostic with a different word in front', () => {
    const transcript = '/app/ios/App/Bridge.m:3:9: fatal error: \'React/RCTBridge.h\' file not found';
    assert.deepEqual(extractXcodeDiagnostics(transcript), [
      { file: '/app/ios/App/Bridge.m', line: 3, column: 9, message: "'React/RCTBridge.h' file not found" },
    ]);
  });

  test('a development team error is a signing error however it is phrased', () => {
    const transcript = "/app/ios/App.xcodeproj: error: Signing for \"App\" requires a development team.";
    const found = extractXcodeDiagnostics(transcript);
    assert.equal(found.length, 1);
    assert.match(found[0].remedy, /needs no signing/);
  });

  test('a compile error gets no remedy, because there is no mechanical fix to name', () => {
    const found = extractXcodeDiagnostics('/a/b.m:1:1: error: expected identifier');
    assert.equal(found[0].remedy, undefined);
  });

  test('nothing recognizable returns [], so a caller knows to fall back to the log tail', () => {
    assert.deepEqual(extractXcodeDiagnostics('note: Building targets in dependency order\nSome prose.'), []);
    assert.deepEqual(extractXcodeDiagnostics(''), []);
    assert.deepEqual(extractXcodeDiagnostics(null), []);
    assert.deepEqual(extractXcodeDiagnostics(undefined), []);
    assert.deepEqual(extractXcodeDiagnostics(42), []);
  });

  test('CRLF transcripts parse the same as LF ones', () => {
    const found = extractXcodeDiagnostics('/a/b.m:1:2: error: broken\r\n** BUILD FAILED **\r\n');
    assert.deepEqual(found, [{ file: '/a/b.m', line: 1, column: 2, message: 'broken' }]);
  });
});

describe('dedupe and order', () => {
  test('the same message at two different sites is two diagnostics', () => {
    // Dedupe is on the location, not the text: two call sites are two edits.
    const transcript = [
      '/a/One.m:10:5: error: use of undeclared identifier \'x\'',
      '/a/Two.m:20:5: error: use of undeclared identifier \'x\'',
    ].join('\n');
    assert.equal(extractXcodeDiagnostics(transcript).length, 2);
  });

  test('the same message at the same site is one, however many arch slices report it', () => {
    const transcript = [
      '/a/One.m:10:5: error: use of undeclared identifier \'x\'',
      '/a/One.m:10:5: error: use of undeclared identifier \'x\'',
      '/a/One.m:10:5: error: use of undeclared identifier \'x\'',
    ].join('\n');
    assert.equal(extractXcodeDiagnostics(transcript).length, 1);
  });

  test('first-seen order is preserved, because the first error is usually the cause', () => {
    const transcript = [
      '/a/Three.m:3:1: error: third',
      '/a/One.m:1:1: error: first',
      '/a/Two.m:2:1: error: second',
    ].join('\n');
    assert.deepEqual(extractXcodeDiagnostics(transcript).map(d => d.message), ['third', 'first', 'second']);
  });
});

describe('capDiagnostics', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ message: `e${i}` }));

  test('the cap is ten', () => {
    assert.equal(MAX_DIAGNOSTICS, 10);
  });

  test('under the cap, nothing is truncated and the count is 0 rather than absent', () => {
    const { diagnostics, truncated } = capDiagnostics(many(3));
    assert.equal(diagnostics.length, 3);
    assert.equal(truncated, 0);
  });

  test('over the cap, the first ten survive and the rest are counted', () => {
    const { diagnostics, truncated } = capDiagnostics(many(31));
    assert.equal(diagnostics.length, 10);
    assert.equal(truncated, 21);
    assert.equal(diagnostics[0].message, 'e0');
    assert.equal(diagnostics[9].message, 'e9');
  });

  test('the cap is a parameter, so a caller that wants everything is not fighting the parser', () => {
    assert.equal(capDiagnostics(many(31), Infinity).diagnostics.length, 31);
    assert.equal(capDiagnostics(many(31), 1).truncated, 30);
  });

  test('it copies rather than aliasing, so a caller cannot mutate the extraction', () => {
    const source = many(2);
    const { diagnostics } = capDiagnostics(source);
    diagnostics.push({ message: 'injected' });
    assert.equal(source.length, 2);
  });

  test('a non-array is the empty result, not a throw', () => {
    assert.deepEqual(capDiagnostics(null), { diagnostics: [], truncated: 0 });
    assert.deepEqual(capDiagnostics(undefined), { diagnostics: [], truncated: 0 });
  });
});

describe('describeDiagnostic', () => {
  test('renders the shape a compiler prints, which is the shape a tool can jump to', () => {
    assert.equal(
      describeDiagnostic({ file: '/a/b.m', line: 5, column: 18, message: 'boom' }),
      '/a/b.m:5:18: boom'
    );
    assert.equal(describeDiagnostic({ file: '/a/b.swift', line: 42, message: 'boom' }), '/a/b.swift:42: boom');
    assert.equal(describeDiagnostic({ file: '/a/App.xcodeproj', message: 'boom' }), '/a/App.xcodeproj: boom');
    assert.equal(describeDiagnostic({ message: 'ld: framework not found Foo' }), 'ld: framework not found Foo');
  });

  test('the remedy is deliberately NOT glued on, so the diagnostic stays greppable', () => {
    const line = describeDiagnostic({ message: 'x', remedy: 'do the thing' });
    assert.equal(line, 'x');
  });

  test('garbage renders as the empty string rather than throwing', () => {
    assert.equal(describeDiagnostic(null), '');
    assert.equal(describeDiagnostic(undefined), '');
    assert.equal(describeDiagnostic('not an object'), '');
  });
});
