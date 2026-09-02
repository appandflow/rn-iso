import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
import {
  SANDBOX_ALLOWANCE,
  applySandboxAllowance,
  claudeSettingsPaths,
  detectHarness,
  mergeSandboxAllowance,
  readClaudeSettings,
  sandboxAllowanceLines,
  sandboxAllowanceSatisfied,
} from '../sandbox.ts';

const FULL = {
  sandbox: {
    filesystem: { allowWrite: ['~/.stim'] },
    network: { allowMachLookup: ['com.apple.coresimulator.*'], allowLocalBinding: true },
  },
};

function project(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('the advertised patch is the three keys and values the guide prints', () => {
  expect(Object.keys(SANDBOX_ALLOWANCE)).toEqual([
    'sandbox.filesystem.allowWrite',
    'sandbox.network.allowMachLookup',
    'sandbox.network.allowLocalBinding',
  ]);
  expect(sandboxAllowanceLines()).toEqual([
    'sandbox.filesystem.allowWrite     ["~/.stim"]',
    'sandbox.network.allowMachLookup   ["com.apple.coresimulator.*"]',
    'sandbox.network.allowLocalBinding true',
  ]);
});

test('detectHarness reads Claude Code first, then Codex env, then the Codex config file', () => {
  const noCodexConfig = () => false;
  expect(detectHarness({ env: { CLAUDECODE: '1' }, home: '/home', exists: noCodexConfig })).toBe('claude');
  expect(detectHarness({ env: { CLAUDE_CODE_ENTRYPOINT: 'cli' }, home: '/home', exists: noCodexConfig })).toBe(
    'claude',
  );
  expect(detectHarness({ env: { CODEX_SANDBOX: 'seatbelt' }, home: '/home', exists: noCodexConfig })).toBe('codex');
  expect(detectHarness({ env: {}, home: '/home', exists: (p) => p === '/home/.codex/config.toml' })).toBe('codex');
  expect(detectHarness({ env: {}, home: '/home', exists: noCodexConfig })).toBe(null);
});

test('detectHarness ignores empty harness variables', () => {
  expect(detectHarness({ env: { CLAUDECODE: '  ', CODEX_HOME: '' }, home: '/home', exists: () => false })).toBe(null);
});

test('detectHarness prefers Claude Code when a Codex config file also exists', () => {
  expect(detectHarness({ env: { CLAUDECODE: '1' }, home: '/home', exists: () => true })).toBe('claude');
});

test('the allowance is satisfied by any of the settings files, and by value not by key', () => {
  expect(sandboxAllowanceSatisfied([FULL])).toBe(true);
  expect(sandboxAllowanceSatisfied([])).toBe(false);
  expect(
    sandboxAllowanceSatisfied([
      { sandbox: { filesystem: { allowWrite: ['~/.stim'] } } },
      { sandbox: { network: { allowMachLookup: ['com.apple.coresimulator.*'], allowLocalBinding: true } } },
    ]),
  ).toBe(true);

  // An array that exists without the entry Stim needs is not an allowance.
  expect(
    sandboxAllowanceSatisfied([
      {
        sandbox: {
          filesystem: { allowWrite: ['~/.other'] },
          network: { allowMachLookup: ['com.apple.coresimulator.*'], allowLocalBinding: true },
        },
      },
    ]),
  ).toBe(false);
  expect(
    sandboxAllowanceSatisfied([
      {
        ...FULL,
        sandbox: {
          ...FULL.sandbox,
          network: { allowMachLookup: ['com.apple.coresimulator.*'], allowLocalBinding: false },
        },
      },
    ]),
  ).toBe(false);
});

test('claudeSettingsPaths checks the local file, the committed file, and the user file', () => {
  expect(claudeSettingsPaths('/repo', '/home')).toEqual([
    '/repo/.claude/settings.local.json',
    '/repo/.claude/settings.json',
    '/home/.claude/settings.json',
  ]);
});

test('mergeSandboxAllowance creates the whole patch when the file is absent', () => {
  const merged = mergeSandboxAllowance(null);
  assert(merged.ok);
  expect(merged.changed).toBe(true);
  expect(JSON.parse(merged.content)).toEqual(FULL);
  expect(merged.content.endsWith('\n')).toBe(true);
  expect(merged.added).toHaveLength(3);
});

test('mergeSandboxAllowance treats an empty file as absent', () => {
  const merged = mergeSandboxAllowance('   \n');
  assert(merged.ok);
  expect(JSON.parse(merged.content)).toEqual(FULL);
});

test('mergeSandboxAllowance keeps unrelated keys, including a sibling sandbox key', () => {
  const merged = mergeSandboxAllowance(
    JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] },
      sandbox: { enabled: true, network: { allowUnixSockets: ['/tmp/x.sock'] } },
    }),
  );
  assert(merged.ok);
  const out = JSON.parse(merged.content);
  expect(out.permissions).toEqual({ allow: ['Bash(ls:*)'] });
  expect(out.sandbox.enabled).toBe(true);
  expect(out.sandbox.network.allowUnixSockets).toEqual(['/tmp/x.sock']);
  expect(out.sandbox.network.allowMachLookup).toEqual(['com.apple.coresimulator.*']);
  expect(out.sandbox.network.allowLocalBinding).toBe(true);
  expect(out.sandbox.filesystem.allowWrite).toEqual(['~/.stim']);
});

test('mergeSandboxAllowance appends to a partial allowance without duplicating', () => {
  const merged = mergeSandboxAllowance(
    JSON.stringify({
      sandbox: {
        filesystem: { allowWrite: ['~/.cache/other', '~/.stim'] },
        network: { allowMachLookup: ['com.example.other'] },
      },
    }),
  );
  assert(merged.ok);
  const out = JSON.parse(merged.content);
  expect(out.sandbox.filesystem.allowWrite).toEqual(['~/.cache/other', '~/.stim']);
  expect(out.sandbox.network.allowMachLookup).toEqual(['com.example.other', 'com.apple.coresimulator.*']);
  expect(out.sandbox.network.allowLocalBinding).toBe(true);
  expect(merged.added).toEqual(['sandbox.network.allowMachLookup', 'sandbox.network.allowLocalBinding']);
});

test('mergeSandboxAllowance is a no-op on a file that already carries the allowance', () => {
  const source = JSON.stringify(FULL, null, 2);
  const merged = mergeSandboxAllowance(source);
  assert(merged.ok);
  expect(merged.changed).toBe(false);
  expect(merged.added).toEqual([]);
  expect(JSON.parse(merged.content)).toEqual(FULL);
});

test('mergeSandboxAllowance refuses malformed JSON instead of overwriting it', () => {
  const merged = mergeSandboxAllowance('{ "sandbox": ');
  expect(merged.ok).toBe(false);
  assert(!merged.ok);
  expect(merged.reason).toMatch(/not valid JSON/);
});

test('mergeSandboxAllowance refuses a shape it would have to clobber', () => {
  for (const [source, pattern] of [
    ['[]', /not a JSON object/],
    ['"settings"', /not a JSON object/],
    [JSON.stringify({ sandbox: 'off' }), /sandbox is not an object/],
    [JSON.stringify({ sandbox: { filesystem: { allowWrite: '~/.stim' } } }), /allowWrite is not an array/],
    [JSON.stringify({ sandbox: { network: { allowLocalBinding: 'yes' } } }), /allowLocalBinding is not a boolean/],
  ] as const) {
    const merged = mergeSandboxAllowance(source);
    assert(!merged.ok);
    expect(merged.reason).toMatch(pattern);
  }
});

test('applySandboxAllowance writes only the personal file and leaves the committed one alone', () => {
  const root = project('stim-sandbox-apply-');
  try {
    mkdirSync(join(root, '.claude'), { recursive: true });
    const committed = join(root, '.claude', 'settings.json');
    writeFileSync(committed, JSON.stringify({ permissions: { allow: [] } }, null, 2));

    const fix = applySandboxAllowance({ projectRoot: root, harness: 'claude' });
    expect(fix.applied).toBe(true);
    expect(fix.path).toBe(join(root, '.claude', 'settings.local.json'));
    expect(fix.message).toMatch(/settings\.local\.json/);
    expect(JSON.parse(readFileSync(fix.path as string, 'utf-8'))).toEqual(FULL);
    expect(JSON.parse(readFileSync(committed, 'utf-8'))).toEqual({ permissions: { allow: [] } });

    const again = applySandboxAllowance({ projectRoot: root, harness: 'claude' });
    expect(again.applied).toBe(false);
    expect(again.message).toMatch(/already carries/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applySandboxAllowance creates the .claude directory when the project has none', () => {
  const root = project('stim-sandbox-create-');
  try {
    expect(existsSync(join(root, '.claude'))).toBe(false);
    const fix = applySandboxAllowance({ projectRoot: root, harness: 'claude' });
    expect(fix.applied).toBe(true);
    expect(JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf-8'))).toEqual(FULL);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applySandboxAllowance leaves a malformed personal file untouched', () => {
  const root = project('stim-sandbox-bad-');
  try {
    mkdirSync(join(root, '.claude'), { recursive: true });
    const local = join(root, '.claude', 'settings.local.json');
    writeFileSync(local, '{ oops');
    const fix = applySandboxAllowance({ projectRoot: root, harness: 'claude' });
    expect(fix.applied).toBe(false);
    expect(fix.message).toMatch(/Refusing to write/);
    expect(readFileSync(local, 'utf-8')).toBe('{ oops');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applySandboxAllowance refuses under Codex and explains the single enum', () => {
  const root = project('stim-sandbox-codex-');
  try {
    const fix = applySandboxAllowance({ projectRoot: root, harness: 'codex' });
    expect(fix.applied).toBe(false);
    expect(fix.path).toBe(null);
    expect(fix.message).toMatch(/sandbox_mode/);
    expect(fix.message).toMatch(/danger-full-access/);
    expect(existsSync(join(root, '.claude'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applySandboxAllowance reports nothing to apply with no harness', () => {
  const root = project('stim-sandbox-none-');
  try {
    const fix = applySandboxAllowance({ projectRoot: root, harness: null });
    expect(fix.applied).toBe(false);
    expect(fix.message).toMatch(/nothing to apply/);
    expect(existsSync(join(root, '.claude'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readClaudeSettings skips absent and unparseable files', () => {
  const root = project('stim-sandbox-read-');
  try {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.local.json'), '{ broken');
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(FULL));
    const parsed = readClaudeSettings(claudeSettingsPaths(root, join(root, 'nowhere')));
    expect(parsed).toEqual([FULL]);
    expect(sandboxAllowanceSatisfied(parsed)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
