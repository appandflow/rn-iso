import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { topicNames, renderTopic, renderIndex } from '../src/commands/guide.js';

test('every advertised topic renders non-empty content', () => {
  for (const name of topicNames()) {
    const body = renderTopic(name);
    assert.ok(body && body.length > 100, `topic ${name} should render real content`);
  }
});

test('an unknown topic renders nothing rather than throwing', () => {
  assert.equal(renderTopic('nope'), null);
});

test('the index lists every topic and the running version', () => {
  const idx = renderIndex('9.9.9');
  assert.match(idx, /rn-iso 9\.9\.9/);
  for (const name of topicNames()) assert.match(idx, new RegExp(name));
});

// The whole point of `guide` is that it cannot drift from the binary. These
// pin the claims most likely to rot -- if a flag or field is renamed and the
// guide is not updated, this fails rather than shipping stale agent guidance.
test('the facts topic documents the fields each --json payload actually carries', () => {
  const body = renderTopic('facts');
  const sources = {
    start: readFileSync(new URL('../src/commands/start.js', import.meta.url), 'utf-8'),
    ios: readFileSync(new URL('../src/commands/ios.js', import.meta.url), 'utf-8'),
    android: readFileSync(new URL('../src/commands/android.js', import.meta.url), 'utf-8'),
  };
  const fields = {
    start: ['port', 'supervisorPid', 'mode', 'logsDir', 'alreadyRunning'],
    ios: ['udid', 'deviceName', 'fingerprint', 'cacheKey', 'cacheHit', 'cacheSkipped', 'appPath', 'bundleId', 'launched', 'metroPort'],
    android: ['serial', 'fingerprint', 'cacheHit', 'cacheSkipped', 'appPath', 'bundleId', 'launched'],
  };
  for (const [command, names] of Object.entries(fields)) {
    for (const f of names) {
      assert.ok(body.includes(f), `guide should document ${command}'s ${f}`);
      assert.ok(sources[command].includes(f), `${command}.js should still emit ${f}`);
    }
  }
});

// Every flag the guide advertises has to be one the binary actually defines,
// and every flag the binary defines has to be advertised. v2's guide outlived
// `up --wait-metro` by exactly one release, which is what this pins against.
test('the flags the guide advertises are the flags the commands define', () => {
  const lifecycle = renderTopic('lifecycle');
  const advertised = {
    'start.js': ['--json', '--wait'],
    'ios.js': ['--json', '--no-metro-check', '--no-build-cache'],
    'android.js': ['--json', '--no-metro-check', '--no-build-cache'],
    'stop.js': ['--json', '--force'],
    'logs.js': ['--errors', '--follow', '--since', '--grep', '--tail'],
    'gc.js': ['--delete', '--older-than', '--all'],
  };
  for (const [file, flags] of Object.entries(advertised)) {
    const src = readFileSync(new URL(`../src/commands/${file}`, import.meta.url), 'utf-8');
    for (const flag of flags) {
      assert.ok(src.includes(flag), `${file} must still define ${flag}`);
      assert.ok(lifecycle.includes(flag), `the lifecycle topic should list ${flag}`);
    }
  }
  // The other direction, for the flag most likely to be documented into
  // existence: `status` is machine-wide already and has no --all.
  const statusSrc = readFileSync(new URL('../src/commands/status.js', import.meta.url), 'utf-8');
  assert.ok(!statusSrc.includes("'--all'"), 'if status grows --all, the docs saying it has none must change');
  for (const name of topicNames()) {
    assert.ok(!renderTopic(name).includes('status --all'), `the ${name} topic must not advertise a status --all that does not exist`);
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
      assert.ok(!body.includes(dead), `the ${name} topic must not teach ${dead}`);
    }
    assert.doesNotMatch(body, /rn-iso config (--repo|<key>|[a-z]+\.[a-z])/i, `the ${name} topic must not invoke the deleted config command`);
  }
  assert.match(renderTopic('settings'), /no `rn-iso config` command/);
});

// Every error code the build path can emit must be documented, or an agent
// branching on `code` meets one it has no guidance for.
test('the errors topic documents every code the build commands can emit', () => {
  const body = renderTopic('errors');
  const sources = ['ios.js', 'android.js', 'start.js']
    .map((f) => readFileSync(new URL(`../src/commands/${f}`, import.meta.url), 'utf-8'))
    .join('\n');
  const codes = new Set([...sources.matchAll(/RN_ISO_[A-Z_]+/g)].map((m) => m[0]));
  assert.ok(codes.size >= 8, 'sanity: should have found the build-path codes');
  for (const code of codes) {
    if (code === 'RN_ISO_CONFIG_CORRUPT') continue; // documented by its message, not its code
    assert.ok(body.includes(code), `guide errors should document ${code}`);
  }
});

test('the settings topic lists exactly the keys settings.js honours', () => {
  const body = renderTopic('settings');
  const src = readFileSync(new URL('../src/settings.js', import.meta.url), 'utf-8');
  const known = [...src.matchAll(/^\s*'([a-zA-Z.]+)',$/gm)].map(m => m[1]);
  assert.ok(known.length > 0, 'sanity: should have parsed the KNOWN_SETTINGS list');
  for (const key of known) {
    assert.ok(body.includes(key), `guide should document the honoured key ${key}`);
  }
});

// The skill is now a pointer for volatile detail. Pin that it still names the
// guide command -- if that link rots, agents get the thin skill with no way to
// reach the reference it defers to.
test('the skill points at the guide command and the topics it advertises', () => {
  const skill = readFileSync(new URL('../skill/SKILL.md', import.meta.url), 'utf-8');
  assert.match(skill, /rn-iso guide/, 'skill must tell agents to run `guide`');
  for (const name of topicNames()) {
    assert.ok(skill.includes(`guide ${name}`), `skill should advertise the ${name} topic`);
  }
});

test('the skill still carries the rules an agent must not have to look up', () => {
  const skill = readFileSync(new URL('../skill/SKILL.md', import.meta.url), 'utf-8');
  for (const must of ['gc --delete', '--force', 'RN_ISO_NO_METRO', 'booted', 'rn-iso-']) {
    assert.ok(skill.includes(must), `skill must still cover ${must}`);
  }
});

// The surface list in the skill IS the surface an agent reads first. A command
// listed there that the binary does not register is a guaranteed dead end.
test('the skill advertises exactly the commands bin/cli.js registers', () => {
  const skill = readFileSync(new URL('../skill/SKILL.md', import.meta.url), 'utf-8');
  const cli = readFileSync(new URL('../bin/cli.js', import.meta.url), 'utf-8');
  const registered = [...cli.matchAll(/^import (\w+)Command from '\.\.\/src\/commands\/([\w-]+)\.js';$/gm)].map((m) => m[2]);
  assert.deepEqual(
    registered.sort(),
    ['android', 'doctor', 'gc', 'guide', 'init', 'ios', 'logs', 'skill', 'start', 'status', 'stop', 'worktree'],
    'the target v3 surface'
  );
  const surface = skill.slice(skill.indexOf('## Command surface'), skill.indexOf('## When things go wrong'));
  for (const command of registered) {
    assert.ok(surface.includes(`\`${command}\``) || surface.includes(`\`${command} `), `the surface list should name ${command}`);
  }
  for (const gone of ['up', 'release', 'shutdown', 'config', 'build-cache']) {
    assert.ok(surface.includes(`no \`${gone}\``), `the surface list should record that ${gone} is gone`);
  }
});
