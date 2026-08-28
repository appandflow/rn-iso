import {
  MAX_DIAGNOSTICS,
  capDiagnostics,
  describeDiagnostic,
  extractXcodeDiagnostics,
} from '../engine/errors-xcode.ts';
import type { Diagnostic } from '../engine/errors-xcode.ts';

const REAL_COMPILE_FAILURE = [
  "CompileC /tmp/rn-iso-xc/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Objects-normal/arm64/main.o /tmp/rn-iso-xc/Scratch/main.m normal arm64 objective-c com.apple.compilers.llvm.clang.1_0.compiler (in target 'Scratch' from project 'Scratch')",
  '    cd /tmp/rn-iso-xc',
  '    ',
  '    Using response file: /tmp/rn-iso-xc/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Objects-normal/arm64/e6072d4f65d7061329687fe24e3d63a7-common-args.resp',
  '    ',
  '    /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang -x  [argv elided] cratch.build/Objects-normal/arm64/main.o',
  "/tmp/rn-iso-xc/Scratch/main.m:5:18: error: use of undeclared identifier 'undefinedThing'",
  '    5 |     NSLog(@"%@", undefinedThing);',
  '      |                  ^~~~~~~~~~~~~~',
  "/tmp/rn-iso-xc/Scratch/main.m:6:19: error: implicit conversion of 'int' to 'NSString *' is disallowed with ARC",
  '    6 |     NSString *s = 42;',
  '      |                   ^~',
  '2 errors generated.',
  '',
  '** BUILD FAILED **',
  '',
  '',
  'The following build commands failed:',
  "\tCompileC /tmp/rn-iso-xc/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Objects-normal/arm64/main.o /tmp/rn-iso-xc/Scratch/main.m normal arm64 objective-c com.apple.compilers.llvm.clang.1_0.compiler (in target 'Scratch' from project 'Scratch')",
  '\tBuilding project Scratch with scheme Scratch and configuration Debug',
  '(2 failures)',
].join('\n');

const REAL_LINK_FAILURE = [
  "Ld /tmp/rn-iso-xc/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Objects-normal/arm64/Binary/Scratch normal arm64 (in target 'Scratch' from project 'Scratch')",
  '    cd /tmp/rn-iso-xc',
  '    /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang -Xl [argv elided] uild/Objects-normal/arm64/Binary/Scratch',
  'Undefined symbols for architecture arm64:',
  '  "_rnIsoMissingFunction", referenced from:',
  '      _main in main.o',
  'ld: symbol(s) not found for architecture arm64',
  '/tmp/rn-iso-xc/Scratch.xcodeproj: Scratch: clang: error: linker command failed with exit code 1 (use -v to see invocation)',
  '',
  "Ld /tmp/rn-iso-xc/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Objects-normal/x86_64/Binary/Scratch normal x86_64 (in target 'Scratch' from project 'Scratch')",
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
  "\tLd /tmp/rn-iso-xc/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Objects-normal/arm64/Binary/Scratch normal arm64 (in target 'Scratch' from project 'Scratch')",
  '\tBuilding project Scratch with scheme Scratch and configuration Debug',
  '(2 failures)',
].join('\n');

const REAL_PODS_FAILURE = [
  '',
  "PhaseScriptExecution [CP]\\ Check\\ Pods\\ Manifest.lock /tmp/rn-iso-xc-pods/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Script-AA00000000000000000020.sh (in target 'Scratch' from project 'Scratch')",
  '    cd /tmp/rn-iso-xc-pods',
  '    /bin/sh -c /tmp/rn-iso-xc-pods/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Script-AA00000000000000000020.sh',
  "error: The sandbox is not in sync with the Podfile.lock. Run 'pod install' or update your CocoaPods installation.",
  '',
  "ProcessInfoPlistFile /tmp/rn-iso-xc-pods/dd/Build/Products/Debug-iphonesimulator/Scratch.app/Info.plist /tmp/rn-iso-xc-pods/Scratch/Info.plist (in target 'Scratch' from project 'Scratch')",
  '    cd /tmp/rn-iso-xc-pods',
  '    builtin-infoPlistUtility /tmp/rn-iso-xc-pods/Scratch/Info.plist -producttype com.apple.product-type.application -genpkginfo /tmp/rn-iso-xc-pods/dd/Build/Products/Debug-iphonesimulator/Scratch.app/PkgInfo -expandbuildsettings -format binary -platform iphonesimulator -o /tmp/rn-iso-xc-pods/dd/Build/Products/Debug-iphonesimulator/Scratch.app/Info.plist',
  '',
  "warning: Run script build phase '[CP] Check Pods Manifest.lock' will be run during every build because it does not specify any outputs. To address this issue, either add output dependencies to the script phase, or configure it to run in every build by unchecking \"Based on dependency analysis\" in the script phase. (in target 'Scratch' from project 'Scratch')",
  '** BUILD FAILED **',
  '',
].join('\n');

const REAL_SIGNING_FAILURE = [
  'Build description signature: 5aff88b39ca8e2b9798e399e4ba14334',
  'Build description path: /tmp/rn-iso-xc/dd-dev/Build/Intermediates.noindex/XCBuildData/5aff88b39ca8e2b9798e399e4ba14334.xcbuilddata',
  "/tmp/rn-iso-xc/Scratch.xcodeproj: error: No profiles for 'com.rniso.scratch' were found: Xcode couldn't find any iOS App Development provisioning profiles matching 'com.rniso.scratch'. Automatic signing is disabled and unable to generate a profile. To enable automatic signing, pass -allowProvisioningUpdates to xcodebuild. (in target 'Scratch' from project 'Scratch')",
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
  "RegisterExecutionPolicyException /tmp/rn-iso-xc/dd/Build/Products/Debug-iphonesimulator/Scratch.app (in target 'Scratch' from project 'Scratch')",
  '    cd /tmp/rn-iso-xc',
  '    builtin-RegisterExecutionPolicyException /tmp/rn-iso-xc/dd/Build/Products/Debug-iphonesimulator/Scratch.app',
  '',
  "Validate /tmp/rn-iso-xc/dd/Build/Products/Debug-iphonesimulator/Scratch.app (in target 'Scratch' from project 'Scratch')",
  '    cd /tmp/rn-iso-xc',
  '    builtin-validationUtility /tmp/rn-iso-xc/dd/Build/Products/Debug-iphonesimulator/Scratch.app -shallow-bundle -infoplist-subpath Info.plist',
  '',
  "Touch /tmp/rn-iso-xc/dd/Build/Products/Debug-iphonesimulator/Scratch.app (in target 'Scratch' from project 'Scratch')",
  '    cd /tmp/rn-iso-xc',
  '    /usr/bin/touch -c /tmp/rn-iso-xc/dd/Build/Products/Debug-iphonesimulator/Scratch.app',
  '',
  '** BUILD SUCCEEDED **',
  '',
].join('\n');

describe('real transcripts', () => {
  test('a clang compile failure yields file, line, column and message, and nothing else', () => {
    const found = extractXcodeDiagnostics(REAL_COMPILE_FAILURE);
    expect(found).toEqual([
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
    expect(REAL_COMPILE_FAILURE.includes('The following build commands failed:')).toBeTruthy();
    expect(extractXcodeDiagnostics(REAL_COMPILE_FAILURE).length).toBe(2);
  });

  test('nothing after ** BUILD FAILED ** is extracted, whatever its indentation', () => {
    const transcript = [
      '/a/b.m:1:1: error: the real one',
      '** BUILD FAILED **',
      'The following build commands failed:',
      'CompileC /dd/b.o /a/b.m normal arm64 objective-c',
      'error: a recap line at column zero',
    ].join('\n');
    expect(extractXcodeDiagnostics(transcript).map((d) => d.message)).toEqual(['the real one']);
  });

  test('a link failure reports the missing symbol ONCE across both simulator slices', () => {
    const found = extractXcodeDiagnostics(REAL_LINK_FAILURE);
    expect(found.map((d) => d.message)).toEqual([
      'Undefined symbol: _rnIsoMissingFunction',
      'ld: symbol(s) not found for architecture arm64',
      'linker command failed with exit code 1 (use -v to see invocation)',
    ]);
    expect(found[2]?.file).toBe('/tmp/rn-iso-xc/Scratch.xcodeproj');
    expect(found[0]?.file).toBe(undefined);
  });

  test('the CocoaPods sandbox error carries the remedy that fixes it', () => {
    const found = extractXcodeDiagnostics(REAL_PODS_FAILURE);
    expect(found.length).toBe(1);
    expect(found[0]?.message).toMatch(/The sandbox is not in sync with the Podfile\.lock/);
    expect(found[0]?.remedy).toMatch(/pod install/);
    expect(found[0]?.file).toBe(undefined);
  });

  test('the run-script warning in that same transcript is not promoted to an error', () => {
    expect(REAL_PODS_FAILURE.includes('warning: Run script build phase')).toBeTruthy();
    expect(extractXcodeDiagnostics(REAL_PODS_FAILURE).length).toBe(1);
  });

  test('a signing failure is recognized as one, and told it should not be signing', () => {
    const found = extractXcodeDiagnostics(REAL_SIGNING_FAILURE);
    expect(found.length).toBe(1);
    expect(found[0]?.file).toBe('/tmp/rn-iso-xc/Scratch.xcodeproj');
    expect(found[0]?.message).toMatch(/No profiles for 'com\.rniso\.scratch' were found/);
    expect(found[0]?.remedy).toMatch(/simulator, which needs no signing/);
  });

  test('an xcodebuild invocation error survives its own timestamped log line', () => {
    const found = extractXcodeDiagnostics(REAL_SCHEME_FAILURE);
    expect(found.length).toBe(1);
    expect(found[0]?.message).toMatch(/does not contain a scheme named "NoSuchScheme"/);
    expect(found[0]?.remedy).toMatch(/xcodebuild -list/);
    expect(found[0]?.file).toBe(undefined);
  });

  test('a successful build yields no diagnostics at all', () => {
    expect(extractXcodeDiagnostics(REAL_SUCCESS_TAIL)).toEqual([]);
  });
});

describe('what is and is not a diagnostic', () => {
  test('an indented command line is never one, however much it says error', () => {
    const transcript = [
      'CompileC /dd/Foo.o /src/Foo.m normal arm64 objective-c',
      '    cd /project',
      '    /usr/bin/clang -Werror -o /build/paths/with/error: -c /src/Foo.m',
      '        error: this one is indented too',
    ].join('\n');
    expect(extractXcodeDiagnostics(transcript)).toEqual([]);
  });

  test('ld: warning is excluded, ld: anything else is not', () => {
    const transcript = ['ld: warning: ignoring duplicate libraries: -lc++', 'ld: framework not found Foo'].join('\n');
    expect(extractXcodeDiagnostics(transcript)).toEqual([{ message: 'ld: framework not found Foo' }]);
  });

  test('the Xcode 15+ linker spelling of an undefined symbol is recognized too', () => {
    const transcript = [
      'ld: Undefined symbols:',
      '  _RCTRegisterModule, referenced from:',
      '      -[AppDelegate application:didFinishLaunchingWithOptions:] in AppDelegate.o',
      '',
      'clang: error: linker command failed with exit code 1',
    ].join('\n');
    expect(extractXcodeDiagnostics(transcript).map((d) => d.message)).toEqual([
      'Undefined symbol: _RCTRegisterModule',
      'linker command failed with exit code 1',
    ]);
  });

  test('a Swift diagnostic without a column keeps its line and omits the column', () => {
    const transcript = "/app/ios/App/AppDelegate.swift:42: error: cannot find 'Foo' in scope";
    expect(extractXcodeDiagnostics(transcript)).toEqual([
      { file: '/app/ios/App/AppDelegate.swift', line: 42, message: "cannot find 'Foo' in scope" },
    ]);
  });

  test('`fatal error:` is the same diagnostic with a different word in front', () => {
    const transcript = "/app/ios/App/Bridge.m:3:9: fatal error: 'React/RCTBridge.h' file not found";
    expect(extractXcodeDiagnostics(transcript)).toEqual([
      { file: '/app/ios/App/Bridge.m', line: 3, column: 9, message: "'React/RCTBridge.h' file not found" },
    ]);
  });

  test('a development team error is a signing error however it is phrased', () => {
    const transcript = '/app/ios/App.xcodeproj: error: Signing for "App" requires a development team.';
    const found = extractXcodeDiagnostics(transcript);
    expect(found.length).toBe(1);
    expect(found[0]?.remedy).toMatch(/needs no signing/);
  });

  test('a compile error gets no remedy, because there is no mechanical fix to name', () => {
    const found = extractXcodeDiagnostics('/a/b.m:1:1: error: expected identifier');
    expect(found[0]?.remedy).toBe(undefined);
  });

  test('nothing recognizable returns [], so a caller knows to fall back to the log tail', () => {
    expect(extractXcodeDiagnostics('note: Building targets in dependency order\nSome prose.')).toEqual([]);
    expect(extractXcodeDiagnostics('')).toEqual([]);
    expect(extractXcodeDiagnostics(null as unknown as string)).toEqual([]);
    expect(extractXcodeDiagnostics(undefined as unknown as string)).toEqual([]);
    expect(extractXcodeDiagnostics(42 as unknown as string)).toEqual([]);
  });

  test('CRLF transcripts parse the same as LF ones', () => {
    const found = extractXcodeDiagnostics('/a/b.m:1:2: error: broken\r\n** BUILD FAILED **\r\n');
    expect(found).toEqual([{ file: '/a/b.m', line: 1, column: 2, message: 'broken' }]);
  });
});

describe('dedupe and order', () => {
  test('the same message at two different sites is two diagnostics', () => {
    const transcript = [
      "/a/One.m:10:5: error: use of undeclared identifier 'x'",
      "/a/Two.m:20:5: error: use of undeclared identifier 'x'",
    ].join('\n');
    expect(extractXcodeDiagnostics(transcript).length).toBe(2);
  });

  test('the same message at the same site is one, however many arch slices report it', () => {
    const transcript = [
      "/a/One.m:10:5: error: use of undeclared identifier 'x'",
      "/a/One.m:10:5: error: use of undeclared identifier 'x'",
      "/a/One.m:10:5: error: use of undeclared identifier 'x'",
    ].join('\n');
    expect(extractXcodeDiagnostics(transcript).length).toBe(1);
  });

  test('first-seen order is preserved, because the first error is usually the cause', () => {
    const transcript = [
      '/a/Three.m:3:1: error: third',
      '/a/One.m:1:1: error: first',
      '/a/Two.m:2:1: error: second',
    ].join('\n');
    expect(extractXcodeDiagnostics(transcript).map((d) => d.message)).toEqual(['third', 'first', 'second']);
  });
});

describe('capDiagnostics', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ message: `e${i}` }));

  test('the cap is ten', () => {
    expect(MAX_DIAGNOSTICS).toBe(10);
  });

  test('under the cap, nothing is truncated and the count is 0 rather than absent', () => {
    const { diagnostics, truncated } = capDiagnostics(many(3));
    expect(diagnostics.length).toBe(3);
    expect(truncated).toBe(0);
  });

  test('over the cap, the first ten survive and the rest are counted', () => {
    const { diagnostics, truncated } = capDiagnostics(many(31));
    expect(diagnostics.length).toBe(10);
    expect(truncated).toBe(21);
    expect(diagnostics[0]?.message).toBe('e0');
    expect(diagnostics[9]?.message).toBe('e9');
  });

  test('the cap is a parameter, so a caller that wants everything is not fighting the parser', () => {
    expect(capDiagnostics(many(31), Infinity).diagnostics.length).toBe(31);
    expect(capDiagnostics(many(31), 1).truncated).toBe(30);
  });

  test('it copies rather than aliasing, so a caller cannot mutate the extraction', () => {
    const source = many(2);
    const { diagnostics } = capDiagnostics(source);
    diagnostics.push({ message: 'injected' });
    expect(source.length).toBe(2);
  });

  test('a non-array is the empty result, not a throw', () => {
    expect(capDiagnostics(null as unknown as Diagnostic[])).toEqual({ diagnostics: [], truncated: 0 });
    expect(capDiagnostics(undefined as unknown as Diagnostic[])).toEqual({ diagnostics: [], truncated: 0 });
  });
});

describe('describeDiagnostic', () => {
  test('renders the shape a compiler prints, which is the shape a tool can jump to', () => {
    expect(describeDiagnostic({ file: '/a/b.m', line: 5, column: 18, message: 'boom' })).toBe('/a/b.m:5:18: boom');
    expect(describeDiagnostic({ file: '/a/b.swift', line: 42, message: 'boom' })).toBe('/a/b.swift:42: boom');
    expect(describeDiagnostic({ file: '/a/App.xcodeproj', message: 'boom' })).toBe('/a/App.xcodeproj: boom');
    expect(describeDiagnostic({ message: 'ld: framework not found Foo' })).toBe('ld: framework not found Foo');
  });

  test('the remedy is deliberately NOT glued on, so the diagnostic stays greppable', () => {
    const line = describeDiagnostic({ message: 'x', remedy: 'do the thing' });
    expect(line).toBe('x');
  });

  test('garbage renders as the empty string rather than throwing', () => {
    expect(describeDiagnostic(null)).toBe('');
    expect(describeDiagnostic(undefined)).toBe('');
    expect(describeDiagnostic('not an object' as unknown as Diagnostic)).toBe('');
  });
});
