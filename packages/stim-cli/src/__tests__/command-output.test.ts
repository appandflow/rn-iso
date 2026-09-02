import { readFileSync } from 'node:fs';
import {
  formatDuration,
  formatElapsed,
  formatLongDuration,
  isOutputLabel,
  launchErrorReport,
  OUTPUT_LABELS,
  phaseLine,
  shortHash,
} from '../command-output.ts';

test('formatDuration uses one format for every command', () => {
  expect(formatDuration(0)).toBe('0ms');
  expect(formatDuration(410)).toBe('410ms');
  expect(formatDuration(1000)).toBe('1s');
  expect(formatDuration(3100)).toBe('3.1s');
  expect(formatDuration(18000)).toBe('18s');
  expect(formatDuration(119600)).toBe('2m00s');
  expect(formatDuration(161000)).toBe('2m41s');
  expect(formatDuration(605000)).toBe('10m05s');
  expect(formatDuration(undefined)).toBe('unknown');
  expect(formatDuration(-1)).toBe('unknown');
});

test('formatElapsed keeps seconds at every scale, so a 30s progress line never repeats itself', () => {
  expect(formatElapsed(0)).toBe('0s');
  expect(formatElapsed(42_000)).toBe('42s');
  expect(formatElapsed(60_000)).toBe('1m00s');
  expect(formatElapsed(90_000)).toBe('1m30s');
  expect(formatElapsed(119_600)).toBe('2m00s');
  expect(formatElapsed(319_000)).toBe('5m19s');
  expect(formatElapsed(605_000)).toBe('10m05s');
  expect(formatElapsed(-5)).toBe('0s');
  expect(formatElapsed(undefined)).toBe('0s');
});

test('formatLongDuration adds hours and pads the smaller unit at every scale', () => {
  expect(formatLongDuration(0)).toBe('0s');
  expect(formatLongDuration(31_000)).toBe('31s');
  expect(formatLongDuration(245_000)).toBe('4m05s');
  expect(formatLongDuration(252_000)).toBe('4m12s');
  expect(formatLongDuration(2_460_000)).toBe('41m');
  expect(formatLongDuration(3_900_000)).toBe('1h05m');
  expect(formatLongDuration(7_980_000)).toBe('2h13m');
  expect(formatLongDuration(7_200_000)).toBe('2h');
  expect(formatLongDuration(-1)).toBe('unknown');
  expect(formatLongDuration(undefined)).toBe('unknown');
});

test('phaseLine uses one indented column', () => {
  expect(phaseLine('device', 'x')).toBe('  device      x');
  expect(phaseLine('fingerprint', 'x')).toBe('  fingerprint x');
});

test('shortHash keeps short values and abbreviates long values', () => {
  expect(shortHash('12345678')).toBe('12345678');
  expect(shortHash('123456789')).toBe('123456..');
  expect(shortHash(null)).toBe('');
});

test('the label set is closed, sorted, and free of duplicates', () => {
  expect(OUTPUT_LABELS).toEqual(OUTPUT_LABELS.toSorted());
  expect(new Set(OUTPUT_LABELS).size).toBe(OUTPUT_LABELS.length);
  expect(isOutputLabel('install')).toBe(true);
  expect(isOutputLabel('launch err')).toBe(false);
  expect(isOutputLabel('js swap')).toBe(false);
  expect(isOutputLabel('wired')).toBe(false);
});

test('every label ios.ts and android.ts print comes from that one set', () => {
  for (const command of ['ios', 'android']) {
    const src = readFileSync(new URL(`../commands/${command}.ts`, import.meta.url), 'utf-8');
    const labels = new Set<string>();
    for (const match of src.matchAll(/\bphase(?:Line)?\(\s*'((?:[^'\\]|\\.)*)'/g)) labels.add(match[1]!);
    expect(labels.size).toBeGreaterThan(10);
    for (const label of labels) {
      expect({ command, label, known: isOutputLabel(label) }).toEqual({ command, label, known: true });
    }
  }
});

test('a verified launch summarizes the OS log noise and still prints the rest', () => {
  const records = [
    { src: 'device', proc: 'Fixture', msg: 'the app itself complained' },
    { src: 'device', proc: 'SpringBoard', msg: 'attention client lost event tag' },
    { src: 'device', proc: 'amsengagementd', msg: 'Object decoding failed' },
    { src: 'client', msg: 'a redbox' },
  ];
  const report = launchErrorReport(records, {
    appId: 'com.example.app',
    fromApp: (record) => record.proc === 'Fixture',
  });
  expect(report.summary).toBe(
    '2 error-level OS log lines during launch, none from com.example.app (logs --source device)',
  );
  expect(report.lines).toEqual(['the app itself complained', 'a redbox']);
});

test('one noise line is singular, and no noise means no line at all', () => {
  expect(launchErrorReport([{ src: 'device', msg: 'x' }], { appId: 'app', fromApp: () => false }).summary).toBe(
    '1 error-level OS log line during launch, none from app (logs --source device)',
  );
  const quiet = launchErrorReport([{ src: 'client', msg: 'x' }], { appId: 'app', fromApp: () => false });
  expect(quiet.summary).toBe(null);
  expect(quiet.lines).toEqual(['x']);
});
