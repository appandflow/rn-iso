import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { getExecutor } from './exec.ts';

const VERSION_OUTPUT_LIMIT = 4096;

export interface StimInstallation {
  path: string;
  realPath: string;
  version: string | null;
}

export interface StimVersionReport {
  runningVersion: string;
  runningPath: string | null;
  resolved: StimInstallation | null;
  installations: StimInstallation[];
  versions: string[];
  highestVersion: string | null;
  resolvedIsOlder: boolean;
}

interface ParsedVersion {
  core: number[];
  prerelease: Array<number | string> | null;
}

function parsedVersion(version: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return null;
  const core = [match[1] as string, match[2] as string, match[3] as string];
  if (core.some((part) => part.length > 1 && part.startsWith('0'))) return null;
  const prereleaseParts = match[4]?.split('.');
  if (prereleaseParts?.some((part) => !part || (/^\d+$/.test(part) && part.length > 1 && part.startsWith('0')))) {
    return null;
  }
  const prerelease = prereleaseParts?.map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  return {
    core: core.map(Number),
    prerelease: prerelease ?? null,
  };
}

export function compareStimVersions(left: string, right: string): number | null {
  const a = parsedVersion(left);
  const b = parsedVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < a.core.length; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function parseStimVersionOutput(output: string | null): string | null {
  const version = output?.split('\n')[0]?.trim() ?? '';
  return parsedVersion(version) ? version.replace(/^v/, '') : null;
}

function executableNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['stim.cmd', 'stim.exe', 'stim'] : ['stim'];
}

function stimExecutablePaths(
  pathValue: string,
  { platform = process.platform, cwd = process.cwd() }: { platform?: NodeJS.Platform; cwd?: string } = {},
): Array<{ path: string; realPath: string }> {
  const found: Array<{ path: string; realPath: string }> = [];
  const seen = new Set<string>();
  for (const entry of pathValue.split(delimiter)) {
    const directory = resolve(cwd, entry || '.');
    for (const name of executableNames(platform)) {
      const path = join(directory, name);
      try {
        accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
        if (!statSync(path).isFile()) continue;
        const realPath = realpathSync(path);
        if (seen.has(realPath)) continue;
        seen.add(realPath);
        found.push({ path, realPath });
      } catch {}
    }
  }
  return found;
}

function canonicalPath(path: string | undefined): string | null {
  if (!path) return null;
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

export function analyzeStimVersions(
  runningVersion: string,
  runningPath: string | null,
  installations: StimInstallation[],
): StimVersionReport {
  const candidates: Array<string | null> = [runningVersion, ...installations.map((entry) => entry.version)];
  const versions = [...new Set(candidates)]
    .filter((version): version is string => version !== null && compareStimVersions(version, version) !== null)
    .toSorted((left, right) => -(compareStimVersions(left, right) ?? 0));
  const highestVersion = versions[0] ?? null;
  const resolved = installations[0] ?? null;
  return {
    runningVersion,
    runningPath,
    resolved,
    installations,
    versions,
    highestVersion,
    resolvedIsOlder: Boolean(
      resolved?.version && highestVersion && (compareStimVersions(resolved.version, highestVersion) ?? 0) < 0,
    ),
  };
}

function probeStimVersion(path: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolveProbe) => {
    let settled = false;
    let output = '';
    const finish = (version: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProbe(version);
    };
    let child;
    try {
      child = getExecutor().spawn(path, ['--version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: process.platform !== 'win32',
      });
    } catch {
      resolveProbe(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
      finish(null);
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      if (output.length < VERSION_OUTPUT_LIMIT) output += String(chunk).slice(0, VERSION_OUTPUT_LIMIT - output.length);
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? parseStimVersionOutput(output) : null));
  });
}

export async function inspectStimVersions(
  runningVersion: string,
  {
    pathValue = process.env.PATH ?? '',
    runningPath = process.argv[1],
    probeTimeoutMs = 5000,
  }: { pathValue?: string; runningPath?: string; probeTimeoutMs?: number } = {},
): Promise<StimVersionReport> {
  const paths = stimExecutablePaths(pathValue);
  const versions = await Promise.all(paths.map((entry) => probeStimVersion(entry.path, probeTimeoutMs)));
  const installations = paths.map((entry, index) => ({
    path: entry.path,
    realPath: entry.realPath,
    version: versions[index] ?? null,
  }));
  return analyzeStimVersions(runningVersion, canonicalPath(runningPath), installations);
}
