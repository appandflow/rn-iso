// src/engine/prebuild.js -- CNG native project generation, and only when it
// is actually needed.
//
// The rule is narrow on purpose: prebuild runs when the project is an Expo
// (CNG) project AND its native directory is absent. Regenerating a native
// directory that already exists is destructive -- it overwrites hand-edited
// files that a project with committed native sources deliberately keeps --
// and doing it because a build failed for some unrelated reason is how a
// build tool eats someone's work.
//
// The fingerprint is taken BEFORE this runs (see the plan's command flow):
// @expo/fingerprint hashes config and dependencies on a CNG project rather
// than the generated directory, so a cache hit skips generation entirely.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getExecutor } from '../exec.js';
import { detectIsExpo } from '../project.js';
import { createLineReader, expoBinPath, stripAnsi } from '../supervisor/server-expo.js';
// One implementation of the both-endings wait, not two: a spawn that fails
// emits `error` and never `exit`, and awaiting `exit` alone hangs forever on
// exactly the failure these modules exist to report.
import { waitForChild } from './deps.js';

export const PREBUILD_ERROR = 'RN_ISO_PREBUILD_FAILED';

const LAST_LINES = 20;

// PURE. The directory a platform's native project lives in.
export function nativeDirName(platform) {
  return platform === 'android' ? 'android' : 'ios';
}

export function nativeDir(root, platform) {
  return join(root, nativeDirName(platform));
}

// PURE. The decision, with the disk already read.
export function shouldPrebuild({ isExpo, nativeDirExists }) {
  return Boolean(isExpo) && !nativeDirExists;
}

// Thin: the same decision with the one existsSync it needs.
export function needsPrebuild(root, platform, isExpo) {
  return shouldPrebuild({ isExpo, nativeDirExists: existsSync(nativeDir(root, platform)) });
}

// PURE. Why a build cannot proceed, or null when it can. A BARE project with
// no native directory is not a prebuild candidate: there is no config plugin
// pipeline to generate one from, so `expo prebuild` would either fail or --
// worse, if `expo` happens to be installed -- generate a native project from
// defaults that have nothing to do with this app. Refusing with a remedy is
// the honest answer.
export function prebuildRefusal({ isExpo, platform, nativeDirExists }) {
  if (nativeDirExists || isExpo) return null;
  const dir = nativeDirName(platform);
  return {
    code: PREBUILD_ERROR,
    message: `This project has no ${dir}/ directory and is not an Expo (CNG) project, so rn-iso cannot generate one.`,
    remedy: `Check out or generate the native project (\`npx @react-native-community/cli init\` produced one originally), or add \`expo\` to the project so \`expo prebuild\` can create ${dir}/.`,
  };
}

// `<project>/node_modules/.bin/expo prebuild -p <platform> --no-install`.
//
// THE PROJECT'S OWN expo binary, never `npx expo`: npx on a project without
// expo installed silently downloads whatever version is newest and prebuilds
// with it, producing a native project that does not match the app's SDK. The
// same reasoning as server-expo.js, which is where expoBinPath comes from.
//
// `--no-install`, because installing dependencies is the caller's judgment
// (CLAUDE.md item 3): prebuild's job here is to generate the native project,
// and `pod install` is run separately by engine/deps.js against the result.
//
// Never throws. Transcript lines stream to the build log as src "build",
// level debug; a failure comes back as { failed, reason, lastLines }.
export async function runPrebuild(root, platform, logWriter, { spawnFn = null, now = Date.now, isExpo = null } = {}) {
  const dirExists = existsSync(nativeDir(root, platform));
  const refusal = prebuildRefusal({
    isExpo: isExpo === null ? detectIsExpo(root) : isExpo,
    platform,
    nativeDirExists: dirExists,
  });
  if (refusal) {
    return { failed: true, code: refusal.code, reason: refusal.message, remedy: refusal.remedy, error: refusal, lastLines: [] };
  }

  const bin = expoBinPath(root);
  if (!existsSync(bin)) {
    return {
      failed: true,
      code: PREBUILD_ERROR,
      reason: `Cannot prebuild ${root}: ${bin} does not exist.`,
      remedy: 'Run `npm install` in the project so the `expo` package installs its binary.',
      lastLines: [],
    };
  }

  const spawn = spawnFn || ((cmd, args, opts) => getExecutor().spawn(cmd, args, opts));
  const startedAt = now();
  const tail = [];
  const push = (line) => {
    const msg = stripAnsi(String(line)).trimEnd();
    if (!msg.trim()) return;
    tail.push(msg);
    if (tail.length > LAST_LINES) tail.shift();
    logWriter?.write?.({ src: 'build', level: 'debug', msg, raw: true, event: 'prebuild' });
  };

  let child;
  try {
    child = spawn(bin, ['prebuild', '-p', platform, '--no-install'], {
      cwd: root,
      // stdin ignored: prebuild prompts for a bundle identifier when it
      // cannot infer one, and a prompt in a detached agent loop looks like a
      // hang. A missing identifier must fail, visibly, instead.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
    });
  } catch (err) {
    return {
      failed: true,
      code: PREBUILD_ERROR,
      reason: `Could not run \`expo prebuild\`: ${err?.message || err}`,
      lastLines: [],
    };
  }

  const outReader = createLineReader(push);
  const errReader = createLineReader(push);
  child.stdout?.setEncoding?.('utf-8');
  child.stderr?.setEncoding?.('utf-8');
  child.stdout?.on('data', (chunk) => outReader.push(chunk));
  child.stderr?.on('data', (chunk) => errReader.push(chunk));

  const result = await waitForChild(child);
  outReader.flush();
  errReader.flush();
  const durationMs = now() - startedAt;

  if (result.error) {
    return {
      failed: true,
      code: PREBUILD_ERROR,
      reason: `Could not run \`expo prebuild\`: ${result.error?.message || result.error}`,
      lastLines: tail.slice(),
      durationMs,
    };
  }
  if (result.code !== 0) {
    const how = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`;
    return {
      failed: true,
      code: PREBUILD_ERROR,
      reason: `\`expo prebuild -p ${platform}\` failed (${how}).`,
      lastLines: tail.slice(),
      durationMs,
    };
  }
  // A prebuild that exits 0 without producing the directory is a silent
  // no-op, and the build that follows would fail three minutes later with a
  // far worse message.
  if (!existsSync(nativeDir(root, platform))) {
    return {
      failed: true,
      code: PREBUILD_ERROR,
      reason: `\`expo prebuild -p ${platform}\` succeeded but did not create ${nativeDirName(platform)}/.`,
      lastLines: tail.slice(),
      durationMs,
    };
  }
  return { ok: true, durationMs, nativeDir: nativeDir(root, platform) };
}
