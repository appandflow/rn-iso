import assert from 'node:assert';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NdjsonRecord, NdjsonWriter } from '../ndjson.ts';
import {
  ASSEMBLE_TASK,
  BUILD_ERROR,
  androidSdkRefusal,
  apkOutputsDir,
  assembleTaskFor,
  buildAndroid,
  debugApkDir,
  discoverAndroidProject,
  gradleArgs,
  locateApk,
  parseApkFromTranscript,
  parseOutputMetadata,
  pickDebugApk,
  staleApkRefusal,
  variantNameOf,
} from '../engine/gradle.ts';
import { makeWriter } from './_factories.ts';

let root: string;
let sdk: string;
let savedAndroidHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-cli-gradle-'));
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

function writeFlavoredApk(flavor: string, buildType: string, name: string, contents = 'apk') {
  const dir = join(apkOutputsDir(root), flavor, buildType);
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
    assert(refusal);
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

  test('is deterministic whatever order the listing arrives in', () => {
    const files = ['b-debug.apk', 'a-debug.apk'];
    expect(pickDebugApk(files)).toBe(pickDebugApk(files.toReversed()));
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

describe('assembleTaskFor', () => {
  test('unset means the default task, exactly the old constant', () => {
    expect(assembleTaskFor(null)).toBe(ASSEMBLE_TASK);
    expect(assembleTaskFor(undefined)).toBe('assembleDebug');
    expect(assembleTaskFor('')).toBe('assembleDebug');
    expect(assembleTaskFor('  ')).toBe('assembleDebug');
  });

  test('capitalizes the variant the way gradle names its task', () => {
    expect(assembleTaskFor('productionDebug')).toBe('assembleProductionDebug');
    expect(assembleTaskFor('debug')).toBe('assembleDebug');
    expect(assembleTaskFor('ProductionDebug')).toBe('assembleProductionDebug');
    expect(assembleTaskFor('demoMinApi24Debug')).toBe('assembleDemoMinApi24Debug');
  });
});

describe('variantNameOf', () => {
  test('camel-joins the output directory segments into the variant name', () => {
    expect(variantNameOf(['production', 'debug'])).toBe('productionDebug');
    expect(variantNameOf(['demoMinApi24', 'debug'])).toBe('demoMinApi24Debug');
    expect(variantNameOf(['debug'])).toBe('debug');
    expect(variantNameOf([])).toBe('');
    expect(variantNameOf(null)).toBe('');
  });
});

describe('locateApk', () => {
  test('an absolute path from the transcript wins when it exists', () => {
    const apk = writeApk('app-debug.apk');
    expect(locateApk(root, `Wrote APK to ${apk}`).apkPath).toBe(apk);
  });

  test('the output listing is used when the transcript says nothing', () => {
    writeApk('app-debug.apk');
    const flavoured = writeApk('app-staging-debug.apk');
    writeFileSync(
      join(debugApkDir(root), 'output-metadata.json'),
      JSON.stringify({ elements: [{ outputFile: 'app-staging-debug.apk' }] }),
    );
    expect(locateApk(root, 'BUILD SUCCESSFUL in 3s').apkPath).toBe(flavoured);
  });

  test('a directory listing is the last resort', () => {
    const apk = writeApk('app-debug.apk');
    expect(locateApk(root, '').apkPath).toBe(apk);
  });

  test('a transcript path that does not exist does not win', () => {
    const apk = writeApk('app-debug.apk');
    expect(locateApk(root, 'Wrote APK to /nope/gone.apk').apkPath).toBe(apk);
  });

  test('no APK at all is null, not a throw', () => {
    expect(locateApk(root, '')).toEqual({ apkPath: null });
  });

  test("a variant resolves to the flavor's own output directory", () => {
    const apk = writeFlavoredApk('production', 'debug', 'app-production-debug.apk');
    writeFlavoredApk('preview', 'debug', 'app-preview-debug.apk');
    expect(locateApk(root, '', 'productionDebug').apkPath).toBe(apk);
  });

  test('a multi-dimension flavor combination resolves the same way', () => {
    const apk = writeFlavoredApk('demoMinApi24', 'debug', 'app-demo-minApi24-debug.apk');
    expect(locateApk(root, '', 'demoMinApi24Debug').apkPath).toBe(apk);
  });

  test("a variant's own output-metadata.json is honoured inside its directory", () => {
    writeFlavoredApk('production', 'debug', 'renamed.apk');
    writeFlavoredApk('production', 'debug', 'other.apk');
    writeFileSync(
      join(apkOutputsDir(root), 'production', 'debug', 'output-metadata.json'),
      JSON.stringify({ elements: [{ outputFile: 'renamed.apk' }] }),
    );
    expect(locateApk(root, '', 'productionDebug').apkPath).toBe(
      join(apkOutputsDir(root), 'production', 'debug', 'renamed.apk'),
    );
  });

  test('a variant that matches no output directory is null, and never falls back to another flavor', () => {
    writeFlavoredApk('preview', 'debug', 'app-preview-debug.apk');
    expect(locateApk(root, '', 'productionDebug').apkPath).toBe(null);
  });

  test('exactly one flavored debug APK is used, with a note naming the directory and the variant to set', () => {
    const apk = writeFlavoredApk('production', 'debug', 'app-production-debug.apk');
    const result = locateApk(root, '');
    expect(result.apkPath).toBe(apk);
    expect(result.note).toMatch(/apk\/production\/debug/);
    expect(result.note).toMatch(/android\.variant/);
    expect(result.note).toMatch(/"productionDebug"/);
  });

  test('several flavored debug APKs are candidates, not a guess', () => {
    const production = writeFlavoredApk('production', 'debug', 'app-production-debug.apk');
    const preview = writeFlavoredApk('preview', 'debug', 'app-preview-debug.apk');
    const result = locateApk(root, '');
    expect(result.apkPath).toBe(null);
    expect(result.candidates).toEqual([preview, production].toSorted());
  });

  test('the recursive fallback never picks an intermediate or an androidTest APK', () => {
    writeFlavoredApk('production', 'debug', 'app-production-debug-unsigned.apk');
    mkdirSync(join(apkOutputsDir(root), 'androidTest', 'production', 'debug'), { recursive: true });
    writeFileSync(
      join(apkOutputsDir(root), 'androidTest', 'production', 'debug', 'app-production-debug-androidTest.apk'),
      'apk',
    );
    expect(locateApk(root, '')).toEqual({ apkPath: null });
  });

  test('the default apk/debug directory wins over the recursive fallback when it has the APK', () => {
    const apk = writeApk('app-debug.apk');
    writeFlavoredApk('production', 'debug', 'app-production-debug.apk');
    const result = locateApk(root, '');
    expect(result.apkPath).toBe(apk);
    expect(result.note).toBeUndefined();
  });
});

describe('staleApkRefusal', () => {
  const task = 'assembleDebug';
  const apkPath = '/w/android/app/build/outputs/apk/debug/app-debug.apk';

  test('an APK older than the build that just ran is refused, naming the file', () => {
    const refusal = staleApkRefusal({ task, apkPath, mtimeMs: 1_000_000, buildStartMs: 2_000_000 });
    assert(refusal);
    expect(refusal.code).toBe(BUILD_ERROR);
    expect(refusal.reason).toMatch(/predates the build/);
    expect(refusal.reason).toContain(apkPath);
    expect(refusal.remedy).toMatch(/android\.variant/);
  });

  test('an APK written during or after the build is fresh', () => {
    expect(staleApkRefusal({ task, apkPath, mtimeMs: 2_000_500, buildStartMs: 2_000_000 })).toBe(null);
    expect(staleApkRefusal({ task, apkPath, mtimeMs: 5_000_000, buildStartMs: 2_000_000 })).toBe(null);
  });

  test('the slop absorbs filesystem timestamp granularity', () => {
    expect(staleApkRefusal({ task, apkPath, mtimeMs: 1_999_000, buildStartMs: 2_000_000 })).toBe(null);
    expect(staleApkRefusal({ task, apkPath, mtimeMs: 1_997_000, buildStartMs: 2_000_000 })).not.toBe(null);
  });

  test('an unreadable mtime never refuses', () => {
    expect(staleApkRefusal({ task, apkPath, mtimeMs: Number.NaN, buildStartMs: 2_000_000 })).toBe(null);
  });
});

function fakeChild({
  lines = [],
  stderrLines = [],
  code = 0,
  signal = null,
  error = null,
  onExit = null,
}: {
  lines?: string[];
  stderrLines?: string[];
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error | null;
  onExit?: (() => void) | null;
} = {}): ChildProcess {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: (enc?: string) => void };
    stderr: EventEmitter & { setEncoding: (enc?: string) => void };
  };
  child.stdout = new EventEmitter() as EventEmitter & { setEncoding: (enc?: string) => void };
  child.stderr = new EventEmitter() as EventEmitter & { setEncoding: (enc?: string) => void };
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
  return child as unknown as ChildProcess;
}

function recordingWriter(): NdjsonWriter & { records: NdjsonRecord[] } {
  const records: NdjsonRecord[] = [];
  const writer = makeWriter({
    write(record) {
      records.push(record as NdjsonRecord);
      return true;
    },
  });
  return Object.assign(writer, { records });
}

type BuildAndroidResultLike = {
  ok?: boolean;
  apkPath?: string;
  failed?: boolean;
  code?: string;
  reason?: string;
  remedy?: string;
  durationMs?: number;
};

describe('gradleArgs', () => {
  test('is the assemble task plus --build-cache', () => {
    expect(gradleArgs('assembleDebug')).toEqual(['assembleDebug', '--build-cache']);
    expect(gradleArgs('assembleProductionRelease')).toEqual(['assembleProductionRelease', '--build-cache']);
  });

  test('a caller can turn it off, and then the argv is exactly the task', () => {
    expect(gradleArgs('assembleDebug', { buildCache: false })).toEqual(['assembleDebug']);
  });
});

describe('buildAndroid', () => {
  test('runs ./gradlew assembleDebug in android/ and streams every line as it arrives', async () => {
    makeAndroidProject();
    const writer = recordingWriter();
    const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
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
    const call = calls[0];
    assert(call);
    expect(call.cmd).toBe(join(root, 'android', 'gradlew'));
    expect(call.args).toEqual(['assembleDebug', '--build-cache']);
    expect(ASSEMBLE_TASK).toBe('assembleDebug');
    expect(call.opts.cwd).toBe(join(root, 'android'));
    const { stdio } = call.opts;
    assert(Array.isArray(stdio));
    expect(stdio[0]).toBe('ignore');

    expect((result as BuildAndroidResultLike).ok).toBe(true);
    expect((result as BuildAndroidResultLike).apkPath).toBe(join(debugApkDir(root), 'app-debug.apk'));
    expect(result.durationMs).toBe(41000);
    const [start, ...transcript] = writer.records;
    assert(start);
    expect(start.event).toBe('build_start');
    expect(start.msg).toBe(`${join(root, 'android', 'gradlew')} assembleDebug --build-cache`);
    expect(transcript.map((r) => r.msg)).toEqual(['> Task :app:compileDebugKotlin', 'BUILD SUCCESSFUL in 41s']);
    for (const record of transcript) {
      expect(record.src).toBe('build');
      expect(record.level).toBe('debug');
      expect(record.raw).toBe(true);
    }
  });

  test('writes a build_start record carrying the resolved gradlew path and its full argv', async () => {
    makeAndroidProject();
    const writer = recordingWriter();
    await buildAndroid(
      { root, logWriter: writer },
      { spawnFn: () => fakeChild({ lines: ['BUILD SUCCESSFUL in 1s'], onExit: () => writeApk() }) },
    );
    const starts = writer.records.filter((r) => r.event === 'build_start');
    expect(starts.length).toBe(1);
    const start = starts[0];
    assert(start);
    expect(start.src).toBe('build');
    expect(start.level).toBe('info');
    expect(start.raw).toBe(undefined);
    expect(start.msg).toBe(`${join(root, 'android', 'gradlew')} assembleDebug --build-cache`);
  });

  test('the build_start record shows the argv WITHOUT --build-cache when the cache is off', async () => {
    makeAndroidProject();
    const writer = recordingWriter();
    await buildAndroid(
      { root, logWriter: writer },
      {
        buildCache: false,
        spawnFn: () => fakeChild({ lines: ['BUILD SUCCESSFUL in 1s'], onExit: () => writeApk() }),
      },
    );
    const start = writer.records.find((r) => r.event === 'build_start');
    assert(start);
    expect(start.msg).toBe(`${join(root, 'android', 'gradlew')} assembleDebug`);
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
    assert(result.diagnostics);
    expect(result.diagnostics.length > 0).toBeTruthy();
    expect(result.diagnostics.some((d) => (d.file || '').endsWith('Broken.java'))).toBeTruthy();
    expect(result.truncated).toBe(0);
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
    expect((result as BuildAndroidResultLike).remedy).toMatch(/assembleDebug/);
  });

  test('the build cache is announced once, and buildCache: false drops the flag and the note', async () => {
    makeAndroidProject();
    const notes: string[] = [];
    const calls: string[][] = [];
    const on = await buildAndroid(
      { root, logWriter: recordingWriter() },
      {
        spawnFn: (_cmd, args) => {
          calls.push(args);
          return fakeChild({ lines: ['BUILD SUCCESSFUL in 3s'], onExit: () => writeApk() });
        },
        onNote: (line) => notes.push(line),
      },
    );
    expect((on as BuildAndroidResultLike).ok).toBe(true);
    expect(notes.length).toBe(1);
    expect(notes[0]).toMatch(/gradle build cache on for this build: --build-cache/);

    notes.length = 0;
    calls.length = 0;
    await buildAndroid(
      { root, logWriter: recordingWriter() },
      {
        buildCache: false,
        spawnFn: (_cmd, args) => {
          calls.push(args);
          return fakeChild({ lines: ['BUILD SUCCESSFUL in 3s'], onExit: () => writeApk() });
        },
        onNote: (line) => notes.push(line),
      },
    );
    expect(calls).toEqual([['assembleDebug']]);
    expect(notes).toEqual([]);
  });

  test('a variant drives assemble<Variant> and the APK is read from the flavor directory', async () => {
    makeAndroidProject();
    const calls: string[][] = [];
    const result = await buildAndroid(
      { root, logWriter: recordingWriter(), variant: 'productionDebug' },
      {
        spawnFn: (_cmd, args) => {
          calls.push(args);
          return fakeChild({
            lines: ['BUILD SUCCESSFUL in 8m14s'],
            onExit: () => writeFlavoredApk('production', 'debug', 'app-production-debug.apk'),
          });
        },
      },
    );
    expect(calls).toEqual([['assembleProductionDebug', '--build-cache']]);
    expect((result as BuildAndroidResultLike).ok).toBe(true);
    expect((result as BuildAndroidResultLike).apkPath).toBe(
      join(apkOutputsDir(root), 'production', 'debug', 'app-production-debug.apk'),
    );
  });

  test('a flavored build with NO variant configured still succeeds, with the note on the result', async () => {
    makeAndroidProject();
    const result = await buildAndroid(
      { root, logWriter: recordingWriter() },
      {
        spawnFn: () =>
          fakeChild({
            lines: ['BUILD SUCCESSFUL in 8m14s'],
            onExit: () => writeFlavoredApk('production', 'debug', 'app-production-debug.apk'),
          }),
      },
    );
    expect((result as BuildAndroidResultLike & { apkNote?: string }).ok).toBe(true);
    expect((result as BuildAndroidResultLike & { apkNote?: string }).apkNote).toMatch(/android\.variant/);
  });

  test('two flavored debug APKs and no variant is a refusal listing them, never a guess', async () => {
    makeAndroidProject();
    writeFlavoredApk('preview', 'debug', 'app-preview-debug.apk');
    const result = await buildAndroid(
      { root, logWriter: recordingWriter() },
      {
        spawnFn: () =>
          fakeChild({
            lines: ['BUILD SUCCESSFUL in 8m14s'],
            onExit: () => writeFlavoredApk('production', 'debug', 'app-production-debug.apk'),
          }),
      },
    );
    expect(result.failed).toBe(true);
    expect(result.code).toBe(BUILD_ERROR);
    expect(result.reason).toMatch(/2 debug APKs/);
    expect((result as BuildAndroidResultLike).remedy).toMatch(/android\.variant/);
    expect(result.lastLines.some((l) => l.includes('app-preview-debug.apk'))).toBeTruthy();
    expect(result.lastLines.some((l) => l.includes('app-production-debug.apk'))).toBeTruthy();
  });

  test('an APK whose mtime predates the build is refused as a stale carried artifact', async () => {
    makeAndroidProject();
    const apk = writeApk('app-debug.apk');
    const old = (Date.now() - 3_600_000) / 1000;
    utimesSync(apk, old, old);
    const result = await buildAndroid(
      { root, logWriter: recordingWriter() },
      { spawnFn: () => fakeChild({ lines: ['BUILD SUCCESSFUL in 1s'] }) },
    );
    expect(result.failed).toBe(true);
    expect(result.code).toBe(BUILD_ERROR);
    expect(result.reason).toMatch(/predates the build/);
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
    expect((result as BuildAndroidResultLike).remedy).toMatch(/chmod \+x/);
  });

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
    expect((result as BuildAndroidResultLike).remedy).toMatch(/prebuild/);
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
    expect((result as BuildAndroidResultLike).remedy).toMatch(/ANDROID_HOME/);
  });

  test('a slow gradle build emits heartbeats carrying the latest transcript line', async () => {
    makeAndroidProject();
    const beats: string[] = [];
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding: (enc?: string) => void };
      stderr: EventEmitter & { setEncoding: (enc?: string) => void };
    };
    child.stdout = new EventEmitter() as EventEmitter & { setEncoding: (enc?: string) => void };
    child.stderr = new EventEmitter() as EventEmitter & { setEncoding: (enc?: string) => void };
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    const promise = buildAndroid(
      { root, logWriter: recordingWriter() },
      {
        spawnFn: () => child as unknown as ChildProcess,
        heartbeatMs: 10,
        onHeartbeat: (line) => beats.push(line),
      },
    );
    child.stdout.emit('data', '> Task :app:compileDebugKotlin\n');
    await new Promise((r) => setTimeout(r, 80));
    expect(beats.length).toBeGreaterThanOrEqual(1);
    expect(beats[0]).toMatch(/^build {6} still running \(\d+s\): > Task :app:compileDebugKotlin$/);
    writeApk();
    child.emit('exit', 0, null);
    const result = await promise;
    expect((result as BuildAndroidResultLike).ok).toBe(true);
    const settled = beats.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(beats.length).toBe(settled);
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
    expect((result as BuildAndroidResultLike).ok).toBe(true);
  });
});
