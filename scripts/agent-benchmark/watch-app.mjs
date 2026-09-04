import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  androidApplicationLabelFromBadging,
  androidDevicesFromAdb,
  iosDevicesFromSimctl,
  selectAndroidCandidate,
  selectIosCandidate,
} from './watch-app-selection.mjs';

const [
  baselinePath,
  outputPath,
  dispatchIso,
  variant,
  arm,
  parkedUdid,
  expectedControlName,
  expectedControlDeviceType,
  expectedControlRuntime,
  platform = 'ios',
  expectedStimName,
  expectedSystemImage,
  expectedNativeLabel,
] = process.argv.slice(2);
const baseline = new Set(JSON.parse(readFileSync(baselinePath, 'utf8')));
const expectedControl = {
  name: expectedControlName,
  deviceTypeIdentifier: expectedControlDeviceType,
  runtimeIdentifier: expectedControlRuntime,
  ...(expectedSystemImage ? { systemImage: expectedSystemImage } : {}),
};
const deadline = Date.now() + 20 * 60 * 1000;
let firstAlive = null;

function simctl(...args) {
  return execFileSync('xcrun', ['simctl', ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function adb(...args) {
  return execFileSync('adb', args, {
    encoding: 'utf8',
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function devices() {
  if (platform === 'android') {
    return androidDevicesFromAdb(adb('devices', '-l'), (serial) => {
      const name = adb('-s', serial, 'shell', 'getprop', 'ro.boot.qemu.avd_name').trim();
      const configPath = join(
        process.env.ANDROID_AVD_HOME ?? join(homedir(), '.android', 'avd'),
        `${name}.avd`,
        'config.ini',
      );
      const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
      const systemImage = config
        .match(/^image\.sysdir\.1=(.+)$/m)?.[1]
        ?.trim()
        .replace(/\/+$/, '')
        .replaceAll('/', ';');
      return {
        name,
        deviceTypeIdentifier:
          config.match(/^hw\.device\.name=(.+)$/m)?.[1]?.trim() ??
          adb('-s', serial, 'shell', 'getprop', 'ro.product.device').trim(),
        runtimeIdentifier: `Android-${adb('-s', serial, 'shell', 'getprop', 'ro.build.version.sdk').trim()}`,
        systemImage,
      };
    });
  }
  return iosDevicesFromSimctl(JSON.parse(simctl('list', 'devices', '--json')));
}

function alive(udid) {
  try {
    if (platform === 'android') {
      return adb('-s', udid, 'shell', 'pidof', 'com.appandflow.trailhead').trim().length > 0;
    }
    simctl('get_app_container', udid, 'com.appandflow.trailhead', 'app');
    const processes = execFileSync('ps', ['-A', '-o', 'command='], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return processes
      .split('\n')
      .some((line) => line.includes(`/Devices/${udid}/`) && line.includes('/Trailhead.app/Trailhead'));
  } catch {
    return false;
  }
}

function captureJavascriptProof() {
  const expected = 'Keep saved trail maps available offline';
  for (let port = 8081; port <= 8090; port += 1) {
    const target = join(dirname(outputPath), 'proof', `metro-${port}-at-app-alive.bundle`);
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
          `http://127.0.0.1:${port}/.expo/.virtual-metro-entry.bundle?platform=${platform}&dev=true&minify=false`,
        ],
        { timeout: 70_000 },
      );
      const contents = readFileSync(target);
      if (contents.includes(Buffer.from(expected))) {
        return { valid: true, kind: 'metro-bundle-string-at-app-alive', expected, target, port };
      }
    } catch {}
    if (existsSync(target)) rmSync(target);
  }
  return { valid: false, reason: 'changed-metro-bundle-not-found-at-app-alive' };
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

function captureAndroidNativeProof(serial) {
  const aapt = androidBuildTool('aapt');
  if (!aapt) return { valid: false, reason: 'android-native-proof-tool-missing' };
  const packagePath = adb('-s', serial, 'shell', 'pm', 'path', 'com.appandflow.trailhead')
    .split('\n')
    .find((line) => line.startsWith('package:') && line.endsWith('/base.apk'))
    ?.slice('package:'.length);
  if (!packagePath) return { valid: false, reason: 'android-installed-apk-missing' };
  const safeLabel = expectedNativeLabel.replaceAll(/[^a-zA-Z0-9.-]/g, '-');
  const temporaryApk = join('/tmp', `${safeLabel}-base.apk`);
  const target = join(dirname(outputPath), 'proof', 'native-application-label.txt');
  try {
    adb('-s', serial, 'pull', packagePath, temporaryApk);
    const label = androidApplicationLabelFromBadging(
      execFileSync(aapt, ['dump', 'badging', temporaryApk], {
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    writeFileSync(target, `serial=${serial}\napplication-label=${label ?? ''}\n`);
    return {
      valid: label === expectedNativeLabel,
      kind: 'installed-android-apk-label-at-app-alive',
      expected: expectedNativeLabel,
      observed: label,
      target,
    };
  } finally {
    if (existsSync(temporaryApk)) rmSync(temporaryApk);
  }
}

while (Date.now() < deadline) {
  try {
    const selection =
      platform === 'android'
        ? selectAndroidCandidate(devices(), {
            arm,
            baseline,
            expectedControl,
            expectedStim: { ...expectedControl, name: undefined, namePrefix: expectedStimName },
          })
        : selectIosCandidate(devices(), {
            arm,
            baseline,
            parkedUdid,
            expectedControl,
          });
    if (selection.error) {
      writeFileSync(outputPath, `${JSON.stringify(selection, null, 2)}\n`);
      process.exit(2);
    }
    if (selection.candidate && alive(selection.candidate.udid)) {
      firstAlive ??= {
        observedAt: new Date().toISOString(),
        simulator: selection.candidate,
      };
      const proof =
        variant === 'javascript'
          ? captureJavascriptProof()
          : variant === 'native' && platform === 'android'
            ? captureAndroidNativeProof(selection.candidate.udid)
            : null;
      if (proof && !proof.valid) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      const proofObservedAt = new Date().toISOString();
      writeFileSync(
        outputPath,
        `${JSON.stringify(
          {
            dispatchAt: dispatchIso,
            observedAt: firstAlive.observedAt,
            dispatchToAppAliveSeconds: (Date.parse(firstAlive.observedAt) - Date.parse(dispatchIso)) / 1000,
            simulator: firstAlive.simulator,
            proof,
            proofObservedAt,
            dispatchToProofSeconds: (Date.parse(proofObservedAt) - Date.parse(dispatchIso)) / 1000,
          },
          null,
          2,
        )}\n`,
      );
      process.exit(0);
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

writeFileSync(
  outputPath,
  `${JSON.stringify(
    firstAlive
      ? {
          error: 'proof-timeout-after-app-alive',
          dispatchAt: dispatchIso,
          observedAt: firstAlive.observedAt,
          dispatchToAppAliveSeconds: (Date.parse(firstAlive.observedAt) - Date.parse(dispatchIso)) / 1000,
          simulator: firstAlive.simulator,
        }
      : { error: 'app-alive-timeout', dispatchAt: dispatchIso },
    null,
    2,
  )}\n`,
);
process.exit(3);
