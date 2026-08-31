import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundlerPin, podInstallCommand } from '../engine/bundler.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-bundler-'));
  writeFileSync(join(root, 'Gemfile'), "source 'https://rubygems.org'\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function lock(text: string) {
  writeFileSync(join(root, 'Gemfile.lock'), text);
}

const GEM_SPECS = ['GEM', '  remote: https://rubygems.org/', '  specs:'];

test('a resolved cocoapods spec pins the pods toolchain', () => {
  lock([...GEM_SPECS, '    activesupport (7.2.3.2)', '    cocoapods (1.15.2)', ''].join('\n'));
  expect(bundlerPin(root)).toEqual({ gemfile: join(root, 'Gemfile'), lockfile: join(root, 'Gemfile.lock') });
});

test('a CRLF lockfile pins it too, because the match is anchored at the line start', () => {
  lock([...GEM_SPECS, '    cocoapods (1.15.2)', ''].join('\r\n'));
  expect(bundlerPin(root)).not.toBe(null);
});

test('cocoapods as another gem dependency, with no spec of its own, is NOT a pin', () => {
  lock([...GEM_SPECS, '    cocoapods-catalyst-support (0.2.1)', '      cocoapods (>= 1.10)', ''].join('\n'));
  expect(bundlerPin(root)).toBe(null);
});

test('a CHECKSUMS entry alone is NOT a pin: those lines are indented two spaces', () => {
  lock(
    [
      ...GEM_SPECS,
      '    fastlane (2.219.0)',
      '',
      'CHECKSUMS',
      '  cocoapods (1.15.2) sha256=0d1e2f',
      '',
      'DEPENDENCIES',
      '  fastlane',
      '',
    ].join('\n'),
  );
  expect(bundlerPin(root)).toBe(null);
});

test('a cocoapods spec resolved from a GIT source pins it', () => {
  lock(
    [
      'GIT',
      '  remote: https://github.com/CocoaPods/CocoaPods.git',
      '  revision: 7f0c3c1e',
      '  specs:',
      '    cocoapods (1.16.2)',
      '',
    ].join('\n'),
  );
  expect(bundlerPin(root)).not.toBe(null);
});

test('a missing Gemfile, a missing lockfile, and a lockfile that is a directory are all unpinned', () => {
  expect(bundlerPin(root)).toBe(null);
  mkdirSync(join(root, 'Gemfile.lock'));
  expect(bundlerPin(root)).toBe(null);
  rmSync(join(root, 'Gemfile.lock'), { recursive: true });
  lock([...GEM_SPECS, '    cocoapods (1.15.2)', ''].join('\n'));
  rmSync(join(root, 'Gemfile'));
  expect(bundlerPin(root)).toBe(null);
});

test('podInstallCommand follows the pin and keeps the extra pod flags', () => {
  lock([...GEM_SPECS, '    fastlane (2.219.0)', ''].join('\n'));
  expect(podInstallCommand(root)).toBe('pod install');
  expect(podInstallCommand(root, '--clean-install')).toBe('pod install --clean-install');

  lock([...GEM_SPECS, '    cocoapods (1.15.2)', ''].join('\n'));
  expect(podInstallCommand(root)).toBe('bundle exec pod install');
  expect(podInstallCommand(root, '--clean-install')).toBe('bundle exec pod install --clean-install');
});
