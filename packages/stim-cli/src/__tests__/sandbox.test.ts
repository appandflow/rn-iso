import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { expect, test } from 'vitest';
import {
  allowanceSearchPaths,
  applyClaudeAllowance,
  claudeLocalSettingsPath,
  detectHarness,
  missingAllowance,
  sandboxAllowance,
  sandboxBlocksStimHome,
  sandboxFinding,
  unmergeableKey,
  withAllowance,
} from '../sandbox.ts';
import { applySandboxFix } from '../commands/doctor.ts';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'stim-sandbox-'));
}

test('detectHarness reads the variable each harness exports', () => {
  expect(detectHarness({ CLAUDECODE: '1' })).toBe('claude-code');
  expect(detectHarness({ CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe('claude-code');
  expect(detectHarness({ CODEX_SANDBOX: 'seatbelt' })).toBe('codex');
  expect(detectHarness({})).toBe(null);
  expect(detectHarness({ CLAUDECODE: '1', CODEX_SANDBOX: 'seatbelt' })).toBe('claude-code');
});

test('sandboxBlocksStimHome reports a directory it cannot write, and only that', () => {
  const dir = scratch();
  try {
    expect(sandboxBlocksStimHome(join(dir, 'stim-home'))).toBe(false);

    const locked = join(dir, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    expect(sandboxBlocksStimHome(join(locked, 'stim-home'))).toBe(process.getuid?.() !== 0);
    chmodSync(locked, 0o700);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

    const other = join(dir, 'settings.json');
    writeFileSync(other, JSON.stringify({ sandbox: { network: { allowMachLookup: ['com.apple.CoreSimulator.*'] } } }));
    expect(missingAllowance([path, other])).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missingAllowance accepts the ways a home path is written, including a parent', () => {
  const dir = scratch();
  const home = '/Users/example';
  const write = (value: unknown): string[] => {
    const path = join(dir, 'settings.local.json');
    writeFileSync(path, JSON.stringify({ sandbox: { filesystem: { allowWrite: [value] } } }));
    return missingAllowance([path], '~/.stim', home);
  };
  try {
    for (const value of ['~/.stim', '~/.stim/', '~/.stim/**', '$HOME/.stim', '/Users/example/.stim', '~']) {
      expect(write(value)).not.toContain('sandbox.filesystem.allowWrite');
    }
    expect(write('~/.stim-other')).toContain('sandbox.filesystem.allowWrite');
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
    expect(missingAllowance([path], '~/.stim')).not.toContain('sandbox.filesystem.allowWrite');
    expect(missingAllowance([path], '/opt/stim-home')).toContain('sandbox.filesystem.allowWrite');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unmergeableKey names a value the merge would have to discard', () => {
  expect(unmergeableKey({})).toBe(null);
  expect(unmergeableKey({ permissions: { allow: [] } })).toBe(null);
  expect(unmergeableKey({ sandbox: { enabled: true } })).toBe(null);
  expect(unmergeableKey({ sandbox: 'workspace-write' })).toBe('sandbox');
  expect(unmergeableKey({ sandbox: ['a'] })).toBe('sandbox');
  expect(unmergeableKey({ sandbox: { filesystem: 'all' } })).toBe('sandbox.filesystem');
  expect(unmergeableKey({ sandbox: { network: true } })).toBe('sandbox.network');
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

    expect(applyClaudeAllowance(path, sandboxAllowance()).status).toBe('created');
    expect(missingAllowance([path])).toEqual([]);

    const before = readFileSync(path, 'utf-8');
    expect(applyClaudeAllowance(path, sandboxAllowance()).status).toBe('updated');
    expect(readFileSync(path, 'utf-8')).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applyClaudeAllowance preserves settings it did not come for', () => {
  const root = scratch();
  try {
    const path = claudeLocalSettingsPath(root);
    mkdirSync(join(root, '.claude'));
    writeFileSync(path, JSON.stringify({ permissions: { allow: ['Bash(git *)'] }, sandbox: { enabled: true } }));

    expect(applyClaudeAllowance(path, sandboxAllowance()).status).toBe('updated');
    const after = JSON.parse(readFileSync(path, 'utf-8')) as {
      permissions: { allow: string[] };
      sandbox: { enabled: boolean };
    };
    expect(after.permissions.allow).toEqual(['Bash(git *)']);
    expect(after.sandbox.enabled).toBe(true);
    expect(missingAllowance([path])).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applyClaudeAllowance refuses a file it cannot read back, and writes nothing', () => {
  const root = scratch();
  try {
    const path = claudeLocalSettingsPath(root);
    mkdirSync(join(root, '.claude'));
    for (const contents of [
      '{ // a comment Claude Code accepts\n  "permissions": { "allow": ["Bash(git *)"] }\n}',
      '{ "permissions": { "allow": [] }, ',
      '["not an object"]',
      '"a string"',
    ]) {
      writeFileSync(path, contents);
      const result = applyClaudeAllowance(path, sandboxAllowance());
      expect(result.status).toBe('refused');
      expect(readFileSync(path, 'utf-8')).toBe(contents);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applyClaudeAllowance refuses a sandbox value it would have to discard', () => {
  const root = scratch();
  try {
    const path = claudeLocalSettingsPath(root);
    mkdirSync(join(root, '.claude'));
    const contents = JSON.stringify({ sandbox: 'workspace-write' });
    writeFileSync(path, contents);

    const result = applyClaudeAllowance(path, sandboxAllowance());
    expect(result.status).toBe('refused');
    expect(result.status === 'refused' && result.reason).toContain('sandbox');
    expect(readFileSync(path, 'utf-8')).toBe(contents);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applyClaudeAllowance leaves no temporary file behind', () => {
  const root = scratch();
  try {
    const path = claudeLocalSettingsPath(root);
    applyClaudeAllowance(path, sandboxAllowance());
    expect(readdirSync(join(root, '.claude'))).toEqual(['settings.local.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('allowanceSearchPaths covers the project and the user, project first', () => {
  const paths = allowanceSearchPaths('/repo', '/home/me');
  expect(paths).toEqual([
    join('/repo', '.claude', 'settings.local.json'),
    join('/repo', '.claude', 'settings.json'),
    join('/home/me', '.claude', 'settings.json'),
  ]);
});

test('sandboxFinding says nothing when no harness is present', () => {
  const dir = scratch();
  try {
    expect(sandboxFinding(dir, { env: {}, home: dir, blocked: true })).toBe(null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sandboxFinding says nothing when the harness is present but writes go through', () => {
  const dir = scratch();
  try {
    expect(sandboxFinding(dir, { env: { CLAUDECODE: '1' }, home: dir, blocked: false })).toBe(null);
    expect(sandboxFinding(dir, { env: { CODEX_SANDBOX: 'seatbelt' }, home: dir, blocked: false })).toBe(null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sandboxFinding points Claude Code at the one command that fixes it', () => {
  const dir = scratch();
  try {
    const f = sandboxFinding(dir, { env: { CLAUDECODE: '1' }, home: dir, blocked: true });
    expect(f?.level).toBe('cost');
    expect(f?.detail).toContain('sandbox.filesystem.allowWrite');
    expect(f?.fix).toContain('stim doctor --fix');
    expect(f?.fix).toContain(join('.claude', 'settings.local.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sandboxFinding asks for a restart once the allowance is written but not yet read', () => {
  const dir = scratch();
  try {
    applyClaudeAllowance(claudeLocalSettingsPath(dir), sandboxAllowance());
    const f = sandboxFinding(dir, { env: { CLAUDECODE: '1' }, home: dir, blocked: true });
    expect(f?.fix).toContain('Restart the session');
    expect(f?.title).toContain('has not picked it up');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sandboxFinding offers Codex no patch, because it has no per-path allowance', () => {
  const dir = scratch();
  try {
    const f = sandboxFinding(dir, { env: { CODEX_SANDBOX: 'seatbelt' }, home: dir, blocked: true });
    expect(f?.level).toBe('cost');
    expect(f?.detail).toContain('no per-path allowance');
    expect(f?.fix).not.toContain('doctor --fix');
    expect(f?.fix).toContain('danger-full-access');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function captureFix(root: string, env: NodeJS.ProcessEnv): { out: string; exitCode: number | undefined } {
  const lines: string[] = [];
  const realError = console.error;
  const realLog = console.log;
  const realExit = process.exitCode;
  process.exitCode = undefined;
  console.error = (...args: unknown[]): void => void lines.push(args.map(String).join(' '));
  console.log = (...args: unknown[]): void => void lines.push(`STDOUT:${args.map(String).join(' ')}`);
  try {
    applySandboxFix(root, env);
    return { out: lines.join('\n'), exitCode: process.exitCode };
  } finally {
    console.error = realError;
    console.log = realLog;
    process.exitCode = realExit;
  }
}

test('applySandboxFix writes the allowance, then reports it is already there', () => {
  const root = scratch();
  try {
    const env = { CLAUDECODE: '1', STIM_HOME: join(root, 'home') };
    const first = captureFix(root, env);
    expect(first.out).toContain('Wrote');
    expect(first.exitCode).toBe(undefined);
    expect(missingAllowance([claudeLocalSettingsPath(root)], env.STIM_HOME)).toEqual([]);

    const second = captureFix(root, env);
    expect(second.out).toContain('Nothing to apply');
    expect(second.exitCode).toBe(undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applySandboxFix refuses a settings file it cannot read back, and says nothing was written', () => {
  const root = scratch();
  try {
    const path = claudeLocalSettingsPath(root);
    mkdirSync(join(root, '.claude'));
    const contents = '{ // hand written\n "permissions": { "allow": ["Bash(git *)"] } }';
    writeFileSync(path, contents);

    const { out, exitCode } = captureFix(root, { CLAUDECODE: '1', STIM_HOME: join(root, 'home') });
    expect(out).toContain('Nothing was written');
    expect(exitCode).toBe(1);
    expect(readFileSync(path, 'utf-8')).toBe(contents);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applySandboxFix writes nothing under Codex, and nothing without a harness', () => {
  const root = scratch();
  try {
    const codex = captureFix(root, { CODEX_SANDBOX: 'seatbelt', STIM_HOME: join(root, 'home') });
    expect(codex.out).toContain('Nothing to apply under Codex');
    expect(codex.exitCode).toBe(1);

    const none = captureFix(root, { STIM_HOME: join(root, 'home') });
    expect(none.out).toContain('No sandboxing harness detected');
    expect(none.exitCode).toBe(undefined);

    expect(existsSync(claudeLocalSettingsPath(root))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applySandboxFix keeps its status off stdout, so --json stays parseable', () => {
  const root = scratch();
  try {
    const { out } = captureFix(root, { CLAUDECODE: '1', STIM_HOME: join(root, 'home') });
    expect(out).not.toContain('STDOUT:');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
