import { existsSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { listAllIosSims } from './sim/ios.js';

const LOCKFILES = [
  // Order matters: most specific / modern first. If a project has multiple
  // lockfiles (e.g., during a migration), the first match wins.
  { name: 'bun.lock', pm: 'bun' },
  { name: 'bun.lockb', pm: 'bun' },
  { name: 'pnpm-lock.yaml', pm: 'pnpm' },
  { name: 'yarn.lock', pm: 'yarn' },
  { name: 'package-lock.json', pm: 'npm' },
];

// Walk up from startDir looking for a lockfile. In monorepos the lockfile
// lives at the workspace root, several levels above any individual package.
// Returns { dir, pm } or null if no lockfile is found before the filesystem
// root.
export function findLockfile(startDir) {
  let dir = resolve(startDir);
  while (true) {
    for (const { name, pm } of LOCKFILES) {
      if (existsSync(join(dir, name))) return { dir, pm };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Detect package manager from lockfiles, walking up for monorepos.
// Defaults to npm when no lockfile is found anywhere up the tree.
export function detectPackageManager(projectRoot) {
  return findLockfile(projectRoot)?.pm || 'npm';
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

// Decide which CLI a script invokes. Affects flag names:
//   iOS:     Expo `--device <UDID>`     | RN `--udid <UDID>`
//   Android: Expo `--device <AVD-name>` | RN `--device <serial>`
// Expo's run:android resolves --device by name (not by serial), so we pass
// the AVD name there even though we boot/track by serial.
export function detectScriptCli(scriptBody) {
  if (typeof scriptBody !== 'string') return 'unknown';
  if (/\bexpo\s+(run:ios|run:android|start)\b/.test(scriptBody)) return 'expo';
  if (/\breact-native\s+(run-ios|run-android|start)\b/.test(scriptBody)) return 'react-native';
  return 'unknown';
}

// iOS run command. Prefers the project's `ios` script if present (the most
// reliable: respects user customization, picks the right CLI). Falls back to
// expo run:ios / react-native run-ios when no script exists or --no-script.
// Any `extras` are appended last so they can override earlier flags (CLIs
// using commander/yargs are last-wins on repeated options).
export function buildIosCommand({ projectRoot, packageManager, scriptName, isExpo, udid, port, useScript = true, extras = [] }) {
  const tail = (extras || []).map(shQuote);
  if (useScript && scriptName) {
    const script = getProjectScript(projectRoot, scriptName);
    if (script) {
      const cli = detectScriptCli(script);
      // Expo: --device <UDID>; RN (and unknown, common case): --udid <UDID>.
      const deviceFlag = cli === 'expo' ? `--device ${udid}` : `--udid ${udid}`;
      return buildScriptCommand(packageManager, scriptName, [
        deviceFlag,
        `--port ${port}`,
        ...tail,
      ]);
    }
  }
  const tailStr = tail.length ? ' ' + tail.join(' ') : '';
  if (isExpo) {
    return `npx expo run:ios --device ${udid} --port ${port}${tailStr}`;
  }
  return `npx react-native run-ios --udid ${udid} --port ${port}${tailStr}`;
}

export function buildAndroidCommand({ projectRoot, packageManager, scriptName, isExpo, avdName, serial, port, useScript = true, extras = [] }) {
  const tail = (extras || []).map(shQuote);
  // Expo `--device <id>` accepts either an AVD name (emulators) or a
  // hardware serial (physical devices). When no AVD name is available
  // (physical), fall back to the serial.
  const expoDeviceArg = avdName ?? serial;
  if (useScript && scriptName) {
    const script = getProjectScript(projectRoot, scriptName);
    if (script) {
      const cli = detectScriptCli(script);
      // Expo: --device <AVD name | serial>; RN: --device <serial>.
      const deviceFlag = cli === 'expo' ? `--device "${expoDeviceArg}"` : `--device ${serial}`;
      return buildScriptCommand(packageManager, scriptName, [
        deviceFlag,
        `--port ${port}`,
        ...tail,
      ]);
    }
  }
  const tailStr = tail.length ? ' ' + tail.join(' ') : '';
  if (isExpo) {
    return `npx expo run:android --device "${expoDeviceArg}" --port ${port}${tailStr}`;
  }
  return `RCT_METRO_PORT=${port} npx react-native run-android --device ${serial}${tailStr}`;
}

// POSIX-safe single-quote shell escape. Leaves "safe" tokens (alnum and a
// few harmless punctuation marks like `=`, `.`, `,`, `:`, `/`, `-`, `@`,
// `+`, `_`, `%`) alone, single-quotes everything else.
export function shQuote(s) {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
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
