import assert from 'node:assert';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'node:url';
import { topicNames, renderTopic, renderIndex } from '../commands/guide.ts';
import { ANDROID_AVD_CONFIG_HELP } from '../settings.ts';

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
  expect(idx).toMatch(/stim 9\.9\.9/);
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
      'compilationCache',
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
    'start.ts': ['--json', '--wait', '--remote'],
    'ios.ts': ['--json', '--no-metro-check', '--no-build-cache', '--configuration', '--remote'],
    'android.ts': ['--json', '--no-metro-check', '--no-build-cache', '--variant', '--remote'],
    'stop.ts': ['--json', '--force'],
    'logs.ts': ['--errors', '--follow', '--since', '--grep', '--tail'],
    'gc.ts': ['--delete', '--older-than', '--cache'],
    'worktree.ts': ['--carry-ignored', '--base', '--label', '--force'],
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

test('the Metro guide documents explicit remote intent and the local default', () => {
  const body = renderTopic('metro');
  assert(body);
  expect(body).toMatch(/stim start --remote/);
  expect(body).toMatch(/plain `stim start`[^.]*local/i);
  expect(body).toMatch(/metro\.tunnel[^.]*provider/i);
});

test('the guide documents scoped iOS dev-client preapproval', () => {
  const facts = renderTopic('facts');
  assert(facts);
  expect(facts).toMatch(/preapproves[^.]*CoreSimulatorBridge[^.]*bundle id[^.]*scheme/i);
  expect(facts).toMatch(/unrelated schemes remain[^.]*unapproved/i);
  expect(facts).not.toMatch(/confirmation alert[^.]*every first launch/i);
});

test('the guide keeps Metro intent separate from the explicit device backend', () => {
  const lifecycle = renderTopic('lifecycle');
  const settings = renderTopic('settings');
  const errors = renderTopic('errors');
  assert(lifecycle);
  assert(settings);
  assert(errors);
  expect(lifecycle).toMatch(/ios\s+[^\n]*--remote <proxy\|eas>/);
  expect(lifecycle).toMatch(/android\s+[^\n]*--remote <proxy\|eas>/);
  expect(settings).toMatch(/ios\.remote[^\n]*"proxy" or "eas"/);
  expect(settings).toMatch(/android\.remote[^\n]*"proxy" or "eas"/);
  expect(errors).toContain('not a IncludeTreeRoot node kind');
  expect(errors).toContain('--cache "compilation cache"');
  expect(errors).not.toContain('--delete --all');
  expect(errors).toContain('STIM_REMOTE_PROXY_CONFIG');
  expect(errors).toContain('STIM_REMOTE_EAS_UNAVAILABLE');
});

test('the guide documents Android AVD disk-space diagnosis and cleanup', () => {
  const errors = renderTopic('errors');
  const cleanup = renderTopic('cleanup');
  assert(errors);
  assert(cleanup);

  for (const topic of [errors, cleanup]) {
    expect(topic).toMatch(/~\/\.android\/avd/);
    expect(topic).toMatch(/several GB/);
  }
  expect(errors).toMatch(/ENOSPC[^.]*disk space/i);
  expect(cleanup).toMatch(/worktree remove[^.]*deletes[^.]*owned AVD/i);
  expect(cleanup).toMatch(/neither loads nor saves[^.]*Quick\s+Boot snapshot/i);
  expect(cleanup).toMatch(/gc[^.]*on-disk size[^.]*orphaned[^.]*stale owned Android AVD/i);
});

test('the guide documents remote providers and backend credential boundaries', () => {
  const metro = renderTopic('metro');
  const settings = renderTopic('settings');
  assert(metro);
  assert(settings);

  expect(metro).toContain('stim ios --remote proxy');
  expect(metro).toContain('stim android --remote eas');
  expect(metro).toMatch(/AGENT_DEVICE_DAEMON_BASE_URL[\s\S]*AGENT_DEVICE_DAEMON_AUTH_TOKEN/);
  expect(metro).toMatch(/another machine/i);
  expect(metro).toMatch(/environment variables[^.]*never select the backend/i);
  expect(metro).toMatch(/EAS[^.]*eas-cli[^.]*access/i);
  expect(metro).toMatch(/EAS[^.]*billable/i);
  expect(metro).toMatch(/EAS[^.]*does not inherit[^.]*proxy credentials/i);
  expect(metro).toMatch(/stop[\s\S]*worktree remove[\s\S]*gc/);

  for (const provider of ['auto', 'expo', 'ngrok', 'cloudflared', 'off']) {
    expect(settings).toContain(`"${provider}"`);
  }
  expect(settings).toMatch(/Expo and bare React Native[\s\S]*authenticated[\s\S]*ngrok[\s\S]*cloudflared/i);
  expect(settings).toMatch(/auth[^.]*refus[^.]*cloudflared/i);
  expect(settings).toMatch(/metro\.ngrokUrl[^.]*stable[^.]*managed ngrok URL/i);
  expect(settings).toMatch(/metro\.ngrokUrl[\s\S]*requires metro\.tunnel\s+"ngrok"/i);
  expect(settings).toMatch(/metro\.publicUrl[\s\S]*before[^.]*Expo[^.]*start/i);
});

test('the cleanup guide documents fail-closed EAS orphan recovery', () => {
  const cleanup = renderTopic('cleanup');
  assert(cleanup);

  expect(cleanup).toMatch(/plain `stim gc`[^.]*dry run/i);
  expect(cleanup).toMatch(/gc --delete[\s\S]*active stim-\* EAS\s+sessions/i);
  expect(cleanup).toMatch(/workspace state[^.]*missing/i);
  for (const proof of ['project', 'name', 'platform', 'status']) {
    expect(cleanup).toMatch(new RegExp(`verified[^.]*${proof}`, 'i'));
  }
  expect(cleanup).toMatch(/registered root[^.]*missing[^.]*unreadable[^.]*fails closed/i);
  expect(cleanup).toMatch(/fixed[^.]*~\/\.stim\/machine\/eas[^.]*independent of STIM_HOME/i);
  expect(cleanup).toMatch(/unclaimed[^.]*never stopped/i);
  expect(cleanup).toMatch(/missing config\.json[^.]*does not authorize/i);
  expect(cleanup).toMatch(/exact recorded workspace state path/i);
  expect(cleanup).toMatch(/session is stopped[^.]*workspace record[^.]*kept[^.]*reconciliation/i);
  expect(cleanup).toMatch(/remote EAS session[^.]*running/i);
  expect(cleanup).toMatch(/local cleanup[^.]*continues/i);
  expect(cleanup).not.toMatch(/EAS session and local claim stay/i);
});

test('the cleanup guide documents that the shared Gradle build cache is report-only', () => {
  const cleanup = renderTopic('cleanup');
  assert(cleanup);

  expect(cleanup).toMatch(/Gradle build cache[\s\S]*report-only/i);
  expect(cleanup).toMatch(/never[^.]*prunes[^.]*empties/i);
});

test('the settings guide defines Metro overrides as parent roots and preserves legacy files', () => {
  const settings = renderTopic('settings');
  assert(settings);

  expect(settings).toMatch(/Metro value is a PARENT root/i);
  expect(settings).toMatch(/sanitized package name[^.]*appended/i);
  expect(settings).toMatch(/older package[^.]*current gc ignores[^.]*unmarked legacy parent/i);
  expect(settings).toMatch(/marked store[^.]*override parent[^.]*report-only/i);
  expect(settings).toMatch(/root-level legacy files remain[^.]*untouched/i);
});

test('the guide distinguishes local stop behavior from EAS session teardown', () => {
  const lifecycle = renderTopic('lifecycle');
  assert(lifecycle);

  expect(lifecycle).not.toMatch(/stop[^.]*destroys nothing/i);
  expect(lifecycle).toMatch(/local device[^.]*never deletes/i);
  expect(lifecycle).toMatch(/recorded EAS session[^.]*irreversibly ends/i);
});

test('no topic teaches a command this binary does not have', () => {
  const gone = [
    'stim up',
    'stim release',
    'stim shutdown',
    'stim device',
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
    expect(body).not.toMatch(/stim config (--repo|<key>|[a-z]+\.[a-z]+)/i);
  }
  expect(renderTopic('errors')).not.toMatch(/Installed Stim skill/);
  expect(renderTopic('settings')).toMatch(/no `stim config` command/);
});

test('the errors topic documents every code the build commands can emit', () => {
  const body = renderTopic('errors');
  assert(body);
  const sources = ['ios.ts', 'android.ts', 'start.ts']
    .map((f) => readFileSync(new URL(`../commands/${f}`, import.meta.url), 'utf-8'))
    .join('\n');
  const codes = new Set([...sources.matchAll(/STIM_[A-Z_]+/g)].map((m) => m[0]));
  expect(codes.size >= 8).toBeTruthy();
  for (const code of codes) {
    expect(body.includes(code)).toBeTruthy();
  }
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
  for (const expected of [
    'STIM_CONFIG_CORRUPT',
    'STIM_LOCK_REFUSED',
    'STIM_LOCK_TIMEOUT',
    'STIM_BUILD_SLOT_TIMEOUT',
    'STIM_REMOTE_PLATFORM_MISMATCH',
    'STIM_REMOTE_SESSION_STATE',
    'STIM_REMOTE_SESSION_CLEANUP',
  ]) {
    expect(codes.has(expected)).toBeTruthy();
  }
  for (const code of codes) {
    expect(body.includes(code)).toBeTruthy();
  }
});

test('the remote start remedy covers existing bare and Expo servers', () => {
  const body = renderTopic('errors');
  assert(body);
  const section = body.slice(body.indexOf('STIM_REMOTE_START_REQUIRED'), body.indexOf('STIM_BARE_DEPS'));
  expect(section).toContain('bare');
  expect(section).toContain('Expo');
});

test('the settings topic lists exactly the keys settings.js honours', () => {
  const body = renderTopic('settings');
  assert(body);
  const src = readFileSync(new URL('../settings.ts', import.meta.url), 'utf-8');
  const knownStart = src.indexOf('const KNOWN_SETTINGS');
  const knownEnd = src.indexOf(']);', knownStart);
  const knownSource = src.slice(knownStart, knownEnd);
  const known = [...knownSource.matchAll(/^\s*'([a-zA-Z.]+)',$/gm)]
    .map((m) => m[1])
    .filter((k): k is string => k !== undefined);
  expect(known.length > 0).toBeTruthy();
  for (const key of known) {
    expect(body.includes(key)).toBeTruthy();
  }
});

test('the safe Android AVD override contract is consistent across user guidance', () => {
  const guide = renderTopic('settings');
  assert(guide);
  const website = readFileSync(new URL('../../../../website/docs/settings.md', import.meta.url), 'utf-8');
  for (const body of [guide, website]) {
    expect(body).toMatch(/android\.avdConfigFile/);
    expect(body).toMatch(/android\.avdConfig/);
    expect(body).toMatch(/config\.ini/);
    expect(body).toMatch(/newly created|new owned/i);
    expect(body).toMatch(/existing.*never|never.*existing/i);
    expect(body).toMatch(/path|identity/i);
    expect(body).toMatch(/displayless Linux/i);
    expect(body).toMatch(/-noaudio/);
  }
  for (const line of ANDROID_AVD_CONFIG_HELP) expect(guide).toContain(line);
});

test('the Android data partition contract is consistent across user guidance', () => {
  const settings = renderTopic('settings');
  const cleanup = renderTopic('cleanup');
  assert(settings);
  assert(cleanup);
  for (const body of [settings, cleanup]) {
    expect(body).toMatch(/android\.dataPartitionSizeGb/i);
    expect(body).toMatch(/8 GiB[^.]*default|defaults to 8/i);
    expect(body).toMatch(/6 through 16384/i);
    expect(body).toMatch(/newly created|new owned/i);
    expect(body).toMatch(/never resized|does not shrink/i);
  }
});

test('the skill points at the guide command and the topics it advertises', () => {
  const skill = readFileSync(new URL('../../skill/SKILL.md', import.meta.url), 'utf-8');
  expect(skill).toMatch(/stim guide/);
  for (const name of topicNames()) {
    expect(skill.includes(`guide ${name}`)).toBeTruthy();
  }
});

test('the skill and guide explain the npx fallback for short stim commands', () => {
  const skill = readFileSync(new URL('../../skill/SKILL.md', import.meta.url), 'utf-8');
  expect(skill.match(/npx stim-cli <command>/g)).toHaveLength(1);
  expect(skill).toContain('npm install --global stim-cli');
  expect(skill).toMatch(/replace `stim` with the `npx` form above/i);

  for (const name of topicNames()) {
    const topic = renderTopic(name);
    assert(topic);
    expect(topic).toMatch(/not installed globally[^.]*npx stim-cli/i);
  }
  expect(renderIndex('9.9.9')).toContain('stim guide <topic>');
  expect(renderIndex('9.9.9')).toMatch(/not installed globally[^.]*npx stim-cli/i);
});

test('standalone package docs explain the npx fallback', () => {
  for (const path of ['../../../metro/README.md', '../../../expo-build-cache/README.md']) {
    const readme = readFileSync(new URL(path, import.meta.url), 'utf-8');
    expect(readme).toMatch(/not installed globally[^.]*npx stim-cli/i);
  }
});

test('website command tabs synchronize with Global as the default', () => {
  const tabs = readFileSync(new URL('../../../../website/src/components/StimTabs.tsx', import.meta.url), 'utf-8');
  expect(tabs).toContain("const groupId = 'stim-invocation'");
  expect(tabs).toContain('defaultValue="global"');
  expect(tabs).toContain("const npxPrefix = 'npx stim-cli'");
});

test('exactly one compact skill ships', () => {
  const dir = fileURLToPath(new URL('../../skill/', import.meta.url));
  expect(readdirSync(dir).toSorted()).toEqual(['SKILL.md']);
  const skill = readFileSync(new URL('../../skill/SKILL.md', import.meta.url), 'utf-8');
  const wordCount = skill.split(/\s+/).filter(Boolean).length;
  expect(wordCount).toBeLessThanOrEqual(1200);
  expect(skill).toMatch(/stim doctor/);
});

test('the skill shows the fast worktree path and owns app launch', () => {
  const skill = readFileSync(new URL('../../skill/SKILL.md', import.meta.url), 'utf-8');
  expect(skill).toContain('stim worktree create <name> --carry-ignored');
  expect(skill).toMatch(/`ios` and `android` install the app, launch it, and check its readiness/);
  expect(skill).not.toMatch(/agent-device/i);
});

test('the skill explains a clean human log result', () => {
  const skill = readFileSync(new URL('../../skill/SKILL.md', import.meta.url), 'utf-8');
  expect(skill).toMatch(/Exit code 0 from `logs --errors` is the pass condition/);
  expect(skill).toContain('No matching log records');
});

test('the skill keeps ordinary authorized cleanup on the fast path', () => {
  const skill = readFileSync(new URL('../../skill/SKILL.md', import.meta.url), 'utf-8');
  expect(skill).toMatch(/Ordinary `stim stop` and an authorized clean `stim worktree remove` do not need/);
  expect(skill).toMatch(/`gc`, `--force`, cleanup failures, or unfamiliar cleanup states/);
});

test('the skill and guide shut down owned simulators without an occupancy check', () => {
  const skill = readFileSync(new URL('../../skill/SKILL.md', import.meta.url), 'utf-8');
  const cleanup = renderTopic('cleanup');
  assert(cleanup);

  expect(skill).toMatch(/explicit `stop` shuts down a Stim-owned simulator even when[\s\S]*another process uses it/i);
  expect(skill).toMatch(/never shuts down an unowned simulator/i);
  expect(cleanup).toMatch(/do not check simulator occupancy/i);
  expect(cleanup).toMatch(/never shuts down an unowned simulator/i);
  expect(skill).not.toContain('agent-device close --shutdown');
});

test('the skill still carries the rules an agent must not have to look up', () => {
  const skill = readFileSync(new URL('../../skill/SKILL.md', import.meta.url), 'utf-8');
  for (const must of [
    'gc --delete',
    '--force',
    'STIM_NO_METRO',
    'booted',
    'stim-',
    'registry.npmjs.org',
    '20.19.4',
    'worktree remove',
  ]) {
    expect(skill.includes(must)).toBeTruthy();
  }
});

test('advanced contracts stay in guide topics instead of the skill', () => {
  const skill = readFileSync(new URL('../../skill/SKILL.md', import.meta.url), 'utf-8');
  const advanced = [
    ['AGENT_DEVICE_DAEMON_AUTH_TOKEN', 'metro'],
    ['metro.ngrokUrl', 'settings'],
    ['waitedForBuild', 'facts'],
    ['STIM_AT_CAPACITY', 'errors'],
    ['.fingerprintignore', 'lifecycle'],
    ['CoreSimulatorBridge', 'facts'],
    ['~/.android/avd', 'cleanup'],
    ['android.avdConfigFile', 'settings'],
    ['productionRelease', 'lifecycle'],
  ] as const;

  for (const [detail, topicName] of advanced) {
    const topic = renderTopic(topicName);
    assert(topic);
    expect(topic).toContain(detail);
    expect(skill).not.toContain(detail);
  }
});

test('the package exposes only the stim binary', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
  expect(packageJson.bin).toEqual({ stim: 'dist/cli.mjs' });

  const cli = readFileSync(new URL('../../bin/cli.ts', import.meta.url), 'utf-8');
  expect(cli).toContain(".name('stim')");
  expect(cli).not.toContain(".name('Stim')");
});

test('the binary command surface remains intentional', () => {
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
});

test('the guide documents the project cache provider as the tier between local and Expo', () => {
  const lifecycle = renderTopic('lifecycle');
  const settings = renderTopic('settings');
  assert(lifecycle);
  assert(settings);

  expect(lifecycle).toMatch(/THE BUILD CACHE HAS THREE LEVELS/);
  expect(lifecycle).toMatch(/2\. The project's own cache provider[\s\S]*bare React\s+Native/i);
  expect(lifecycle).toMatch(/3\. On an EXPO project only[\s\S]*Consulted only when levels one and two miss/i);
  expect(lifecycle).toMatch(/ONE note per\s+failure class/i);
  expect(lifecycle).toMatch(/gc[\s\S]*no delete\s+operation/i);
  expect(settings).toMatch(/cache\.provider[\s\S]*@stim-cli\/cache/);
  expect(settings).toMatch(/cache\.options[\s\S]*Keep secrets/);
  expect(settings).toMatch(/cache\.provider[\s\S]*EXECUTABLE CODE/);
  expect(settings).toMatch(/sharedCacheStores\(\)[\s\S]*stays local-only/);
  expect(lifecycle).toMatch(/--no-build-cache looks nothing up -- not the local cache, not either/);
});
