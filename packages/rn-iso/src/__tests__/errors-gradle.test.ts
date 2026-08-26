// engine/errors-gradle.js -- a gradle transcript reduced to the lines that say
// what broke.
//
// Everything here is pure, so the transcripts are the test. They are the real
// shapes: the kotlinc K2 and pre-K2 diagnostics, javac's file:line: error:,
// aapt2 through gradle, the FAILURE block gradle prints at the end of every
// failed build, and dependency resolution. The `assembleDebug` transcripts
// captured from a real gradle 8.13 run are in test/fixtures/gradle-*.txt --
// see test/engine-gradle.test.js for how they were produced.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_DIAGNOSTICS,
  capDiagnostics,
  extractGradleDiagnostics,
  formatDiagnostic,
  remedyFor,
} from '../engine/errors-gradle.ts';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf-8');

describe('what is recognized', () => {
  test('the FAILURE block reduces to its What went wrong section, causes and all', () => {
    const diagnostics = extractGradleDiagnostics(`
> Task :app:preBuild UP-TO-DATE

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:compileDebugKotlin'.
> A failure occurred while executing org.jetbrains.kotlin.compilerRunner.GradleCompilerRunnerWithWorkers
   > Compilation error. See log for more details

* Try:
> Run with --stacktrace option to get the stack trace.

BUILD FAILED in 41s
`);
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0].message).toMatch(/Execution failed for task ':app:compileDebugKotlin'/);
    // The nested cause carries the useful half, so it is kept rather than
    // dropped: "Execution failed for task X" alone says nothing.
    expect(diagnostics[0].message).toMatch(/Compilation error/);
    // "* Try:" is gradle telling the user to re-run with --stacktrace, which
    // is not a diagnostic.
    expect(diagnostics.filter((d) => /stacktrace/.test(d.message)).length).toBe(0);
  });

  test('a failing task is named', () => {
    const diagnostics = extractGradleDiagnostics('> Task :app:processDebugResources FAILED');
    expect(diagnostics).toEqual([{ message: 'Task :app:processDebugResources FAILED' }]);
  });

  test('kotlinc K2 diagnostics keep file, line and column', () => {
    const diagnostics = extractGradleDiagnostics(
      "e: file:///Users/me/app/android/app/src/main/java/com/app/MainActivity.kt:23:9 Unresolved reference 'Foo'.\n" +
        'w: file:///Users/me/app/android/app/src/main/java/com/app/MainActivity.kt:9:1 Parameter is never used',
    );
    expect(diagnostics).toEqual([
      {
        message: "Unresolved reference 'Foo'.",
        file: '/Users/me/app/android/app/src/main/java/com/app/MainActivity.kt',
        line: 23,
        column: 9,
      },
    ]);
  });

  test('kotlinc pre-K2 diagnostics are recognized too', () => {
    const diagnostics = extractGradleDiagnostics(
      'e: /Users/me/app/android/app/src/main/java/com/app/Main.kt: (10, 5): Unresolved reference: foo',
    );
    expect(diagnostics).toEqual([
      {
        message: 'Unresolved reference: foo',
        file: '/Users/me/app/android/app/src/main/java/com/app/Main.kt',
        line: 10,
        column: 5,
      },
    ]);
  });

  test('a percent-encoded kotlinc path is decoded', () => {
    const diagnostics = extractGradleDiagnostics(
      'e: file:///Users/me/My%20App/android/app/src/main/java/A.kt:3:1 Expecting an expression',
    );
    expect(diagnostics[0].file).toBe('/Users/me/My App/android/app/src/main/java/A.kt');
  });

  test('javac diagnostics keep the file and line', () => {
    const diagnostics = extractGradleDiagnostics(
      '/Users/me/app/android/app/src/main/java/com/app/MainApplication.java:31: error: cannot find symbol\n' +
        '      return Foo.getPackages();\n' +
        '             ^\n' +
        '  symbol:   variable Foo\n' +
        '1 error',
    );
    expect(diagnostics).toEqual([
      {
        message: 'cannot find symbol',
        file: '/Users/me/app/android/app/src/main/java/com/app/MainApplication.java',
        line: 31,
      },
    ]);
  });

  test('aapt2 resource errors keep the resource file, line and column', () => {
    const diagnostics = extractGradleDiagnostics(
      '> Task :app:processDebugResources FAILED\n' +
        'ERROR:/Users/me/app/android/app/src/main/res/values/strings.xml:5:5: AAPT: error: unclosed token.\n' +
        '\n' +
        'error: failed linking references.\n',
    );
    const resource = diagnostics.find((d) => d.file);
    expect(resource).toEqual({
      message: 'unclosed token.',
      file: '/Users/me/app/android/app/src/main/res/values/strings.xml',
      line: 5,
      column: 5,
    });
    expect(diagnostics.some((d) => d.message === 'failed linking references.')).toBeTruthy();
  });

  test('dependency resolution failures come back with a remedy', () => {
    const diagnostics = extractGradleDiagnostics(`
FAILURE: Build failed with an exception.

* What went wrong:
Could not determine the dependencies of task ':app:compileDebugJavaWithJavac'.
> Could not resolve all files for configuration ':app:debugCompileClasspath'.
   > Could not find com.facebook.react:react-android:0.99.0.
`);
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0].message).toMatch(/Could not find com\.facebook\.react:react-android:0\.99\.0/);
    expect(diagnostics[0].remedy).toMatch(/refresh-dependencies/);
  });

  // The two environment failures rn-iso must name rather than let an agent
  // retry into: a missing SDK and the wrong JDK.
  test('a missing Android SDK carries the ANDROID_HOME remedy', () => {
    const diagnostics = extractGradleDiagnostics(`
FAILURE: Build failed with an exception.

* What went wrong:
A problem occurred configuring project ':app'.
> SDK location not found. Define a valid SDK location with an ANDROID_HOME environment variable or by setting the sdk.dir path in your project's local properties file at '/Users/me/app/android/local.properties'.
`);
    expect(diagnostics[0].remedy).toMatch(/ANDROID_HOME/);
  });

  test('a JAVA_HOME pointed at nothing carries the JDK remedy', () => {
    const diagnostics = extractGradleDiagnostics(
      'ERROR: JAVA_HOME is set to an invalid directory: /nope\n\nPlease set the JAVA_HOME variable in your environment to match the\nlocation of your Java installation.',
    );
    expect(diagnostics[0].remedy).toMatch(/JAVA_HOME/);
  });

  test('gradle rich-console carriage returns do not glue lines together', () => {
    const diagnostics = extractGradleDiagnostics(
      '<-------------> 0% CONFIGURING [1s]\r> Task :app:compileDebugKotlin FAILED',
    );
    expect(diagnostics).toEqual([{ message: 'Task :app:compileDebugKotlin FAILED' }]);
  });
});

describe('what is not', () => {
  test('a successful build yields nothing', () => {
    expect(
      extractGradleDiagnostics(
        '> Task :app:assembleDebug\n\nBUILD SUCCESSFUL in 12s\n41 actionable tasks: 41 executed',
      ),
    ).toEqual([]);
  });

  test('non-text and empty input yield nothing', () => {
    expect(extractGradleDiagnostics('')).toEqual([]);
    expect(extractGradleDiagnostics(null as any)).toEqual([]);
    expect(extractGradleDiagnostics(undefined as any)).toEqual([]);
    expect(extractGradleDiagnostics(42 as any)).toEqual([]);
  });

  test('warnings are not errors', () => {
    const text =
      'w: file:///a/B.kt:1:1 Variable is never used\n' +
      'Note: Some input files use unchecked or unsafe operations.\n' +
      '/a/C.java:4: warning: [deprecation] foo() in Bar has been deprecated';
    expect(extractGradleDiagnostics(text)).toEqual([]);
  });

  test('remedyFor answers null for a plain compiler error', () => {
    expect(remedyFor('cannot find symbol')).toBe(null);
  });
});

describe('dedupe, order and the cap', () => {
  test('the same diagnostic printed twice appears once, in transcript order', () => {
    const line = 'e: file:///a/B.kt:3:5 Unresolved reference: foo';
    const diagnostics = extractGradleDiagnostics(
      ['> Task :app:compileDebugKotlin FAILED', line, 'e: file:///a/B.kt:4:5 Expecting an expression', line].join('\n'),
    );
    expect(diagnostics.map((d) => d.message)).toEqual([
      'Task :app:compileDebugKotlin FAILED',
      'Unresolved reference: foo',
      'Expecting an expression',
    ]);
  });

  test('the same message at a different line is a different diagnostic', () => {
    const diagnostics = extractGradleDiagnostics(
      'e: file:///a/B.kt:3:5 Unresolved reference: foo\ne: file:///a/B.kt:9:5 Unresolved reference: foo',
    );
    expect(diagnostics.length).toBe(2);
  });

  test('capDiagnostics keeps ten and counts the rest', () => {
    const many = Array.from({ length: 14 }, (_, i) => `e: file:///a/B.kt:${i + 1}:1 Unresolved reference: x${i}`).join(
      '\n',
    );
    const all = extractGradleDiagnostics(many);
    expect(all.length).toBe(14);
    const capped = capDiagnostics(all);
    expect(capped.shown.length).toBe(MAX_DIAGNOSTICS);
    expect(capped.truncated).toBe(4);
    expect(capped.shown[0].line).toBe(1);
  });

  test('capDiagnostics is a no-op under the limit and tolerates junk', () => {
    expect(capDiagnostics([{ message: 'a' }])).toEqual({ shown: [{ message: 'a' }], truncated: 0 });
    expect(capDiagnostics(null as any)).toEqual({ shown: [], truncated: 0 });
  });

  test('a runaway message is clipped rather than printed whole', () => {
    const diagnostics = extractGradleDiagnostics(`e: file:///a/B.kt:1:1 ${'x'.repeat(900)}`);
    expect(diagnostics[0].message.length <= 300).toBeTruthy();
    expect(diagnostics[0].message).toMatch(/\.\.\.$/);
  });
});

describe('formatDiagnostic', () => {
  test('prints file:line:col: message when it has them, the message alone otherwise', () => {
    expect(formatDiagnostic({ file: '/a/B.kt', line: 3, column: 5, message: 'boom' })).toBe('/a/B.kt:3:5: boom');
    expect(formatDiagnostic({ file: '/a/B.java', line: 3, message: 'boom' })).toBe('/a/B.java:3: boom');
    expect(formatDiagnostic({ message: 'boom' })).toBe('boom');
    expect(formatDiagnostic(null)).toBe('');
  });
});

describe('against transcripts captured from a real gradle run', () => {
  test('the compile failure names the task, the file and the line', () => {
    const diagnostics = extractGradleDiagnostics(fixture('gradle-compile-failure.txt'));
    expect(diagnostics.length > 0).toBeTruthy();
    expect(diagnostics.some((d) => /FAILED/.test(d.message))).toBeTruthy();
    const located = diagnostics.find((d) => d.file && d.line);
    expect(located).toBeTruthy();
    assert(located);
    expect(located.file).toMatch(/Broken\.java$/);
    expect(diagnostics.map((d) => d.message).join(' | ')).toMatch(/Execution failed for task/);
  });

  test('the successful build yields nothing', () => {
    expect(extractGradleDiagnostics(fixture('gradle-success.txt'))).toEqual([]);
  });
});
