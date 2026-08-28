import assert from 'node:assert';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'node:url';
import { topicNames, renderTopic, renderIndex } from '../commands/guide.ts';

test('every advertised topic renders non-empty content', () => {
  for (const name of topicNames()) {
    const body = renderTopic(name);
    expect(body && body.length > 100).toBeTruthy();
  }
});

test('an unknown topic renders nothing rather than throwing', () => {
  expect(renderTopic('nope')).toBe(null);
});

test('the index lists every topic and the running version', () => {
  const idx = renderIndex('9.9.9');
  expect(idx).toMatch(/rn-iso 9\.9\.9/);
  for (const name of topicNames()) expect(idx).toMatch(new RegExp(name));
});

test('the facts topic documents the fields each --json payload actually carries', () => {
  const body = renderTopic('facts');
  assert(body);
  const sources = {
    start: readFileSync(new URL('../commands/start.ts', import.meta.url), 'utf-8'),
    ios: readFileSync(new URL('../commands/ios.ts', import.meta.url), 'utf-8'),
    android: readFileSync(new URL('../commands/android.ts', import.meta.url), 'utf-8'),
  };
  const fields = {
    start: ['port', 'supervisorPid', 'mode', 'logsDir', 'alreadyRunning'],
    ios: [
      'udid',
      'deviceName',
      'fingerprint',
      'configuration',
      'cacheKey',
      'cacheHit',
      'cacheSkipped',
      'waitedForBuild',
      'appPath',
      'bundleId',
      'launched',
      'metroPort',
    ],
    android: [
      'serial',
      'fingerprint',
      'cacheKey',
      'variant',
      'metroPort',
      'cacheHit',
      'cacheSkipped',
      'waitedForBuild',
      'appPath',
      'bundleId',
      'launched',
    ],
  };
  for (const [command, names] of Object.entries(fields)) {
    for (const f of names) {
      expect(body.includes(f)).toBeTruthy();
      expect(sources[command as keyof typeof sources].includes(f)).toBeTruthy();
    }
  }
});

test('the flags the guide advertises are the flags the commands define', () => {
  const lifecycle = renderTopic('lifecycle');
  assert(lifecycle);
  const advertised = {
    'start.ts': ['--json', '--wait'],
    'ios.ts': ['--json', '--no-metro-check', '--no-build-cache', '--configuration'],
    'android.ts': ['--json', '--no-metro-check', '--no-build-cache', '--variant'],
    'stop.ts': ['--json', '--force'],
    'logs.ts': ['--errors', '--follow', '--since', '--grep', '--tail'],
    'gc.ts': ['--delete', '--older-than', '--all'],
  };
  for (const [file, flags] of Object.entries(advertised)) {
    const src = readFileSync(new URL(`../commands/${file}`, import.meta.url), 'utf-8');
    for (const flag of flags) {
      expect(src.includes(flag)).toBeTruthy();
      expect(lifecycle.includes(flag)).toBeTruthy();
    }
  }
  const statusSrc = readFileSync(new URL('../commands/status.ts', import.meta.url), 'utf-8');
  expect(!statusSrc.includes("'--all'")).toBeTruthy();
  for (const name of topicNames()) {
    const topic = renderTopic(name);
    assert(topic);
    expect(!topic.includes('status --all')).toBeTruthy();
  }
});

test('no topic teaches a command this binary does not have', () => {
  const gone = [
    'rn-iso up',
    'rn-iso release',
    'rn-iso shutdown',
    'rn-iso device',
    'build-cache resolve',
    '--wait-metro',
    '--serial',
  ];
  for (const name of topicNames()) {
    const body = renderTopic(name);
    assert(body);
    for (const dead of gone) {
      expect(!body.includes(dead)).toBeTruthy();
    }
    expect(body).not.toMatch(/rn-iso config (--repo|<key>|[a-z]+\.[a-z])/i);
  }
  expect(renderTopic('settings')).toMatch(/no `rn-iso config` command/);
});

test('the errors topic documents every code the build commands can emit', () => {
  const body = renderTopic('errors');
  assert(body);
  const sources = ['ios.ts', 'android.ts', 'start.ts']
    .map((f) => readFileSync(new URL(`../commands/${f}`, import.meta.url), 'utf-8'))
    .join('\n');
  const codes = new Set([...sources.matchAll(/RN_ISO_[A-Z_]+/g)].map((m) => m[0]));
  expect(codes.size >= 8).toBeTruthy();
  for (const code of codes) {
    if (code === 'RN_ISO_CONFIG_CORRUPT') continue;
    expect(body.includes(code)).toBeTruthy();
  }
});

test('the settings topic lists exactly the keys settings.js honours', () => {
  const body = renderTopic('settings');
  assert(body);
  const src = readFileSync(new URL('../settings.ts', import.meta.url), 'utf-8');
  const known = [...src.matchAll(/^\s*'([a-zA-Z.]+)',$/gm)]
    .map((m) => m[1])
    .filter((k): k is string => k !== undefined);
  expect(known.length > 0).toBeTruthy();
  for (const key of known) {
    expect(body.includes(key)).toBeTruthy();
  }
});

test('the skill points at the guide command and the topics it advertises', () => {
  const skill = readFileSync(new URL('../../skill/SKILL.md', import.meta.url), 'utf-8');
  expect(skill).toMatch(/rn-iso guide/);
  for (const name of topicNames()) {
    expect(skill.includes(`guide ${name}`)).toBeTruthy();
  }
});

test('exactly one skill ships, and the deleted init skill has not come back', () => {
  const dir = fileURLToPath(new URL('../../skill/', import.meta.url));
  expect(readdirSync(dir).toSorted()).toEqual(['SKILL.md']);
  const skill = readFileSync(new URL('../../skill/SKILL.md', import.meta.url), 'utf-8');
  expect(skill).toMatch(/no separate init skill/);
  expect(skill).toMatch(/rn-iso doctor/);
  expect(skill).toMatch(/\.fingerprintignore/);
});

test('the skill still carries the rules an agent must not have to look up', () => {
  const skill = readFileSync(new URL('../../skill/SKILL.md', import.meta.url), 'utf-8');
  for (const must of ['gc --delete', '--force', 'RN_ISO_NO_METRO', 'booted', 'rn-iso-']) {
    expect(skill.includes(must)).toBeTruthy();
  }
});

test('the skill advertises exactly the commands bin/cli.js registers', () => {
  const skill = readFileSync(new URL('../../skill/SKILL.md', import.meta.url), 'utf-8');
  const cli = readFileSync(new URL('../../bin/cli.ts', import.meta.url), 'utf-8');
  const registered = [...cli.matchAll(/^import (\w+)Command from '\.\.\/src\/commands\/([\w-]+)\.ts';$/gm)].map(
    (m) => m[2],
  );
  expect(registered.toSorted()).toEqual([
    'android',
    'doctor',
    'gc',
    'guide',
    'ios',
    'logs',
    'start',
    'status',
    'stop',
    'worktree',
  ]);
  const surface = skill.slice(skill.indexOf('## Command surface'), skill.indexOf('## When things go wrong'));
  for (const command of registered) {
    expect(surface.includes(`\`${command}\``) || surface.includes(`\`${command} `)).toBeTruthy();
  }
  for (const gone of ['up', 'release', 'shutdown', 'config', 'build-cache', 'init']) {
    expect(surface.includes(`no \`${gone}\``)).toBeTruthy();
  }
});
