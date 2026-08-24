import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'fs';
import { join } from 'path';
import { skillTargets, bundledSkillPath, planSkillInstall } from '../src/commands/skill.js';

test('the bundled skill actually ships in the package', () => {
  assert.ok(existsSync(bundledSkillPath()), 'skill/SKILL.md must exist for `skill install` to work');
});

test('skillTargets covers both directories agents read', () => {
  const t = skillTargets('/home/u');
  assert.deepEqual(t, ['/home/u/.claude/skills/rn-iso', '/home/u/.agents/skills/rn-iso']);
});

test('planSkillInstall reports create for a missing target', () => {
  const plan = planSkillInstall(['/a'], { exists: () => false, readVersion: () => null });
  assert.deepEqual(plan, [{ dir: '/a', action: 'create' }]);
});

test('planSkillInstall reports overwrite when a copy is already there', () => {
  const plan = planSkillInstall(['/a'], { exists: () => true, readVersion: () => '0.6.2' });
  assert.deepEqual(plan, [{ dir: '/a', action: 'overwrite', current: '0.6.2' }]);
});
