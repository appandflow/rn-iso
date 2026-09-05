import assert from 'node:assert';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FINGERPRINT_IGNORES } from '../build-cache.ts';
import { OUTPUT_LABELS } from '../command-output.ts';
import TOPICS from '../guide/index.ts';
import {
  topicNames,
  renderTopic,
  renderIndex,
  renderSection,
  renderSectionIndex,
  sectionLookup,
  sectionNames,
} from '../commands/guide.ts';

function allBodies(): string[] {
  const bodies: string[] = [];
  for (const name of topicNames()) {
    const topic = renderTopic(name);
    assert(topic);
    bodies.push(topic);
    for (const section of sectionNames(name)) {
      const body = renderSection(name, section);
      assert(body);
      bodies.push(body);
    }
  }
  return bodies;
}

const NOT_A_REFUSAL_CODE = new Set(['STIM_HOME']);

function scrapedCodes(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/STIM_[A-Z_]+/g)].map((m) => m[0]).filter((code) => !NOT_A_REFUSAL_CODE.has(code)),
  );
}

const SUMMARY_ONLY_LABELS = ['app', 'compilation cache'];

test('every advertised topic renders non-empty content', () => {
  for (const name of topicNames()) {
    const body = renderTopic(name);
    const topic = TOPICS[name];
    assert(topic);
    const content = topic.body?.() ?? topic.preamble?.();
    assert(content?.trim());
    expect(body).toContain(content);
  }
});

test('every section of every sectioned topic renders its own content', () => {
  const sectioned = topicNames().filter((name) => sectionNames(name).length > 0);
  expect(sectioned.length).toBeGreaterThan(0);
  for (const name of sectioned) {
    for (const section of sectionNames(name)) {
      const body = renderSection(name, section);
      const content = TOPICS[name]?.sections?.[section]?.body();
      assert(content?.trim());
      expect(body).toContain(content);
    }
  }
});

test('the dev-menu section reads at the left margin, not in the payload table column', () => {
  const facts = renderSection('facts', 'devmenu');
  assert(facts);
  const indents = facts
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.length - line.trimStart().length);
  expect(Math.max(...indents)).toBeLessThanOrEqual(2);
});

test('an alias resolves to the same body as the section it spells', () => {
  for (const name of topicNames()) {
    const lookup = sectionLookup(name);
    for (const section of sectionNames(name)) {
      for (const alias of lookup[section]?.aliases ?? []) {
        expect(renderSection(name, alias)).toBe(renderSection(name, section));
      }
    }
  }
});

test('section and alias names are unique within a topic', () => {
  for (const name of topicNames()) {
    const spellings: string[] = [];
    for (const section of sectionNames(name)) {
      spellings.push(section);
      for (const alias of sectionLookup(name)[section]?.aliases ?? []) spellings.push(alias);
    }
    expect(new Set(spellings).size).toBe(spellings.length);
    expect(Object.keys(sectionLookup(name)).toSorted()).toEqual(spellings.toSorted());
  }
});

test('a section name that no topic declares renders nothing', () => {
  expect(renderSection('errors', 'stim_no_metro')).toBe(null);
  expect(renderSection('errors', 'nope')).toBe(null);
  expect(renderSection('logs', 'phone')).toBe(null);
});

test('a sectioned topic prints its preamble and an index of every section', () => {
  for (const name of topicNames().filter((topic) => sectionNames(topic).length > 0)) {
    const body = renderTopic(name);
    assert(body);
    expect(body).toContain('SECTIONS');
    for (const section of sectionNames(name)) {
      expect(body).toContain(section);
      for (const alias of sectionLookup(name)[section]?.aliases ?? []) expect(body).toContain(alias);
    }
    expect(body).toMatch(new RegExp(`Read one with: {2}stim guide ${name} `));
  }
});

test('an index row carries the word count of the section body it names', () => {
  const index = renderSectionIndex('errors');
  assert(index);
  const body = renderSection('errors', 'STIM_BUILD_WAIT_TIMEOUT');
  assert(body);
  const words = body.slice(body.indexOf('STIM_BUILD_WAIT_TIMEOUT')).trim().split(/\s+/).length;
  expect(index).toMatch(new RegExp(`STIM_BUILD_WAIT_TIMEOUT\\s+${words}w {2}`));
});

test('the errors index keeps the configured group separators and preambles', () => {
  const index = renderTopic('errors');
  const groups = Object.values(TOPICS.errors?.sections ?? {}).filter((section) => section.separator);
  expect(groups.length).toBeGreaterThan(0);
  for (const group of groups) {
    assert(group.separator);
    expect(index).toContain(group.separator);
  }
  for (const group of groups.filter((section) => section.context)) {
    assert(group.context);
    expect(index).toContain(group.context);
  }
});

test('a section renders its group preamble before its body', () => {
  const sections = Object.entries(TOPICS.errors?.sections ?? {}).filter(([, section]) => section.context);
  expect(sections.length).toBeGreaterThan(0);
  for (const [name, section] of sections) {
    const rendered = renderSection('errors', name);
    assert(rendered);
    assert(section.context);
    expect(rendered).toContain(`${section.context}\n\n${section.body()}`);
  }
});

test('the lifecycle topic grids every label the output vocabulary allows, and no others', () => {
  const body = renderSection('lifecycle', 'progress');
  assert(body);
  const start = body.indexOf('The labels are a closed set');
  expect(start).toBeGreaterThan(-1);
  const grid = body.slice(body.indexOf('column:', start) + 'column:'.length, body.indexOf('`app` and', start));
  expect(grid.trim().split(/\s+/).toSorted()).toEqual(
    OUTPUT_LABELS.filter((label) => label !== '' && !SUMMARY_ONLY_LABELS.includes(label)).toSorted(),
  );
});

test('an unknown topic renders nothing rather than throwing', () => {
  expect(renderTopic('nope')).toBe(null);
  expect(renderSection('nope', 'anything')).toBe(null);
  expect(renderSectionIndex('nope')).toBe(null);
});

test('an inherited property name is an unknown topic, not a prototype member', () => {
  for (const name of ['constructor', 'toString', '__proto__']) {
    expect(renderTopic(name)).toBe(null);
    expect(renderSection(name, 'anything')).toBe(null);
    expect(renderSectionIndex(name)).toBe(null);
  }
});

test('a whole topic offers no section index and no section body', () => {
  const whole = topicNames().filter((name) => sectionNames(name).length === 0);
  expect(whole.length).toBeGreaterThan(0);
  for (const name of whole) {
    expect(renderSectionIndex(name)).toBe(null);
    expect(renderSection(name, 'phone')).toBe(null);
    expect(Object.keys(sectionLookup(name))).toHaveLength(0);
  }
});

test('the index lists every topic and the running version', () => {
  const idx = renderIndex('9.9.9');
  expect(idx).toMatch(/stim 9\.9\.9/);
  for (const name of topicNames()) expect(idx).toMatch(new RegExp(name));
});

test('the errors topic documents every code the build commands and the iOS signing gate can emit', () => {
  const body = renderTopic('errors');
  assert(body);
  const commandFiles = [
    'ios.ts',
    'android.ts',
    'start.ts',
    'native-runtime.ts',
    'dev-client.ts',
    ...['ios', 'android'].flatMap((command) =>
      readdirSync(new URL(`../commands/${command}/`, import.meta.url))
        .filter((file) => file.endsWith('.ts'))
        .map((file) => `${command}/${file}`),
    ),
  ];
  const sources = [
    ...commandFiles.map((file) => readFileSync(new URL(`../commands/${file}`, import.meta.url), 'utf-8')),
    ...['engine/ios-profile.ts', 'engine/ios-signing.ts'].map((f) =>
      readFileSync(new URL(`../${f}`, import.meta.url), 'utf-8'),
    ),
  ].join('\n');
  const codes = scrapedCodes(sources);
  expect(codes.size).toBeGreaterThan(0);
  for (const code of codes) {
    expect(body).toContain(code);
    expect(sectionLookup('errors')[code]).toBeDefined();
  }
});

test('current guides expose warm and remove while leaving worktree creation to Git', () => {
  const body = allBodies().join('\n');
  expect(body).toContain('git worktree add');
  expect(body).toContain('stim worktree warm');
  expect(body).toContain('stim worktree remove');
  expect(body).not.toMatch(/worktree create|--carry-ignored|STIM_WORKTREE_BRANCH_EXISTS/);
  expect(body).not.toMatch(/worktreeDir|worktree\.baseRef|worktree\.include|\.worktreeinclude/);
  expect(sectionLookup('errors')['STIM_WORKTREE_BRANCH_EXISTS']).toBeUndefined();
});

test('the errors topic documents every code the engine can emit under a command', () => {
  const body = renderTopic('errors');
  assert(body);
  const sources = ['config.ts', 'engine/workspace-process-lock.ts', 'engine/build-slots.ts', 'engine/device-remote.ts']
    .map((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf-8'))
    .join('\n');
  const codes = new Set(
    [...sources.matchAll(/(?:code:\s*|\.code\s*=\s*)'(STIM_[A-Z_]+)'/g)].map((m) => m[1] as string),
  );
  expect(codes.size).toBeGreaterThan(0);
  for (const code of codes) {
    expect(body.includes(code)).toBeTruthy();
    expect(sectionLookup('errors')[code]).toBeDefined();
  }
});

test('the settings topic documents every supported setting key', () => {
  const body = renderTopic('settings');
  assert(body);
  const src = readFileSync(new URL('../settings.ts', import.meta.url), 'utf-8');
  const table = src.slice(src.indexOf('const SETTING_SHAPES'), src.indexOf('};', src.indexOf('const SETTING_SHAPES')));
  const known = [...table.matchAll(/^\s*'?([A-Za-z0-9.]+)'?: '[a-z]+',$/gm)]
    .map((match) => match[1])
    .filter((key): key is string => key !== undefined);
  expect(known.length).toBeGreaterThan(0);
  for (const key of known) {
    expect(body.includes(key)).toBeTruthy();
  }
});

test('the static skill is only the agent guide router', () => {
  const dir = fileURLToPath(new URL('../../skill/', import.meta.url));
  expect(readdirSync(dir).toSorted()).toEqual(['SKILL.md']);
  const skill = readFileSync(new URL('../../skill/SKILL.md', import.meta.url), 'utf-8');
  const wordCount = skill.split(/\s+/).filter(Boolean).length;
  expect(wordCount).toBeLessThanOrEqual(100);
  expect(skill.match(/stim guide agent/g)).toHaveLength(1);
  expect(skill).toMatch(/Follow the version-matched instructions it prints/);

  for (const mutableDetail of [
    'stim doctor',
    'worktree create',
    'STIM_NO_METRO',
    'gc --delete',
    '--force',
    'registry.npmjs.org',
    '20.19.4',
    'sandbox',
  ]) {
    expect(skill).not.toContain(mutableDetail);
  }
});

test('every guide topic explains the npx fallback for short stim commands', () => {
  for (const body of allBodies()) {
    expect(body).toMatch(/not installed globally[^.]*npx stim-cli/i);
  }
  expect(renderIndex('9.9.9')).toContain('stim guide <topic>');
  expect(renderIndex('9.9.9')).toMatch(/not installed globally[^.]*npx stim-cli/i);
});

test('the agent workflow checks errors before and after edits, before cleanup', () => {
  const agent = renderTopic('agent');
  assert(agent);
  const normalWorkflow = agent.match(/NORMAL WORKFLOW([\s\S]*?)RULES DURING THE LOOP/)?.[1];
  assert(normalWorkflow);
  expect(normalWorkflow.match(/stim logs --errors/g)).toHaveLength(2);
  expect(normalWorkflow.lastIndexOf('stim logs --errors')).toBeLessThan(normalWorkflow.lastIndexOf('stim stop'));
  expect(agent).toContain('stim guide lifecycle verification');
  expect(renderSection('lifecycle', 'verification')).toBeTruthy();
});

test('the agent guide routes to every detailed topic', () => {
  const agent = renderTopic('agent');
  assert(agent);
  for (const topicName of topicNames().filter((name) => name !== 'agent')) {
    expect(agent).toContain(`guide ${topicName}`);
  }
  expect(agent).toContain('stim guide errors <CODE>');
  for (const route of ['guide errors sandbox', 'guide facts devmenu', 'guide cleanup collector']) {
    expect(agent).toContain(route);
  }
});

test('the agent guide protects other workspaces device lease files', () => {
  const agent = renderTopic('agent');
  expect(agent).toMatch(/Never delete another\s+workspace's lease file/);
  expect(agent).toMatch(/gc --delete removes expired\s+ones/);
});

test('the agent and cleanup guides shut down owned simulators without an occupancy check', () => {
  const agent = renderTopic('agent');
  const cleanup = renderSection('cleanup', 'gc');
  assert(agent);
  assert(cleanup);

  expect(agent).toMatch(/explicit stop shuts down a Stim-owned simulator even when\s+another process uses it/i);
  expect(agent).toMatch(/never shuts down an unowned simulator/i);
  expect(cleanup).toMatch(/do not check simulator occupancy/i);
  expect(cleanup).toMatch(/never shuts down an unowned simulator/i);
  expect(agent).not.toContain('agent-device close --shutdown');
});

test('the guide names every path Stim ignores by default', () => {
  const lifecycle = renderSection('lifecycle', 'builds') ?? '';
  for (const path of DEFAULT_FINGERPRINT_IGNORES) {
    const bare = path.replace(/^\*\*\//, '').replace(/\/\*\*$/, '');
    expect(lifecycle).toContain(bare);
  }
});

test('the package exposes only the stim binary', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
  expect(packageJson.bin).toEqual({ stim: 'dist/cli.mjs' });
});

test('the reload payload guide distinguishes dispatch from observed completion', () => {
  expect(renderSection('facts', 'payloads')).toMatch(/reload request was sent[\s\S]*does not observe completion/);
});

test('warm guidance protects existing entries and tracked changes', () => {
  const options = renderSection('lifecycle', 'options');
  assert(options);
  expect(options).toMatch(/existing\s+ignored directory such as node_modules is skipped WHOLE/i);
  expect(options).toMatch(/dangling symlinks/);
  expect(options).toMatch(/does not copy tracked changes/);
});

test('temporary storage guidance names the override and Git visibility boundary', () => {
  const settings = renderTopic('settings');
  expect(settings).toContain('STIM_TMPDIR');
  expect(settings).toContain('tempDir');
  expect(settings).toMatch(/outside Git working trees/);
  expect(renderTopic('agent')).toContain('STIM_TMPDIR');
  expect(renderSection('lifecycle', 'options')).toContain('STIM_TMPDIR');
});
