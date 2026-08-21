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
test('the facts topic documents the fields the payload actually carries', () => {
  const body = renderTopic('facts');
  const up = readFileSync(new URL('../src/commands/up.js', import.meta.url), 'utf-8');
  const fields = ['metroPort', 'metroHealthy', 'metroConflict', 'bundleId', 'owned'];
  for (const f of fields) {
    assert.ok(body.includes(f), `guide should document ${f}`);
    assert.ok(up.includes(f), `up.js should still emit ${f}`);
  }
});

test('the metro topic advertises --wait-metro, and up actually implements it', () => {
  assert.match(renderTopic('metro'), /--wait-metro/);
  const up = readFileSync(new URL('../src/commands/up.js', import.meta.url), 'utf-8');
  assert.ok(up.includes('--wait-metro'), 'up.js must still define --wait-metro');
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
  for (const must of ['gc --delete', '--force', 'metroConflict', 'booted', 'rn-iso-']) {
    assert.ok(skill.includes(must), `skill must still cover ${must}`);
  }
});
