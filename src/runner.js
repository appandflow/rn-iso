import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { listAllIosSims } from './sim/ios.js';

// Detect package manager from lockfiles. Defaults to npm if nothing is found.
export function detectPackageManager(projectRoot) {
  if (existsSync(join(projectRoot, 'bun.lock')) || existsSync(join(projectRoot, 'bun.lockb'))) return 'bun';
  if (existsSync(join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(projectRoot, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(projectRoot, 'package-lock.json'))) return 'npm';
  return 'npm';
}

export function getProjectScript(projectRoot, name) {
  const p = join(projectRoot, 'package.json');
  if (!existsSync(p)) return null;
  try {
    const pkg = JSON.parse(readFileSync(p, 'utf-8'));
    return pkg?.scripts?.[name] || null;
  } catch {
    return null;
  }
}

// Build a `<pm> <script> ...args` invocation. npm needs `--` to separate
// script-name args from script-passed args; yarn / pnpm / bun pass them
// directly. We always invoke through the package manager rather than running
// the script body so the user's pre/post hooks fire.
export function buildScriptCommand(packageManager, scriptName, extraArgs = []) {
  const args = extraArgs.filter(Boolean).join(' ');
  switch (packageManager) {
    case 'yarn':
      return `yarn ${scriptName}${args ? ' ' + args : ''}`;
    case 'pnpm':
      return `pnpm ${scriptName}${args ? ' ' + args : ''}`;
    case 'bun':
      return `bun run ${scriptName}${args ? ' ' + args : ''}`;
    case 'npm':
    default:
      return `npm run ${scriptName}${args ? ' -- ' + args : ''}`;
  }
}

// Decide which CLI a script invokes. Affects flag names: Expo CLI takes
// --device <UDID>, bare RN CLI takes --udid <UDID> for iOS (--device there
// means physical device by name) and --deviceId for Android.
export function detectScriptCli(scriptBody) {
  if (typeof scriptBody !== 'string') return 'unknown';
  if (/\bexpo\s+(run:ios|run:android|start)\b/.test(scriptBody)) return 'expo';
  if (/\breact-native\s+(run-ios|run-android|start)\b/.test(scriptBody)) return 'react-native';
  return 'unknown';
}

// iOS run command. Prefers the project's `ios` script if present (the most
// reliable: respects user customization, picks the right CLI). Falls back to
// expo run:ios / react-native run-ios when no script exists or --no-script.
export function buildIosCommand({ projectRoot, packageManager, scriptName, isExpo, udid, port, useScript = true }) {
  if (useScript && scriptName) {
    const script = getProjectScript(projectRoot, scriptName);
    if (script) {
      const cli = detectScriptCli(script);
      // Expo: --device <UDID>; RN (and unknown, common case): --udid <UDID>.
      const deviceFlag = cli === 'expo' ? `--device ${udid}` : `--udid ${udid}`;
      return buildScriptCommand(packageManager, scriptName, [
        deviceFlag,
        `--port ${port}`,
      ]);
    }
  }
  if (isExpo) {
    return `npx expo run:ios --device ${udid} --port ${port}`;
  }
  return `npx react-native run-ios --udid ${udid} --port ${port}`;
}

export function buildAndroidCommand({ projectRoot, packageManager, scriptName, isExpo, serial, port, useScript = true }) {
  if (useScript && scriptName) {
    const script = getProjectScript(projectRoot, scriptName);
    if (script) {
      const cli = detectScriptCli(script);
      // Expo: --device <serial>; RN: --deviceId <serial>.
      const deviceFlag = cli === 'expo' ? `--device ${serial}` : `--deviceId ${serial}`;
      return buildScriptCommand(packageManager, scriptName, [
        deviceFlag,
        `--port ${port}`,
      ]);
    }
  }
  if (isExpo) {
    return `npx expo run:android --device ${serial} --port ${port}`;
  }
  return `RCT_METRO_PORT=${port} npx react-native run-android --deviceId ${serial}`;
}

export function buildMetroCommand({ isExpo, port }) {
  return isExpo
    ? `npx expo start --port ${port}`
    : `npx react-native start --port ${port}`;
}

export function resolveSimNameByUdid(udid) {
  const sims = listAllIosSims();
  const target = sims.find(s => s.udid === udid);
  if (!target) throw new Error(`Simulator UDID not found: ${udid}`);
  const sameName = sims.filter(s => s.name === target.name);
  if (sameName.length > 1) {
    throw new Error(
      `Ambiguous: multiple simulators named "${target.name}" -- bare RN takes a name, not UDID. ` +
      `Rename one in the Simulator app.`
    );
  }
  return target.name;
}
