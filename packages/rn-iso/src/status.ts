// The one question a machine running several agents actually raises: who is
// using this Mac right now, and is anything stuck?
//
// The registry alone cannot answer it. A project entry says a simulator was
// assigned, not whether it is booted; it says a port was reserved, not whether
// Metro is listening or whether the thing listening is even ours. Those gaps are
// exactly where a wedged environment hides, so this assembles the live facts
// alongside the recorded ones.
//
// Kept pure: every fact comes in as an argument, so the shape of the report can
// be tested without a simulator, a port or a git repo.

import type { ProjectRecord } from './config.ts';

// Rough, and deliberately so. The point is not to model memory accurately, it is
// to notice that a fourth environment on a 16 GB laptop will swap -- and swapping
// is slower than working sequentially, which is the one failure mode a parallel
// agent cannot see for itself.
const IOS_SIM_MB = 1500;
const ANDROID_EMULATOR_MB = 2500;
const METRO_MB = 700;

// Loosely-typed views of facts this module receives already resolved by its
// caller (commands/status.js): a simctl listing, a Metro identity probe, a
// supervisor record, a worktree list, a log summary. None of these are
// produced here, so each is modelled as a flat bag of the fields this module
// actually reads rather than imported from the module that built it.
interface SimFacts {
  udid?: string;
  name?: string;
  state?: string;
  [key: string]: unknown;
}

interface MetroFacts {
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

interface WorktreeFacts {
  path: string;
  branch?: string;
  [key: string]: unknown;
}

// The report `environmentState` builds. A flat interface with every
// project-shaped field optional -- `ios` / `android` / `metro` / `supervisor`
// / `logs` are each present only when the project has that platform or fact,
// mirroring the defensive `?.` reads every consumer already does.
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

// `simsAvailable: false` means the sim listing could not be read at all
// (simctl missing, or a failing simctl). An empty map then says nothing about
// any recorded sim, so this reports the state as unknown instead of claiming
// every recorded device is gone.
//
// `supervisor` and `logs` arrive the same way as `metro`: already resolved.
// `supervisor` is `{ pid, mode, startedAt, alive, healthy }` -- `alive` is
// "the pid exists", `healthy` is "and resolveProjectMetro proves the thing on
// its port is ours". The two differ for a supervisor that is still coming up
// or has wedged, and only the first distinguishes a record whose process is
// gone. `logs` is `{ dir, errorsSinceMarker }` or null when the workspace has
// no log directory yet.
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
  // `deviceUdid` reaches DeviceRecord's index signature (the interface only
  // names the fields it declares up front) rather than a typed field, hence
  // the cast: the value is a udid string wherever this codebase writes it.
  const sim = ios ? simsByUdid[ios.deviceUdid as string] : null;

  // "Live" means something is actually consuming the machine right now: a booted
  // device or a running Metro. A registered-but-idle project costs nothing and
  // should not read as competition for resources.
  const simBooted = Boolean(sim && sim.state === 'Booted');
  const metroRunning = Boolean(metro?.metro);
  const live = simBooted || metroRunning || Boolean(android?.serial);

  let memoryMb = 0;
  if (simBooted) memoryMb += IOS_SIM_MB;
  if (android?.serial) memoryMb += ANDROID_EMULATOR_MB;
  if (metroRunning) memoryMb += METRO_MB;

  const warnings: string[] = [];
  // A port reserved for us that something else answers on is the failure that
  // silently builds against the wrong bundler, so it outranks everything else.
  if (metro?.notOurs) warnings.push(`port ${project.metroPort}: ${metro.notOurs}`);
  // A device recorded but no longer present means the record outlived the sim.
  if (ios && !sim && simsAvailable) warnings.push(`recorded sim ${ios.deviceUdid} no longer exists`);
  // Booted with no bundler is the shape of an environment somebody walked away
  // from: it holds ~1.5 GB and serves nothing.
  if (simBooted && project.metroPort && !metroRunning) {
    warnings.push('simulator is booted with no Metro serving it');
  }
  // A registration whose process is gone is what `start` would read as "already
  // running" and what `worktree remove` would go looking for. Nothing else on
  // the machine reports it. An unhealthy but LIVE supervisor is not this: the
  // pid is real, so stopping it is still `stop`'s job, not a cleanup.
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
      ? { name: android.avdName ?? android.serial, owned: Boolean(android.owned), physical: Boolean(android.serial && !android.avdName) }
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
    // A worktree whose environment is registered is the normal case; one without
    // is a workspace nobody has provisioned yet, which is worth seeing.
    worktree: worktrees.find(w => w.path === project.__path) ?? null,
  };
}

// Over capacity is the interesting verdict, not exact numbers: past the point
// where committed memory exceeds what the machine has, more parallelism makes
// everything slower, and nothing else in the system will say so.
export function capacity(states: EnvironmentState[], totalMemoryMb: number): { liveCount: number; committedMb: number; totalMemoryMb: number; overCapacity: boolean } {
  const committedMb = states.reduce((n: number, s) => n + s.memoryMb, 0);
  const liveCount = states.filter(s => s.live).length;
  return {
    liveCount,
    committedMb,
    totalMemoryMb,
    // Leave room for the OS and an editor; a machine at 100% committed is
    // already swapping.
    overCapacity: Boolean(totalMemoryMb && committedMb > totalMemoryMb * 0.6),
  };
}

// Free disk, parsed from `df -k <path>`. rn-iso reports RAM commitment but was
// silent about disk, and disk is what actually ran out: two member-app
// environments filled a 926 GB volume, and once it was full nothing could run
// at all -- including `gc`, the command that exists to reclaim space.
//
// `df -k` rather than `-h` so the number needs no unit parsing. Returns null on
// any surprise: this is a hint printed beside a summary, never a gate.
export function parseDfFree(output: unknown): DiskInfo | null {
  const lines = String(output || '').trim().split('\n');
  if (lines.length < 2) return null;
  // Fields: Filesystem 1024-blocks Used Available Capacity ... Mounted-on.
  // The filesystem name can contain spaces, so count from the RIGHT of the
  // capacity field rather than assuming field 0 is one token.
  const m = /\s(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%/.exec(lines[lines.length - 1]);
  if (!m) return null;
  const totalKb = Number(m[1]);
  const availableKb = Number(m[3]);
  if (!Number.isFinite(totalKb) || !Number.isFinite(availableKb) || totalKb <= 0) return null;
  return { availableMb: Math.round(availableKb / 1024), totalMb: Math.round(totalKb / 1024) };
}

// Below this, a single iOS build can fail partway with a disk error that names
// nothing about disk. Worth saying before it happens, not after.
export function diskIsTight(disk: DiskInfo | null | undefined): boolean {
  return Boolean(disk && disk.availableMb < 25 * 1024);
}

// Pure. Free space at the scale it is being read at: whole GB up to a terabyte,
// one decimal past it. The memory summary keeps its own one-decimal GB, because
// there the interesting range is 8-64 and a rounded "16 GB of 16 GB" hides the
// margin this report exists to show.
export function formatSpace(mb: number): string {
  if (!Number.isFinite(mb)) return '?';
  if (mb >= 1024 * 1024) return `${(mb / (1024 * 1024)).toFixed(1)} TB`;
  if (mb >= 1024) return `${Math.round(mb / 1024)} GB`;
  return `${Math.round(mb)} MB`;
}

// Pure. The disk summary, over however many volumes are actually in play.
//
// It reported the boot volume and only the boot volume, which on this machine
// is the wrong number twice over: the repos live on an external SSD, so the
// figure printed described a volume nothing was building on, and the volume
// that could actually fill up went unmentioned. Build output is workspace-local
// (`<root>/.rn-iso/derived-data`), so the project's volume is where a build
// runs out of room; the boot volume still matters because the shared caches and
// the simulator device set live under $HOME.
//
// One volume keeps the free-of-total form -- there is room for it, and the
// total is what makes "38 GB" mean something. Two get free space each, named by
// volume, because that is the comparison being made.
export function diskLine(volumes: VolumeInfo[] | null | undefined): string | null {
  const usable = (volumes || []).filter((v): v is VolumeInfo & { disk: DiskInfo } => Boolean(v && v.disk));
  if (usable.length === 0) return null;
  if (usable.length === 1) {
    const { disk } = usable[0];
    return `${formatSpace(disk.availableMb)} free of ${formatSpace(disk.totalMb)} on disk.`;
  }
  return `${usable.map(v => `${formatSpace(v.disk.availableMb)} free on ${v.volume}`).join(', ')}.`;
}

// Pure. Which of the reported volumes are tight enough to fail a build partway.
export function tightVolumes(volumes: VolumeInfo[] | null | undefined): VolumeInfo[] {
  return (volumes || []).filter(v => v && diskIsTight(v.disk));
}

// Worktrees rn-iso knows nothing about: a workspace someone created by hand, or
// one whose environment was released. Listing them is what makes this a
// replacement for `worktree list` rather than a second thing to check.
export function unprovisionedWorktrees(worktrees: WorktreeFacts[], projectPaths: string[]): WorktreeFacts[] {
  const known = new Set(projectPaths);
  return worktrees.filter(w => !known.has(w.path));
}
