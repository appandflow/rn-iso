import type { ProjectRecord } from './config.ts';

const IOS_SIM_MB = 1500;
const ANDROID_EMULATOR_MB = 2500;
const METRO_MB = 700;

export interface SimFacts {
  udid?: string;
  name?: string;
  state?: string;
  [key: string]: unknown;
}

export interface MetroFacts {
  metro?: { pid: number } | null;
  notOurs?: string;
  [key: string]: unknown;
}

interface SupervisorFacts {
  pid?: number | null;
  mode?: string | null;
  startedAt?: string | null;
  alive?: boolean;
  healthy?: boolean;
}

interface LogsFacts {
  dir: string;
  errorsSinceMarker?: number;
}

export interface WorktreeFacts {
  path: string;
  branch?: string;
  [key: string]: unknown;
}

export interface EnvironmentState {
  path: string;
  live: boolean;
  memoryMb: number;
  warnings: string[];
  ios?: { name: string | null; udid: string; owned: boolean; state: string } | null;
  android?: { name: string | undefined; owned: boolean; physical: boolean } | null;
  metro?: { port: number; running: boolean; pid: number | null } | null;
  supervisor?: { pid: number | null; mode: string | null; startedAt: string | null; healthy: boolean } | null;
  logs?: { dir: string; errorsSinceMarker: number } | null;
  worktree?: WorktreeFacts | null;
}

export interface DiskInfo {
  availableMb: number;
  totalMb: number;
}

export interface VolumeInfo {
  volume: string;
  disk: DiskInfo | null;
}

export function environmentState(
  project: ProjectRecord & { __path: string },
  {
    simsByUdid = {},
    metro = null,
    worktrees = [],
    simsAvailable = true,
    supervisor = null,
    logs = null,
  }: {
    simsByUdid?: Record<string, SimFacts>;
    metro?: MetroFacts | null;
    worktrees?: WorktreeFacts[];
    simsAvailable?: boolean;
    supervisor?: SupervisorFacts | null;
    logs?: LogsFacts | null;
  } = {},
): EnvironmentState {
  const ios = project.platforms?.ios;
  const android = project.platforms?.android;
  const sim = ios ? simsByUdid[ios.deviceUdid as string] : null;

  const simBooted = Boolean(sim && sim.state === 'Booted');
  const metroRunning = Boolean(metro?.metro);
  const live = simBooted || metroRunning || Boolean(android?.serial);

  let memoryMb = 0;
  if (simBooted) memoryMb += IOS_SIM_MB;
  if (android?.serial) memoryMb += ANDROID_EMULATOR_MB;
  if (metroRunning) memoryMb += METRO_MB;

  const warnings: string[] = [];
  if (metro?.notOurs) warnings.push(`port ${project.metroPort}: ${metro.notOurs}`);
  if (ios && !sim && simsAvailable) warnings.push(`recorded sim ${ios.deviceUdid} no longer exists`);
  if (simBooted && project.metroPort && !metroRunning) {
    warnings.push('simulator is booted with no Metro serving it');
  }
  if (supervisor && supervisor.alive === false) {
    warnings.push(`stale supervisor record for ${project.__path}`);
  }

  return {
    path: project.__path,
    live,
    memoryMb,
    warnings,
    ios: ios
      ? {
          name: sim?.name ?? null,
          udid: ios.deviceUdid as string,
          owned: Boolean(ios.owned),
          state: sim?.state ?? (simsAvailable ? 'missing' : 'unknown'),
        }
      : null,
    android: android
      ? {
          name: android.avdName ?? android.serial,
          owned: Boolean(android.owned),
          physical: Boolean(android.serial && !android.avdName),
        }
      : null,
    metro: project.metroPort
      ? { port: project.metroPort, running: metroRunning, pid: metro?.metro?.pid ?? null }
      : null,
    supervisor: supervisor
      ? {
          pid: supervisor.pid ?? null,
          mode: supervisor.mode ?? null,
          startedAt: supervisor.startedAt ?? null,
          healthy: Boolean(supervisor.healthy),
        }
      : null,
    logs: logs ? { dir: logs.dir, errorsSinceMarker: logs.errorsSinceMarker ?? 0 } : null,
    worktree: worktrees.find((w) => w.path === project.__path) ?? null,
  };
}

export function capacity(
  states: EnvironmentState[],
  totalMemoryMb: number,
): { liveCount: number; committedMb: number; totalMemoryMb: number; overCapacity: boolean } {
  const committedMb = states.reduce((n: number, s) => n + s.memoryMb, 0);
  const liveCount = states.filter((s) => s.live).length;
  return {
    liveCount,
    committedMb,
    totalMemoryMb,
    overCapacity: Boolean(totalMemoryMb && committedMb > totalMemoryMb * 0.6),
  };
}

export function parseDfFree(output: unknown): DiskInfo | null {
  const lines = String(output || '')
    .trim()
    .split('\n');
  if (lines.length < 2) return null;
  const lastLine = lines[lines.length - 1];
  if (lastLine === undefined) return null;
  const m = /\s(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%/.exec(lastLine);
  if (!m) return null;
  const totalKb = Number(m[1]);
  const availableKb = Number(m[3]);
  if (!Number.isFinite(totalKb) || !Number.isFinite(availableKb) || totalKb <= 0) return null;
  return { availableMb: Math.round(availableKb / 1024), totalMb: Math.round(totalKb / 1024) };
}

export function diskIsTight(disk: DiskInfo | null | undefined): boolean {
  return Boolean(disk && disk.availableMb < 25 * 1024);
}

export function formatSpace(mb: number): string {
  if (!Number.isFinite(mb)) return '?';
  if (mb >= 1024 * 1024) return `${(mb / (1024 * 1024)).toFixed(1)} TB`;
  if (mb >= 1024) return `${Math.round(mb / 1024)} GB`;
  return `${Math.round(mb)} MB`;
}

export function diskLine(volumes: VolumeInfo[] | null | undefined): string | null {
  const usable = (volumes || []).filter((v): v is VolumeInfo & { disk: DiskInfo } => Boolean(v && v.disk));
  if (usable.length === 0) return null;
  if (usable.length === 1) {
    const first = usable[0];
    if (!first) return null;
    const { disk } = first;
    return `${formatSpace(disk.availableMb)} free of ${formatSpace(disk.totalMb)} on disk.`;
  }
  return `${usable.map((v) => `${formatSpace(v.disk.availableMb)} free on ${v.volume}`).join(', ')}.`;
}

export function tightVolumes(volumes: VolumeInfo[] | null | undefined): VolumeInfo[] {
  return (volumes || []).filter((v) => v && diskIsTight(v.disk));
}

export function unprovisionedWorktrees(worktrees: WorktreeFacts[], projectPaths: string[]): WorktreeFacts[] {
  const known = new Set(projectPaths);
  return worktrees.filter((w) => !known.has(w.path));
}
