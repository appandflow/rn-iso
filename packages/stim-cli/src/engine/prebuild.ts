import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getExecutor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { createLineReader, stripAnsi, waitForChild } from '../process-output.ts';
import { detectIsExpo } from '../project.ts';
import { expoBinPath, expoBinRefusal } from '../supervisor/server-expo.ts';

export const PREBUILD_ERROR = 'STIM_CLI_PREBUILD_FAILED';

const LAST_LINES = 20;

type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess;

export function nativeDirName(platform: string): string {
  return platform === 'android' ? 'android' : 'ios';
}

function nativeDir(root: string, platform: string) {
  return join(root, nativeDirName(platform));
}

export function shouldPrebuild({ isExpo, nativeDirExists }: { isExpo?: unknown; nativeDirExists?: unknown }): boolean {
  return Boolean(isExpo) && !nativeDirExists;
}

export function needsPrebuild(root: string, platform: string, isExpo: unknown): boolean {
  return shouldPrebuild({ isExpo, nativeDirExists: existsSync(nativeDir(root, platform)) });
}

export function prebuildRefusal({
  isExpo,
  platform,
  nativeDirExists,
}: {
  isExpo?: unknown;
  platform: string;
  nativeDirExists?: unknown;
}): { code: string; message: string; remedy: string } | null {
  if (nativeDirExists || isExpo) return null;
  const dir = nativeDirName(platform);
  return {
    code: PREBUILD_ERROR,
    message: `This project has no ${dir}/ directory and is not an Expo (CNG) project, so stim-cli cannot generate one.`,
    remedy: `Check out or generate the native project (\`npx @react-native-community/cli init\` produced one originally), or add \`expo\` to the project so \`expo prebuild\` can create ${dir}/.`,
  };
}

export type RunPrebuildResult = {
  ok?: boolean;
  nativeDir?: string;
  failed?: boolean;
  code?: string;
  reason?: string;
  remedy?: string;
  error?: { code: string; message: string; remedy: string };
  lastLines?: string[];
  durationMs?: number;
};

function prebuildFailure(logWriter: NdjsonWriter | null | undefined, result: RunPrebuildResult): RunPrebuildResult {
  logWriter?.write?.({
    src: 'build',
    level: 'error',
    msg: result.reason || 'Expo prebuild failed.',
    event: 'prebuild_failed',
  });
  return result;
}

export async function runPrebuild(
  root: string,
  platform: string,
  logWriter: NdjsonWriter | null | undefined,
  {
    spawnFn = null,
    now = Date.now,
    isExpo = null,
  }: { spawnFn?: SpawnFn | null; now?: () => number; isExpo?: boolean | null } = {},
): Promise<RunPrebuildResult> {
  const dirExists = existsSync(nativeDir(root, platform));
  const refusal = prebuildRefusal({
    isExpo: isExpo === null ? detectIsExpo(root) : isExpo,
    platform,
    nativeDirExists: dirExists,
  });
  if (refusal) {
    return prebuildFailure(logWriter, {
      failed: true,
      code: refusal.code,
      reason: refusal.message,
      remedy: refusal.remedy,
      error: refusal,
      lastLines: [],
    });
  }

  const bin = expoBinPath(root);
  if (!bin) {
    const binRefusal = expoBinRefusal(root, 'prebuild');
    return prebuildFailure(logWriter, {
      failed: true,
      code: PREBUILD_ERROR,
      reason: binRefusal.message,
      remedy: binRefusal.remedy,
      lastLines: [],
    });
  }

  const spawn: SpawnFn = spawnFn || ((cmd, args, opts) => getExecutor().spawn(cmd, args, opts));
  const startedAt = now();
  const tail: string[] = [];
  const push = (line: unknown) => {
    const msg = stripAnsi(String(line)).trimEnd();
    if (!msg.trim()) return;
    tail.push(msg);
    if (tail.length > LAST_LINES) tail.shift();
    logWriter?.write?.({ src: 'build', level: 'debug', msg, raw: true, event: 'prebuild' });
  };

  let child: ChildProcess;
  try {
    child = spawn(bin, ['prebuild', '-p', platform, '--no-install'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
    });
  } catch (err) {
    return prebuildFailure(logWriter, {
      failed: true,
      code: PREBUILD_ERROR,
      reason: `Could not run \`expo prebuild\`: ${(err as Error)?.message || err}`,
      lastLines: [] as string[],
    });
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
    return prebuildFailure(logWriter, {
      failed: true,
      code: PREBUILD_ERROR,
      reason: `Could not run \`expo prebuild\`: ${result.error?.message || result.error}`,
      lastLines: tail.slice(),
      durationMs,
    });
  }
  if (result.code !== 0) {
    const how = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`;
    return prebuildFailure(logWriter, {
      failed: true,
      code: PREBUILD_ERROR,
      reason: `\`expo prebuild -p ${platform}\` failed (${how}).`,
      lastLines: tail.slice(),
      durationMs,
    });
  }
  if (!existsSync(nativeDir(root, platform))) {
    return prebuildFailure(logWriter, {
      failed: true,
      code: PREBUILD_ERROR,
      reason: `\`expo prebuild -p ${platform}\` succeeded but did not create ${nativeDirName(platform)}/.`,
      lastLines: tail.slice(),
      durationMs,
    });
  }
  return { ok: true, durationMs, nativeDir: nativeDir(root, platform) };
}
