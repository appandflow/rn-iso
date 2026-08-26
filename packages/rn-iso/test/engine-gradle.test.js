// engine/gradle.js -- `./gradlew assembleDebug` and where its APK ended up.
//
// No real gradle build runs here: every case uses a fake spawn, and the APK
// files are written by the test. The transcripts in test/fixtures/gradle-*.txt
// ARE real -- captured from a gradle 8.13 `assembleDebug` on a scratch java
// project (one deliberately uncompilable source file), run through this
// module's own line reader, using the distribution already on the machine so
// nothing was downloaded and no emulator was involved.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
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
} from '../src/engine/gradle.ts';

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
    assert.equal(result.failed, true);
    assert.equal(result.code, BUILD_ERROR);
    assert.match(result.reason, /No android\/ directory/);
    assert.match(result.remedy, /prebuild/);
  });

  test('names the wrapper when android/ exists without gradlew', () => {
    makeAndroidProject({ gradlew: false });
    const result = discoverAndroidProject(root);
    assert.equal(result.failed, true);
    assert.match(result.reason, /gradlew/);
    assert.match(result.remedy, /wrapper/);
  });

  test('returns the directory and the wrapper when both are there', () => {
    makeAndroidProject();
    assert.deepEqual(discoverAndroidProject(root), {
      androidDir: join(root, 'android'),
      gradlew: join(root, 'android', 'gradlew'),
    });
  });
});

describe('androidSdkRefusal', () => {
  test('refuses with the ANDROID_HOME remedy when nothing points at an SDK', () => {
    const refusal = androidSdkRefusal({ sdkPath: '/nope', sdkExists: false, hasLocalProperties: false });
    assert.equal(refusal.code, BUILD_ERROR);
    assert.match(refusal.remedy, /ANDROID_HOME/);
    assert.match(refusal.remedy, /JAVA_HOME/);
  });

  test('an existing SDK, or a local.properties, is enough', () => {
    assert.equal(androidSdkRefusal({ sdkPath: '/sdk', sdkExists: true, hasLocalProperties: false }), null);
    assert.equal(androidSdkRefusal({ sdkPath: '/nope', sdkExists: false, hasLocalProperties: true }), null);
  });
});

describe('pickDebugApk', () => {
  test('prefers the AGP default name', () => {
    assert.equal(pickDebugApk(['app-debug-androidTest.apk', 'app-debug.apk']), 'app-debug.apk');
  });

  test('falls back to a flavoured debug APK', () => {
    assert.equal(pickDebugApk(['app-staging-debug.apk']), 'app-staging-debug.apk');
  });

  test('never picks an intermediate output', () => {
    assert.equal(pickDebugApk(['app-debug-unsigned.apk', 'app-debug-unaligned.apk']), null);
    assert.equal(pickDebugApk(['app-debug-unsigned.apk', 'app-staging-debug.apk']), 'app-staging-debug.apk');
  });

  test('ignores everything that is not an APK', () => {
    assert.equal(pickDebugApk(['output-metadata.json', 'app-debug.apk']), 'app-debug.apk');
    assert.equal(pickDebugApk(['output-metadata.json']), null);
    assert.equal(pickDebugApk([]), null);
    assert.equal(pickDebugApk(null), null);
  });

  // readdir order is not a contract; two orderings must give one answer.
  test('is deterministic whatever order the listing arrives in', () => {
    const files = ['b-debug.apk', 'a-debug.apk'];
    assert.equal(pickDebugApk(files), pickDebugApk([...files].reverse()));
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
    assert.equal(parseOutputMetadata(metadata), 'app-debug.apk');
  });

  test('parseOutputMetadata answers null for junk rather than throwing', () => {
    assert.equal(parseOutputMetadata('not json'), null);
    assert.equal(parseOutputMetadata('{}'), null);
    assert.equal(parseOutputMetadata(JSON.stringify({ elements: [{ outputFile: 42 }] })), null);
  });

  test('parseApkFromTranscript picks up the paths the toolchain prints', () => {
    assert.equal(parseApkFromTranscript("Installing APK 'app-debug.apk' on 'Pixel_7(AVD) - 16'"), 'app-debug.apk');
    assert.equal(parseApkFromTranscript('> Task :app:assembleDebug\nWrote APK to /tmp/out/app-debug.apk'), '/tmp/out/app-debug.apk');
    assert.equal(parseApkFromTranscript('BUILD SUCCESSFUL in 12s'), null);
    assert.equal(parseApkFromTranscript(null), null);
  });
});

describe('locateDebugApk', () => {
  test('an absolute path from the transcript wins when it exists', () => {
    const apk = writeApk('app-debug.apk');
    assert.equal(locateDebugApk(root, `Wrote APK to ${apk}`), apk);
  });

  test('the output listing is used when the transcript says nothing', () => {
    writeApk('app-debug.apk');
    const flavoured = writeApk('app-staging-debug.apk');
    writeFileSync(join(debugApkDir(root), 'output-metadata.json'), JSON.stringify({ elements: [{ outputFile: 'app-staging-debug.apk' }] }));
    // The listing names the flavoured APK this build actually produced, so
    // the AGP-default name on disk (left by an earlier run) does not win.
    assert.equal(locateDebugApk(root, 'BUILD SUCCESSFUL in 3s'), flavoured);
  });

  test('a directory listing is the last resort', () => {
    const apk = writeApk('app-debug.apk');
    assert.equal(locateDebugApk(root, ''), apk);
  });

  test('a transcript path that does not exist does not win', () => {
    const apk = writeApk('app-debug.apk');
    assert.equal(locateDebugApk(root, 'Wrote APK to /nope/gone.apk'), apk);
  });

  test('no APK at all is null, not a throw', () => {
    assert.equal(locateDebugApk(root, ''), null);
  });
});

// --- buildAndroid ----------------------------------------------------------

function fakeChild({ lines = [], stderrLines = [], code = 0, signal = null, error = null, onExit = null } = {}) {
  const child = new EventEmitter();
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
  return { records, write: (r) => records.push(r) };
}

describe('buildAndroid', () => {
  test('runs ./gradlew assembleDebug in android/ and streams every line as it arrives', async () => {
    makeAndroidProject();
    const writer = recordingWriter();
    const calls = [];
    const result = await buildAndroid({ root, logWriter: writer }, {
      spawnFn: (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        return fakeChild({ lines: ['> Task :app:compileDebugKotlin', 'BUILD SUCCESSFUL in 41s'], onExit: () => writeApk() });
      },
      now: (() => { let t = 1000; return () => (t += 41000); })(),
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, join(root, 'android', 'gradlew'));
    // The literal, not the constant: a test that reads the task name out of
    // the module under test cannot notice the module changing it.
    assert.deepEqual(calls[0].args, ['assembleDebug']);
    assert.equal(ASSEMBLE_TASK, 'assembleDebug');
    assert.equal(calls[0].opts.cwd, join(root, 'android'));
    assert.equal(calls[0].opts.stdio[0], 'ignore');

    assert.equal(result.ok, true);
    assert.equal(result.apkPath, join(debugApkDir(root), 'app-debug.apk'));
    assert.equal(result.durationMs, 41000);
    // Contract 1: the raw transcript is src "build", level debug.
    assert.deepEqual(writer.records.map(r => r.msg), ['> Task :app:compileDebugKotlin', 'BUILD SUCCESSFUL in 41s']);
    for (const record of writer.records) {
      assert.equal(record.src, 'build');
      assert.equal(record.level, 'debug');
      assert.equal(record.raw, true);
    }
  });

  test('a failing build comes back as data with the diagnostics extracted, never a throw', async () => {
    makeAndroidProject();
    const transcript = readFileSync(join(import.meta.dirname, 'fixtures', 'gradle-compile-failure.txt'), 'utf-8').split('\n');
    const writer = recordingWriter();
    const result = await buildAndroid({ root, logWriter: writer }, {
      spawnFn: () => fakeChild({ lines: transcript, code: 1 }),
      now: (() => { let t = 0; return () => (t += 2000); })(),
    });

    assert.equal(result.failed, true);
    assert.equal(result.code, BUILD_ERROR);
    assert.match(result.reason, /exit code 1/);
    assert.equal(result.durationMs, 2000);
    assert.ok(result.diagnostics.length > 0);
    assert.ok(result.diagnostics.some(d => /Broken\.java$/.test(d.file || '')));
    assert.equal(result.truncated, 0);
    // The tail is what the command prints when nothing could be extracted.
    assert.ok(result.lastLines.length > 0);
    assert.ok(result.lastLines.every(l => typeof l === 'string'));
  });

  test('a build killed by a signal reports the signal', async () => {
    makeAndroidProject();
    const result = await buildAndroid({ root, logWriter: recordingWriter() }, {
      spawnFn: () => fakeChild({ lines: ['> Task :app:compileDebugKotlin'], code: null, signal: 'SIGKILL' }),
    });
    assert.equal(result.failed, true);
    assert.match(result.reason, /signal SIGKILL/);
  });

  test('exit 0 with no APK is a failure, not a success with nothing to install', async () => {
    makeAndroidProject();
    const result = await buildAndroid({ root, logWriter: recordingWriter() }, {
      spawnFn: () => fakeChild({ lines: ['BUILD SUCCESSFUL in 3s'] }),
    });
    assert.equal(result.failed, true);
    assert.match(result.reason, /produced no APK/);
    assert.match(result.remedy, /assembleDebug/);
  });

  test('a wrapper that will not execute names the permission bit', async () => {
    makeAndroidProject();
    const denied = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
    const result = await buildAndroid({ root, logWriter: recordingWriter() }, {
      spawnFn: () => { throw denied; },
    });
    assert.equal(result.failed, true);
    assert.match(result.remedy, /chmod \+x/);
  });

  // A spawn that fails emits `error` and never `exit`; awaiting exit alone
  // would hang here forever.
  test('a spawn that errors after starting still resolves', async () => {
    makeAndroidProject();
    const result = await buildAndroid({ root, logWriter: recordingWriter() }, {
      spawnFn: () => fakeChild({ lines: ['starting'], error: new Error('boom') }),
    });
    assert.equal(result.failed, true);
    assert.match(result.reason, /boom/);
    assert.deepEqual(result.lastLines, ['starting']);
  });

  test('a missing android/ is reported before anything is spawned', async () => {
    let spawned = false;
    const result = await buildAndroid({ root, logWriter: recordingWriter() }, {
      spawnFn: () => { spawned = true; return fakeChild(); },
    });
    assert.equal(spawned, false);
    assert.equal(result.failed, true);
    assert.match(result.remedy, /prebuild/);
    assert.deepEqual(result.diagnostics, []);
  });

  test('a missing Android SDK is reported before anything is spawned', async () => {
    makeAndroidProject();
    process.env.ANDROID_HOME = join(root, 'no-such-sdk');
    let spawned = false;
    const result = await buildAndroid({ root, logWriter: recordingWriter() }, {
      spawnFn: () => { spawned = true; return fakeChild(); },
    });
    assert.equal(spawned, false);
    assert.equal(result.failed, true);
    assert.match(result.remedy, /ANDROID_HOME/);
  });

  test('android/local.properties satisfies the SDK check on its own', async () => {
    makeAndroidProject();
    process.env.ANDROID_HOME = join(root, 'no-such-sdk');
    writeFileSync(join(root, 'android', 'local.properties'), 'sdk.dir=/opt/android-sdk\n');
    const result = await buildAndroid({ root, logWriter: recordingWriter() }, {
      spawnFn: () => fakeChild({ lines: ['BUILD SUCCESSFUL in 1s'], onExit: () => writeApk() }),
    });
    assert.equal(result.ok, true);
  });
});
