// engine/gradle.js -- `./gradlew assembleDebug` and where its APK ended up.
//
// No real gradle build runs here: every case uses a fake spawn, and the APK
// files are written by the test. The transcripts in test/fixtures/gradle-*.txt
// ARE real -- captured from a gradle 8.13 `assembleDebug` on a scratch java
// project (one deliberately uncompilable source file), run through this
// module's own line reader, using the distribution already on the machine so
// nothing was downloaded and no emulator was involved.
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSEMBLE_TASK,
  BUILD_ERROR,
  androidSdkRefusal,
  buildAndroid,
  debugApkDir,
  discoverAndroidProject,
  locateDebugApk,
  parseApkFromTranscript,
  parseOutputMetadata,
  pickDebugApk,
} from '../engine/gradle.ts';

let root;
let sdk;
let savedAndroidHome;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rn-iso-gradle-'));
  sdk = join(root, 'fake-sdk');
  mkdirSync(sdk, { recursive: true });
  savedAndroidHome = process.env.ANDROID_HOME;
  process.env.ANDROID_HOME = sdk;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedAndroidHome === undefined) delete process.env.ANDROID_HOME;
  else process.env.ANDROID_HOME = savedAndroidHome;
});

function makeAndroidProject({ gradlew = true } = {}) {
  mkdirSync(join(root, 'android'), { recursive: true });
  if (gradlew) {
    const path = join(root, 'android', 'gradlew');
    writeFileSync(path, '#!/bin/sh\nexit 0\n');
    chmodSync(path, 0o755);
  }
}

function writeApk(name = 'app-debug.apk', contents = 'apk') {
  const dir = debugApkDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), contents);
  return join(dir, name);
}

describe('discoverAndroidProject', () => {
  test('names prebuild when there is no android directory', () => {
    const result = discoverAndroidProject(root);
    expect(result.failed).toBe(true);
    expect(result.code).toBe(BUILD_ERROR);
    expect(result.reason).toMatch(/No android\/ directory/);
    expect(result.remedy).toMatch(/prebuild/);
  });

  test('names the wrapper when android/ exists without gradlew', () => {
    makeAndroidProject({ gradlew: false });
    const result = discoverAndroidProject(root);
    expect(result.failed).toBe(true);
    expect(result.reason).toMatch(/gradlew/);
    expect(result.remedy).toMatch(/wrapper/);
  });

  test('returns the directory and the wrapper when both are there', () => {
    makeAndroidProject();
    expect(discoverAndroidProject(root)).toEqual({
      androidDir: join(root, 'android'),
      gradlew: join(root, 'android', 'gradlew'),
    });
  });
});

describe('androidSdkRefusal', () => {
  test('refuses with the ANDROID_HOME remedy when nothing points at an SDK', () => {
    const refusal = androidSdkRefusal({ sdkPath: '/nope', sdkExists: false, hasLocalProperties: false });
    expect(refusal.code).toBe(BUILD_ERROR);
    expect(refusal.remedy).toMatch(/ANDROID_HOME/);
    expect(refusal.remedy).toMatch(/JAVA_HOME/);
  });

  test('an existing SDK, or a local.properties, is enough', () => {
    expect(androidSdkRefusal({ sdkPath: '/sdk', sdkExists: true, hasLocalProperties: false })).toBe(null);
    expect(androidSdkRefusal({ sdkPath: '/nope', sdkExists: false, hasLocalProperties: true })).toBe(null);
  });
});

describe('pickDebugApk', () => {
  test('prefers the AGP default name', () => {
    expect(pickDebugApk(['app-debug-androidTest.apk', 'app-debug.apk'])).toBe('app-debug.apk');
  });

  test('falls back to a flavoured debug APK', () => {
    expect(pickDebugApk(['app-staging-debug.apk'])).toBe('app-staging-debug.apk');
  });

  test('never picks an intermediate output', () => {
    expect(pickDebugApk(['app-debug-unsigned.apk', 'app-debug-unaligned.apk'])).toBe(null);
    expect(pickDebugApk(['app-debug-unsigned.apk', 'app-staging-debug.apk'])).toBe('app-staging-debug.apk');
  });

  test('ignores everything that is not an APK', () => {
    expect(pickDebugApk(['output-metadata.json', 'app-debug.apk'])).toBe('app-debug.apk');
    expect(pickDebugApk(['output-metadata.json'])).toBe(null);
    expect(pickDebugApk([])).toBe(null);
    expect(pickDebugApk(null)).toBe(null);
  });

  // readdir order is not a contract; two orderings must give one answer.
  test('is deterministic whatever order the listing arrives in', () => {
    const files = ['b-debug.apk', 'a-debug.apk'];
    expect(pickDebugApk(files)).toBe(pickDebugApk([...files].reverse()));
  });
});

describe('the output listing', () => {
  test('parseOutputMetadata reads the APK out of AGP output-metadata.json', () => {
    const metadata = JSON.stringify({
      version: 3,
      artifactType: { type: 'APK', kind: 'Directory' },
      applicationId: 'com.app',
      variantName: 'debug',
      elements: [{ type: 'SINGLE', filters: [], versionCode: 1, versionName: '1.0', outputFile: 'app-debug.apk' }],
    });
    expect(parseOutputMetadata(metadata)).toBe('app-debug.apk');
  });

  test('parseOutputMetadata answers null for junk rather than throwing', () => {
    expect(parseOutputMetadata('not json')).toBe(null);
    expect(parseOutputMetadata('{}')).toBe(null);
    expect(parseOutputMetadata(JSON.stringify({ elements: [{ outputFile: 42 }] }))).toBe(null);
  });

  test('parseApkFromTranscript picks up the paths the toolchain prints', () => {
    expect(parseApkFromTranscript("Installing APK 'app-debug.apk' on 'Pixel_7(AVD) - 16'")).toBe('app-debug.apk');
    expect(parseApkFromTranscript('> Task :app:assembleDebug\nWrote APK to /tmp/out/app-debug.apk')).toBe(
      '/tmp/out/app-debug.apk',
    );
    expect(parseApkFromTranscript('BUILD SUCCESSFUL in 12s')).toBe(null);
    expect(parseApkFromTranscript(null)).toBe(null);
  });
});

describe('locateDebugApk', () => {
  test('an absolute path from the transcript wins when it exists', () => {
    const apk = writeApk('app-debug.apk');
    expect(locateDebugApk(root, `Wrote APK to ${apk}`)).toBe(apk);
  });

  test('the output listing is used when the transcript says nothing', () => {
    writeApk('app-debug.apk');
    const flavoured = writeApk('app-staging-debug.apk');
    writeFileSync(
      join(debugApkDir(root), 'output-metadata.json'),
      JSON.stringify({ elements: [{ outputFile: 'app-staging-debug.apk' }] }),
    );
    // The listing names the flavoured APK this build actually produced, so
    // the AGP-default name on disk (left by an earlier run) does not win.
    expect(locateDebugApk(root, 'BUILD SUCCESSFUL in 3s')).toBe(flavoured);
  });

  test('a directory listing is the last resort', () => {
    const apk = writeApk('app-debug.apk');
    expect(locateDebugApk(root, '')).toBe(apk);
  });

  test('a transcript path that does not exist does not win', () => {
    const apk = writeApk('app-debug.apk');
    expect(locateDebugApk(root, 'Wrote APK to /nope/gone.apk')).toBe(apk);
  });

  test('no APK at all is null, not a throw', () => {
    expect(locateDebugApk(root, '')).toBe(null);
  });
});

// --- buildAndroid ----------------------------------------------------------

function fakeChild({ lines = [], stderrLines = [], code = 0, signal = null, error = null, onExit = null } = {}) {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  setImmediate(() => {
    for (const line of lines) child.stdout.emit('data', `${line}\n`);
    for (const line of stderrLines) child.stderr.emit('data', `${line}\n`);
    if (error) {
      child.emit('error', error);
      return;
    }
    if (onExit) onExit();
    child.emit('exit', code, signal);
  });
  return child;
}

function recordingWriter() {
  const records = [];
  return { records, write: (r) => records.push(r) } as any;
}

describe('buildAndroid', () => {
  test('runs ./gradlew assembleDebug in android/ and streams every line as it arrives', async () => {
    makeAndroidProject();
    const writer = recordingWriter();
    const calls = [];
    const result = await buildAndroid(
      { root, logWriter: writer },
      {
        spawnFn: (cmd, args, opts) => {
          calls.push({ cmd, args, opts });
          return fakeChild({
            lines: ['> Task :app:compileDebugKotlin', 'BUILD SUCCESSFUL in 41s'],
            onExit: () => writeApk(),
          });
        },
        now: (() => {
          let t = 1000;
          return () => (t += 41000);
        })(),
      },
    );

    expect(calls.length).toBe(1);
    expect(calls[0].cmd).toBe(join(root, 'android', 'gradlew'));
    // The literal, not the constant: a test that reads the task name out of
    // the module under test cannot notice the module changing it.
    expect(calls[0].args).toEqual(['assembleDebug']);
    expect(ASSEMBLE_TASK).toBe('assembleDebug');
    expect(calls[0].opts.cwd).toBe(join(root, 'android'));
    expect(calls[0].opts.stdio[0]).toBe('ignore');

    expect((result as any).ok).toBe(true);
    expect((result as any).apkPath).toBe(join(debugApkDir(root), 'app-debug.apk'));
    expect(result.durationMs).toBe(41000);
    // Contract 1: the raw transcript is src "build", level debug.
    expect(writer.records.map((r) => r.msg)).toEqual(['> Task :app:compileDebugKotlin', 'BUILD SUCCESSFUL in 41s']);
    for (const record of writer.records) {
      expect(record.src).toBe('build');
      expect(record.level).toBe('debug');
      expect(record.raw).toBe(true);
    }
  });

  test('a failing build comes back as data with the diagnostics extracted, never a throw', async () => {
    makeAndroidProject();
    const transcript = readFileSync(join(import.meta.dirname, 'fixtures', 'gradle-compile-failure.txt'), 'utf-8').split(
      '\n',
    );
    const writer = recordingWriter();
    const result = await buildAndroid(
      { root, logWriter: writer },
      {
        spawnFn: () => fakeChild({ lines: transcript, code: 1 }),
        now: (() => {
          let t = 0;
          return () => (t += 2000);
        })(),
      },
    );

    expect(result.failed).toBe(true);
    expect(result.code).toBe(BUILD_ERROR);
    expect(result.reason).toMatch(/exit code 1/);
    expect(result.durationMs).toBe(2000);
    expect(result.diagnostics.length > 0).toBeTruthy();
    expect(result.diagnostics.some((d) => (d.file || '').endsWith('Broken.java'))).toBeTruthy();
    expect(result.truncated).toBe(0);
    // The tail is what the command prints when nothing could be extracted.
    expect(result.lastLines.length > 0).toBeTruthy();
    expect(result.lastLines.every((l) => typeof l === 'string')).toBeTruthy();
  });

  test('a build killed by a signal reports the signal', async () => {
    makeAndroidProject();
    const result = await buildAndroid(
      { root, logWriter: recordingWriter() },
      {
        spawnFn: () => fakeChild({ lines: ['> Task :app:compileDebugKotlin'], code: null, signal: 'SIGKILL' }),
      },
    );
    expect(result.failed).toBe(true);
    expect(result.reason).toMatch(/signal SIGKILL/);
  });

  test('exit 0 with no APK is a failure, not a success with nothing to install', async () => {
    makeAndroidProject();
    const result = await buildAndroid(
      { root, logWriter: recordingWriter() },
      {
        spawnFn: () => fakeChild({ lines: ['BUILD SUCCESSFUL in 3s'] }),
      },
    );
    expect(result.failed).toBe(true);
    expect(result.reason).toMatch(/produced no APK/);
    expect((result as any).remedy).toMatch(/assembleDebug/);
  });

  test('a wrapper that will not execute names the permission bit', async () => {
    makeAndroidProject();
    const denied = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
    const result = await buildAndroid(
      { root, logWriter: recordingWriter() },
      {
        spawnFn: () => {
          throw denied;
        },
      },
    );
    expect(result.failed).toBe(true);
    expect((result as any).remedy).toMatch(/chmod \+x/);
  });

  // A spawn that fails emits `error` and never `exit`; awaiting exit alone
  // would hang here forever.
  test('a spawn that errors after starting still resolves', async () => {
    makeAndroidProject();
    const result = await buildAndroid(
      { root, logWriter: recordingWriter() },
      {
        spawnFn: () => fakeChild({ lines: ['starting'], error: new Error('boom') }),
      },
    );
    expect(result.failed).toBe(true);
    expect(result.reason).toMatch(/boom/);
    expect(result.lastLines).toEqual(['starting']);
  });

  test('a missing android/ is reported before anything is spawned', async () => {
    let spawned = false;
    const result = await buildAndroid(
      { root, logWriter: recordingWriter() },
      {
        spawnFn: () => {
          spawned = true;
          return fakeChild();
        },
      },
    );
    expect(spawned).toBe(false);
    expect(result.failed).toBe(true);
    expect((result as any).remedy).toMatch(/prebuild/);
    expect(result.diagnostics).toEqual([]);
  });

  test('a missing Android SDK is reported before anything is spawned', async () => {
    makeAndroidProject();
    process.env.ANDROID_HOME = join(root, 'no-such-sdk');
    let spawned = false;
    const result = await buildAndroid(
      { root, logWriter: recordingWriter() },
      {
        spawnFn: () => {
          spawned = true;
          return fakeChild();
        },
      },
    );
    expect(spawned).toBe(false);
    expect(result.failed).toBe(true);
    expect((result as any).remedy).toMatch(/ANDROID_HOME/);
  });

  test('android/local.properties satisfies the SDK check on its own', async () => {
    makeAndroidProject();
    process.env.ANDROID_HOME = join(root, 'no-such-sdk');
    writeFileSync(join(root, 'android', 'local.properties'), 'sdk.dir=/opt/android-sdk\n');
    const result = await buildAndroid(
      { root, logWriter: recordingWriter() },
      {
        spawnFn: () => fakeChild({ lines: ['BUILD SUCCESSFUL in 1s'], onExit: () => writeApk() }),
      },
    );
    expect((result as any).ok).toBe(true);
  });
});
