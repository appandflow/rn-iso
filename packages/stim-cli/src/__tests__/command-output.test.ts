import { readdirSync, readFileSync } from 'node:fs';
import {
  formatDuration,
  formatElapsed,
  formatLongDuration,
  isOutputLabel,
  launchErrorReport,
  OUTPUT_LABELS,
  phaseLine,
  shortHash,
  shortUdid,
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

test('shortUdid keeps short values and abbreviates simulator ids', () => {
  expect(shortUdid('A1F3')).toBe('A1F3');
  expect(shortUdid('A1F3-0000')).toBe('A1F3..');
  expect(shortUdid(null)).toBe('');
});

test('the label set is closed, sorted, and free of duplicates', () => {
  expect(OUTPUT_LABELS).toEqual(OUTPUT_LABELS.toSorted());
  expect(new Set(OUTPUT_LABELS).size).toBe(OUTPUT_LABELS.length);
  expect(isOutputLabel('install')).toBe(true);
  expect(isOutputLabel('launch err')).toBe(false);
  expect(isOutputLabel('js swap')).toBe(false);
  expect(isOutputLabel('wired')).toBe(false);
});

test('every label the run, lifecycle, and doctor commands print comes from that one set', () => {
  for (const command of ['ios', 'android', 'worktree', 'start', 'stop', 'doctor']) {
    const files = [`${command}.ts`];
    if (command === 'ios' || command === 'android') {
      files.push(
        ...readdirSync(new URL(`../commands/${command}/`, import.meta.url))
          .filter((file) => file.endsWith('.ts'))
          .map((file) => `${command}/${file}`),
        'native-runtime.ts',
        'dev-client.ts',
      );
    }
    const src = files.map((file) => readFileSync(new URL(`../commands/${file}`, import.meta.url), 'utf-8')).join('\n');
    const labels = new Set<string>();
    for (const match of src.matchAll(/\bphase(?:Line)?\(\s*'((?:[^'\\]|\\.)*)'/g)) labels.add(match[1]!);
    expect(labels.size).toBeGreaterThan(1);
    for (const label of labels) {
      expect({ command, label, known: isOutputLabel(label) }).toEqual({ command, label, known: true });
    }
  }
});

test("a verified launch counts the device log and still prints the app's own errors", () => {
  const records = [
    { src: 'device', proc: 'Trailhead', msg: 'Failed to send CA Event for app launch measurements' },
    { src: 'device', proc: 'Trailhead', msg: 'TCP Conn 0x106f86d00 Failed : error 0:61 [61]' },
    { src: 'device', proc: 'Trailhead', msg: 'NSBundle (null) initWithPath failed' },
    { src: 'client', msg: 'a redbox' },
    { src: 'metro', msg: 'a bundler error' },
  ];
  const report = launchErrorReport(records);
  expect(report.summary).toBe('3 error-level records in the device log during launch (logs --errors --source device)');
  expect(report.lines).toEqual(['a redbox', 'a bundler error']);
});

test('the count never depends on the process a record names', () => {
  const named = launchErrorReport([{ src: 'device', proc: 'Trailhead', msg: 'x' }]);
  const unnamed = launchErrorReport([{ src: 'device', msg: 'x' }]);
  expect(named.summary).toBe(unnamed.summary);
  expect(named.summary).toBe('1 error-level record in the device log during launch (logs --errors --source device)');
  expect(named.lines).toEqual([]);
});

test('no device record means no count line at all', () => {
  const quiet = launchErrorReport([{ src: 'client', msg: 'x' }]);
  expect(quiet.summary).toBe(null);
  expect(quiet.lines).toEqual(['x']);
});
