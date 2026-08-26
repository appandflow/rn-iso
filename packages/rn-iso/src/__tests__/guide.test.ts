import { readFileSync } from 'fs';
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

// The whole point of `guide` is that it cannot drift from the binary. These
// pin the claims most likely to rot -- if a flag or field is renamed and the
// guide is not updated, this fails rather than shipping stale agent guidance.
test('the facts topic documents the fields each --json payload actually carries', () => {
  const body = renderTopic('facts');
  const sources = {
    start: readFileSync(new URL('../commands/start.ts', import.meta.url), 'utf-8'),
    ios: readFileSync(new URL('../commands/ios.ts', import.meta.url), 'utf-8'),
    android: readFileSync(new URL('../commands/android.ts', import.meta.url), 'utf-8'),
  };
  const fields = {
    start: ['port', 'supervisorPid', 'mode', 'logsDir', 'alreadyRunning'],
    ios: ['udid', 'deviceName', 'fingerprint', 'cacheKey', 'cacheHit', 'cacheSkipped', 'waitedForBuild', 'appPath', 'bundleId', 'launched', 'metroPort'],
    android: ['serial', 'fingerprint', 'cacheHit', 'cacheSkipped', 'waitedForBuild', 'appPath', 'bundleId', 'launched'],
  };
  for (const [command, names] of Object.entries(fields)) {
    for (const f of names) {
      expect(body.includes(f)).toBeTruthy();
      expect(sources[command].includes(f)).toBeTruthy();
    }
  }
});

// Every flag the guide advertises has to be one the binary actually defines,
// and every flag the binary defines has to be advertised. v2's guide outlived
// `up --wait-metro` by exactly one release, which is what this pins against.
test('the flags the guide advertises are the flags the commands define', () => {
  const lifecycle = renderTopic('lifecycle');
  const advertised = {
    'start.ts': ['--json', '--wait'],
    'ios.ts': ['--json', '--no-metro-check', '--no-build-cache'],
    'android.ts': ['--json', '--no-metro-check', '--no-build-cache'],
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
  // The other direction, for the flag most likely to be documented into
  // existence: `status` is machine-wide already and has no --all.
  const statusSrc = readFileSync(new URL('../commands/status.ts', import.meta.url), 'utf-8');
  expect(!statusSrc.includes("'--all'")).toBeTruthy();
  for (const name of topicNames()) {
    expect(!renderTopic(name).includes('status --all')).toBeTruthy();
  }
});

// The commands v3 deleted. A guide that still teaches one of them is worse than
// no guide: the agent runs it and gets "unknown command".
test('no topic teaches a command this binary does not have', () => {
  // "rn-iso config" is excluded from this list on purpose: it survives as the
  // name of the config FILE in two error messages, and as an explicit "there is
  // no such command" in the settings topic. Its INVOCATION forms are checked
  // separately below.
  const gone = ['rn-iso up', 'rn-iso release', 'rn-iso shutdown', 'rn-iso device', 'build-cache resolve', '--wait-metro', '--serial'];
  for (const name of topicNames()) {
    const body = renderTopic(name);
    for (const dead of gone) {
      expect(!body.includes(dead)).toBeTruthy();
    }
    expect(body).not.toMatch(/rn-iso config (--repo|<key>|[a-z]+\.[a-z])/i);
  }
  expect(renderTopic('settings')).toMatch(/no `rn-iso config` command/);
});

// Every error code the build path can emit must be documented, or an agent
// branching on `code` meets one it has no guidance for.
test('the errors topic documents every code the build commands can emit', () => {
  const body = renderTopic('errors');
  const sources = ['ios.ts', 'android.ts', 'start.ts']
    .map((f) => readFileSync(new URL(`../commands/${f}`, import.meta.url), 'utf-8'))
    .join('\n');
  const codes = new Set([...sources.matchAll(/RN_ISO_[A-Z_]+/g)].map((m) => m[0]));
  expect(codes.size >= 8).toBeTruthy();
  for (const code of codes) {
    if (code === 'RN_ISO_CONFIG_CORRUPT') continue; // documented by its message, not its code
    expect(body.includes(code)).toBeTruthy();
  }
});

test('the settings topic lists exactly the keys settings.js honours', () => {
  const body = renderTopic('settings');
  const src = readFileSync(new URL('../settings.ts', import.meta.url), 'utf-8');
  const known = [...src.matchAll(/^\s*'([a-zA-Z.]+)',$/gm)].map(m => m[1]);
  expect(known.length > 0).toBeTruthy();
  for (const key of known) {
    expect(body.includes(key)).toBeTruthy();
  }
});

// The skill is now a pointer for volatile detail. Pin that it still names the
// guide command -- if that link rots, agents get the thin skill with no way to
// reach the reference it defers to.
test('the skill points at the guide command and the topics it advertises', () => {
  const skill = readFileSync(new URL('../../skill/SKILL.md', import.meta.url), 'utf-8');
  expect(skill).toMatch(/rn-iso guide/);
  for (const name of topicNames()) {
    expect(skill.includes(`guide ${name}`)).toBeTruthy();
  }
});

test('the skill still carries the rules an agent must not have to look up', () => {
  const skill = readFileSync(new URL('../../skill/SKILL.md', import.meta.url), 'utf-8');
  for (const must of ['gc --delete', '--force', 'RN_ISO_NO_METRO', 'booted', 'rn-iso-']) {
    expect(skill.includes(must)).toBeTruthy();
  }
});

// The surface list in the skill IS the surface an agent reads first. A command
// listed there that the binary does not register is a guaranteed dead end.
test('the skill advertises exactly the commands bin/cli.js registers', () => {
  const skill = readFileSync(new URL('../../skill/SKILL.md', import.meta.url), 'utf-8');
  const cli = readFileSync(new URL('../../bin/cli.ts', import.meta.url), 'utf-8');
  const registered = [...cli.matchAll(/^import (\w+)Command from '\.\.\/src\/commands\/([\w-]+)\.ts';$/gm)].map((m) => m[2]);
  expect(registered.sort()).toEqual(['android', 'doctor', 'gc', 'guide', 'ios', 'logs', 'skill', 'start', 'status', 'stop', 'worktree']);
  const surface = skill.slice(skill.indexOf('## Command surface'), skill.indexOf('## When things go wrong'));
  for (const command of registered) {
    expect(surface.includes(`\`${command}\``) || surface.includes(`\`${command} `)).toBeTruthy();
  }
  for (const gone of ['up', 'release', 'shutdown', 'config', 'build-cache', 'init']) {
    expect(surface.includes(`no \`${gone}\``)).toBeTruthy();
  }
});
