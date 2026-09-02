import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { expect, test } from 'vitest';
import {
  applyClaudeAllowance,
  claudeLocalSettingsPath,
  detectHarness,
  missingAllowance,
  sandboxAllowance,
  sandboxFinding,
  withAllowance,
} from '../sandbox.ts';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'stim-sandbox-'));
}

test('detectHarness reads the variable each harness exports, and a codex config as a fallback', () => {
  const noHome = join(tmpdir(), 'stim-sandbox-absent');
  expect(detectHarness({ CLAUDECODE: '1' }, noHome)).toBe('claude-code');
  expect(detectHarness({ CLAUDE_CODE_ENTRYPOINT: 'cli' }, noHome)).toBe('claude-code');
  expect(detectHarness({ CODEX_COMPANION_SESSION_ID: 'x' }, noHome)).toBe('codex');
  expect(detectHarness({}, noHome)).toBe(null);

  const home = scratch();
  try {
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'config.toml'), 'sandbox_mode = "workspace-write"\n');
    expect(detectHarness({}, home)).toBe('codex');
    // A harness that announces itself wins over a config file left on disk.
    expect(detectHarness({ CLAUDECODE: '1' }, home)).toBe('claude-code');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('missingAllowance names only the parts no settings file supplies', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'settings.local.json');
    expect(missingAllowance([path])).toEqual([
      'sandbox.filesystem.allowWrite',
      'sandbox.network.allowMachLookup',
      'sandbox.network.allowLocalBinding',
    ]);

    writeFileSync(
      path,
      JSON.stringify({ sandbox: { filesystem: { allowWrite: ['~/.stim'] }, network: { allowLocalBinding: true } } }),
    );
    expect(missingAllowance([path])).toEqual(['sandbox.network.allowMachLookup']);

    // Any file in the list may supply any part.
    const other = join(dir, 'settings.json');
    writeFileSync(other, JSON.stringify({ sandbox: { network: { allowMachLookup: ['com.apple.coresimulator.*'] } } }));
    expect(missingAllowance([path, other])).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missingAllowance tolerates a settings file that is absent or unreadable', () => {
  const dir = scratch();
  try {
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ not json');
    expect(missingAllowance([join(dir, 'absent.json'), broken]).length).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missingAllowance honours a STIM_HOME that is not the default', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'settings.local.json');
    writeFileSync(path, JSON.stringify({ sandbox: { filesystem: { allowWrite: ['~/.stim'] } } }));
    // The default is covered, a relocated home is not.
    expect(missingAllowance([path], '~/.stim')).not.toContain('sandbox.filesystem.allowWrite');
    expect(missingAllowance([path], '/opt/stim-home')).toContain('sandbox.filesystem.allowWrite');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withAllowance keeps every setting it did not come for', () => {
  const before = {
    permissions: { allow: ['Bash(git *)'] },
    sandbox: {
      enabled: true,
      filesystem: { allowWrite: ['/already/here'], denyWrite: ['/secret'] },
      network: { allowedDomains: ['example.com'] },
    },
  };
  const after = withAllowance(before, sandboxAllowance());

  expect(after.permissions).toEqual({ allow: ['Bash(git *)'] });
  const sandbox = after.sandbox as {
    enabled: boolean;
    filesystem: { allowWrite: string[]; denyWrite: string[] };
    network: { allowedDomains: string[]; allowMachLookup: string[]; allowLocalBinding: boolean };
  };
  expect(sandbox.enabled).toBe(true);
  expect(sandbox.filesystem.denyWrite).toEqual(['/secret']);
  expect(sandbox.filesystem.allowWrite).toEqual(['/already/here', '~/.stim']);
  expect(sandbox.network.allowedDomains).toEqual(['example.com']);
  expect(sandbox.network.allowMachLookup).toEqual(['com.apple.coresimulator.*']);
  expect(sandbox.network.allowLocalBinding).toBe(true);
  // The input is not mutated.
  expect((before.sandbox.filesystem as { allowWrite: string[] }).allowWrite).toEqual(['/already/here']);
});

test('withAllowance is idempotent', () => {
  const once = withAllowance({}, sandboxAllowance());
  expect(withAllowance(once, sandboxAllowance())).toEqual(once);
});

test('applyClaudeAllowance writes the local settings file and leaves it valid JSON', () => {
  const root = scratch();
  try {
    const path = claudeLocalSettingsPath(root);
    expect(path.endsWith(join('.claude', 'settings.local.json'))).toBeTruthy();

    const first = applyClaudeAllowance(path, sandboxAllowance());
    expect(first.created).toBeTruthy();
    expect(missingAllowance([path])).toEqual([]);

    // A second run changes nothing and does not report a creation.
    const before = readFileSync(path, 'utf-8');
    expect(applyClaudeAllowance(path, sandboxAllowance()).created).toBeFalsy();
    expect(readFileSync(path, 'utf-8')).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sandboxFinding says nothing when no harness is present', () => {
  const dir = scratch();
  try {
    expect(sandboxFinding(dir, { env: {}, home: dir })).toBe(null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sandboxFinding points Claude Code at the one command that fixes it', () => {
  const dir = scratch();
  try {
    const f = sandboxFinding(dir, { env: { CLAUDECODE: '1' }, home: dir });
    expect(f?.level).toBe('cost');
    expect(f?.detail).toContain('sandbox.filesystem.allowWrite');
    expect(f?.fix).toContain('stim doctor --fix');
    expect(f?.fix).toContain(join('.claude', 'settings.local.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sandboxFinding goes quiet once the allowance is in place', () => {
  const dir = scratch();
  try {
    applyClaudeAllowance(claudeLocalSettingsPath(dir), sandboxAllowance());
    expect(sandboxFinding(dir, { env: { CLAUDECODE: '1' }, home: dir })).toBe(null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sandboxFinding offers Codex no patch, because it has no per-path allowance', () => {
  const dir = scratch();
  try {
    const f = sandboxFinding(dir, { env: { CODEX_COMPANION_SESSION_ID: 'x' }, home: dir });
    expect(f?.level).toBe('cost');
    expect(f?.detail).toContain('no per-path allowance');
    expect(f?.fix).not.toContain('doctor --fix');
    expect(f?.fix).toContain('danger-full-access');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
