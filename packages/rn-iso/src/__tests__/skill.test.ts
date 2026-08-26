import { existsSync } from 'fs';
import { join } from 'path';
import { skillTargets, bundledSkillPath, planSkillInstall, stampSkillVersion, parseSkillVersion, staleSkillCopies, staleSkillWarning } from '../commands/skill.ts';

test('the bundled skill actually ships in the package', () => {
  expect(existsSync(bundledSkillPath())).toBeTruthy();
});

test('skillTargets covers both directories agents read', () => {
  const t = skillTargets('/home/u');
  expect(t).toEqual(['/home/u/.claude/skills/rn-iso', '/home/u/.agents/skills/rn-iso']);
});

test('planSkillInstall reports create for a missing target', () => {
  const plan = planSkillInstall(['/a'], { exists: () => false, readVersion: () => null });
  expect(plan).toEqual([{ dir: '/a', action: 'create' }]);
});

test('planSkillInstall reports overwrite when a copy is already there', () => {
  const plan = planSkillInstall(['/a'], { exists: () => true, readVersion: () => '0.6.2' });
  expect(plan).toEqual([{ dir: '/a', action: 'overwrite', current: '0.6.2' }]);
});

// The installed copy is a plain file copy, so upgrading rn-iso leaves it
// untouched. Without a version stamped into it, nothing can tell an agent that
// the docs it is reading are four minors behind the binary it is driving.
test('the installed skill carries the version that produced it', () => {
  const stamped = stampSkillVersion('---\nname: rn-iso\n---\n\nbody\n', '0.14.0');
  expect(parseSkillVersion(stamped)).toBe('0.14.0');
  expect(stamped).toMatch(/^---\nname: rn-iso/);
});

test('re-stamping replaces the marker instead of stacking them', () => {
  const once = stampSkillVersion('body\n', '0.14.0');
  const twice = stampSkillVersion(once, '0.15.0');
  expect(parseSkillVersion(twice)).toBe('0.15.0');
  expect(twice.match(/rn-iso-skill-version/g).length).toBe(1);
});

test('an unstamped copy reads as unknown, not as current', () => {
  expect(parseSkillVersion('# rn-iso\n\nno marker here\n')).toBe(null);
});

// Both directions matter. A skill older than the CLI hides commands; a skill
// NEWER than the CLI is the npx-served-a-stale-binary case, where the docs
// describe commands the running binary does not have.
test('staleSkillCopies reports any disagreement with the running CLI', () => {
  const installed = [
    { file: '/a/SKILL.md', version: '0.10.0' },
    { file: '/b/SKILL.md', version: '0.14.0' },
    { file: '/c/SKILL.md', version: null },
  ];
  expect(staleSkillCopies(installed, '0.14.0').map(s => s.file)).toEqual(['/a/SKILL.md', '/c/SKILL.md']);
  expect(staleSkillCopies(installed, '0.6.2').map(s => s.file)).toEqual(['/a/SKILL.md', '/b/SKILL.md', '/c/SKILL.md']);
  expect(staleSkillCopies([], '0.14.0')).toEqual([]);
});

// `skill install` writes the SAME file into both targets, so an upgrade leaves
// two stale copies -- and the warning names neither of them. Printing it per
// copy said the identical sentence twice on every `start` (grep -c proved 2).
test('however many copies are stale, the warning is one line', () => {
  const installed = [
    { file: '/home/.claude/skills/rn-iso/SKILL.md', version: '0.10.0' },
    { file: '/home/.agents/skills/rn-iso/SKILL.md', version: '0.10.0' },
  ];
  const warning = staleSkillWarning(installed, '0.14.0');
  expect(typeof warning).toBe('string');
  expect(warning.split('\n').length).toBe(1);
  expect(warning).toMatch(/0\.10\.0/);
  expect(warning).toMatch(/0\.14\.0/);
  expect(warning).toMatch(/skill install/);
});

// Two copies stamped differently is a real fact about the machine, so both
// versions are named rather than collapsed into whichever came first.
test('copies stamped with different versions are all named, still on one line', () => {
  const warning = staleSkillWarning([
    { file: '/a/SKILL.md', version: '0.10.0' },
    { file: '/b/SKILL.md', version: null },
  ], '0.14.0');
  expect(warning.split('\n').length).toBe(1);
  expect(warning).toMatch(/0\.10\.0/);
  expect(warning).toMatch(/unstamped/);
});

test('nothing stale, and no version to compare against, are both silent', () => {
  expect(staleSkillWarning([{ file: '/a/SKILL.md', version: '0.14.0' }], '0.14.0')).toBe(null);
  expect(staleSkillWarning([], '0.14.0')).toBe(null);
  expect(staleSkillWarning([{ file: '/a/SKILL.md', version: '0.10.0' }], null)).toBe(null);
});
