import assert from 'node:assert';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FINGERPRINT_IGNORES } from '../build-cache.ts';
import { OUTPUT_LABELS } from '../command-output.ts';
import { topicNames, renderTopic, renderIndex } from '../commands/guide.ts';
import { carriedChangesLine, carryConflictWarning } from '../commands/worktree.ts';
import { ANDROID_AVD_CONFIG_HELP } from '../settings.ts';
import { CONSOLE_ENV, deviceConsoleArgs } from '../collector/ios-device.ts';
import { HEARTBEAT_INTERVAL_MS, heartbeatLine } from '../engine/xcode.ts';

test('every advertised topic renders non-empty content', () => {
  for (const name of topicNames()) {
    const body = renderTopic(name);
    expect(body && body.length > 100).toBeTruthy();
  }
});

test('the facts topic pins how an owned emulator gets its console port', () => {
  const body = renderTopic('facts');
  assert(body);
  expect(body).toMatch(/CHOSEN AND RECORDED under the global config lock\s+BEFORE the emulator starts/);
  expect(body).toMatch(/passed to it as `-port`/);
  expect(body).toMatch(/A boot that fails releases the port again and\s+keeps the AVD recorded for `gc`/);
});

test('shared-build recovery keeps waiters behind replacement builders with one deadline', () => {
  expect(renderTopic('agent')).toMatch(
    /one waiter takes over and the others keep waiting within the same\s+90-minute limit/,
  );
  expect(renderTopic('lifecycle')).toMatch(/other waiters keep waiting for that holder/);
  expect(renderTopic('lifecycle')).toMatch(/one ~90-minute deadline, including lock acquisition between waits/);
  expect(renderTopic('errors')).toMatch(/Replacement builders share that deadline, including time spent acquiring/);
});

test('the lifecycle topic separates an iOS install proof from dev-client preparation', () => {
  const body = renderTopic('lifecycle');
  assert(body);
  expect(body).toMatch(/install\s+unchanged \(stim-app already has this build\)/);
  expect(body).toMatch(/install\s+dev client prepared/);
  expect(body).toMatch(/slow simulator command is never charged\s+to an install that did not run/);
});

const SUMMARY_ONLY_LABELS = ['app', 'compilation cache'];

test('the lifecycle topic grids every label the output vocabulary allows, and no others', () => {
  const body = renderTopic('lifecycle');
  assert(body);
  const start = body.indexOf('The labels are a closed set');
  expect(start).toBeGreaterThan(-1);
  const grid = body.slice(body.indexOf('column:', start) + 'column:'.length, body.indexOf('`app` and', start));
  expect(
    grid
      .trim()
      .split('\n')
      .filter((line) => line.trim() !== ''),
  ).toHaveLength(7);
  expect(grid.trim().split(/\s+/).toSorted()).toEqual(
    OUTPUT_LABELS.filter((label) => label !== '' && !SUMMARY_ONLY_LABELS.includes(label)).toSorted(),
  );
  expect(body.slice(start)).toMatch(/`app` and `compilation cache` join them in the stdout block/);
});

test('the lifecycle topic shows the lifecycle commands in the same label column', () => {
  const body = renderTopic('lifecycle');
  assert(body);
  expect(body).toMatch(/branch\s+worktree-e2e-1 from HEAD \(9d0ebc4\)/);
  expect(body).toMatch(/carry\s+node_modules \(APFS clone\); no Pods; no native build output/);
  expect(body).toMatch(/ready\s+\/w\/worktree-e2e-1/);
  expect(body).toMatch(/metro\s+starting on port 8083 \(expo-child, supervisor pid 13724\)/);
  expect(body).toMatch(/stop\s+collector ios pid 45268/);
  expect(body).toMatch(/port\s+released 8084/);
});

test('the lifecycle topic documents slash-separated worktree names', () => {
  const body = renderTopic('lifecycle');
  assert(body);
  expect(body).toMatch(/worktree create app\/412/);
  expect(body).toMatch(/worktree-app\/412/);
  expect(body).toMatch(/flat \+ separated directory directly under worktreeDir/);
  expect(body).toMatch(/device labels include a stable hash/);
});

test('the errors topic names the two device fallbacks under the label that prints them', () => {
  const body = renderTopic('errors');
  assert(body);
  expect(body).toMatch(/both print a `cache` note and\s+build fresh/);
  expect(body).toMatch(/cache\s+a cached Release device app carries its builder's JS/);
  expect(body).not.toMatch(/^ *device app {2}/m);
  const src = readFileSync(new URL('../commands/ios.ts', import.meta.url), 'utf-8');
  expect(src.includes("'device app'")).toBe(false);
});

test('the errors topic quotes the stop refusals in the column stop actually prints', () => {
  const body = renderTopic('errors');
  assert(body);
  expect(body).toMatch(/"metro {7}refusing to kill port <n>/);
  expect(body).toMatch(/"stop {8}refusing to signal supervisor pid <n>/);
  expect(body).not.toMatch(/"metro: refusing/);
  expect(body).not.toMatch(/"supervisor: refusing/);
  const src = readFileSync(new URL('../commands/stop.ts', import.meta.url), 'utf-8');
  expect(src).toContain("phaseLine('metro', `refusing to kill port ${port}");
  expect(src).toContain("phaseLine('stop', `refusing to signal supervisor pid ${target.pid}");
});

test('the errors topic quotes the carry lines exactly as worktree create writes them', () => {
  const body = renderTopic('errors');
  assert(body);
  expect(body).toMatch(/"carry {7}carried 2 uncommitted changes from the source/);
  expect(body).toMatch(/"carry {7}could not carry the source's uncommitted changes/);
  expect(carriedChangesLine(['a', 'b'])).toMatch(/^carried 2 uncommitted changes from the source/);
  expect(carryConflictWarning(['a'])).toMatch(/^could not carry the source's uncommitted changes/);
});

test('the errors topic states that the stale-carry line only prints on a real difference', () => {
  const body = renderTopic('errors');
  assert(body);
  expect(body).toMatch(/carry\s+carried dependencies may be stale/);
  expect(body).toMatch(/a carry whose lockfile matches is\s+silent/);
});

test('the errors topic covers a directory that is not a React Native or Expo app', () => {
  const body = renderTopic('errors');
  assert(body);
  expect(body).toMatch(/whose nearest package.json does not\s+parse or depends on neither react-native nor expo/);
  expect(body).toMatch(/the refusal names that package.json and says which of the two it\s+is/);
  expect(body).toMatch(/`doctor` reports the same directory as a finding/);
  expect(body).toMatch(/These errors are caught before the port is reserved/);
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
      'installSkipped',
      'launched',
      'metroPort',
      'deviceType',
      'runtime',
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
      'installSkipped',
      'launched',
      'durationMs',
      'systemImage',
    ],
  };
  for (const [command, names] of Object.entries(fields)) {
    for (const f of names) {
      expect(body.includes(f)).toBeTruthy();
      expect(sources[command as keyof typeof sources].includes(f)).toBeTruthy();
    }
  }
});

test('the facts topic documents durationMs for both run commands', () => {
  const body = renderTopic('facts');
  assert(body);
  const ios = body.slice(body.indexOf('stim ios --json'), body.indexOf('stim android --json'));
  const android = body.slice(body.indexOf('stim android --json'), body.indexOf('ON FAILURE'));

  expect(ios).toMatch(/durationMs\s+wall time for the whole run/);
  expect(android).toMatch(/durationMs\s+wall time for the whole run/);
});

test('the facts topic says Android artifacts use the post-Gradle fingerprint', () => {
  const body = renderTopic('facts');
  assert(body);
  expect(body).toMatch(/Android also fingerprints after Gradle/);
  expect(body).toMatch(/stored only under that post-build hash/);
  expect(body).toMatch(/fingerprint and cacheKey are null/);
});

test('the guides document Android target-ABI builds and universal fallbacks', () => {
  expect(renderTopic('facts')).toMatch(/debug-sim-arm64-v8a/);
  expect(renderTopic('lifecycle')).toMatch(/-PreactNativeArchitectures=<target ABI>/);
  expect(renderTopic('lifecycle')).toMatch(/ABI-targeted Android Debug build skips this Expo\s+tier/);
  expect(renderTopic('agent')).toMatch(/Unknown targets and Release builds stay\s+universal/);
});

test('the one-line JSON sentence names every command whose --json payload is a single line', () => {
  const body = renderTopic('facts');
  assert(body);
  const singleLineJsonCommands = ['start', 'ios', 'android', 'reload', 'stop', 'status', 'stats', 'doctor'];
  const files: Record<string, string> = {
    start: 'start.ts',
    ios: 'ios.ts',
    android: 'android.ts',
    reload: 'reload.ts',
    stop: 'stop.ts',
    status: 'status.ts',
    stats: 'stats.ts',
    doctor: 'doctor.ts',
    device: 'device.ts',
  };
  for (const [, file] of Object.entries(files)) {
    const src = readFileSync(new URL(`../commands/${file}`, import.meta.url), 'utf-8');
    expect(src).toMatch(/--json/);
    expect(src).not.toMatch(/JSON\.stringify\([^)]*,\s*null\s*,\s*2\s*\)/);
    expect(src).not.toMatch(/JSON\.stringify\(\s*\n/);
  }
  for (const command of singleLineJsonCommands) expect(body.includes(`\`${command}\``)).toBeTruthy();
  expect(body).toMatch(/device lock.*device unlock/s);
  expect(body).toMatch(/exactly ONE line of JSON/);
  expect(body).toMatch(/logs --json[^.]*NDJSON/);
});

test('the flags the guide advertises are the flags the commands define', () => {
  const lifecycle = renderTopic('lifecycle');
  assert(lifecycle);
  const advertised = {
    'start.ts': ['--json', '--wait', '--remote'],
    'ios.ts': [
      '--json',
      '--no-metro-check',
      '--no-build-cache',
      '--configuration',
      '--device-type',
      '--runtime',
      '--device',
      '--remote',
    ],
    'android.ts': [
      '--json',
      '--no-metro-check',
      '--no-build-cache',
      '--variant',
      '--system-image',
      '--device',
      '--remote',
    ],
    'reload.ts': ['--json'],
    'stop.ts': ['--json', '--force'],
    'logs.ts': ['--errors', '--follow', '--since', '--grep', '--tail'],
    'gc.ts': ['--delete', '--older-than', '--cache'],
    'worktree.ts': ['--carry-ignored', '--base', '--dir', '--label', '--force'],
    'doctor.ts': ['--json', '--fix', '--platform'],
  };
  expect(/doctor\s+--json --fix --platform <ios\|android>/.test(lifecycle)).toBeTruthy();

  const retired: Record<string, string[]> = { 'gc.ts': ['--all'] };
  for (const [file, flags] of Object.entries(retired)) {
    const src = readFileSync(new URL(`../commands/${file}`, import.meta.url), 'utf-8');
    for (const flag of flags) {
      const mention = new RegExp(`${flag}(?![\\w-])`);
      expect(mention.test(src)).toBeFalsy();
      for (const name of topicNames()) expect(mention.test(renderTopic(name) ?? '')).toBeFalsy();
    }
  }
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

test('the guide documents the identical-artifact skip and its fail-closed rule', () => {
  const lifecycle = renderTopic('lifecycle');
  assert(lifecycle);
  expect(lifecycle).toMatch(/pm path/);
  expect(lifecycle).toMatch(/sha256sum/);
  expect(lifecycle).toMatch(/simctl get_app_container/);
  expect(lifecycle).toMatch(/cannot determine[^.]*installs exactly as it always did/i);
  expect(lifecycle).toMatch(/release[\s\S]*COPY of the artifact[\s\S]*always installed/i);
  expect(lifecycle).toMatch(/installSkipped/);
});

test('the guide says what a verified launch does not prove, in the words the commands print', () => {
  const facts = renderTopic('facts');
  assert(facts);
  expect(facts).toMatch(/IT IS NOT A PAINTED SCREEN/);
  expect(facts).toMatch(/first screen may still be\s+rendering/);
  expect(facts).toMatch(/Poll the UI before you trust a\s+screenshot/);
  for (const command of ['ios', 'android']) {
    const src = readFileSync(new URL(`../commands/${command}.ts`, import.meta.url), 'utf-8');
    expect(src.includes('the first screen may still be rendering')).toBeTruthy();
    expect(src.includes('ready: bundle loaded')).toBeFalsy();
  }
});

test('the guide documents the one launch error a verified run drops', () => {
  const logs = renderTopic('logs');
  assert(logs);
  expect(logs).toMatch(/TCP Conn \.\.\. Failed :\s+error 0:61 \[61\]/);
  expect(logs).toMatch(/ECONNREFUSED/);
  expect(logs).toMatch(/A refusal before the\s+launch verifies still prints/);
  const src = readFileSync(new URL('../engine/app-install.ts', import.meta.url), 'utf-8');
  expect(src.includes('error 0:61')).toBeTruthy();
});

test('the guide documents the progress cadence the heartbeat actually uses', () => {
  const lifecycle = renderTopic('lifecycle');
  assert(lifecycle);
  expect(HEARTBEAT_INTERVAL_MS).toBe(30_000);
  expect(lifecycle).toMatch(/PROGRESS ON A LONG RUN/);
  expect(lifecycle).toMatch(/every 30 seconds, on the 30-second\s+grid/);
  expect(lifecycle).toMatch(/build {7}still compiling \(1m00s of ~3m10s\)/);
  expect(lifecycle).toMatch(/build {7}still compiling \(4m00s, usually ~3m10s\)/);
  expect(lifecycle).toMatch(/build {7}still compiling \(1m00s\)/);
  expect(lifecycle).toMatch(/pods {8}still installing \(1m30s of ~1m40s\)/);
  expect(lifecycle).not.toMatch(/still (?:compiling|running|installing) \([^)]*\):/);
  expect(heartbeatLine(60_000, 'build', 190_000)).toBe('  build       still compiling (1m00s of ~3m10s)');
  expect(heartbeatLine(240_000, 'build', 190_000)).toBe('  build       still compiling (4m00s, usually ~3m10s)');
  expect(heartbeatLine(60_000, 'build')).toBe('  build       still compiling (1m00s)');
  expect(heartbeatLine(90_000, 'pods', 100_000)).toBe('  pods        still installing (1m30s of ~1m40s)');
  expect(lifecycle).toMatch(/GAP BETWEEN HEARTBEATS IS NOT A HANG/);
  expect(lifecycle).toMatch(/device\s+stim-app-412 \(BF2A\.\.\) created \(2m14s\)/);
  for (const command of ['ios', 'android']) {
    const src = readFileSync(new URL(`../commands/${command}.ts`, import.meta.url), 'utf-8');
    expect(src.includes('SLOW_STEP_MS')).toBeTruthy();
  }
});

test('the guide states once where the heartbeat estimate comes from', () => {
  const facts = renderTopic('facts');
  assert(facts);
  expect(facts).toMatch(/lastColdBuildMs/);
  expect(facts).toMatch(/lastPodsMs/);
  expect(facts).toMatch(/THAT IS\s+WHERE THE HEARTBEAT ESTIMATE COMES FROM/);
  expect(facts).toMatch(/THIS PROJECT'S LAST COLD BUILD/);
  expect(facts).toMatch(/never a mean/);
  expect(facts).toMatch(/read takes no lock/);
  expect(facts).toMatch(/build {7}still compiling \(1m00s of ~3m10s\)/);
  const lifecycle = renderTopic('lifecycle');
  assert(lifecycle);
  expect(lifecycle).toMatch(/`guide facts` says where the\s+number comes from/);
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

test('the cleanup guide documents the collector ownership proof and its upgrade window', () => {
  const cleanup = renderTopic('cleanup');
  assert(cleanup);

  expect(cleanup).toMatch(/before signalling a recorded collector pid/i);
  expect(cleanup).toMatch(/stop[\s\S]*gc --delete[\s\S]*worktree remove[\s\S]*live command/i);
  expect(cleanup).toMatch(/cannot be proven[^.]*reported and left alone/i);
  expect(cleanup).toMatch(/kernel reuses pids/i);
  expect(cleanup).toMatch(/older Stim[^.]*no root[^.]*reports as\s+unverified/i);
  expect(cleanup).toMatch(/record clears[\s\S]*log\s+stream ends[^.]*unregisters itself/i);
  expect(cleanup).toMatch(/next\s+`ios` \/ `android` run overwrites the record with its own/i);
  expect(cleanup).toMatch(/the old process itself keeps running until it exits on its own/i);
  expect(cleanup).toMatch(/a fresh `ios` \/ `android`\s+run[^.]*starts its replacement anyway/i);
});

test('the cleanup guide documents the keep-and-retry split for a live, unverified collector pid', () => {
  const cleanup = renderTopic('cleanup');
  assert(cleanup);

  expect(cleanup).toMatch(/weigh an unproven live\s+pid against the record's own startedAt claim/i);
  expect(cleanup).toMatch(/started AFTER that\s+claim[^.]*recycled the number[^.]*genuinely stale[^.]*dropped/i);
  expect(cleanup).toMatch(
    /started at or\s+before that claim[^.]*may still be the collector[^.]*kept and reported for a retry/i,
  );
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
  const gone = ['stim up', 'stim release', 'stim shutdown', 'build-cache resolve', '--wait-metro', '--serial'];
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

test('the guide states the physical-iPhone device-log losses, and states them as losses', () => {
  const logs = renderTopic('logs');
  const cleanup = renderTopic('cleanup');
  assert(logs);
  assert(cleanup);

  expect(logs).toContain('devicectl device process launch --console');
  for (const [key, value] of Object.entries(CONSOLE_ENV)) {
    expect(logs).toContain(key);
    expect(deviceConsoleArgs({ udid: 'U', bundleId: 'b' }).join(' ')).toContain(`"${key}":"${value}"`);
  }
  expect(logs).toMatch(/subsystem LOST/);
  expect(logs).toMatch(/level {5}LOST/);
  expect(logs).toMatch(/category {2}KEPT/);
  expect(logs).toMatch(/Must be root to collect logs from attached device/);
  expect(logs).toMatch(/libimobiledevice or pymobiledevice3[\s\S]*does not require/);
  expect(logs).toMatch(/--source device --errors[\s\S]*crash and refusal lines only/);
  expect(logs).toContain('appandflow/stim#179');

  expect(cleanup).toMatch(/on\s+hardware the collector IS the launch/);
  expect(cleanup).toMatch(/proven and replaced by the same pid rules/);
  expect(cleanup).toMatch(/Unplugging the phone[\s\S]*collector_stopped/);
  expect(cleanup).not.toMatch(/not started yet/);
  expect(logs).toMatch(/lines that OPEN with a marker[\s\S]*anchored[\s\S]*app logging ABOUT a crash stays\s+info/);
  expect(logs).toMatch(/only on a line with no mirror\s+prefix/);
  expect(cleanup).toMatch(
    /unverified until someone pulls a cable[\s\S]*collector_stopped, a non-zero one is\s+collector_failed/,
  );

  const lifecycle = renderTopic('lifecycle');
  assert(lifecycle);
  expect(lifecycle).toMatch(/THE DEVICE LOG COLLECTOR IS THE LAUNCH/);
  expect(lifecycle).toContain('appandflow/stim#179');
});

test('the guide teaches the device install and launch that #178 phases 3 and 5 wired', () => {
  const lifecycle = renderTopic('lifecycle');
  const errors = renderTopic('errors');
  assert(lifecycle);
  assert(errors);

  expect(lifecycle).not.toMatch(/IT IS NOT FINISHED/);
  expect(lifecycle).not.toMatch(/REFUSES with\s+STIM_BAD_ARG/);
  expect(lifecycle).toMatch(/devicectl device install app/);
  expect(lifecycle).toMatch(/--payload-url/);
  expect(lifecycle).toMatch(/STORE, THEN COPY, THEN\s+MUTATE/);
  expect(lifecycle).toMatch(/never consults the compiled RCT_METRO_PORT/);
  expect(lifecycle).toMatch(/NO INSTALL SKIP ON A PHONE/);
  expect(lifecycle).toMatch(/device pid means nothing to the host/);

  expect(errors).not.toMatch(/ONE EXCEPTION, and it is temporary/);
  expect(errors).toMatch(/STIM_NO_LAN_ADDRESS[\s\S]*Deliberately NOT "set metro\.publicUrl"/);
  expect(errors).toMatch(/STIM_LAN_METRO_UNREACHABLE[\s\S]*ios\.lanHost/);
  expect(errors).toMatch(
    /STIM_LAN_METRO_UNREACHABLE[\s\S]*routes a host connection to its own address over\s+loopback/,
  );
  expect(errors).toMatch(/FBSOpenApplicationErrorDomain 3/);
  expect(errors).toMatch(/VPN & Device Management/);
  expect(errors).toMatch(/devicectl device uninstall app[\s\S]*data went with it/);
  expect(errors).toMatch(/THE DEVICE FALLBACKS[\s\S]*building fresh instead/);
  expect(errors).toMatch(/FRESHLY BUILT app is a code/);
  expect(errors).toMatch(/an uninstall clears it, including the one Stim's own\s+signer-conflict retry performs/);
});

// devicectl keeps the app attached to the process that launched it, so the
// collector holding it is a fact about `stop`, not only about logs.
test('the guide says a phone loses its running app when the collector ends', () => {
  const cleanup = renderTopic('cleanup');
  const lifecycle = renderTopic('lifecycle');
  assert(cleanup);
  assert(lifecycle);

  expect(cleanup).toMatch(/THE APP'S LIFETIME IS BOUND TO THAT COLLECTOR/);
  expect(cleanup).toMatch(/anything that\s+ends the collector ends the APP ON THE PHONE/);
  expect(cleanup).toMatch(/leaves no RECORD of the\s+phone -- it never had one -- but it does close the app/);
  expect(cleanup).toMatch(/Nothing is uninstalled/);
  expect(lifecycle).toMatch(/THE APP RUNS FOR AS LONG AS THE COLLECTOR DOES/);
  expect(lifecycle).toMatch(/stays INSTALLED/);
});

test('the guide matches the Local Network path reason alone, not any errno-50 block', () => {
  const errors = renderTopic('errors');
  assert(errors);

  expect(errors).toMatch(/LAUNCH UNVERIFIED, LOCAL NETWORK NOT GRANTED/);
  expect(errors).toContain('_NSURLErrorNWPathKey=unsatisfied (Local network prohibited)');
  expect(errors).toMatch(/THAT REASON IS THE WHOLE MATCH/);
  expect(errors).toContain('unsatisfied (No network route)');
  expect(errors).toContain('unsatisfied (Denied over cellular interface)');
  expect(errors).toMatch(/would drop the same-SSID check that is the actual fix/);
  expect(errors).toMatch(/THE PROMPT AND A PRIOR DENIAL READ THE SAME[\s\S]*persists across upgrade\s+installs/);
  expect(errors).toMatch(/if the first `alert get` finds no alert,\s+it was denied earlier/i);
  expect(errors).toMatch(/It is NOT origin-scoped[\s\S]*carries no URL/);
  expect(errors).toMatch(/no record's\s+level changes[\s\S]*stays out of `logs --errors`/);
});

test('the guide gives the Local Network recovery commands and the taps that have no API', () => {
  const errors = renderTopic('errors');
  const facts = renderTopic('facts');
  assert(errors);
  assert(facts);

  for (const command of [
    'agent-device alert get --platform ios --udid <udid>',
    'agent-device alert accept --platform ios --udid <udid>',
    'agent-device snapshot -i --platform ios --udid <udid>',
    `agent-device press 'label="Reload"' --platform ios --udid <udid>`,
  ]) {
    expect(errors).toContain(command);
  }
  expect(errors).toMatch(/THE GRANT ALONE IS NOT ENOUGH[\s\S]*does not\s+retry/);
  expect(errors).toContain(`agent-device press 'label="Close"'`);
  expect(errors).toMatch(
    /Stim's own launch\s+ends in `-- -EXDevMenuShowsAtLaunch 0 -EXDevMenuShowFloatingActionButton 0`/,
  );
  expect(errors).toMatch(/the Expo dev menu is not over the app, fresh install or not/);
  expect(errors).toMatch(/An app started\s+ANOTHER way does not carry those arguments/);
  expect(errors).toMatch(/A BARE APP \(no expo-dev-client\)[\s\S]*Could not connect to development server/);
  expect(errors).toMatch(/reads that reason alone and knows nothing about dev\s+clients/);
  expect(errors).toMatch(/neither that text nor the button's accessibility label has been read\s+off hardware/);
  expect(errors).toMatch(/`agent-device metro reload` does NOT recover either screen/);
  expect(errors).toMatch(/never connected/);
  expect(errors).toMatch(/WHAT HAS ACTUALLY RUN[\s\S]*bare path has NOT been exercised on hardware/);
  expect(errors).toMatch(/--terminate-existing[\s\S]*replaces the process the collector follows/);
  expect(errors).toMatch(/`stim logs --source device` stops for the rest of that run/);
  expect(errors).toMatch(/THE OTHER ONE-TIME TAP HAS NO API[\s\S]*agent-device's own runner included/);
  expect(errors).toMatch(/its remedy is\s+"ask the user"/);

  expect(facts).toMatch(/The phone's unverified remedy is also ROUTED, not a fixed/);
  expect(facts).toMatch(/the grant\s+alone does not reload the dev client/);
  expect(facts).toMatch(/Routing changes no record's level/);
  expect(facts).toMatch(/developer trust, has no API at all and is always the user's/);
});

test('the guide scopes each platform dev-menu suppression mechanism accurately', () => {
  const facts = renderTopic('facts');
  assert(facts);

  expect(facts).toMatch(/EVERY DEV-CLIENT DEEP LINK CARRIES disableOnboarding=1\s+INSIDE ITS PROJECT URL/);
  expect(facts).toContain('?url=http%3A%2F%2Fhost%3Aport%2F%3FdisableOnboarding%3D1&disableFab=1');
  expect(facts).toMatch(/ON iOS it has to sit on the\s+PROJECT url/);
  expect(facts).toMatch(/on the\s+outer deep link it does nothing there\. Android reads it on\s+either/);
  expect(facts).toMatch(
    /ON LOCAL ANDROID the same deep link also carries the\s+`EXDevMenuDisableAutoLaunch` boolean intent extra/,
  );
  expect(facts).toContain("-d '<devClientUrl>'\n                  --ez EXDevMenuDisableAutoLaunch true");
  expect(facts).toMatch(/set EXDevMenuShowsAtLaunch=false and\s+EXDevMenuIsOnboardingFinished=true/);
  expect(facts).toMatch(/does NOT set expo-dev-menu's\s+showFab preference/);
  expect(facts).toMatch(/Remote Android opens only the URL, so that intent-extra\s+suppression does not apply there/);
  expect(facts).toMatch(/outer `disableFab=1`\s+query parameter/);
  expect(facts).toContain('expo/expo#49651');
  expect(facts).toMatch(/Stim does\s+not rewrite expo-dev-menu's private SharedPreferences XML/);
  expect(facts).toMatch(/ON A SIMULATOR, before a local dev-client openurl, Stim\s+preapproves/);
  expect(facts).toMatch(/those together are what keep the menu and its\s+button off a simulator entirely/);
  expect(facts).toContain('EXDevMenuShowFloatingActionButton=false');
  expect(facts).toMatch(/ON A PHONE NONE OF THAT PREAPPROVAL APPLIES/);
  expect(facts).toMatch(/devicectl has\s+no defaults command/);
  expect(facts).toMatch(/cfprefsd serves its cached domain and rewrites\s+the file/);
  expect(facts).toMatch(/THE FLAG ALONE DOES NOT COVER A PHONE/);
  expect(facts).toMatch(/EXDevMenuShowsAtLaunch defaults to TRUE on iOS/);
  expect(facts).toMatch(/`showsAtLaunch \|\|\s+shouldShowOnboarding\(\)`/);
  expect(facts).toMatch(/THE LAUNCH ARGUMENTS COVER THE REST/);
  expect(facts).toContain('-EXDevMenuShowsAtLaunch 0');
  expect(facts).toContain('-EXDevMenuShowFloatingActionButton 0');
  expect(facts).toMatch(/devicectl passes\s+everything after `--` to the app/);
  expect(facts).toMatch(/reads\s+the argument domain AHEAD of the persisted one/);
  expect(facts).toMatch(/a fresh install comes up on the\s+app, not on the menu, and with no floating button/);
  expect(facts).toMatch(/THE FAB IS REAL ON A PHONE, and a screenshot is the only\s+way to see it/);
  expect(facts).toMatch(/no accessibility label after the fade, so\s+`agent-device snapshot -i` stops listing it/);
  expect(facts).toMatch(/the corner is clean at 4s and at 12s/);
  expect(facts).toMatch(/an app started ANOTHER way -- a home-screen\s+tap/);
  expect(facts).toContain(`agent-device press 'label="Close"'`);
  expect(facts).toMatch(/survive an\s+UPGRADE install/);
});

test('the errors topic documents every code the build commands and the iOS signing gate can emit', () => {
  const body = renderTopic('errors');
  assert(body);
  const sources = [
    ...['ios.ts', 'android.ts', 'start.ts'].map((f) =>
      readFileSync(new URL(`../commands/${f}`, import.meta.url), 'utf-8'),
    ),
    ...['engine/ios-profile.ts', 'engine/ios-signing.ts'].map((f) =>
      readFileSync(new URL(`../${f}`, import.meta.url), 'utf-8'),
    ),
  ].join('\n');
  const codes = new Set([...sources.matchAll(/STIM_[A-Z_]+/g)].map((m) => m[0]));
  expect(codes.size >= 8).toBeTruthy();
  for (const code of codes) {
    expect(body.includes(code)).toBeTruthy();
  }
});

test('the errors topic documents every code worktree create can emit, and the rules behind it', () => {
  const body = renderTopic('errors');
  assert(body);
  const src = readFileSync(new URL('../commands/worktree.ts', import.meta.url), 'utf-8');
  const codes = new Set([...src.matchAll(/STIM_[A-Z_]+/g)].map((m) => m[0]));
  expect(codes.has('STIM_WORKTREE_BRANCH_EXISTS')).toBeTruthy();
  for (const code of codes) expect(body.includes(code)).toBeTruthy();

  const section = body.slice(body.indexOf('STIM_WORKTREE_BRANCH_EXISTS')).replace(/\s+/g, ' ');
  expect(section).toMatch(/refuses whenever it is passed and the branch already exists/i);
  expect(section).toMatch(/INCLUDING the case where the branch happens to sit on the requested base/i);
  expect(section).toMatch(/Stim deletes the branch it just made/i);
  expect(section).toMatch(/only a branch that create made/i);
  expect(section).toMatch(/decides that from whether THIS run passed -b/);
  expect(section).toMatch(/a branch named \.\.\. already exists.{0,80}did not make it/i);
  expect(section).toMatch(/base sha captured before the add/i);
  expect(src).not.toMatch(/--base does not apply/);

  const settings = renderTopic('settings');
  assert(settings);
  const website = readFileSync(new URL('../../../../website/docs/settings.md', import.meta.url), 'utf-8');
  for (const guidance of [settings, website]) {
    const flat = guidance.replace(/\s+/g, ' ');
    const entry = flat.slice(flat.lastIndexOf('worktree.baseRef'));
    expect(entry).toMatch(/only the .{0,2}--base.{0,2} (FLAG|flag) triggers/i);
    expect(entry).toMatch(/STIM_WORKTREE_BRANCH_EXISTS/);
    expect(entry).toMatch(/still attaches/i);
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

test('STIM_BUILD_FAILED lists only the Android refusals gradle.ts still raises (#154)', () => {
  const body = renderTopic('errors');
  assert(body);
  const section = body.slice(body.indexOf('STIM_BUILD_FAILED'), body.indexOf('FALLBACK NOTES THAT ARE NOT CODES'));
  const gradle = readFileSync(new URL('../engine/gradle.ts', import.meta.url), 'utf-8');

  expect(gradle).not.toMatch(/mtime|predates the build/);
  expect(section).toContain('Two Android refusals');
  expect(section).toMatch(/MORE THAN ONE debug APK/);
  expect(section).toMatch(/NO APK for the configured variant/);
  expect(section).not.toMatch(/STALE APK/);
  expect(section).toMatch(/AN APK OLDER THAN THE BUILD IS NOT A REFUSAL/);
  expect(section.replace(/\s+/g, ' ')).toContain('reports UP-TO-DATE');
});

test('the STIM_DEPS_FAILED ladder names the commands and the gate the engine actually uses (#137)', () => {
  const body = renderTopic('errors');
  assert(body);
  const flat = body.slice(body.indexOf('STIM_DEPS_FAILED'), body.indexOf('STIM_BUILD_FAILED')).replace(/\s+/g, ' ');
  const deps = readFileSync(new URL('../engine/deps.ts', import.meta.url), 'utf-8');
  const bundler = readFileSync(new URL('../engine/bundler.ts', import.meta.url), 'utf-8');

  for (const [spawned, documented] of [
    ["args: ['check', '--dry-run']", 'bundle check --dry-run'],
    ["args: ['install']", 'bundle install'],
    ["['bundle', 'exec', 'pod', 'install']", 'bundle exec pod install'],
    ["['pod', 'install']", 'pod install'],
  ] as Array<[string, string]>) {
    expect(deps.includes(spawned)).toBeTruthy();
    expect(flat).toContain(documented);
  }
  expect(deps).toContain("BUNDLE_FROZEN: 'true'");
  expect(flat).toContain('BUNDLE_FROZEN');
  expect(deps).toContain("label: 'gems'");
  expect(flat).toContain('`gems` label');
  expect(bundler).toContain('COCOAPODS_SPEC');
  expect(flat).toContain('Gemfile.lock that resolves cocoapods');
  expect(flat).toContain('BUNDLE_PATH');
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
  const table = src.slice(src.indexOf('const SETTING_SHAPES'), src.indexOf('};', src.indexOf('const SETTING_SHAPES')));
  const known = [...table.matchAll(/^\s*'?([A-Za-z0-9.]+)'?: '[a-z]+',$/gm)]
    .map((match) => match[1])
    .filter((key): key is string => key !== undefined);
  expect(known.length > 0).toBeTruthy();
  for (const key of known) {
    expect(body.includes(key)).toBeTruthy();
  }
});

test('the errors topic names a wrong-typed setting as a STIM_BAD_ARG cause', () => {
  const errors = renderTopic('errors');
  assert(errors);
  const section = errors.slice(errors.indexOf('STIM_BAD_ARG')).replace(/\s+/g, ' ');
  expect(section).toMatch(/a known setting with the wrong type/);
  expect(section).toMatch(/Invalid <key> setting <value>\. Expected <shape>\./);
  expect(section).toMatch(/guide settings.{0,4} names the type each key takes/);
});

test('the setting type rule is stated once and is consistent across user guidance', () => {
  const guide = renderTopic('settings');
  assert(guide);
  const website = readFileSync(new URL('../../../../website/docs/settings.md', import.meta.url), 'utf-8');
  for (const guidance of [guide, website]) {
    const flat = guidance.replace(/\s+/g, ' ');
    expect(flat.match(/wrong type is refused by name/gi)).toHaveLength(1);
    expect(flat).toMatch(/takes ONE type: a string, an array of strings, a number/i);
    expect(flat).toMatch(/android\.avdConfig.? and .?cache\.options.?, an object/i);
    expect(flat).toMatch(/refused by name on every command that resolves settings/i);
    expect(flat).toMatch(/never falls back to a default silently/i);
    expect(flat).toMatch(/doctor.{0,3} reports it as a finding instead of refusing/i);
  }
});

test('the worktreeDir resolution rule is consistent across user guidance', () => {
  const guide = renderTopic('settings');
  assert(guide);
  const website = readFileSync(new URL('../../../../website/docs/settings.md', import.meta.url), 'utf-8');
  for (const body of [guide, website]) {
    const flat = body.replace(/\s+/g, ' ');
    expect(flat).toMatch(/worktreeDir.*relative.*resolves against.{0,40}repository root/i);
  }
  expect(guide.replace(/\s+/g, ' ')).toMatch(/worktreeDir.*--dir.*current directory/i);
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

test('the skill description names the task phrases an agent sees', () => {
  const skill = readFileSync(new URL('../../skill/SKILL.md', import.meta.url), 'utf-8');
  const description = skill.match(/^description: (.+)$/m)?.[1];
  assert(description);
  expect(description).toMatch(/^The React Native \/ Expo CLI for AI agents\./);

  for (const trigger of [
    'expo run:ios',
    'expo run:android',
    'react-native run-ios',
    'react-native run-android',
    'expo start',
    'Metro',
    'simulator',
    'emulator',
    'device',
    'redbox',
    'runtime',
    'logs',
    'parallel worktrees',
  ]) {
    expect(description).toContain(trigger);
  }
});

test('every guide topic explains the npx fallback for short stim commands', () => {
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

test('the website offers copyable outcome prompts and explains skill activation', () => {
  const promptBox = readFileSync(new URL('../../../../website/src/components/PromptBox.tsx', import.meta.url), 'utf-8');
  const gettingStarted = readFileSync(new URL('../../../../website/docs/getting-started.md', import.meta.url), 'utf-8');
  const agentSkills = readFileSync(new URL('../../../../website/docs/agent-skills.md', import.meta.url), 'utf-8');

  expect(promptBox).toContain("import CodeBlock from '@theme/CodeBlock'");
  expect(promptBox).toContain('<CodeBlock language="text">');
  expect(promptBox).toContain('Run example');
  expect(promptBox).toContain('Example agent response');
  expect(gettingStarted).toContain('You normally do not need to name Stim');
  expect(gettingStarted).toContain('The current checkout is the default');
  expect(gettingStarted).toContain('illustrative agent response');
  expect(gettingStarted).toContain('Run the app on an iPhone 17 simulator with iOS 26.5');
  expect(gettingStarted).toContain('Show iOS build performance');
  expect(gettingStarted).toContain('Record the affected flow before and after on iOS with agent-device');
  expect(gettingStarted).toContain('Before/After table');
  expect(gettingStarted).not.toContain('Fix any build or launch errors');
  expect(agentSkills).toMatch(/requests match\s+the skill without naming Stim/);
});

test('the agent guide carries the normal workflow and safety rules', () => {
  const agent = renderTopic('agent');
  assert(agent);
  expect(agent).toContain('stim doctor --platform ios');
  expect(agent).toContain('stim worktree create <name> --carry-ignored');
  expect(agent).toMatch(/ios and android install the app, launch it, and check readiness/);
  expect(agent).toMatch(/give the user one compact result: exact device,[\s\S]*total duration/);
  expect(agent).toMatch(/whether stim logs\s+--errors passed/);
  expect(agent).toMatch(/Do not repeat the\s+phase transcript/);
  expect(agent).toMatch(/Exit code 0 from logs --errors is the pass condition/);
  expect(agent).toContain('No matching log records');
  expect(agent).toContain('stim reload');
  expect(agent).not.toContain('agent-device metro reload --metro-port <reported-port>');
  expect(agent).toMatch(/app error but also says the native process is alive,[\s\S]*app did not crash/);
  expect(agent).toMatch(/FATAL because the app process exited,[\s\S]*Metro cannot restart it/);
  expect(agent).toMatch(/Ordinary stim stop and an authorized clean\s+stim worktree remove do not need/);
});

test('the logs guide keeps Expo and bare React Native stack context on one human error record', () => {
  const logs = renderTopic('logs');
  assert(logs);
  expect(logs).toMatch(/Expo error includes its immediately\s+following code frame and Call Stack lines/);
  expect(logs).toMatch(/Bare React Native symbolication is\s+shown as separate context/);
  expect(logs).toMatch(/Context does not change the error count or the raw error records\s+returned by --json/);
});

test('the agent guide tells the agent to run from the app directory', () => {
  const agent = renderTopic('agent');
  assert(agent);
  expect(agent).toMatch(
    /Run Stim from the app directory: the one whose package.json depends on\s+react-native or expo/,
  );
  expect(agent).toMatch(/start, ios and android refuse with STIM_NO_PROJECT naming that package.json/);
  expect(agent).toMatch(/doctor reports it as a finding/);
});

test('the agent guide routes to every detailed topic', () => {
  const agent = renderTopic('agent');
  assert(agent);
  for (const topicName of topicNames().filter((name) => name !== 'agent')) {
    expect(agent).toContain(`guide ${topicName}`);
  }
});

test('the agent and cleanup guides shut down owned simulators without an occupancy check', () => {
  const agent = renderTopic('agent');
  const cleanup = renderTopic('cleanup');
  assert(agent);
  assert(cleanup);

  expect(agent).toMatch(/explicit stop shuts down a Stim-owned simulator even when\s+another process uses it/i);
  expect(agent).toMatch(/never shuts down an unowned simulator/i);
  expect(cleanup).toMatch(/do not check simulator occupancy/i);
  expect(cleanup).toMatch(/never shuts down an unowned simulator/i);
  expect(agent).not.toContain('agent-device close --shutdown');
});

test('the guide names every path Stim ignores by default', () => {
  const lifecycle = renderTopic('lifecycle') ?? '';
  for (const path of DEFAULT_FINGERPRINT_IGNORES) {
    // The guide prints them without the glob, e.g. android/local.properties.
    const bare = path.replace(/^\*\*\//, '').replace(/\/\*\*$/, '');
    expect(lifecycle).toContain(bare);
  }
});

test('the sandbox failures are named in the errors guide, and the agent guide points at them', () => {
  const errors = renderTopic('errors') ?? '';
  const agent = renderTopic('agent') ?? '';

  // The three failures an agent actually sees.
  for (const detail of [
    'RUNNING UNDER A SANDBOX',
    'CoreSimulatorService connection became invalid',
    "ADB server didn't ACK",
  ]) {
    expect(errors).toContain(detail);
  }

  for (const key of [
    'sandbox.filesystem.allowWrite',
    'sandbox.network.allowMachLookup',
    'sandbox.network.allowLocalBinding',
  ]) {
    expect(errors).toContain(key);
    expect(agent).not.toContain(key);
  }

  expect(agent).toMatch(/sandbox/i);
  expect(agent).toContain('guide errors');
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
    'device',
    'doctor',
    'gc',
    'guide',
    'ios',
    'logs',
    'reload',
    'start',
    'stats',
    'status',
    'stop',
    'worktree',
  ]);
});

test('the guide defines reload as a JavaScript-only live-app recovery', () => {
  const agent = renderTopic('agent');
  const facts = renderTopic('facts');
  const lifecycle = renderTopic('lifecycle');
  const errors = renderTopic('errors');
  assert(agent);
  assert(facts);
  assert(lifecycle);
  assert(errors);

  expect(agent).toContain('stim reload');
  expect(lifecycle).toMatch(/never builds, installs, boots, or cold-launches/);
  expect(lifecycle).toMatch(/owned local simulator or emulator/);
  expect(lifecycle).toMatch(/stim reload ios \/ stim reload android/);
  expect(facts).toContain('stim reload [ios|android] --json');
  expect(facts).toMatch(/platform[\s\S]*deviceId[\s\S]*metroPort[\s\S]*strategy/);
  expect(errors).toContain('STIM_RELOAD_AMBIGUOUS');
  expect(errors).toContain('STIM_RELOAD_RELEASE');
  expect(errors).toContain('STIM_RELOAD_FAILED');
  expect(lifecycle).toMatch(/does not\s+take over\s+that stateful session/);
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

test('the guide documents the flavor refusal that lands before the build', () => {
  const lifecycle = renderTopic('lifecycle');
  const errors = renderTopic('errors');
  assert(lifecycle);
  assert(errors);

  expect(lifecycle).toMatch(/refuses BEFORE gradle runs and names the debug\s+variants/);
  expect(lifecycle).toMatch(/best-effort[\s\S]*variable, a loop, or an applied script/);
  expect(errors).toMatch(/STIM_BAD_ARG[\s\S]*declares product flavors with\s+no variant selected/);
  expect(errors).toMatch(/caught before\s+the build instead \(STIM_BAD_ARG\)/);
});

test('the cleanup guide documents what gc does with device lease files', () => {
  const cleanup = renderTopic('cleanup');
  assert(cleanup);
  expect(cleanup).toMatch(/DEVICE LEASES/);
  expect(cleanup).toMatch(/~\/\.stim\/device-locks/);
  expect(cleanup).toMatch(/`gc` reports[\s\S]*expiry has\s+passed/);
  expect(cleanup).toMatch(/`gc --delete` removes those\s+files/);
  expect(cleanup).toMatch(/under its own lock/);
  expect(cleanup).toMatch(/reported and KEPT[\s\S]*does\s+not parse/);
  expect(cleanup).toMatch(/unexpired lease\s+whose holder directory is gone/);
  expect(cleanup).toMatch(/`stim status` lists every lease file/);
  expect(cleanup).toMatch(/`stop` and\s+`worktree remove` release the leases/);
  expect(cleanup).toMatch(/never remove another workspace's/);
});

test('the guide documents the run-scoped device lease and the two flags that steer it', () => {
  const lifecycle = renderTopic('lifecycle');
  assert(lifecycle);
  expect(lifecycle).toMatch(/THE DEVICE LEASE ON A/);
  expect(lifecycle).toMatch(/AFTER the build[\s\S]*before the\s+install/);
  expect(lifecycle).toMatch(/releases what it took when the command exits/);
  expect(lifecycle).toMatch(/Ctrl-C or a SIGTERM, which\s+it catches[\s\S]*exiting 130\/143/);
  expect(lifecycle).toMatch(/Only SIGKILL\s+escapes that/);
  expect(lifecycle).toMatch(/larger of 60 seconds and that step's own upper bound/);
  expect(lifecycle).toMatch(/`--wait\s+<seconds>` \(default 60\) polls every 2 seconds/);
  expect(lifecycle).toMatch(/at once and then every 30 seconds with the holder, the device and the\s+holder's expiry/);
  expect(lifecycle).toMatch(/keeps waiting past the holder's own expiry/);
  expect(lifecycle).toMatch(/`--wait 0` refuses at\s+once/);
  expect(lifecycle).toMatch(/`--no-wait` changes only that case[\s\S]*NO lease/);
  expect(lifecycle).toMatch(/same app id means it TERMINATES the\s+holder's running app/);
  expect(lifecycle).toMatch(/different one means the launch only backgrounds it/);
  expect(lifecycle).toMatch(/cannot read the holder's app id it says so rather than\s+guessing/);
  expect(lifecycle).toMatch(/two flags\s+together are STIM_BAD_ARG, and so is either one without `--device`/);
  expect(lifecycle).toMatch(/`lease: \{ kind, expiresAt \}`/);
  expect(lifecycle).toMatch(/`lease: null`/);
  expect(lifecycle).toMatch(/ios .*--device \[udid\] --wait <seconds> --no-wait/);
  expect(lifecycle).toMatch(/android .*--device \[serial\] --wait <seconds> --no-wait/);
});

test('the errors topic documents both device-lease codes with their remedies', () => {
  const body = renderTopic('errors');
  assert(body);
  expect(body).toMatch(/STIM_DEVICE_BUSY/);
  expect(body).toMatch(/names the holder root, the device, and the\s+expiry/);
  expect(body).toMatch(/lease: \{ platform, id, deviceName, holder, expiresAt \}/);
  expect(body).toMatch(/wait longer with `--wait <seconds>`, pick another device by\s+id, or `--no-wait`/);
  expect(body).toMatch(/lease\s+file that does not parse/);
  expect(body).toMatch(/STIM_DEVICE_LOST/);
  expect(body).toMatch(/raise before the\s+install found it gone or held under another token/);
  expect(body).toMatch(/AFTER the install has started this is not a failure/);
});

test('the guide documents holding a device across runs with lock and unlock', () => {
  const lifecycle = renderTopic('lifecycle');
  assert(lifecycle);
  expect(lifecycle).toMatch(/HOLDING A DEVICE ACROSS RUNS/);
  expect(lifecycle).toMatch(/stim device lock ios --for 10m/);
  expect(lifecycle).toMatch(/stim ios --device[\s\S]*device-tool work on the phone[\s\S]*stim device unlock/);
  expect(lifecycle).toMatch(/`--for` takes a whole number of seconds or minutes, 10s to 30m, and\s+defaults to 5m/);
  expect(lifecycle).toMatch(/`--wait <seconds>`\s+\(default 60, `0` refuses at once\)/);
  expect(lifecycle).toMatch(/refuse outside one with STIM_NO_PROJECT/);
  expect(lifecycle).toMatch(/`lock` runs the same resolver `--device` does/);
  expect(lifecycle).toMatch(/SETS the expiry to now plus\s+`--for`, which can shorten it/);
  expect(lifecycle).toMatch(/at most one lease per\s+platform/);
  expect(lifecycle).toMatch(/Nothing else moves an expiry[\s\S]*Only `lock` and a run's own steps do/);
  expect(lifecycle).toMatch(/Releasing nothing is not an error/);
  expect(lifecycle).toMatch(/releases by holder/);
  expect(lifecycle).toMatch(/With no id, `lock` and a `--device` run pick from the POOL/);
  expect(lifecycle).toMatch(/device\s+lock <ios\|android> \[id\] --for <duration> --wait <seconds> --json/);
  expect(lifecycle).toMatch(/unlock \[ios\|android\] --json/);
});

test('the busy remedy for this root own lease names the command that releases by holder', () => {
  const errors = renderTopic('errors');
  assert(errors);
  expect(errors).toMatch(/remedy for that last one is `stim device unlock`, which releases by\s+holder/);
});

test('the agent guide states the permanent lease rule', () => {
  const agent = renderTopic('agent');
  assert(agent);
  expect(agent).toMatch(/A --device run leases that device for the run/);
  expect(agent).toMatch(/stim device lock ios --for 10m\s+holds it across runs; stim device unlock gives it back/);
  expect(agent).toMatch(/Never delete another\s+workspace's lease file under ~\/\.stim\/device-locks/);
  expect(agent).toMatch(/gc --delete removes expired\s+ones/);
});

test('the guide documents the pool an id-less --device picks from', () => {
  const lifecycle = renderTopic('lifecycle');
  assert(lifecycle);
  expect(lifecycle).toMatch(/THE POOL: WHICH DEVICE AN ID-LESS/);
  expect(lifecycle).toMatch(/wired, paired, with Developer Mode on/);
  expect(lifecycle).toMatch(/not an emulator, TCP serials included/);
  expect(lifecycle).toMatch(/the device this workspace already leases, when it is among them/);
  expect(lifecycle).toMatch(/first one not leased -- or leased and EXPIRED -- in\s+case-folded id order/);
  expect(lifecycle).toMatch(/Ids are sorted on, never names/);
  expect(lifecycle).toMatch(/NOT connected refuses with\s+STIM_NO_DEVICE naming it/);
  expect(lifecycle).toMatch(/`stim device unlock` first/);
  expect(lifecycle).toMatch(/the poll\s+re-LISTS devices/);
  expect(lifecycle).toMatch(/STIM_DEVICE_BUSY names every\s+holder and its expiry/);
  expect(lifecycle).toMatch(/No candidate at all is the existing STIM_NO_DEVICE/);
  expect(lifecycle).toMatch(/`--no-wait` takes the first candidate\s+anyway/);
  expect(lifecycle).toMatch(/in `--json` \(`udid` or\s+`serial`, plus `deviceName`\)/);

  expect(lifecycle).not.toMatch(/one connected device/);
  expect(lifecycle).not.toMatch(/refuses with the candidate\s+list/);
  expect(lifecycle).toMatch(/no serial it takes the first device it can lease/);
  expect(lifecycle).toMatch(/with no UDID it takes the\s+first device it can lease/);
});

test('the option surface lists the model and runtime flags on both platforms', () => {
  const lifecycle = renderTopic('lifecycle');
  assert(lifecycle);
  expect(lifecycle).toMatch(/ios\s+--json[^\n]*--device-type <name> --runtime <version>/);
  expect(lifecycle).toMatch(/android\s+--json[^\n]*--system-image <id>/);
  expect(lifecycle).toMatch(/Each overrides its\s+setting \(ios\.deviceType, ios\.runtime, android\.systemImage\)/);
  expect(lifecycle).toMatch(/exactly as `--configuration` overrides ios\.configuration/);
  expect(lifecycle).toMatch(/reap the current\s+sim with `stim worktree remove` \(or `stim gc --delete`\)/);
});

test('the settings topic says the flag overrides each device-model key', () => {
  const settings = renderTopic('settings');
  assert(settings);
  const flat = settings.replace(/\s+/g, ' ');
  expect(flat).toMatch(/ios\.deviceType[^|]*The `--device-type` flag overrides this per invocation/);
  expect(flat).toMatch(/ios\.runtime[^|]*The `--runtime` flag overrides this per invocation/);
  expect(flat).toMatch(/android\.systemImage[^|]*The `--system-image` flag overrides this per invocation/);
});

test('the errors topic names an uninstalled device name as a STIM_BAD_ARG cause with the printed-names remedy', () => {
  const errors = renderTopic('errors');
  assert(errors);
  const section = errors.slice(errors.indexOf('STIM_BAD_ARG')).replace(/\s+/g, ' ');
  expect(section).toMatch(/`--device-type`, `--runtime` or `--system-image` name that is BLANK or is not installed/);
  expect(section).toMatch(/the installed names are printed in the message/);
  expect(section).toMatch(/the check applies even when this workspace ALREADY owns a device/);
  expect(section).toMatch(/runs only when a name was actually given/);
  expect(section).toMatch(/a listing that fails is reported as STIM_NO_DEVICE naming the tool, never as a crash/);
  expect(section).not.toMatch(/before anything is spawned/);
});

test('the guide says what counts as an installed model, and the two runtime forms', () => {
  const lifecycle = renderTopic('lifecycle');
  assert(lifecycle);
  const flat = lifecycle.replace(/\s+/g, ' ');
  expect(flat).toMatch(/what an installed RUNTIME can create, not what `xcrun simctl list devicetypes` prints/);
  expect(flat).toMatch(/narrowed to the one runtime when `--runtime` also resolved/);
  expect(flat).toMatch(/`--runtime` takes a version \(`26\.5`\) or a runtime's full name \(`iOS 26\.5`\), exactly/);
  const settings = renderTopic('settings');
  assert(settings);
  expect(settings.replace(/\s+/g, ' ')).toMatch(/as a version \("26\.2"\) or a runtime's full name \("iOS 26\.2"\)/);
});

test('the facts topic documents the model, runtime and system image the run reports', () => {
  const facts = renderTopic('facts');
  assert(facts);
  const flat = facts.replace(/\s+/g, ' ');
  expect(flat).toMatch(/deviceType the owned simulator's MODEL/);
  expect(flat).toMatch(/runtime that simulator's iOS runtime version/);
  expect(flat).toMatch(/systemImage the sdkmanager package id the owned AVD was created from/);
  expect(flat).toMatch(/a run driven by the ios\.deviceType setting reports it too/);
});

test('the guide states the rule that turns runs into the numbers `stats` prints', () => {
  const facts = renderTopic('facts');
  assert(facts);

  expect(facts).toMatch(/HOW A RUN IS COUNTED/);
  expect(facts).toMatch(/got as far as computing a\s+cache key is one run/i);
  expect(facts).toMatch(/app's path IN THE MAIN WORKING TREE/);
  expect(facts).toMatch(/worktree of a repository pools into one bucket/i);
  expect(facts).toMatch(/ends through an error or an uncaught exception counts\s+only as `failed`/i);
  expect(facts).toMatch(/"local" or "remote"\s+is a HIT, false is a MISS/);
  expect(facts).toMatch(/mean cold run BEFORE it, minus its own duration, floored at zero/i);
  expect(facts).toMatch(/WAITED for another workspace's build[\s\S]*credited nothing/i);
  expect(facts).toMatch(/no cold run recorded for this project and platform/i);
  expect(facts).toMatch(/ESTIMATE/);
  expect(facts).toMatch(/stim stats --json/);
  expect(facts).toMatch(/timeSavedMs/);
});

test('the guide routes the two report questions to the two commands', () => {
  const lifecycle = renderTopic('lifecycle');
  const cleanup = renderTopic('cleanup');
  assert(lifecycle);
  assert(cleanup);

  expect(lifecycle).toMatch(/"What is running" is `stim status`/);
  expect(lifecycle).toMatch(/"How much the\s+cache saved" is `stim stats`/);
  expect(lifecycle).toMatch(/stats\s+--json/);
  expect(lifecycle).toMatch(/\$STIM_HOME\/stats\.json/);
  expect(cleanup).toMatch(/gc` never reports or trims the run\s+counters/i);
  expect(cleanup).toMatch(/no reset flag[\s\S]*Delete that one file/i);
  expect(cleanup).toMatch(/cannot read[\s\S]*one dim line on stderr/i);
  expect(cleanup).toMatch(/stats\.json\.corrupt-<unix ms>/);
});

test('the agent guide routes cache-saving questions without teaching the payload', () => {
  const agent = renderTopic('agent');
  assert(agent);
  expect(agent).toContain('stim stats');
  expect(agent).not.toContain('timeSavedMs');
  expect(agent).not.toContain('stats.json');
});

test('the website documents the stats command and its JSON shape', () => {
  const website = readFileSync(new URL('../../../../website/docs/commands.md', import.meta.url), 'utf-8');

  expect(website).toContain('## `stats`');
  expect(website).toContain('stim stats [--json]');
  expect(website).toMatch(/"project": \{ "key"/);
  expect(website).toMatch(/no reset flag/i);
});

test('the repository guide names stats in the command surface', () => {
  const agents = readFileSync(new URL('../../../../AGENTS.md', import.meta.url), 'utf-8');

  expect(agents).toMatch(/The command surface is[\s\S]*`status`, `stats`, `gc`/);
});
