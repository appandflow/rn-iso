import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  changedPathsFromGitOutputs,
  injectRootRenderCrash,
  launchCrashDiagnosis,
  launchCrashRecovery,
  launchCrashRepair,
  launchCrashToken,
} from '../launch-crash-benchmark.mjs';
import {
  androidApplicationLabelFromBadging,
  matchesExpectedAndroidEmulator,
  matchesExpectedIosSimulator,
} from './watch-app-selection.mjs';
import { completedCleanupRecord, durableRunRecord } from './run-record.mjs';

const launchCrashVariant = 'launch-crash';
const scriptRoot = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.STIM_BENCH_ROOT ?? '');
if (!process.env.STIM_BENCH_ROOT) {
  throw new Error('STIM_BENCH_ROOT must name the machine-local benchmark directory');
}
const main = resolve(process.env.STIM_BENCH_FIXTURE ?? join(root, '../trailhead-v3'));
const results = join(root, 'results');
const state = join(root, 'state');
const agentDeviceState = join(state, 'agent-device');
const allowedBin = join(root, 'allowed-bin');
const stimBin = join(root, 'bin');
const golden = join(root, 'golden');
const worktreeParent = resolve(process.env.STIM_BENCH_WORKTREE_PARENT ?? join(root, '../trailhead-worktrees'));
const stimPackage = resolve(process.env.STIM_BENCH_STIM_PACKAGE ?? join(root, 'runtime', 'node_modules', 'stim-cli'));
const stimCli = join(stimPackage, 'dist', 'cli.mjs');
const agentDeviceBin = process.env.STIM_BENCH_AGENT_DEVICE_BIN ?? 'agent-device';
const claudeBin = process.env.STIM_BENCH_CLAUDE_BIN ?? 'claude';
const codexBin = process.env.STIM_BENCH_CODEX_BIN ?? 'codex';
const agentSkillsRoot = process.env.STIM_BENCH_SKILLS_ROOT;
const codexAuthPath = process.env.STIM_BENCH_CODEX_AUTH;
const pins = Object.fromEntries(
  readFileSync(join(root, 'pins.env'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }),
);

function checkedPlatform(value = 'ios') {
  if (!['ios', 'android'].includes(value)) throw new Error(`unsupported benchmark platform: ${value}`);
  return value;
}

function goldenFor(platform) {
  return platform === 'ios' ? golden : join(golden, platform);
}

function run(file, args, options = {}) {
  const output = execFileSync(file, args, {
    cwd: options.cwd ?? main,
    encoding: 'utf8',
    env: options.env ?? process.env,
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
  return typeof output === 'string' ? output.trim() : '';
}

function jsonRun(file, args, options) {
  return JSON.parse(run(file, args, options));
}

function executablePath(file) {
  return file.includes('/') ? file : run('/usr/bin/which', [file], { cwd: root });
}

function cleanRubyEnvironment(environment) {
  const clean = { ...environment };
  delete clean.GEM_HOME;
  delete clean.GEM_PATH;
  delete clean.RUBY_VERSION;
  return clean;
}

function agentDeviceEnvironment(session) {
  return {
    ...cleanRubyEnvironment(process.env),
    AGENT_DEVICE_STATE_DIR: agentDeviceState,
    ...(session ? { AGENT_DEVICE_SESSION: session } : {}),
  };
}

function agentDeviceCommand(meta, command) {
  const stateDir = meta.agentDevice?.stateDir ?? agentDeviceState;
  const session = meta.agentDevice?.session ?? meta.runId;
  return `env AGENT_DEVICE_STATE_DIR=${stateDir} AGENT_DEVICE_SESSION=${session} agent-device ${command}`;
}

function isJavascriptVariant(variant) {
  return variant === 'javascript' || variant === launchCrashVariant;
}

function settingsProofText(variant) {
  return variant === 'javascript'
    ? 'Keep saved trail maps available offline'
    : variant === launchCrashVariant
      ? 'Keep map tiles for saved trails on device'
      : 'Offline maps';
}

function agentDeviceSessions(environment) {
  const payload = jsonRun(agentDeviceBin, ['session', 'list', '--json'], {
    cwd: main,
    env: environment,
    timeout: 30_000,
  });
  if (payload.success !== true || !Array.isArray(payload.data?.sessions)) {
    throw new Error(`unexpected agent-device session response: ${JSON.stringify(payload)}`);
  }
  return payload.data.sessions;
}

function stopBenchmarkAgentDeviceDaemon() {
  return run(agentDeviceBin, ['daemon', 'stop', '--state-dir', agentDeviceState, '--clean'], {
    cwd: main,
    env: agentDeviceEnvironment(),
    timeout: 60_000,
  });
}

function prepareAgentDeviceRun(runId, platform, deviceId = null) {
  mkdirSync(agentDeviceState, { recursive: true });
  const environment = agentDeviceEnvironment(runId);
  let sessions = agentDeviceSessions(environment);
  let recovered = false;
  if (sessions.length) {
    stopBenchmarkAgentDeviceDaemon();
    recovered = true;
    sessions = agentDeviceSessions(environment);
  }
  if (sessions.length) {
    throw new Error(`benchmark agent-device sessions remain: ${JSON.stringify(sessions)}`);
  }
  let claims = [];
  if (deviceId) {
    const targetFlag = platform === 'android' ? '--serial' : '--udid';
    const deviceStatus = jsonRun(
      agentDeviceBin,
      ['device', 'status', '--platform', platform, targetFlag, deviceId, '--json'],
      { cwd: main, env: environment, timeout: 30_000 },
    );
    claims = deviceStatus.data?.claims;
    if (deviceStatus.success !== true || !Array.isArray(claims)) {
      throw new Error(`unexpected agent-device ownership response: ${JSON.stringify(deviceStatus)}`);
    }
    if (claims.length || deviceStatus.data.hiddenStaleClaims) {
      throw new Error(`benchmark device has an agent-device claim: ${JSON.stringify(deviceStatus.data)}`);
    }
  }
  return {
    stateDir: agentDeviceState,
    session: runId,
    recoveredBenchmarkDaemon: recovered,
    sessionsBeforeDispatch: sessions.length,
    deviceClaimsBeforeDispatch: claims.length,
  };
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function verifyGoldenCache(platform, platformGolden = goldenFor(platform)) {
  const script = [
    'const fingerprint = await import("@expo/fingerprint");',
    'const result = await fingerprint.createFingerprintAsync(process.cwd(), {',
    `  platforms: [${JSON.stringify(platform)}],`,
    '  silent: true,',
    '  ignorePaths: ["**/android/local.properties", "**/android/.idea/**"],',
    '});',
    'process.stdout.write(result.hash);',
  ].join('\n');
  const fingerprint = run('node', ['--input-type=module', '-e', script], {
    cwd: main,
    timeout: 2 * 60 * 1000,
  });
  const cacheKey = `${fingerprint}-debug-sim`;
  const cacheDir = join(platformGolden, 'stim-home', 'build-cache', platform, cacheKey);
  const extension = platform === 'ios' ? '.app' : '.apk';
  const artifact = existsSync(cacheDir) ? readdirSync(cacheDir).find((name) => name.endsWith(extension)) : null;
  if (!artifact) {
    throw new Error(`golden ${platform} artifact missing for fresh-worktree key ${cacheKey}`);
  }
  return { fingerprint, cacheKey, artifact: join(cacheDir, artifact) };
}

function availableSimulators() {
  const data = jsonRun('xcrun', ['simctl', 'list', 'devices', '--json']);
  return Object.values(data.devices)
    .flat()
    .filter((device) => device.isAvailable);
}

function waitForSimulatorQuiescence(udid) {
  const deadline = Date.now() + 3 * 60 * 1000;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    const simulator = availableSimulators().find((device) => device.udid === udid);
    const runnerActive = run('ps', ['-Ao', 'command='])
      .split('\n')
      .some((command) => command.includes('xcodebuild test-without-building') && command.includes(udid));
    stableSamples = simulator?.state === 'Shutdown' && !runnerActive ? stableSamples + 1 : 0;
    if (stableSamples >= 2) return simulator;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
  }
  throw new Error(`simulator did not become quiescent: ${udid}`);
}

function verifyParkedSimulator(stimHome, expectedUdid) {
  const configPath = join(stimHome, 'config.json');
  if (!existsSync(configPath)) throw new Error('golden Stim config is missing');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const records = Array.isArray(config.parked?.ios) ? config.parked.ios : [];
  if (config.pool?.iosParkedMax !== 1 || records.length !== 1) {
    throw new Error('golden must contain exactly one parked iOS simulator with max 1');
  }
  const record = records[0];
  if (expectedUdid && record.udid !== expectedUdid) {
    throw new Error(`parked simulator changed: expected ${expectedUdid}, got ${record.udid}`);
  }
  const simulator = availableSimulators().find((device) => device.udid === record.udid);
  if (
    !simulator ||
    simulator.state !== 'Shutdown' ||
    simulator.name !== record.name ||
    !simulator.name.startsWith('stim-parked')
  ) {
    throw new Error(`golden parked simulator is not ready: ${JSON.stringify({ record, simulator })}`);
  }
  if (
    record.deviceTypeIdentifier !== 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' ||
    !record.runtimeIdentifier.endsWith('iOS-26-5')
  ) {
    throw new Error(`golden parked simulator has the wrong model or runtime: ${JSON.stringify(record)}`);
  }
  return { ...record, state: simulator.state };
}

function verifyGoldenParkedSimulator() {
  return verifyParkedSimulator(join(golden, 'stim-home'));
}

function ensureDirs() {
  for (const path of [results, state, allowedBin, stimBin, golden]) {
    mkdirSync(path, { recursive: true });
  }
}

function prepareAllowedBin() {
  const names = [
    'adb',
    'agent-device',
    'avdmanager',
    'ccache',
    'emulator',
    'node',
    'npm',
    'npx',
    'pnpm',
    'pod',
    'rg',
    'sdkmanager',
    'watchman',
  ];
  for (const name of names) {
    let source;
    try {
      source = run('/usr/bin/which', [name], { cwd: root });
    } catch {
      continue;
    }
    const target = join(allowedBin, name);
    if (!existsSync(source) || existsSync(target)) continue;
    symlinkSync(source, target);
  }
  chmodSync(join(stimBin, 'stim'), 0o755);
}

function simulatorSnapshot() {
  const data = jsonRun('xcrun', ['simctl', 'list', 'devices', '--json']);
  return Object.values(data.devices)
    .flat()
    .filter((device) => device.isAvailable)
    .map((device) => device.udid);
}

function androidEmulatorSnapshot() {
  return run('adb', ['devices'])
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, deviceState]) => serial?.startsWith('emulator-') && deviceState === 'device')
    .map(([serial]) => serial);
}

function androidAvdSnapshot() {
  return run('emulator', ['-list-avds'])
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean);
}

function androidEmulatorTransports() {
  return run('adb', ['devices'])
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial]) => serial?.startsWith('emulator-'))
    .map(([serial, transportState]) => ({ serial, transportState }));
}

function androidAvdDescription(name) {
  const avdRoot = process.env.ANDROID_AVD_HOME ?? join(process.env.HOME, '.android', 'avd');
  const configPath = join(avdRoot, `${name}.avd`, 'config.ini');
  const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const systemImage = config
    .match(/^image\.sysdir\.1=(.+)$/m)?.[1]
    ?.trim()
    .replace(/\/+$/, '')
    .replaceAll('/', ';');
  return {
    name,
    deviceTypeIdentifier: config.match(/^hw\.device\.name=(.+)$/m)?.[1]?.trim(),
    runtimeIdentifier: `Android-${systemImage?.match(/android-(\d+)/)?.[1]}`,
    systemImage,
  };
}

function androidEmulatorDescription(serial) {
  const name = run('adb', ['-s', serial, 'shell', 'getprop', 'ro.boot.qemu.avd_name']);
  const avd = androidAvdDescription(name);
  return {
    ...avd,
    udid: serial,
    deviceTypeIdentifier:
      avd.deviceTypeIdentifier ?? run('adb', ['-s', serial, 'shell', 'getprop', 'ro.product.device']),
    runtimeIdentifier: `Android-${run('adb', ['-s', serial, 'shell', 'getprop', 'ro.build.version.sdk'])}`,
  };
}

function deviceSnapshot(platform) {
  return platform === 'android' ? androidEmulatorSnapshot() : simulatorSnapshot();
}

function controlSimulatorForCleanup(runDir, preferredUdid) {
  const baselinePath = existsSync(join(runDir, 'devices-before.json'))
    ? join(runDir, 'devices-before.json')
    : join(runDir, 'simulators-before.json');
  const baseline = new Set(JSON.parse(readFileSync(baselinePath, 'utf8')));
  const data = jsonRun('xcrun', ['simctl', 'list', 'devices', '--json']);
  const candidates = Object.values(data.devices)
    .flat()
    .filter((device) => device.isAvailable && !baseline.has(device.udid) && device.name.startsWith('Trailhead '));
  if (preferredUdid) {
    return candidates.find((device) => device.udid === preferredUdid) ?? null;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function controlAndroidForCleanup(runDir, preferredSerial, expectedName) {
  const beforePath = join(runDir, 'avds-before.json');
  if (!existsSync(beforePath)) return null;
  const before = new Set(JSON.parse(readFileSync(beforePath, 'utf8')));
  if (before.has(expectedName)) return null;
  const baseline = new Set(JSON.parse(readFileSync(join(runDir, 'devices-before.json'), 'utf8')));
  const liveCandidates = androidEmulatorSnapshot()
    .filter((serial) => !baseline.has(serial))
    .map(androidEmulatorDescription)
    .filter((device) => device.name === expectedName);
  if (preferredSerial) {
    const preferred = liveCandidates.find((device) => device.udid === preferredSerial);
    if (preferred) return preferred;
  }
  if (liveCandidates.length === 1) return liveCandidates[0];
  return androidAvdSnapshot().includes(expectedName) ? androidAvdDescription(expectedName) : null;
}

function bootedSimulators() {
  const data = jsonRun('xcrun', ['simctl', 'list', 'devices', '--json']);
  return Object.values(data.devices)
    .flat()
    .filter((device) => device.isAvailable && device.state === 'Booted');
}

function git(...args) {
  return run('git', args, { cwd: main });
}

function versionChecks() {
  const macVersion = run('sw_vers', ['-productVersion']);
  const macBuild = run('sw_vers', ['-buildVersion']);
  const xcode = run('xcodebuild', ['-version']).split('\n');
  const actual = {
    TRAILHEAD_FIXTURE_COMMIT: git('rev-parse', 'HEAD'),
    CODEX_VERSION: run(codexBin, ['--version']).replace(/^codex-cli /, ''),
    CLAUDE_VERSION: run(claudeBin, ['--version']).split(/\s+/)[0],
    NODE_VERSION: run('node', ['--version']).replace(/^v/, ''),
    COCOAPODS_VERSION: run('pod', ['--version']),
    STIM_VERSION: JSON.parse(readFileSync(join(stimPackage, 'package.json'), 'utf8')).version,
    STIM_INTEGRITY: JSON.parse(readFileSync(join(root, 'runtime', 'package-lock.json'), 'utf8')).packages[
      'node_modules/stim-cli'
    ].integrity,
    AGENT_DEVICE_VERSION: run(agentDeviceBin, ['--version']).split(/\s+/).at(-1),
    AGENT_DEVICE_SHA256: sha256(executablePath(agentDeviceBin)),
    MACOS_VERSION: macVersion,
    MACOS_BUILD: macBuild,
    XCODE_VERSION: xcode[0].replace(/^Xcode /, ''),
    XCODE_BUILD: xcode[1].replace(/^Build version /, ''),
    ANDROID_SDK_VERSION: run('sdkmanager', ['--version']).split('\n').at(-1),
    ANDROID_EMULATOR_VERSION: run('emulator', ['-version'])
      .split('\n')[0]
      .replace(/^Android emulator version /, ''),
    ADB_VERSION: run('adb', ['version'])
      .split('\n')
      .find((line) => line.startsWith('Version '))
      ?.replace(/^Version /, ''),
  };
  for (const [key, value] of Object.entries(actual)) {
    if (value !== pins[key]) {
      throw new Error(`${key}: expected ${pins[key]}, got ${value}`);
    }
  }
  if (git('status', '--short') !== '') {
    throw new Error('fixture checkout is dirty');
  }
  return actual;
}

function preflight(requestedPlatform = 'ios') {
  const platform = checkedPlatform(requestedPlatform);
  ensureDirs();
  prepareAllowedBin();
  const actual = versionChecks();
  if (!readFileSync(join(stimBin, 'stim'), 'utf8').includes(stimCli)) {
    throw new Error('Stim shim does not target the pinned CLI checkout');
  }
  const booted = platform === 'android' ? androidEmulatorTransports() : bootedSimulators().map((device) => device.udid);
  if (booted.length) {
    throw new Error(`booted ${platform} devices require operator cleanup: ${JSON.stringify(booted)}`);
  }
  const listeners = run('/bin/sh', [
    '-c',
    'for p in 8081 8082 8083 8084 8085 8086 8087 8088 8089 8090; do /usr/sbin/lsof -nP -iTCP:$p -sTCP:LISTEN 2>/dev/null; done; exit 0',
  ]);
  if (listeners) throw new Error(`Metro-range listener found:\n${listeners}`);
  const disk = run('df', ['-k', main, root]);
  const load = run('sysctl', ['-n', 'vm.loadavg']);
  const thermal = run('pmset', ['-g', 'therm']);
  if (thermal.split('\n').some((line) => /warning/i.test(line) && !/No .*warning/i.test(line))) {
    throw new Error(`thermal warning reported:\n${thermal}`);
  }
  for (const [path, minimumGiB] of [
    [main, 12],
    [root, 8],
  ]) {
    const fields = run('df', ['-Pk', path]).split('\n').at(-1).trim().split(/\s+/);
    const freeBytes = Number(fields[3]) * 1024;
    if (!Number.isFinite(freeBytes) || freeBytes < minimumGiB * 1024 ** 3) {
      throw new Error(`${path} requires ${minimumGiB} GiB free; found ${freeBytes} bytes`);
    }
  }
  const platformGolden = goldenFor(platform);
  const readyPath = join(platformGolden, 'READY.json');
  const goldenCache = existsSync(readyPath) ? verifyGoldenCache(platform, platformGolden) : null;
  const parkedSimulator = platform === 'ios' && existsSync(readyPath) ? verifyGoldenParkedSimulator() : null;
  const preflightRecord = {
    checkedAt: new Date().toISOString(),
    actual,
    disk,
    load,
    thermal,
    platform,
    goldenCache,
    parkedSimulator,
    stimExecutableSha256: sha256(join(stimBin, 'stim')),
    stimCliSha256: sha256(stimCli),
  };
  writeFileSync(join(state, 'last-preflight.json'), `${JSON.stringify(preflightRecord, null, 2)}\n`);
  return preflightRecord;
}

async function waitForLoadGate() {
  const samples = [];
  let consecutive = 0;
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const raw = run('sysctl', ['-n', 'vm.loadavg']);
    const oneMinute = Number(raw.match(/[\d.]+/)?.[0]);
    const sample = { at: new Date().toISOString(), raw, oneMinute };
    samples.push(sample);
    consecutive = Number.isFinite(oneMinute) && oneMinute <= 3 ? consecutive + 1 : 0;
    if (consecutive >= 2) return { passed: true, samples };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15_000));
  }
  return { passed: false, samples };
}

function prepare() {
  ensureDirs();
  prepareAllowedBin();
  versionChecks();
  const readyPath = join(golden, 'READY.json');
  if (existsSync(readyPath)) {
    process.stdout.write(readFileSync(readyPath));
    return;
  }
  const seedHome = join(golden, 'seed-stim-home');
  const finalHome = join(golden, 'stim-home');
  const controlTmp = join(golden, 'control-tmp');
  if (existsSync(seedHome)) {
    throw new Error('partial seed golden exists; inspect it before retrying');
  }
  const preparingHome = existsSync(finalHome) ? finalHome : seedHome;
  if (!existsSync(finalHome)) {
    mkdirSync(seedHome, { recursive: true });
    writeFileSync(
      join(seedHome, 'config.json'),
      `${JSON.stringify(
        {
          version: 2,
          projects: {},
          repos: {},
          pool: { iosParkedMax: 1 },
        },
        null,
        2,
      )}\n`,
    );
  }
  const seedEnv = {
    ...cleanRubyEnvironment(process.env),
    STIM_HOME: preparingHome,
    STIM_POOL_IOS_PARKED_MAX: '1',
  };
  const worktree = run('node', [stimCli, 'worktree', 'create', 'bench-golden-seed', '--carry-ignored'], {
    cwd: main,
    env: seedEnv,
    timeout: 20 * 60 * 1000,
  })
    .split('\n')
    .at(-1);
  try {
    run('node', [stimCli, 'start'], {
      cwd: worktree,
      env: seedEnv,
      timeout: 5 * 60 * 1000,
      stdio: 'inherit',
    });
    run('node', [stimCli, 'ios', '--device-type', pins.IOS_DEVICE_TYPE, '--runtime', pins.IOS_RUNTIME], {
      cwd: worktree,
      env: seedEnv,
      timeout: 20 * 60 * 1000,
      stdio: 'inherit',
    });
    run('node', [stimCli, 'stop'], {
      cwd: worktree,
      env: seedEnv,
      timeout: 2 * 60 * 1000,
      stdio: 'inherit',
    });
    run('node', [stimCli, 'worktree', 'remove', '--force'], {
      cwd: worktree,
      env: seedEnv,
      timeout: 5 * 60 * 1000,
      stdio: 'inherit',
    });
  } catch (error) {
    throw new Error(`golden preparation failed; retained ${preparingHome}`, { cause: error });
  }
  if (preparingHome === seedHome) renameSync(seedHome, finalHome);
  const parkedSimulator = verifyGoldenParkedSimulator();
  mkdirSync(controlTmp, { recursive: true });
  const exportPath = join(golden, 'control-export');
  run('npx', ['expo', 'export', '--platform', 'ios', '--dev', '--output-dir', exportPath], {
    cwd: main,
    env: { ...cleanRubyEnvironment(process.env), TMPDIR: controlTmp },
    timeout: 10 * 60 * 1000,
    stdio: 'inherit',
  });
  rmSync(exportPath, { recursive: true, force: true });
  const ready = {
    preparedAt: new Date().toISOString(),
    fixtureCommit: git('rev-parse', 'HEAD'),
    stimVersion: pins.STIM_VERSION,
    stimIntegrity: pins.STIM_INTEGRITY,
    stimCliSha256: sha256(stimCli),
    agentDeviceVersion: pins.AGENT_DEVICE_VERSION,
    agentDeviceSha256: pins.AGENT_DEVICE_SHA256,
    parkedSimulator,
    buildCacheEntries: readdirSync(join(finalHome, 'build-cache', 'ios')),
  };
  writeFileSync(readyPath, `${JSON.stringify(ready, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(ready, null, 2)}\n`);
}

function prepareAndroid() {
  ensureDirs();
  prepareAllowedBin();
  versionChecks();
  const platformGolden = goldenFor('android');
  const readyPath = join(platformGolden, 'READY.json');
  if (existsSync(readyPath)) {
    process.stdout.write(readFileSync(readyPath));
    return;
  }
  if (!pins.ANDROID_SYSTEM_IMAGE) throw new Error('pins.env must define ANDROID_SYSTEM_IMAGE');
  const seedHome = join(platformGolden, 'seed-stim-home');
  const finalHome = join(platformGolden, 'stim-home');
  const controlTmp = join(platformGolden, 'control-tmp');
  if (existsSync(seedHome)) throw new Error('partial Android seed golden exists; inspect it before retrying');
  mkdirSync(platformGolden, { recursive: true });
  mkdirSync(seedHome, { recursive: true });
  writeFileSync(join(seedHome, 'config.json'), `${JSON.stringify({ version: 2, projects: {}, repos: {} }, null, 2)}\n`);
  const seedEnv = { ...cleanRubyEnvironment(process.env), STIM_HOME: seedHome };
  let preparedDevice = null;
  const worktree = run('node', [stimCli, 'worktree', 'create', 'bench-golden-android-seed', '--carry-ignored'], {
    cwd: main,
    env: seedEnv,
    timeout: 20 * 60 * 1000,
  })
    .split('\n')
    .at(-1);
  try {
    run('node', [stimCli, 'start'], {
      cwd: worktree,
      env: seedEnv,
      timeout: 5 * 60 * 1000,
      stdio: 'inherit',
    });
    run('node', [stimCli, 'android', '--system-image', pins.ANDROID_SYSTEM_IMAGE], {
      cwd: worktree,
      env: seedEnv,
      timeout: 25 * 60 * 1000,
      stdio: 'inherit',
    });
    const preparedSerials = androidEmulatorSnapshot();
    if (preparedSerials.length !== 1) {
      throw new Error(`expected one prepared Android emulator, got ${JSON.stringify(preparedSerials)}`);
    }
    preparedDevice = androidEmulatorDescription(preparedSerials[0]);
    if (preparedDevice.systemImage !== pins.ANDROID_SYSTEM_IMAGE) {
      throw new Error(`prepared Android emulator image mismatch: ${JSON.stringify(preparedDevice)}`);
    }
    run('node', [stimCli, 'stop'], {
      cwd: worktree,
      env: seedEnv,
      timeout: 2 * 60 * 1000,
      stdio: 'inherit',
    });
    run('node', [stimCli, 'worktree', 'remove', '--force'], {
      cwd: worktree,
      env: seedEnv,
      timeout: 5 * 60 * 1000,
      stdio: 'inherit',
    });
  } catch (error) {
    throw new Error(`Android golden preparation failed; retained ${seedHome}`, { cause: error });
  }
  renameSync(seedHome, finalHome);
  mkdirSync(controlTmp, { recursive: true });
  const exportPath = join(platformGolden, 'control-export');
  run('npx', ['expo', 'export', '--platform', 'android', '--dev', '--output-dir', exportPath], {
    cwd: main,
    env: { ...cleanRubyEnvironment(process.env), TMPDIR: controlTmp },
    timeout: 10 * 60 * 1000,
    stdio: 'inherit',
  });
  rmSync(exportPath, { recursive: true, force: true });
  const cache = verifyGoldenCache('android', platformGolden);
  const ready = {
    preparedAt: new Date().toISOString(),
    fixtureCommit: git('rev-parse', 'HEAD'),
    stimVersion: pins.STIM_VERSION,
    stimIntegrity: pins.STIM_INTEGRITY,
    stimCliSha256: sha256(stimCli),
    agentDeviceVersion: pins.AGENT_DEVICE_VERSION,
    agentDeviceSha256: pins.AGENT_DEVICE_SHA256,
    systemImage: pins.ANDROID_SYSTEM_IMAGE,
    deviceTypeIdentifier: preparedDevice?.deviceTypeIdentifier ?? null,
    runtimeIdentifier: `Android-${pins.ANDROID_SYSTEM_IMAGE.match(/android-(\d+)/)?.[1]}`,
    buildCacheEntries: [cache.cacheKey],
  };
  writeFileSync(readyPath, `${JSON.stringify(ready, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(ready, null, 2)}\n`);
}

function prepareLaunchCrashFixture(arm, runId, environment) {
  let fixtureCheckout;
  let fixtureBranch;
  if (arm === 'stim') {
    fixtureCheckout = run(
      'stim',
      ['worktree', 'create', `fixture/${runId}`, '--dir', worktreeParent, '--carry-ignored'],
      { cwd: main, env: environment, timeout: 20 * 60 * 1000 },
    )
      .split('\n')
      .at(-1);
    fixtureBranch = `worktree-fixture/${runId}`;
  } else {
    fixtureCheckout = join(worktreeParent, `fixture-${runId}`);
    fixtureBranch = `bench-fixture/${runId}`;
    run('git', ['worktree', 'add', '-b', fixtureBranch, fixtureCheckout, 'HEAD'], {
      cwd: main,
      timeout: 5 * 60 * 1000,
    });
    for (const name of ['node_modules', 'ios/Pods', 'ios/build']) {
      const source = join(main, name);
      if (!existsSync(source)) continue;
      const target = join(fixtureCheckout, name);
      mkdirSync(dirname(target), { recursive: true });
      run('cp', ['-cR', source, target], { cwd: main, timeout: 10 * 60 * 1000 });
    }
  }
  const absolute = realpathSync(fixtureCheckout);
  if (!absolute.startsWith(`${worktreeParent}/`)) {
    throw new Error(`launch-crash fixture escaped the benchmark root: ${absolute}`);
  }
  const sourcePath = join(absolute, 'app', '_layout.tsx');
  const original = readFileSync(sourcePath, 'utf8');
  const token = launchCrashToken(runId);
  writeFileSync(sourcePath, injectRootRenderCrash(original, token));
  run('git', ['add', 'app/_layout.tsx'], { cwd: absolute });
  run('git', ['commit', '-m', 'test: prepare launch failure fixture'], {
    cwd: absolute,
    timeout: 60_000,
  });
  return {
    fixtureCheckout: absolute,
    fixtureBranch,
    fixtureCommit: run('git', ['rev-parse', 'HEAD'], { cwd: absolute }),
    sourcePath,
    sourceRelative: 'app/_layout.tsx',
    token,
    originalSha256: createHash('sha256').update(original).digest('hex'),
  };
}

function promptFor(arm, variant, runId, runDir, crash = null, requestedPlatform = 'ios') {
  const platform = checkedPlatform(requestedPlatform);
  const controlDeviceName = platform === 'ios' ? `Trailhead ${runId}` : `Trailhead_${runId}`;
  const worktree =
    variant === launchCrashVariant
      ? arm === 'stim'
        ? `In ${crash.fixtureCheckout}, use exactly \`stim worktree create bench/${runId} --dir ${worktreeParent} --carry-ignored\` to create your worktree from the current fixture HEAD, then work only in the absolute path it prints. `
        : `In ${crash.fixtureCheckout}, create a git worktree for branch bench/${runId} at ${join(worktreeParent, runId)} from the current fixture HEAD and carry installed dependencies and native outputs from the fixture checkout. Then work only in that run worktree. Name the new simulator exactly ${JSON.stringify(controlDeviceName)}. `
      : arm === 'stim'
        ? `In ${main}, use exactly \`stim worktree create bench/${runId} --dir ${worktreeParent} --carry-ignored\` to create the worktree, then work only in the absolute path it prints. `
        : `In ${main}, create a git worktree for branch bench/${runId} at ${join(worktreeParent, runId)} and carry installed dependencies and native outputs from the main checkout. Then work only in that worktree. Name the new ${platform === 'ios' ? 'simulator' : 'AVD'} exactly ${JSON.stringify(controlDeviceName)} so the coordinator can prove ownership and clean it safely. `;
  const screenshot = join(runDir, 'proof', 'settings.png');
  const screenshotScratch = join('/tmp', `${runId}-settings.png`);
  const recording = join(runDir, 'proof', 'session.mp4');
  const expected = settingsProofText(variant);
  const agentDevicePrefix = `env AGENT_DEVICE_STATE_DIR=${agentDeviceState} AGENT_DEVICE_SESSION=${runId} agent-device`;
  const targetDescription = platform === 'ios' ? 'simulator UDID' : 'emulator serial';
  const targetFlag = platform === 'ios' ? '--udid' : '--serial';
  const deviceProof = ` After the app launches, you MUST use the agent-device skill and CLI. Codex does not forward the coordinator's agent-device environment into shell tools, so prefix every agent-device command exactly with \`${agentDevicePrefix}\`; never run a bare \`agent-device\` command. Read the exact run ${targetDescription} from the launch output and start the session with exactly \`${agentDevicePrefix} open com.appandflow.trailhead --foreground --platform ${platform} ${targetFlag} <run ${targetDescription}>\`, replacing only the angle-bracketed value. Immediately start run-scoped video with exactly \`${agentDevicePrefix} record start ${recording} --scope device --quality high --hide-touches\`. Handle any Expo onboarding shown and navigate to the Settings tab using semantic refs or labels. Then run each of these as its own top-level shell command, without chaining, redirection, a script, or an interactive shell: \`${agentDevicePrefix} wait text ${JSON.stringify(expected)}\`, \`${agentDevicePrefix} screenshot ${screenshotScratch}\`, \`cp ${screenshotScratch} ${screenshot}\`, \`${agentDevicePrefix} record stop\`, and \`${agentDevicePrefix} close\`. Do not stop or restart the agent-device daemon; report a failure if the isolated session refuses to open. The explicit state and session assignments and device identifier prevent cross-run ownership. Do not claim completion before the wait succeeds, the copied screenshot exists, and recording stop reports the saved video.`;
  const suffix = ` Stay in this turn until the Settings screenshot is saved; do not stop to await a background notification. Do not use subagents. Do not read or write outside the fixture checkout, the run worktree, and ${runDir}. Report the run worktree and screenshot paths, then stop; the coordinator will verify and clean up.`;
  if (variant === launchCrashVariant) {
    const launch =
      arm === 'stim'
        ? `Use the Stim skill and only the pinned published command available on PATH as exactly \`stim\`. Keep the inherited STIM_HOME unchanged. Before inspecting source or git diff, run \`stim start\` and then \`stim ios\` so the benchmark observes the failure. Preserve that launch output, then immediately run \`stim logs --errors\` as its own command. Diagnose the launch failure from those results. Only after the diagnostic commands may you inspect and edit source. Make the smallest repair, then refresh the already-running app with exactly \`${agentDevicePrefix} metro reload --metro-port <reported Metro port>\`, replacing only the angle-bracketed value. Do not run \`stim ios\` a second time. Leave Metro and the app running until screenshot proof is complete. Do not use npx, an absolute Stim path, raw Expo launch commands, or stop Stim.`
        : `Use the project's local Expo and Apple tooling and do not use Stim. Create a new iPhone 17 simulator running iOS 26.5 with the exact required name; do not substitute another device type or runtime and do not use an existing simulator. Before inspecting source or git diff, start Metro as a detached process with its PID and log under /tmp. Start the initial native build/install/launch as a detached shell process with its PID and log under /tmp, then poll it with short foreground shell commands. Once the app has launched and failed, run a separate foreground \`tail\`, \`rg\`, or simulator-log command that completes and prints the crash token and source location. Only after that explicit error-capture command completes may you inspect or edit source. Make the smallest repair, then refresh the already-running app with exactly \`${agentDevicePrefix} metro reload --metro-port 8081\`. Do not run a second native build or launch. Do not print, inspect, or search old crash-token output after that reload. Leave Metro and the app running until screenshot proof is complete. Do not use a long-running foreground shell command, concurrent shell tool calls, or rely on streamed output from a command that is still running as diagnosis evidence.`;
    return (
      worktree +
      'The app has a deterministic JavaScript failure during its initial root render. Diagnose and repair that launch failure without making unrelated product changes. ' +
      launch +
      deviceProof +
      suffix
    );
  }
  if (variant === 'javascript') {
    const edit =
      'change the Settings offline-map subtitle from "Keep map tiles for saved trails on device" to "Keep saved trail maps available offline". ';
    const launch = platformLaunchInstructions(arm, platform, runId, true);
    return worktree + edit + launch + deviceProof + suffix;
  }
  const edit =
    platform === 'ios'
      ? `edit ios/Trailhead/AppDelegate.swift so that immediately after the existing window assignment it sets the window accessibilityIdentifier to "Trailhead ${runId}". `
      : `edit android/app/src/main/res/values/strings.xml so the app_name string is exactly "Trailhead ${runId}". `;
  const launch = platformLaunchInstructions(arm, platform, runId, false);
  return worktree + edit + launch + deviceProof + suffix;
}

function platformLaunchInstructions(arm, platform, runId, startMetro) {
  if (arm === 'stim') {
    return platform === 'ios'
      ? 'Use the Stim skill and only the pinned published command available on PATH as exactly `stim` (never through npx or an absolute path). Keep the inherited STIM_HOME unchanged. Run the iOS app on the prepared parked iPhone 17 simulator running iOS 26.5; Stim must report that it adopted the simulator. Leave Metro running until the screenshot is saved.'
      : `Use the Stim skill and only the pinned published command available on PATH as exactly \`stim\` (never through npx or an absolute path). Keep the inherited STIM_HOME unchanged. Run \`stim start\`, then run \`stim android --system-image ${JSON.stringify(pins.ANDROID_SYSTEM_IMAGE)}\`. Leave Metro and the changed app running until the screenshot is saved.`;
  }
  if (platform === 'android') {
    return `Use only the project's local Expo and Android SDK tooling; do not use Stim. Create a new AVD named exactly ${JSON.stringify(`Trailhead_${runId}`)} from ${JSON.stringify(pins.ANDROID_SYSTEM_IMAGE)} using avdmanager's default hardware profile, matching Stim; do not use an existing emulator. Set disk.dataPartition.size=8589934592 in its config.ini, matching Stim's default 8 GiB data partition. Boot it with -no-snapshot-save and -no-snapshot-load, then wait for Android boot completion. ${startMetro ? 'Start Metro detached. ' : ''}Build, install, and launch only the default Debug variant; do not use a Release variant. Start that native build/install/launch as a shell background process with its PID and log under /tmp, then poll it using repeated short foreground shell calls such as \`ps -p <pid>\` and \`tail\`; do not use a long blocking shell call or end the turn while waiting. After it finishes successfully, immediately perform the agent-device proof. Leave the emulator${startMetro ? ', Metro,' : ''} and app running. `;
  }
  return `Run the iOS app with the project's local Expo and Apple tooling on a new iPhone 17 simulator running iOS 26.5; do not use an existing simulator. ${startMetro ? 'Start Metro detached. ' : ''}Start the native build/install/launch as a shell background process with its PID and log under /tmp, then poll it using repeated short foreground shell calls such as \`ps -p <pid>\` and \`tail\`; do not use a long blocking shell call or end the turn while waiting. After it finishes successfully, immediately perform the agent-device proof. Leave the changed app running. Do not use Stim.`;
}

function runnerForModel(model) {
  return ['sonnet', 'opus'].includes(model) || model.startsWith('claude-') ? 'claude' : 'codex';
}

function writeClaudeGuidance(codexHome, arm, runDir) {
  const skillNames = arm === 'stim' ? ['agent-device', 'stim'] : ['agent-device'];
  const guidance = skillNames
    .map((name) => readFileSync(join(codexHome, 'skills', name, 'SKILL.md'), 'utf8'))
    .join('\n\n');
  const path = join(runDir, 'runner-guidance.md');
  writeFileSync(path, `${guidance}\n`);
  return { path, skillNames };
}

function makeRunnerHome(runDir, arm) {
  if (!codexAuthPath || !agentSkillsRoot) {
    throw new Error('STIM_BENCH_CODEX_AUTH and STIM_BENCH_SKILLS_ROOT are required');
  }
  const home = join(runDir, 'runner-home');
  const codexHome = join(home, '.codex');
  mkdirSync(codexHome, { recursive: true });
  copyFileSync(codexAuthPath, join(codexHome, 'auth.json'));
  chmodSync(join(codexHome, 'auth.json'), 0o600);
  const selectedSkills = [
    {
      name: 'agent-device',
      source: join(agentSkillsRoot, 'agent-device'),
    },
  ];
  if (arm === 'stim') {
    selectedSkills.push({
      name: 'stim',
      source: join(stimPackage, 'skill'),
    });
  }
  for (const skill of selectedSkills) {
    const target = join(codexHome, 'skills', skill.name);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(skill.source, target, { recursive: true });
  }
  const skillRoot = agentSkillsRoot;
  const skillPaths = [];
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      if (entry.isFile() && entry.name === 'SKILL.md') {
        skillPaths.push(realpathSync(child));
      }
    }
  }
  visit(skillRoot);
  const config = [
    'service_tier = "priority"',
    'model_reasoning_effort = "high"',
    '',
    '[features]',
    'plugins = false',
    'multi_agent = false',
    '',
    '[skills]',
    'include_instructions = true',
    '',
    '[skills.bundled]',
    'enabled = false',
    ...skillPaths.flatMap((path) => ['', '[[skills.config]]', `path = ${JSON.stringify(path)}`, 'enabled = false']),
    '',
  ].join('\n');
  writeFileSync(join(codexHome, 'config.toml'), config);
  return { codexHome };
}

function verifyRunnerProfile(codexHome, env, arm, runDir) {
  const path = join(runDir, 'prompt-input.json');
  const output = run(executablePath(codexBin), ['debug', 'prompt-input', 'profile smoke'], {
    cwd: main,
    env,
    timeout: 30_000,
  });
  writeFileSync(path, `${output}\n`);
  const payload = JSON.parse(output);
  const textParts = payload.flatMap((item) => item.content ?? []).map((item) => item.text ?? '');
  const skillsText = textParts.find((text) => text.includes('<skills_instructions>')) ?? '';
  const skillLines = skillsText.match(/^- [a-zA-Z0-9:_-]+:/gm) ?? [];
  const expectedSkills = arm === 'stim' ? ['agent-device', 'stim'] : ['agent-device'];
  const actualSkills = skillLines.map((line) => line.slice(2, -1)).toSorted();
  if (JSON.stringify(actualSkills) !== JSON.stringify(expectedSkills)) {
    throw new Error(`${arm} runner skill mismatch: ${skillLines.join(', ')}`);
  }
  return { codexHome, skillLines };
}

function smoke(arm) {
  if (!['stim', 'control'].includes(arm)) {
    throw new Error('smoke requires <stim|control>');
  }
  ensureDirs();
  prepareAllowedBin();
  const runDir = join(state, `smoke-${arm}`);
  const runId = `smoke-${arm}`;
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const { codexHome } = makeRunnerHome(runDir, arm);
  const env = {
    ...cleanRubyEnvironment(process.env),
    CODEX_HOME: codexHome,
    STIM_HOME: join(runDir, 'stim-home'),
    AGENT_DEVICE_STATE_DIR: agentDeviceState,
    AGENT_DEVICE_SESSION: runId,
    PATH: `${arm === 'stim' ? `${stimBin}:` : ''}${allowedBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  if (arm === 'stim') env.STIM_POOL_IOS_PARKED_MAX = '1';
  env.BENCH_STIM_HOME = env.STIM_HOME;
  const profile = verifyRunnerProfile(codexHome, env, arm, runDir);
  const resolvedStim = run('/bin/sh', ['-c', 'command -v stim || true'], {
    cwd: main,
    env,
  });
  if (arm === 'control' && resolvedStim) {
    throw new Error(`control resolved Stim: ${resolvedStim}`);
  }
  if (arm === 'stim' && resolvedStim !== join(stimBin, 'stim')) {
    throw new Error(`Stim profile resolved unexpected binary: ${resolvedStim}`);
  }
  const stimStatus = arm === 'stim' ? JSON.parse(run('stim', ['status', '--json'], { cwd: main, env })) : null;
  const smokeRecord = { checkedAt: new Date().toISOString(), arm, profile, resolvedStim, stimStatus };
  writeFileSync(join(runDir, 'smoke.json'), `${JSON.stringify(smokeRecord, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(smokeRecord, null, 2)}\n`);
}

async function runnerSmoke(arm) {
  smoke(arm);
  const runDir = join(state, `runner-smoke-${arm}`);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const { codexHome } = makeRunnerHome(runDir, arm);
  const env = {
    ...cleanRubyEnvironment(process.env),
    CODEX_HOME: codexHome,
    PATH: `${arm === 'stim' ? `${stimBin}:` : ''}${allowedBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  const result = await spawnStamped(
    executablePath(codexBin),
    [
      '--ask-for-approval',
      'never',
      'exec',
      '--strict-config',
      '--ignore-rules',
      '--json',
      '--model',
      'gpt-5.6-luna',
      '--sandbox',
      'read-only',
      '--cd',
      main,
      '-',
    ],
    join(runDir, 'events.jsonl'),
    { cwd: main, env, stdio: ['pipe', 'pipe', 'pipe'] },
    'Reply OK only.',
  );
  const usage = usageFromEvents(join(runDir, 'events.jsonl'));
  if (result.code !== 0 || !usage) {
    throw new Error(`runner smoke failed: ${JSON.stringify({ result, usage })}`);
  }
  process.stdout.write(`${JSON.stringify({ arm, result, usage }, null, 2)}\n`);
}

function spawnStamped(command, args, output, options, input, timeoutMs = null) {
  const child = spawn(command, args, options);
  let timedOut = false;
  const timeout = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs)
    : null;
  const stampOut = spawn('node', [join(scriptRoot, 'stamp.mjs'), 'stdout'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const stampErr = spawn('node', [join(scriptRoot, 'stamp.mjs'), 'stderr'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const outChunks = [];
  const errChunks = [];
  stampOut.stdout.on('data', (chunk) => outChunks.push(chunk));
  stampErr.stdout.on('data', (chunk) => errChunks.push(chunk));
  child.stdout.pipe(stampOut.stdin);
  child.stderr.pipe(stampErr.stdin);
  child.stdin.end(input);
  const stampOutClosed = new Promise((done) => stampOut.on('close', done));
  const stampErrClosed = new Promise((done) => stampErr.on('close', done));
  return new Promise((resolvePromise) => {
    child.on('close', (code, signal) => {
      if (timeout) clearTimeout(timeout);
      stampOut.stdin.end();
      stampErr.stdin.end();
      return Promise.all([stampOutClosed, stampErrClosed]).then(() => {
        const lines = [outChunks, errChunks]
          .flatMap((chunks) => Buffer.concat(chunks).toString('utf8').split('\n'))
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .toSorted((a, b) => a.arrivedAt.localeCompare(b.arrivedAt));
        writeFileSync(output, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
        writeFileSync(
          join(dirname(output), 'runner-stream.jsonl'),
          lines
            .filter((line) => line.stream === 'stdout')
            .map((line) => line.line)
            .join('\n') + '\n',
        );
        return resolvePromise({ code, signal, timedOut });
      });
    });
  });
}

async function dispatch(model, arm, variant, stage = 'pilot', requestedPlatform = 'ios') {
  const platform = checkedPlatform(requestedPlatform);
  if (!model || !['stim', 'control'].includes(arm)) {
    throw new Error('dispatch requires <model> <stim|control> <javascript|native|launch-crash> [stage] [ios|android]');
  }
  if (!['javascript', 'native', launchCrashVariant].includes(variant)) {
    throw new Error(`unsupported variant: ${variant}`);
  }
  if (platform === 'android' && variant === launchCrashVariant) {
    throw new Error('the launch-crash benchmark currently supports iOS only');
  }
  const preflightReport = preflight(platform);
  preflightReport.loadGate = await waitForLoadGate();
  if (!preflightReport.loadGate.passed) {
    throw new Error('one-minute load average did not pass two consecutive samples within 10 minutes');
  }
  const platformGolden = goldenFor(platform);
  const readyPath = join(platformGolden, 'READY.json');
  if (!existsSync(readyPath)) {
    throw new Error('golden is not prepared; run bench.mjs prepare first');
  }
  const ready = JSON.parse(readFileSync(readyPath, 'utf8'));
  if (ready.stimVersion !== pins.STIM_VERSION || ready.stimIntegrity !== pins.STIM_INTEGRITY) {
    throw new Error(
      `golden Stim package ${ready.stimVersion} (${ready.stimIntegrity}) does not match the published pin`,
    );
  }
  if (arm === 'stim' && ready.stimCliSha256 !== sha256(stimCli)) {
    throw new Error('pinned Stim CLI bytes do not match the prepared golden state');
  }
  const expectedBuildCache = verifyGoldenCache(platform, platformGolden);
  const expectedParkedSimulator = platform === 'ios' ? verifyGoldenParkedSimulator() : null;
  const runId = `${stage}-${model.replaceAll('.', '-')}-${variant}-${arm}-${Date.now()}`;
  const expectedControlSimulator = {
    name: platform === 'ios' ? `Trailhead ${runId}` : `Trailhead_${runId}`,
    deviceTypeIdentifier:
      platform === 'ios' ? 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' : ready.deviceTypeIdentifier,
    runtimeIdentifier: platform === 'ios' ? 'com.apple.CoreSimulator.SimRuntime.iOS-26-5' : ready.runtimeIdentifier,
    ...(platform === 'android' ? { systemImage: ready.systemImage } : {}),
  };
  const expectedStimDevice =
    platform === 'android'
      ? {
          namePrefix: 'stim-',
          deviceTypeIdentifier: ready.deviceTypeIdentifier,
          runtimeIdentifier: ready.runtimeIdentifier,
          systemImage: ready.systemImage,
        }
      : expectedParkedSimulator;
  const runDir = join(results, stage, runId);
  mkdirSync(join(runDir, 'proof'), { recursive: true });
  mkdirSync(join(runDir, 'raw'), { recursive: true });
  const before = deviceSnapshot(platform);
  writeFileSync(join(runDir, 'devices-before.json'), `${JSON.stringify(before, null, 2)}\n`);
  if (platform === 'android') {
    writeFileSync(join(runDir, 'avds-before.json'), `${JSON.stringify(androidAvdSnapshot(), null, 2)}\n`);
  }
  const runnerKind = runnerForModel(model);
  const { codexHome } = makeRunnerHome(runDir, arm);
  const runTmp = join(runDir, 'tmp');
  mkdirSync(runTmp, { recursive: true });
  run('cp', ['-cR', `${join(platformGolden, 'control-tmp')}/.`, runTmp], {
    cwd: root,
    timeout: 5 * 60 * 1000,
  });
  const env = {
    ...cleanRubyEnvironment(process.env),
    CODEX_HOME: codexHome,
    STIM_HOME: join(runDir, 'stim-home'),
    TMPDIR: runTmp,
    PATH: `${arm === 'stim' ? `${stimBin}:` : ''}${allowedBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  if (arm === 'stim' && platform === 'ios') env.STIM_POOL_IOS_PARKED_MAX = '1';
  env.BENCH_STIM_HOME = env.STIM_HOME;
  mkdirSync(env.STIM_HOME, { recursive: true });
  if (arm === 'stim') {
    run('cp', ['-cR', `${join(platformGolden, 'stim-home')}/.`, env.STIM_HOME], {
      cwd: root,
      timeout: 10 * 60 * 1000,
    });
  }
  const crash = variant === launchCrashVariant ? prepareLaunchCrashFixture(arm, runId, env) : null;
  const prompt = promptFor(arm, variant, runId, runDir, crash, platform);
  writeFileSync(join(runDir, 'prompt.txt'), `${prompt}\n`);
  const profile = verifyRunnerProfile(codexHome, env, arm, runDir);
  const claudeGuidance = runnerKind === 'claude' ? writeClaudeGuidance(codexHome, arm, runDir) : null;
  const agentDevice = prepareAgentDeviceRun(runId, platform, expectedParkedSimulator?.udid ?? null);
  const dispatchAt = new Date().toISOString();
  const meta = {
    schemaVersion: 1,
    runId,
    stage,
    runner: runnerKind,
    model,
    requestedServiceTier: 'priority',
    arm,
    variant,
    platform,
    worktreeParent,
    deviceTargetingRequired: true,
    dispatchAt,
    preflight: preflightReport,
    profile: { ...profile, claudeGuidance },
    expectedBuildCache,
    expectedParkedSimulator,
    expectedStimDevice,
    expectedControlSimulator,
    agentDevice,
    crash,
  };
  writeFileSync(join(runDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);

  const watcher = spawn(
    'node',
    [
      join(scriptRoot, 'watch-app.mjs'),
      join(runDir, 'devices-before.json'),
      join(runDir, 'app-alive.json'),
      dispatchAt,
      variant === launchCrashVariant ? 'native' : variant,
      arm,
      expectedParkedSimulator?.udid ?? '',
      expectedControlSimulator.name,
      expectedControlSimulator.deviceTypeIdentifier ?? '',
      expectedControlSimulator.runtimeIdentifier,
      platform,
      expectedStimDevice?.namePrefix ?? '',
      expectedControlSimulator.systemImage ?? '',
      `Trailhead ${runId}`,
    ],
    { cwd: main, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const watcherClosed = new Promise((resolvePromise) => {
    watcher.on('close', (code, signal) => resolvePromise({ code, signal }));
  });
  const runnerCommand = executablePath(runnerKind === 'claude' ? claudeBin : codexBin);
  const runnerCwd = crash?.fixtureCheckout ?? main;
  const runnerArgs =
    runnerKind === 'claude'
      ? [
          '-p',
          '--output-format',
          'stream-json',
          '--verbose',
          '--model',
          model,
          '--effort',
          'high',
          '--safe-mode',
          '--strict-mcp-config',
          '--permission-mode',
          'acceptEdits',
          '--prompt-suggestions',
          'false',
          '--append-system-prompt-file',
          claudeGuidance.path,
          '--allowedTools',
          variant === launchCrashVariant ? 'Bash' : 'Bash,Edit,Read',
        ]
      : [
          '--ask-for-approval',
          'never',
          'exec',
          '--strict-config',
          '--ignore-rules',
          '--json',
          '--model',
          model,
          '--sandbox',
          'danger-full-access',
          '--add-dir',
          dirname(runDir),
          '--cd',
          runnerCwd,
          '-',
        ];
  const runner = spawnStamped(
    runnerCommand,
    runnerArgs,
    join(runDir, 'events.jsonl'),
    { cwd: runnerCwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
    prompt,
    25 * 60 * 1000,
  );
  const runnerResult = await runner;
  const watcherResult = await watcherClosed;
  meta.runnerResult = runnerResult;
  meta.watcherResult = watcherResult;
  meta.finishedAt = new Date().toISOString();
  writeFileSync(join(runDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  process.stdout.write(`${runDir}\n`);
}

function runnerMetricsFromEvents(eventsPath, runner) {
  if (!existsSync(eventsPath)) return null;
  const lines = readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const stamped = JSON.parse(lines[index]);
    try {
      const event = JSON.parse(stamped.line);
      if (runner === 'claude' && event.type === 'result') {
        const usage = event.usage ?? {};
        const cachedInput = usage.cache_read_input_tokens ?? 0;
        const cacheCreationInput = usage.cache_creation_input_tokens ?? 0;
        return {
          usage: {
            input_tokens: (usage.input_tokens ?? 0) + cachedInput + cacheCreationInput,
            cached_input_tokens: cachedInput,
            cache_creation_input_tokens: cacheCreationInput,
            output_tokens: usage.output_tokens ?? 0,
            reasoning_output_tokens: usage.output_tokens_details?.thinking_tokens ?? 0,
          },
          reportedCostUsd: event.total_cost_usd ?? null,
          returnedServiceTier: usage.service_tier ?? null,
          modelUsage: event.modelUsage ?? null,
          terminalReason: event.terminal_reason ?? null,
          isError: Boolean(event.is_error),
          subagentsSpawned: event.subagent_stats?.spawned ?? 0,
        };
      }
      if (runner !== 'claude' && event.type === 'turn.completed') {
        return { usage: event.usage };
      }
    } catch {}
  }
  return null;
}

function usageFromEvents(eventsPath) {
  return runnerMetricsFromEvents(eventsPath, 'codex')?.usage ?? null;
}

function usageFromRollout(rolloutPath) {
  if (!rolloutPath || !existsSync(rolloutPath)) return null;
  const lines = readFileSync(rolloutPath, 'utf8').trim().split('\n').filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const event = JSON.parse(lines[index]);
    const usage = event.payload?.info?.total_token_usage;
    if (event.type === 'event_msg' && event.payload?.type === 'token_count' && usage) {
      return usage;
    }
  }
  return null;
}

function usageAtOrBefore(rolloutPath, observedAt) {
  if (!rolloutPath || !existsSync(rolloutPath) || !observedAt) return null;
  const cutoff = Date.parse(observedAt);
  if (!Number.isFinite(cutoff)) return null;
  const lines = readFileSync(rolloutPath, 'utf8').trim().split('\n').filter(Boolean);
  let result = null;
  for (const line of lines) {
    const event = JSON.parse(line);
    const timestamp = Date.parse(event.timestamp);
    const usage = event.payload?.info?.total_token_usage;
    if (
      event.type === 'event_msg' &&
      event.payload?.type === 'token_count' &&
      usage &&
      Number.isFinite(timestamp) &&
      timestamp <= cutoff
    ) {
      result = usage;
    }
  }
  return result;
}

function tokensFromUsage(usage) {
  if (!usage) return null;
  const input = usage.input_tokens ?? 0;
  const cached = usage.cached_input_tokens ?? 0;
  return {
    uncachedInput: Math.max(0, input - cached),
    cachedInput: cached,
    output: usage.output_tokens ?? 0,
    reasoningOutput: usage.reasoning_output_tokens ?? 0,
  };
}

function commandEvidence(meta, eventsPath, runDir) {
  if (!existsSync(eventsPath)) {
    return { commands: [], activities: [], completedEvents: [], invalidReasons: [] };
  }
  const stamped = readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const started = new Map();
  const commands = [];
  const activities = [];
  const completedEvents = [];
  const completeCommand = (id, item, record, offset) => {
    const begin = started.get(id);
    const elapsedSeconds = begin ? (Date.parse(record.arrivedAt) - Date.parse(begin.at)) / 1000 : null;
    commands.push({
      id,
      command: item.command ?? begin?.command ?? null,
      startedAt: begin?.at ?? null,
      endedAt: record.arrivedAt,
      elapsedSeconds,
      parallelTimingAmbiguous: !begin,
      exitCode: item.exit_code,
      startEventOffset: begin?.offset ?? null,
      endEventOffset: offset,
      output: item.aggregated_output ?? '',
    });
    completedEvents.push(item);
  };
  for (const [offset, record] of stamped.entries()) {
    let event;
    try {
      event = JSON.parse(record.line);
    } catch {
      continue;
    }
    if (meta.runner === 'claude') {
      for (const block of event.message?.content ?? []) {
        if (event.type === 'assistant' && block.type === 'tool_use' && block.name !== 'Bash') {
          activities.push({
            id: block.id,
            command: `tool:${block.name} ${JSON.stringify(block.input ?? {})}`,
            startedAt: record.arrivedAt,
            endedAt: record.arrivedAt,
          });
        }
        if (event.type === 'assistant' && block.type === 'tool_use' && block.name === 'Bash') {
          started.set(block.id, {
            offset,
            at: record.arrivedAt,
            command: block.input?.command ?? null,
          });
        }
        if (event.type === 'user' && block.type === 'tool_result' && started.has(block.tool_use_id)) {
          const result = event.tool_use_result ?? {};
          const output = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? result);
          completeCommand(
            block.tool_use_id,
            {
              type: 'command_execution',
              command: started.get(block.tool_use_id)?.command ?? null,
              aggregated_output: output,
              exit_code: Number.isInteger(result.exit_code)
                ? result.exit_code
                : block.is_error || result.is_error
                  ? 1
                  : 0,
            },
            record,
            offset,
          );
        }
      }
      continue;
    }
    const item = event.item;
    if (event.type === 'item.started' && item?.type && item.type !== 'command_execution') {
      activities.push({
        id: item.id,
        command: `tool:${item.type} ${JSON.stringify(item.changes ?? item)}`,
        startedAt: record.arrivedAt,
        endedAt: record.arrivedAt,
      });
    }
    if (event.type === 'item.started' && item?.type === 'command_execution') {
      started.set(item.id, { offset, at: record.arrivedAt, command: item.command });
    }
    if (event.type === 'item.completed' && item?.type === 'command_execution') {
      completeCommand(item.id, item, record, offset);
    }
  }
  writeFileSync(join(runDir, 'commands.log'), `${commands.map((command) => JSON.stringify(command)).join('\n')}\n`);
  const commandText = commands.map((command) => command.command ?? '').join('\n');
  const outputText = completedEvents.map((item) => item.aggregated_output ?? '').join('\n');
  const invalidReasons = [];
  if (meta.arm === 'control' && /(^|[\s;&|])(?:npx\s+)?stim(?:-cli)?([\s;&|]|$)/m.test(commandText)) {
    invalidReasons.push('control-used-stim');
  }
  if (meta.arm === 'stim') {
    if (/(?:^|[\s;&|])(?:export\s+)?STIM_HOME\s*=(?!%s)/m.test(commandText)) {
      invalidReasons.push('stim-home-overridden');
    }
    if (/\bnpx\s+(?:--yes\s+)?stim(?:-cli)?\b/.test(commandText)) {
      invalidReasons.push('stim-invoked-through-npx');
    }
    const invokedPlatform = new RegExp(`\\bstim\\s+${meta.platform ?? 'ios'}\\b`).test(commandText);
    if (!invokedPlatform) invalidReasons.push(`stim-${meta.platform ?? 'ios'}-command-missing`);
    if (isJavascriptVariant(meta.variant) && !/fingerprint\s+[0-9a-f]{6}\.\.\s+hit\b/.test(outputText)) {
      invalidReasons.push('stim-build-cache-hit-missing');
    }
    if ((meta.platform ?? 'ios') === 'ios' && !/device\s+.+\sadopted\s+\(/.test(outputText)) {
      invalidReasons.push('stim-parked-adoption-missing');
    }
  }
  const topLevelCommands = commands.map((command) => topLevelShellCommand(command.command));
  if (
    meta.arm === 'control' &&
    meta.platform === 'android' &&
    meta.variant === 'native' &&
    topLevelCommands.some((command) => /(?:--variant\s+release\b|\bassembleRelease\b)/i.test(command))
  ) {
    invalidReasons.push('android-native-control-used-release-build');
  }
  if (topLevelCommands.some((command) => /(?:^|\s)agent-device\s+daemon\s+stop(?:\s|$)/.test(command))) {
    invalidReasons.push('agent-device-daemon-recovery-inside-timer');
  }
  const expectedAgentDevicePrefix = agentDeviceCommand(meta, '');
  const agentDeviceCommands = topLevelCommands.filter((command) => /(?:^|\s)agent-device(?:\s|$)/.test(command));
  if (agentDeviceCommands.some((command) => !command.startsWith(expectedAgentDevicePrefix))) {
    invalidReasons.push('agent-device-run-session-not-applied');
  }
  return { commands, activities, completedEvents, invalidReasons };
}

function topLevelShellCommand(command) {
  const trimmed = String(command ?? '').trim();
  const match = trimmed.match(/^\/bin\/(?:zsh|bash|sh) -lc (["'])([\s\S]*)\1$/);
  return (match?.[2] ?? trimmed).trim();
}

function agentDeviceOpenCommand(meta, appAlive) {
  const prefix = agentDeviceCommand(meta, 'open com.appandflow.trailhead --foreground');
  if (!meta.deviceTargetingRequired) return prefix;
  const platform = meta.platform ?? 'ios';
  const targetFlag = platform === 'android' ? '--serial' : '--udid';
  return `${prefix} --platform ${platform} ${targetFlag} ${appAlive.simulator?.udid ?? '<missing-run-device>'}`;
}

function nativeMarkerObserved(items, openCommand, expected) {
  let opened = false;
  for (const item of items) {
    if (item.exit_code === 0 && topLevelShellCommand(item.command) === openCommand) {
      opened = true;
    }
    if (
      opened &&
      item.exit_code === 0 &&
      item.command?.includes('agent-device ') &&
      item.aggregated_output?.includes(`[window] "${expected}"`)
    ) {
      return true;
    }
  }
  return false;
}

function androidBuildTool(name) {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!sdk) return null;
  const buildTools = join(sdk, 'build-tools');
  if (!existsSync(buildTools)) return null;
  return readdirSync(buildTools)
    .toSorted((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    .map((version) => join(buildTools, version, name))
    .find((path) => existsSync(path));
}

function installedAndroidNativeMarker(meta, appAlive, runDir, expected) {
  const serial = appAlive.simulator?.udid;
  const target = join(runDir, 'proof', 'native-application-label.txt');
  if (existsSync(target)) {
    const preserved = readFileSync(target, 'utf8');
    const observedSerial = preserved.match(/^serial=(.*)$/m)?.[1] ?? null;
    const label = preserved.match(/^application-label=(.*)$/m)?.[1] ?? null;
    return {
      valid: observedSerial === serial && label === expected,
      kind: 'installed-android-apk-label',
      expected,
      observed: label,
      target,
    };
  }
  const aapt = androidBuildTool('aapt');
  if (!serial || !aapt) return { valid: false, reason: 'android-native-proof-tool-missing' };
  let packagePath;
  try {
    packagePath = run('adb', ['-s', serial, 'shell', 'pm', 'path', 'com.appandflow.trailhead'])
      .split('\n')
      .find((line) => line.startsWith('package:') && line.endsWith('/base.apk'))
      ?.slice('package:'.length);
  } catch {
    return { valid: false, reason: 'android-installed-apk-missing' };
  }
  if (!packagePath) return { valid: false, reason: 'android-installed-apk-missing' };
  const temporaryApk = join('/tmp', `${meta.runId}-installed-base.apk`);
  try {
    run('adb', ['-s', serial, 'pull', packagePath, temporaryApk], { timeout: 2 * 60 * 1000 });
    const label = androidApplicationLabelFromBadging(run(aapt, ['dump', 'badging', temporaryApk], { timeout: 30_000 }));
    writeFileSync(target, `serial=${serial}\napplication-label=${label ?? ''}\n`);
    return {
      valid: label === expected,
      kind: 'installed-android-apk-label',
      expected,
      observed: label,
      target,
    };
  } finally {
    if (existsSync(temporaryApk)) rmSync(temporaryApk);
  }
}

function screenEvidence(meta, appAlive, commands, runDir) {
  const target = join(runDir, 'proof', 'settings.png');
  const screenshotScratch = join('/tmp', `${meta.runId}-settings.png`);
  const recording = join(runDir, 'proof', 'session.mp4');
  const expected = settingsProofText(meta.variant);
  const openCommand = agentDeviceOpenCommand(meta, appAlive);
  const required = [
    agentDeviceCommand(meta, `record start ${recording} --scope device --quality high --hide-touches`),
    agentDeviceCommand(meta, `wait text ${JSON.stringify(expected)}`),
    agentDeviceCommand(meta, `screenshot ${screenshotScratch}`),
    `cp ${screenshotScratch} ${target}`,
    agentDeviceCommand(meta, 'record stop'),
    agentDeviceCommand(meta, 'close'),
  ];
  const indexes = [];
  let after = -1;
  const openIndex = commands.findIndex(
    (command) => command.exitCode === 0 && topLevelShellCommand(command.command) === openCommand,
  );
  if (openIndex === -1) {
    return {
      valid: false,
      reason: `missing-successful-command:${openCommand}`,
      expected,
      target,
    };
  }
  const session = meta.agentDevice?.session ?? meta.runId;
  const expectedSessionState = `Session state: ${meta.agentDevice?.stateDir ?? agentDeviceState}/sessions/${session}`;
  if (!commands[openIndex].output.includes(expectedSessionState)) {
    return {
      valid: false,
      reason: 'agent-device-open-used-wrong-session',
      expected,
      target,
    };
  }
  indexes.push(openIndex);
  after = openIndex;
  for (const needle of required) {
    const index = commands.findIndex(
      (command, offset) => offset > after && command.exitCode === 0 && topLevelShellCommand(command.command) === needle,
    );
    if (index === -1) {
      return {
        valid: false,
        reason: `missing-successful-command:${needle}`,
        expected,
        target,
      };
    }
    indexes.push(index);
    after = index;
  }
  if (!existsSync(target)) {
    return { valid: false, reason: 'settings-screenshot-missing', expected, target };
  }
  const signature = readFileSync(target).subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') {
    return { valid: false, reason: 'settings-screenshot-not-png', expected, target };
  }
  let dimensions;
  try {
    const metadata = run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', target]);
    dimensions = {
      width: Number(metadata.match(/pixelWidth:\s+(\d+)/)?.[1]),
      height: Number(metadata.match(/pixelHeight:\s+(\d+)/)?.[1]),
    };
  } catch {
    return { valid: false, reason: 'settings-screenshot-unreadable', expected, target };
  }
  if (dimensions.width < 300 || dimensions.height < 600) {
    return {
      valid: false,
      reason: 'settings-screenshot-too-small',
      expected,
      target,
      dimensions,
    };
  }
  const screenshotCommand = commands[indexes[3]];
  return {
    valid: true,
    kind: 'agent-device-settings-screenshot',
    expected,
    target,
    bytes: statSync(target).size,
    dimensions,
    observedAt: screenshotCommand.endedAt,
    openCommandId: commands[indexes[0]].id,
    recordStartCommandId: commands[indexes[1]].id,
    waitCommandId: commands[indexes[2]].id,
    screenshotCommandId: screenshotCommand.id,
    copyCommandId: commands[indexes[4]].id,
    recordStopCommandId: commands[indexes[5]].id,
    closeCommandId: commands[indexes[6]].id,
    dispatchToScreenReadySeconds: (Date.parse(screenshotCommand.endedAt) - Date.parse(meta.dispatchAt)) / 1000,
    commands: [openCommand, ...required],
  };
}

function recordingEvidence(meta, commands, runDir, screen) {
  const target = join(runDir, 'proof', 'session.mp4');
  const start = commands.find((command) => command.id === screen.recordStartCommandId);
  const stop = commands.find((command) => command.id === screen.recordStopCommandId);
  if (!screen.valid || !start || !stop || start.exitCode !== 0 || stop.exitCode !== 0) {
    return { valid: false, reason: 'simulator-recording-commands-missing', target };
  }
  if (!existsSync(target)) return { valid: false, reason: 'simulator-recording-missing', target };
  const bytes = readFileSync(target);
  if (bytes.length < 1_000 || bytes.subarray(4, 8).toString('ascii') !== 'ftyp') {
    return { valid: false, reason: 'simulator-recording-invalid-mp4', target };
  }
  return {
    valid: true,
    kind: 'agent-device-simulator-recording',
    target,
    bytes: bytes.length,
    startedAt: start.endedAt,
    endedAt: stop.endedAt,
    startCommandId: start.id,
    stopCommandId: stop.id,
  };
}

function runWorktreeParent(meta) {
  return resolve(
    meta.worktreeParent ?? (meta.crash?.fixtureCheckout ? dirname(meta.crash.fixtureCheckout) : worktreeParent),
  );
}

function findRunWorktree(runId, parent = worktreeParent) {
  const entries = git('worktree', 'list', '--porcelain').split('\n\n');
  for (const entry of entries) {
    const lines = entry.split('\n');
    const branch = lines.find((line) => line.startsWith('branch '))?.slice(7);
    const path = lines.find((line) => line.startsWith('worktree '))?.slice(9);
    if (
      path &&
      (branch === `refs/heads/bench/${runId}` || branch === `refs/heads/worktree-bench/${runId}`) &&
      validRunWorktree(path, runId, parent)
    )
      return path;
  }
  return null;
}

function validRunWorktree(path, runId, parent = worktreeParent) {
  const absolute = resolve(path);
  const prefix = `${parent}/`;
  if (!absolute.startsWith(prefix)) return false;
  const segments = absolute.slice(prefix.length).split('/');
  return segments.some(
    (segment) =>
      segment === runId ||
      segment === `bench-${runId}` ||
      segment === `bench+${runId}` ||
      segment === `bench%2F${runId}`,
  );
}

function worktreeFromEvents(eventsPath, runId, parent = worktreeParent) {
  if (!existsSync(eventsPath)) return null;
  const prefix = `${parent}/`;
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pathPattern = new RegExp(`${escapedPrefix}[^\\s'"]+`, 'g');
  const candidates = new Set();
  const lines = readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(JSON.parse(line).line);
    } catch {
      continue;
    }
    const claudeBlocks = event.message?.content ?? [];
    const texts = [
      event.item?.command,
      event.item?.aggregated_output,
      event.item?.text,
      event.result,
      ...claudeBlocks.flatMap((block) => [
        block.input?.command,
        typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
      ]),
    ];
    for (const text of texts) {
      if (typeof text !== 'string') continue;
      for (const token of text.matchAll(pathPattern)) {
        const absolute = resolve(token[0].replace(/[`)\]}>.,]+$/, ''));
        if (!absolute.startsWith(prefix)) continue;
        const segments = absolute.slice(prefix.length).split('/');
        let end = -1;
        for (let index = 0; index < segments.length; index += 1) {
          if (
            segments[index] === runId ||
            segments[index] === `bench-${runId}` ||
            segments[index] === `bench+${runId}` ||
            segments[index] === `bench%2F${runId}`
          )
            end = index;
        }
        if (end >= 0) {
          candidates.add(join(parent, ...segments.slice(0, end + 1)));
        }
      }
    }
  }
  const ordered = [...candidates].toSorted((left, right) => right.length - left.length);
  if (ordered.length === 0) return null;
  const deepest = ordered[0];
  return ordered.every((candidate) => candidate === deepest || deepest.startsWith(`${candidate}/`)) ? deepest : null;
}

function worktreeEvidence(runDir, meta, eventsPath) {
  const parent = runWorktreeParent(meta);
  const live = findRunWorktree(meta.runId, parent);
  if (live) return { path: live, source: 'live-git-worktree' };
  const events = worktreeFromEvents(eventsPath, meta.runId, parent);
  if (events) return { path: events, source: 'stamped-events' };
  const recordPath = join(runDir, 'run.json');
  if (existsSync(recordPath)) {
    const preserved = JSON.parse(readFileSync(recordPath, 'utf8')).worktree;
    if (preserved && validRunWorktree(preserved, meta.runId, parent)) {
      return { path: preserved, source: 'preserved-run-record' };
    }
  }
  return null;
}

function copyRollout(runDir) {
  const sessionRoot = join(runDir, 'runner-home', '.codex', 'sessions');
  if (!existsSync(sessionRoot)) return null;
  const files = [];
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(child);
    }
  }
  visit(sessionRoot);
  if (files.length !== 1) return null;
  const target = join(runDir, 'rollout.jsonl');
  copyFileSync(files[0], target);
  return target;
}

function proofFor(meta, appAlive, runDir, worktree, commandItems) {
  if (meta.variant === launchCrashVariant) {
    if (!worktree) {
      return { valid: false, reason: 'launch-crash-worktree-missing' };
    }
    const sourcePath = join(worktree, meta.crash.sourceRelative);
    if (!existsSync(sourcePath)) {
      return { valid: false, reason: 'launch-crash-source-missing', sourcePath };
    }
    const source = readFileSync(sourcePath, 'utf8');
    const repair = launchCrashRepair(source, meta.crash.token, meta.crash.originalSha256);
    if (!repair.valid) return { ...repair, sourcePath };
    const sourceSha256 = repair.sourceSha256;
    const changedPaths = changedPathsFromGitOutputs(
      run('git', ['diff', '--name-only', '-z', 'HEAD'], { cwd: worktree }),
      run('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: worktree }),
    );
    if (changedPaths.length !== 1 || changedPaths[0] !== meta.crash.sourceRelative) {
      return {
        valid: false,
        reason: 'launch-crash-unrelated-source-changes',
        sourcePath,
        changedPaths,
      };
    }
    return {
      valid: true,
      kind: 'launch-crash-source-repair',
      expected: `${meta.crash.token} removed and original source restored`,
      target: sourcePath,
      sourceSha256,
      changedPaths,
    };
  }
  if (appAlive.proof?.valid && existsSync(appAlive.proof.target)) {
    return appAlive.proof;
  }
  if (appAlive.error === 'proof-timeout-after-app-alive') {
    return { valid: false, reason: 'changed-metro-bundle-not-found' };
  }
  if (meta.variant === 'javascript') {
    const expected = 'Keep saved trail maps available offline';
    const proofDir = join(runDir, 'proof');
    const preserved = existsSync(proofDir)
      ? readdirSync(proofDir)
          .filter((name) => name.endsWith('.bundle'))
          .map((name) => join(proofDir, name))
          .find((path) => {
            try {
              run('grep', ['-a', '-F', '-q', expected, path]);
              return true;
            } catch {
              return false;
            }
          })
      : null;
    if (preserved) {
      const port = Number(preserved.match(/metro-(\d+)/)?.[1]);
      return {
        valid: true,
        kind: 'preserved-metro-bundle-string',
        expected,
        target: preserved,
        ...(Number.isInteger(port) ? { port } : {}),
      };
    }
  }
  if (!appAlive.simulator?.udid || !worktree) {
    return { valid: false, reason: 'missing-simulator-or-worktree' };
  }
  if (meta.variant === 'native') {
    const expected = `Trailhead ${meta.runId}`;
    if ((meta.platform ?? 'ios') === 'android') {
      return installedAndroidNativeMarker(meta, appAlive, runDir, expected);
    }
    const eventsPath = join(runDir, 'events.jsonl');
    const markerObserved = nativeMarkerObserved(commandItems, agentDeviceOpenCommand(meta, appAlive), expected);
    return {
      valid: markerObserved,
      kind: 'agent-device-native-window-marker',
      expected,
      target: eventsPath,
    };
  }
  const expected = 'Keep saved trail maps available offline';
  const sourcePath = join(worktree, 'app', '(tabs)', 'settings.tsx');
  if (!existsSync(sourcePath) || !readFileSync(sourcePath, 'utf8').includes(expected)) {
    return { valid: false, reason: 'source-edit-missing', sourcePath };
  }
  for (let port = 8081; port <= 8090; port += 1) {
    const target = join(runDir, 'proof', `metro-${port}.bundle`);
    try {
      execFileSync(
        'curl',
        [
          '--fail',
          '--silent',
          '--show-error',
          '--max-time',
          '60',
          '--output',
          target,
          `http://127.0.0.1:${port}/.expo/.virtual-metro-entry.bundle?platform=${meta.platform ?? 'ios'}&dev=true&minify=false`,
        ],
        { cwd: worktree, timeout: 70_000 },
      );
      run('grep', ['-a', '-F', '-q', expected, target]);
      return { valid: true, kind: 'metro-bundle-string', expected, target, port };
    } catch {
      rmSync(target, { force: true });
    }
  }
  return { valid: false, reason: 'changed-metro-bundle-not-found' };
}

function completedCleanup(runDir) {
  const cleanupPath = join(runDir, 'cleanup.json');
  if (!existsSync(cleanupPath)) return false;
  try {
    return completedCleanupRecord(JSON.parse(readFileSync(cleanupPath, 'utf8')));
  } catch {
    return false;
  }
}

function deviceMismatchReasons(meta, device) {
  const platform = meta.platform ?? 'ios';
  if (meta.arm === 'stim' && platform === 'ios') {
    return device?.udid === meta.expectedParkedSimulator?.udid ? [] : ['stim-did-not-use-prepared-parked-simulator'];
  }
  if (meta.arm === 'stim') {
    return matchesExpectedAndroidEmulator(device, meta.expectedStimDevice ?? {}) ? [] : ['stim-emulator-mismatch'];
  }
  const matchesExpected =
    platform === 'ios'
      ? matchesExpectedIosSimulator(device, meta.expectedControlSimulator ?? {})
      : matchesExpectedAndroidEmulator(device, meta.expectedControlSimulator ?? {});
  return matchesExpected ? [] : [`control-${platform === 'android' ? 'emulator' : 'simulator'}-mismatch`];
}

function collect(runDir) {
  const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8'));
  const appAlivePath = join(runDir, 'app-alive.json');
  const appAlive = existsSync(appAlivePath)
    ? JSON.parse(readFileSync(appAlivePath, 'utf8'))
    : { error: 'missing-app-alive-record' };
  const eventsPath = join(runDir, 'events.jsonl');
  const commandAudit = commandEvidence(meta, eventsPath, runDir);
  const screen = screenEvidence(meta, appAlive, commandAudit.commands, runDir);
  const recording = recordingEvidence(meta, commandAudit.commands, runDir, screen);
  const worktreeRecord = worktreeEvidence(runDir, meta, eventsPath);
  const worktree = worktreeRecord?.path ?? null;
  const proof = proofFor(meta, appAlive, runDir, worktree, commandAudit.completedEvents);
  const rollout =
    meta.runner === 'claude'
      ? eventsPath
      : (copyRollout(runDir) ?? (existsSync(join(runDir, 'rollout.jsonl')) ? join(runDir, 'rollout.jsonl') : null));
  const runnerMetrics = runnerMetricsFromEvents(eventsPath, meta.runner);
  const usage = runnerMetrics?.usage ?? usageFromRollout(rollout);
  const diagnosis =
    meta.variant === launchCrashVariant
      ? launchCrashDiagnosis(commandAudit.commands, {
          dispatchAt: meta.dispatchAt,
          token: meta.crash.token,
          arm: meta.arm,
          platform: meta.platform ?? 'ios',
          activities: commandAudit.activities,
        })
      : null;
  const recovery =
    meta.variant === launchCrashVariant
      ? launchCrashRecovery(commandAudit.commands, {
          diagnosis,
          arm: meta.arm,
          platform: meta.platform ?? 'ios',
          screen,
        })
      : null;
  const diagnosisUsage =
    diagnosis?.valid && meta.runner !== 'claude' ? usageAtOrBefore(rollout, diagnosis.observedAt) : null;
  const invalidReasons = [
    ...(appAlive.error ? [appAlive.error] : []),
    ...(meta.runnerResult?.code === 0 ? [] : [`runner-exit-${meta.runnerResult?.code}`]),
    ...(meta.runnerResult?.timedOut ? ['benchmark-timeout-25m'] : []),
    ...(runnerMetrics?.isError ? [`runner-${runnerMetrics.terminalReason ?? 'error'}`] : []),
    ...(runnerMetrics?.subagentsSpawned ? ['runner-used-subagents'] : []),
    ...(proof.valid ? [] : [proof.reason ?? 'proof-failed']),
    ...(screen.valid ? [] : [screen.reason ?? 'screen-proof-failed']),
    ...(recording.valid ? [] : [recording.reason ?? 'simulator-recording-failed']),
    ...(rollout ? [] : ['rollout-missing-or-ambiguous']),
    ...(existsSync(eventsPath) ? [] : ['stamped-events-missing']),
    ...(worktree ? [] : ['worktree-evidence-missing']),
    ...(diagnosis && !diagnosis.valid ? [diagnosis.reason ?? 'launch-crash-diagnosis-failed'] : []),
    ...(recovery && !recovery.valid ? [recovery.reason ?? 'launch-crash-recovery-failed'] : []),
    ...(meta.variant === launchCrashVariant && meta.runner !== 'claude' && !diagnosisUsage
      ? ['launch-crash-diagnosis-usage-missing']
      : []),
    ...deviceMismatchReasons(meta, appAlive.simulator),
    ...commandAudit.invalidReasons,
    ...(git('status', '--short') === '' ? [] : ['main-checkout-dirty']),
  ];
  const nextRunRecord = {
    schemaVersion: 1,
    runId: meta.runId,
    stage: meta.stage,
    runner: meta.runner,
    model: meta.model,
    requestedServiceTier: meta.requestedServiceTier ?? null,
    returnedServiceTier: runnerMetrics?.returnedServiceTier ?? null,
    serviceTierStatus: runnerMetrics?.returnedServiceTier ? 'tier-reported' : 'tier-unverified',
    arm: meta.arm,
    variant: meta.variant,
    valid: invalidReasons.length === 0,
    invalidReasons,
    dispatchToAppAliveSeconds: appAlive.dispatchToAppAliveSeconds ?? null,
    dispatchToProofSeconds: appAlive.dispatchToProofSeconds ?? null,
    dispatchToScreenReadySeconds: screen.dispatchToScreenReadySeconds ?? null,
    dispatchToDiagnosisSeconds: diagnosis?.dispatchToDiagnosisSeconds ?? null,
    diagnosisCommandCount: diagnosis?.commandCount ?? null,
    diagnosisUsage,
    diagnosisTokens: tokensFromUsage(diagnosisUsage),
    diagnosis,
    recovery,
    simulator: appAlive.simulator ?? null,
    worktree,
    worktreeEvidence: worktreeRecord,
    proof,
    screen,
    recording,
    evidenceSha256: {
      events: existsSync(eventsPath) ? sha256(eventsPath) : null,
      settingsPng: screen.valid && existsSync(screen.target) ? sha256(screen.target) : null,
      transcript: rollout && existsSync(rollout) ? sha256(rollout) : null,
      proof: proof.valid && existsSync(proof.target) ? sha256(proof.target) : null,
      recording: recording.valid && existsSync(recording.target) ? sha256(recording.target) : null,
    },
    reportedCostUsd: runnerMetrics?.reportedCostUsd ?? null,
    modelUsage: runnerMetrics?.modelUsage ?? null,
    runnerTerminalReason: runnerMetrics?.terminalReason ?? null,
    transcript: meta.runner === 'claude' ? eventsPath : rollout,
    usage,
    tokens: tokensFromUsage(usage),
    retrySecondsByClass: {},
    commandCount: commandAudit.commands.length,
    collectedAt: new Date().toISOString(),
  };
  const runRecordPath = join(runDir, 'run.json');
  const previousRunRecord = existsSync(runRecordPath) ? JSON.parse(readFileSync(runRecordPath, 'utf8')) : null;
  const runRecord = durableRunRecord(previousRunRecord, nextRunRecord, completedCleanup(runDir));
  writeFileSync(runRecordPath, `${JSON.stringify(runRecord, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(runRecord, null, 2)}\n`);
}

function cleanup(runDir) {
  const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8'));
  const appAlivePath = join(runDir, 'app-alive.json');
  const appAlive = existsSync(appAlivePath) ? JSON.parse(readFileSync(appAlivePath, 'utf8')) : {};
  const worktree = findRunWorktree(meta.runId, runWorktreeParent(meta));
  const branch = meta.arm === 'stim' ? `worktree-bench/${meta.runId}` : `bench/${meta.runId}`;
  const actions = [];
  const agentDeviceEnv = agentDeviceEnvironment(meta.agentDevice?.session ?? meta.runId);
  try {
    run(agentDeviceBin, ['close'], {
      cwd: worktree && existsSync(worktree) ? worktree : main,
      env: agentDeviceEnv,
      timeout: 30_000,
    });
    actions.push(`agent-device close session ${meta.agentDevice?.session ?? meta.runId}`);
  } catch {}
  try {
    const sessions = agentDeviceSessions(agentDeviceEnv);
    if (sessions.length) {
      actions.push(`agent-device cleanup could not prove closure: ${JSON.stringify(sessions)}`);
      stopBenchmarkAgentDeviceDaemon();
      actions.push('stop and clean benchmark agent-device daemon');
      const remaining = agentDeviceSessions(agentDeviceEnv);
      if (remaining.length) {
        throw new Error(`benchmark agent-device sessions remain after daemon cleanup: ${JSON.stringify(remaining)}`);
      }
    }
    actions.push('verified benchmark agent-device sessions empty');
  } catch (error) {
    try {
      stopBenchmarkAgentDeviceDaemon();
      actions.push(`stop and clean benchmark agent-device daemon after verification failure: ${error}`);
    } catch (stopError) {
      actions.push(`failed: benchmark agent-device cleanup: ${stopError}`);
    }
  }
  const screenshotScratch = join('/tmp', `${meta.runId}-settings.png`);
  if (existsSync(screenshotScratch)) {
    rmSync(screenshotScratch);
    actions.push(`remove ${screenshotScratch}`);
  }
  if (meta.arm === 'stim' && worktree && existsSync(worktree)) {
    const stimHome = join(runDir, 'stim-home');
    const env = {
      ...cleanRubyEnvironment(process.env),
      STIM_HOME: stimHome,
      ...(meta.platform === 'android' ? {} : { STIM_POOL_IOS_PARKED_MAX: '1' }),
    };
    for (const args of [['stop'], ['worktree', 'remove', '--force']]) {
      try {
        run('node', [stimCli, ...args], {
          cwd: worktree,
          env,
          timeout: 5 * 60 * 1000,
          stdio: 'inherit',
        });
        actions.push(`stim ${args.join(' ')}`);
      } catch (error) {
        actions.push(`failed: stim ${args.join(' ')}: ${error}`);
      }
    }
    if (meta.platform !== 'android') {
      try {
        const parked = verifyParkedSimulator(stimHome, meta.expectedParkedSimulator?.udid);
        actions.push(`verified parked simulator ${parked.udid}`);
        waitForSimulatorQuiescence(parked.udid);
        actions.push(`verified quiescent simulator ${parked.udid}`);
      } catch (error) {
        actions.push(`failed: parked simulator verification: ${error}`);
      }
    }
  } else if (meta.arm === 'control') {
    const simulator =
      meta.platform === 'android'
        ? controlAndroidForCleanup(runDir, appAlive.simulator?.udid, meta.expectedControlSimulator?.name)
        : controlSimulatorForCleanup(runDir, appAlive.simulator?.udid);
    if (simulator) {
      const udid = simulator.udid;
      if (!appAlive.simulator?.udid) {
        actions.push(`inferred sole new benchmark simulator ${udid}`);
      }
      if (meta.platform === 'android') {
        const expected = meta.expectedControlSimulator ?? {};
        const cleanupExpected = simulator.deviceTypeIdentifier
          ? expected
          : { ...expected, deviceTypeIdentifier: undefined };
        const matchesExpected = matchesExpectedAndroidEmulator(simulator, cleanupExpected);
        try {
          if (!matchesExpected) throw new Error('ownership revalidation failed');
          if (udid) {
            run('adb', ['-s', udid, 'emu', 'kill'], { timeout: 60_000 });
            actions.push(`shutdown ${udid}`);
            const deadline = Date.now() + 60_000;
            while (Date.now() < deadline && androidEmulatorSnapshot().includes(udid)) {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
            }
          }
          run('avdmanager', ['delete', 'avd', '-n', simulator.name], { timeout: 60_000 });
          actions.push(`delete AVD ${simulator.name}`);
        } catch (error) {
          actions.push(`failed: delete Android benchmark emulator ${udid}: ${error}`);
        }
      } else {
        try {
          run('xcrun', ['simctl', 'shutdown', udid], { timeout: 60_000 });
          actions.push(`shutdown ${udid}`);
        } catch {}
        if (controlSimulatorForCleanup(runDir, udid)) {
          try {
            run('xcrun', ['simctl', 'delete', udid], { timeout: 60_000 });
            actions.push(`delete ${udid}`);
          } catch (error) {
            actions.push(`failed: delete ${udid}: ${error}`);
          }
        } else {
          actions.push(`skipped delete ${udid}: ownership revalidation failed`);
        }
      }
    }
    if (worktree && existsSync(worktree)) {
      for (let port = 8081; port <= 8090; port += 1) {
        try {
          const pids = run('/usr/sbin/lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'])
            .split('\n')
            .filter(Boolean);
          for (const pid of pids) {
            const cwd = run('/usr/sbin/lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'])
              .split('\n')
              .find((line) => line.startsWith('n'))
              ?.slice(1);
            if (cwd?.startsWith(worktree)) {
              process.kill(Number(pid), 'SIGTERM');
              actions.push(`terminate Metro pid ${pid}`);
            }
          }
        } catch {}
      }
      try {
        run('git', ['worktree', 'remove', '--force', worktree], {
          cwd: main,
          timeout: 5 * 60 * 1000,
        });
        actions.push(`remove worktree ${worktree}`);
      } catch (error) {
        actions.push(`failed: remove worktree ${worktree}: ${error}`);
      }
      try {
        run('git', ['branch', '-D', branch], { cwd: main });
        actions.push(`delete branch ${branch}`);
      } catch {}
    }
  } else {
    actions.push('skipped Stim device cleanup: run worktree missing');
  }
  if (!findRunWorktree(meta.runId, runWorktreeParent(meta))) {
    try {
      run('git', ['branch', '-D', branch], { cwd: main });
      actions.push(`delete branch ${branch}`);
    } catch {}
  }
  if (meta.crash?.fixtureCheckout) {
    const fixtureCheckout = resolve(meta.crash.fixtureCheckout);
    const fixtureBranch = meta.crash.fixtureBranch;
    if (!fixtureCheckout.startsWith(`${worktreeParent}/`)) {
      actions.push(`skipped launch-crash fixture cleanup outside benchmark root: ${fixtureCheckout}`);
    } else if (existsSync(fixtureCheckout)) {
      if (meta.arm === 'stim') {
        try {
          run('node', [stimCli, 'worktree', 'remove', '--force'], {
            cwd: fixtureCheckout,
            env: {
              ...cleanRubyEnvironment(process.env),
              STIM_HOME: join(runDir, 'stim-home'),
              STIM_POOL_IOS_PARKED_MAX: '1',
            },
            timeout: 5 * 60 * 1000,
            stdio: 'inherit',
          });
          actions.push(`stim worktree remove launch-crash fixture ${fixtureCheckout}`);
        } catch (error) {
          actions.push(`failed: remove Stim launch-crash fixture ${fixtureCheckout}: ${error}`);
        }
      } else {
        try {
          run('git', ['worktree', 'remove', '--force', fixtureCheckout], {
            cwd: main,
            timeout: 5 * 60 * 1000,
          });
          actions.push(`remove launch-crash fixture ${fixtureCheckout}`);
        } catch (error) {
          actions.push(`failed: remove launch-crash fixture ${fixtureCheckout}: ${error}`);
        }
      }
    }
    if (!existsSync(fixtureCheckout) && fixtureBranch) {
      try {
        run('git', ['branch', '-D', fixtureBranch], { cwd: main });
        actions.push(`delete branch ${fixtureBranch}`);
      } catch {}
    }
  }
  copyRollout(runDir);
  rmSync(join(runDir, 'runner-home'), { recursive: true, force: true });
  const record = { cleanedAt: new Date().toISOString(), actions };
  writeFileSync(join(runDir, 'cleanup.json'), `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}

function relativeUsage(stim, control) {
  const percent = (1 - stim / control) * 100;
  return `${Math.abs(percent).toFixed(0)}% ${percent >= 0 ? 'fewer' : 'more'}`;
}

function report(stage) {
  const stageDir = join(results, stage);
  const records = existsSync(stageDir)
    ? readdirSync(stageDir)
        .map((name) => join(stageDir, name, 'run.json'))
        .filter(existsSync)
        .map((path) => JSON.parse(readFileSync(path, 'utf8')))
    : [];
  const pricing = {
    'gpt-5.6-sol': { input: 4, cached: 0.4, output: 20 },
    'gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
    'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
  };
  const estimatedCost = (model, tokens) => {
    const rate = pricing[model];
    if (!rate || !tokens) return null;
    return (
      (tokens.uncachedInput * rate.input + tokens.cachedInput * rate.cached + tokens.output * rate.output) / 1_000_000
    );
  };
  const cost = (record) => {
    if (Number.isFinite(record.reportedCostUsd)) return record.reportedCostUsd;
    return estimatedCost(record.model, record.tokens);
  };
  const header =
    '| Model | Variant | Arm | Valid | Diagnosis (s) | Settings repaired (s) | Commands to diagnosis | Tokens to diagnosis | Cost to diagnosis | Total commands | Uncached input | Cached input | Output | Total cost |\n| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |';
  const rows = records.map((record) =>
    [
      record.model,
      record.variant,
      record.arm,
      record.valid ? 'yes' : `no: ${record.invalidReasons.join(', ')}`,
      record.dispatchToDiagnosisSeconds ?? '-',
      record.dispatchToScreenReadySeconds ?? '-',
      record.diagnosisCommandCount ?? '-',
      record.diagnosisTokens
        ? record.diagnosisTokens.uncachedInput + record.diagnosisTokens.cachedInput + record.diagnosisTokens.output
        : '-',
      estimatedCost(record.model, record.diagnosisTokens) === null
        ? '-'
        : `$${estimatedCost(record.model, record.diagnosisTokens).toFixed(3)}`,
      record.commandCount ?? '-',
      record.tokens?.uncachedInput ?? '-',
      record.tokens?.cachedInput ?? '-',
      record.tokens?.output ?? '-',
      cost(record) === null ? '-' : `$${cost(record).toFixed(3)} (${record.serviceTierStatus ?? 'tier-unverified'})`,
    ]
      .map((value) => String(value))
      .join(' | ')
      .replace(/^/, '| ')
      .replace(/$/, ' |'),
  );
  const valid = records.filter((record) => record.valid);
  const pairKeys = [...new Set(valid.map((record) => `${record.model}\0${record.variant}`))];
  const pairs = pairKeys
    .map((key) => {
      const [model, variant] = key.split('\0');
      const stim = valid.find(
        (record) => record.model === model && record.variant === variant && record.arm === 'stim',
      );
      const control = valid.find(
        (record) => record.model === model && record.variant === variant && record.arm === 'control',
      );
      return stim && control ? { model, variant, stim, control } : null;
    })
    .filter(Boolean);
  const pairHeader =
    '| Model | Variant | Screen-ready speedup | App-alive speedup | Commands | Uncached input | Cached input | Output | Cost |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |';
  const pairRows = pairs.map(({ model, variant, stim, control }) => {
    const stimCost = cost(stim);
    const controlCost = cost(control);
    const tierStatus =
      stim.serviceTierStatus === control.serviceTierStatus
        ? stim.serviceTierStatus
        : `${stim.serviceTierStatus}/${control.serviceTierStatus}`;
    return `| ${model} | ${variant} | ${(control.dispatchToScreenReadySeconds / stim.dispatchToScreenReadySeconds).toFixed(2)}x | ${(control.dispatchToAppAliveSeconds / stim.dispatchToAppAliveSeconds).toFixed(2)}x | ${relativeUsage(stim.commandCount, control.commandCount)} | ${relativeUsage(stim.tokens.uncachedInput, control.tokens.uncachedInput)} | ${relativeUsage(stim.tokens.cachedInput, control.tokens.cachedInput)} | ${relativeUsage(stim.tokens.output, control.tokens.output)} | ${relativeUsage(stimCost, controlCost)} (${tierStatus}) |`;
  });
  const pairSection = pairs.length
    ? `## Valid paired results\n\n${pairHeader}\n${pairRows.join('\n')}\n\nEach row is one matched pilot pair and is directional, not statistically conclusive. Claude costs are the CLI-reported total cost; Codex costs use direct API token rates. Both exclude local tool/runtime costs, and reasoning tokens are already included in output tokens.\n\n`
    : '';
  const markdown = `# Benchmark ${stage}\n\nGenerated ${new Date().toISOString()}.\n\n${pairSection}## All attempts\n\n${header}\n${rows.join('\n')}\n`;
  const path = join(results, `${stage}-report.md`);
  writeFileSync(path, markdown);
  process.stdout.write(`${path}\n`);
}

function selftestDeviceTargeting() {
  const meta = {
    deviceTargetingRequired: true,
    runId: 'benchmark-run',
    agentDevice: { stateDir: agentDeviceState, session: 'benchmark-run' },
  };
  const appAlive = { simulator: { udid: 'RUN-UDID' } };
  const expected = agentDeviceOpenCommand(meta, appAlive);
  const commands = [
    'agent-device open com.appandflow.trailhead --foreground',
    'agent-device open com.appandflow.trailhead --foreground --platform ios --udid WRONG-UDID',
    expected,
  ];
  if (commands[0].includes(expected) || commands[1].includes(expected)) {
    throw new Error('omitted or wrong simulator UDID passed the target check');
  }
  if (!commands[2].includes(expected)) {
    throw new Error('matching simulator UDID failed the target check');
  }
  const marker = 'Trailhead benchmark-run';
  const afterOnboarding = [
    {
      type: 'command_execution',
      command: expected,
      exit_code: 0,
      aggregated_output: 'Expo developer menu',
    },
    {
      type: 'command_execution',
      command: agentDeviceCommand(meta, 'click @continue --settle'),
      exit_code: 0,
      aggregated_output: `[window] "${marker}"`,
    },
  ];
  if (!nativeMarkerObserved(afterOnboarding, expected, marker)) {
    throw new Error('native marker after Expo onboarding failed the proof check');
  }
  const withoutSuccessfulOpen = [
    {
      ...afterOnboarding[0],
      exit_code: 1,
    },
    afterOnboarding[1],
  ];
  if (nativeMarkerObserved(withoutSuccessfulOpen, expected, marker)) {
    throw new Error('native marker passed without a successful exact-device open');
  }
  const androidMeta = { ...meta, platform: 'android' };
  const androidExpected = agentDeviceOpenCommand(androidMeta, { simulator: { udid: 'emulator-5554' } });
  if (!androidExpected.endsWith('--platform android --serial emulator-5554')) {
    throw new Error('Android emulator serial failed the target check');
  }
  process.stdout.write('device targeting self-test passed\n');
}

function selftestAgentDeviceIsolation() {
  const runId = 'benchmark-run';
  const environment = agentDeviceEnvironment(runId);
  if (environment.AGENT_DEVICE_STATE_DIR !== agentDeviceState) {
    throw new Error('benchmark agent-device state directory is not isolated');
  }
  if (environment.AGENT_DEVICE_SESSION !== runId) {
    throw new Error('benchmark agent-device session is not run-scoped');
  }
  const meta = { runId, agentDevice: { stateDir: agentDeviceState, session: runId } };
  const expected = agentDeviceCommand(meta, 'close');
  if (topLevelShellCommand(`/bin/zsh -lc '${expected}'`) !== expected) {
    throw new Error('top-level shell command was not recognized');
  }
  if (topLevelShellCommand(`/bin/zsh -lc '${expected} && echo hidden'`) === expected) {
    throw new Error('chained proof command was accepted as top-level evidence');
  }
  if ('agent-device close'.startsWith(agentDeviceCommand(meta, ''))) {
    throw new Error('bare default-session command passed the isolation check');
  }
  process.stdout.write('agent-device isolation self-test passed\n');
}

function selftestLaunchCrash() {
  const runId = 'launch-crash-selftest';
  const token = launchCrashToken(runId);
  const crash = {
    fixtureCheckout: join(worktreeParent, `fixture-${runId}`),
    sourceRelative: 'app/_layout.tsx',
    token,
  };
  const prompt = promptFor('stim', launchCrashVariant, runId, state, crash);
  for (const required of [
    `stim worktree create bench/${runId}`,
    'Before inspecting source or git diff',
    'stim logs --errors',
    'Make the smallest repair',
    'agent-device metro reload --metro-port <reported Metro port>',
    'Do not run `stim ios` a second time',
  ]) {
    if (!prompt.includes(required)) {
      throw new Error(`launch-crash prompt is missing: ${required}`);
    }
  }
  const usagePath = join('/tmp', 'stim-launch-crash-selftest-rollout.jsonl');
  writeFileSync(
    usagePath,
    [
      {
        timestamp: '2026-09-04T12:00:10.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 } },
        },
      },
      {
        timestamp: '2026-09-04T12:00:20.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 200, cached_input_tokens: 50, output_tokens: 30 } },
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n',
  );
  const usage = usageAtOrBefore(usagePath, '2026-09-04T12:00:15.000Z');
  rmSync(usagePath, { force: true });
  if (usage?.input_tokens !== 100 || usage?.cached_input_tokens !== 20) {
    throw new Error(`launch-crash diagnosis usage was not cutoff correctly: ${JSON.stringify(usage)}`);
  }
  process.stdout.write('launch-crash self-test passed\n');
}

function selftestAndroid() {
  const runId = 'android-selftest';
  const prompt = promptFor('stim', 'native', runId, state, null, 'android');
  for (const required of [
    `stim worktree create bench/${runId}`,
    'android/app/src/main/res/values/strings.xml',
    'stim android --system-image',
    '--platform android --serial <run emulator serial>',
    'record start',
    'record stop',
  ]) {
    if (!prompt.includes(required)) throw new Error(`Android prompt is missing: ${required}`);
  }
  const cleanupDir = join('/tmp', `stim-android-cleanup-selftest-${process.pid}`);
  mkdirSync(cleanupDir, { recursive: true });
  writeFileSync(join(cleanupDir, 'devices-before.json'), '[]\n');
  writeFileSync(join(cleanupDir, 'avds-before.json'), `${JSON.stringify(['Trailhead_existing'])}\n`);
  if (controlAndroidForCleanup(cleanupDir, 'emulator-5554', 'Trailhead_existing') !== null) {
    throw new Error('Android cleanup accepted an AVD that existed before dispatch');
  }
  rmSync(cleanupDir, { recursive: true, force: true });
  process.stdout.write('Android self-test passed\n');
}

const [command, ...args] = process.argv.slice(2);
ensureDirs();
if (command === 'preflight') {
  process.stdout.write(`${JSON.stringify(preflight(args[0]), null, 2)}\n`);
} else if (command === 'prepare') {
  if (checkedPlatform(args[0]) === 'android') prepareAndroid();
  else prepare();
} else if (command === 'smoke') {
  smoke(args[0]);
} else if (command === 'runner-smoke') {
  await runnerSmoke(args[0]);
} else if (command === 'dispatch') {
  await dispatch(...args);
} else if (command === 'collect') {
  collect(resolve(args[0]));
} else if (command === 'cleanup') {
  cleanup(resolve(args[0]));
} else if (command === 'report') {
  report(args[0]);
} else if (command === 'selftest-device-targeting') {
  selftestDeviceTargeting();
} else if (command === 'selftest-agent-device-isolation') {
  selftestAgentDeviceIsolation();
} else if (command === 'selftest-launch-crash') {
  selftestLaunchCrash();
} else if (command === 'selftest-android') {
  selftestAndroid();
} else {
  throw new Error(
    'usage: bench.mjs preflight [ios|android] | prepare [ios|android] | smoke <stim|control> | runner-smoke <stim|control> | dispatch <model> <stim|control> <javascript|native|launch-crash> [stage] [ios|android] | collect <run-dir> | cleanup <run-dir> | report <stage> | selftest-device-targeting | selftest-agent-device-isolation | selftest-launch-crash | selftest-android',
  );
}
