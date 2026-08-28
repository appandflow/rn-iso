import { formatDuration, phaseLine, shortHash } from '../command-output.ts';

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

test('phaseLine uses one indented column', () => {
  expect(phaseLine('device', 'x')).toBe('  device      x');
  expect(phaseLine('fingerprint', 'x')).toBe('  fingerprint x');
});

test('shortHash keeps short values and abbreviates long values', () => {
  expect(shortHash('12345678')).toBe('12345678');
  expect(shortHash('123456789')).toBe('123456..');
  expect(shortHash(null)).toBe('');
});
