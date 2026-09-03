import chalk from 'chalk';
import type { Command } from 'commander';
import { clockTime } from '../command-output.ts';
import {
  fileLeaseIo,
  parseLeaseDuration,
  releaseWorkspaceLeases,
  takeLease,
  type LeaseIo,
  type LeasePlatform,
  type ReleasedLease,
} from '../engine/device-lease.ts';
import { parseDeviceWait, waitForDevice } from '../engine/device-lease-run.ts';
import { selectFromPool } from '../engine/device-pool.ts';
import {
  iosPoolCandidates,
  iosPoolNoCandidatesRefusal,
  listIosDevices,
  resolveIosPhysicalDevice,
} from '../engine/ios-device.ts';
import { findProjectRoot } from '../project.ts';
import {
  androidPoolCandidates,
  androidPoolNoCandidatesRefusal,
  listAdbDevices,
  memoizeEmulatorProbe,
  physicalDeviceModel,
  probeEmulatorSerial,
  resolvePhysicalDevice,
} from '../sim/android.ts';

const DEFAULT_FOR = '5m';

export interface DeviceDeps {
  findProjectRoot: typeof findProjectRoot;
  listIosDevices: typeof listIosDevices;
  listAdbDevices: typeof listAdbDevices;
  physicalDeviceModel: typeof physicalDeviceModel;
  probeEmulatorSerial: typeof probeEmulatorSerial;
  takeLease: typeof takeLease;
  releaseLeases: typeof releaseWorkspaceLeases;
  waitForDevice: typeof waitForDevice;
  selectFromPool: typeof selectFromPool;
  io: LeaseIo;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  out: (line: string) => void;
  note: (line: string) => void;
}

const DEFAULT_DEPS: DeviceDeps = {
  findProjectRoot,
  listIosDevices,
  listAdbDevices,
  physicalDeviceModel,
  probeEmulatorSerial,
  takeLease,
  releaseLeases: releaseWorkspaceLeases,
  waitForDevice,
  selectFromPool,
  io: fileLeaseIo,
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  out: (line: string) => console.log(line),
  note: (line: string) => console.error(line),
};

interface LockOptions {
  for?: string;
  wait?: string;
  json?: boolean;
}

interface UnlockOptions {
  json?: boolean;
}

export interface DeviceFailure {
  code: string;
  message: string;
  remedy: string | null;
  lease?: unknown;
}

export interface LockFacts {
  platform: LeasePlatform;
  id: string;
  deviceName: string | null;
  holder: string;
  kind: string;
  grantedAt: string | null;
  expiresAt: string;
  leaseSeconds: number;
}

export function grantLine(facts: LockFacts, durationText: string): string {
  const device = facts.deviceName ? `${facts.deviceName} (${facts.id})` : facts.id;
  return (
    `locked ${device} for ${facts.holder} until ${clockTime(facts.expiresAt)} (${durationText}). ` +
    `Renew: stim device lock ${facts.platform} --for ${durationText}. Release: stim device unlock.`
  );
}

export function releasedLine(lease: ReleasedLease): string {
  const device = lease.deviceName ? `${lease.deviceName} (${lease.id})` : lease.id;
  return `unlocked ${device} -- the ${lease.platform} lease ran until ${clockTime(lease.expiresAt)}.`;
}

function readPlatform(value: unknown): LeasePlatform | null {
  return value === 'ios' || value === 'android' ? value : null;
}

interface ResolvedDevice {
  id: string;
  deviceName: string | null;
}

function resolveDevice(
  platform: LeasePlatform,
  requested: string | null,
  d: DeviceDeps,
): ResolvedDevice | DeviceFailure {
  if (platform === 'ios') {
    const resolved = resolveIosPhysicalDevice(requested, d.listIosDevices());
    if (!resolved.udid) {
      return { code: 'STIM_NO_DEVICE', message: resolved.error as string, remedy: resolved.remedy ?? null };
    }
    return { id: resolved.udid, deviceName: resolved.name ?? resolved.udid };
  }
  const resolved = resolvePhysicalDevice(requested, d.listAdbDevices(), d.probeEmulatorSerial);
  if (!resolved.serial) {
    return { code: 'STIM_NO_DEVICE', message: resolved.error as string, remedy: resolved.remedy ?? null };
  }
  return { id: resolved.serial, deviceName: d.physicalDeviceModel(resolved.serial) ?? resolved.serial };
}

function isFailure(value: object): value is DeviceFailure {
  return 'code' in value;
}

async function poolDevice(
  platform: LeasePlatform,
  idLabel: string,
  waitSeconds: number,
  deadline: number,
  root: string,
  d: DeviceDeps,
): Promise<ResolvedDevice | DeviceFailure> {
  const isEmulator = memoizeEmulatorProbe(d.probeEmulatorSerial);
  const pooled = await d.selectFromPool({
    root,
    platform,
    idLabel,
    list: () =>
      platform === 'ios'
        ? iosPoolCandidates(d.listIosDevices()).map((entry) => ({ id: entry.udid, name: entry.name }))
        : androidPoolCandidates(d.listAdbDevices(), isEmulator).map((entry) => ({ id: entry.serial })),
    noCandidates: () => {
      const resolved =
        platform === 'ios'
          ? iosPoolNoCandidatesRefusal(d.listIosDevices())
          : androidPoolNoCandidatesRefusal(d.listAdbDevices(), isEmulator);
      return { message: resolved.error as string, remedy: resolved.remedy as string };
    },
    waitSeconds,
    deadline,
    now: d.now,
    sleep: d.sleep,
    warn: (line: string) => d.note(chalk.yellow(line)),
    io: d.io,
  });
  if (pooled.status === 'refused') {
    return {
      code: pooled.refusal.code,
      message: pooled.refusal.message,
      remedy: pooled.refusal.remedy,
      ...(pooled.refusal.lease === null ? {} : { lease: pooled.refusal.lease }),
    };
  }
  const name =
    pooled.candidate.name ?? (platform === 'ios' ? pooled.candidate.id : d.physicalDeviceModel(pooled.candidate.id));
  return { id: pooled.candidate.id, deviceName: name ?? pooled.candidate.id };
}

export async function runLock(
  platformArg: string,
  idArg: string | undefined,
  opts: LockOptions = {},
  overrides: Partial<DeviceDeps> = {},
): Promise<LockFacts | DeviceFailure> {
  const d: DeviceDeps = { ...DEFAULT_DEPS, ...overrides };
  const json = Boolean(opts.json);
  const report = (failure: DeviceFailure): DeviceFailure => {
    d.note(chalk.red(`${failure.code}: ${failure.message}`));
    if (failure.remedy) d.note(chalk.dim(failure.remedy));
    if (json) {
      d.out(
        JSON.stringify({
          code: failure.code,
          message: failure.message,
          remedy: failure.remedy,
          ...(failure.lease === undefined ? {} : { lease: failure.lease }),
        }),
      );
    }
    return failure;
  };

  const platform = readPlatform(platformArg);
  if (!platform) {
    return report({
      code: 'STIM_BAD_ARG',
      message: `\`stim device lock\` takes ios or android, not ${JSON.stringify(platformArg)}.`,
      remedy: 'Run `stim device lock ios` or `stim device lock android`.',
    });
  }

  const root = d.findProjectRoot(process.cwd());
  if (!root) {
    return report({
      code: 'STIM_NO_PROJECT',
      message: 'Not in a React Native project (no package.json found).',
      remedy: 'Run this from the app directory -- the one holding package.json.',
    });
  }

  const durationText = String(opts.for ?? DEFAULT_FOR).trim();
  const duration = parseLeaseDuration(durationText);
  if ('error' in duration) {
    return report({
      code: 'STIM_BAD_ARG',
      message: duration.error,
      remedy: 'Pass a whole number of seconds or minutes from 10s to 30m, e.g. --for 90s or --for 10m.',
    });
  }

  const wait = parseDeviceWait(opts.wait);
  if ('error' in wait) {
    return report({
      code: 'STIM_BAD_ARG',
      message: wait.error,
      remedy: 'Pass a whole number of seconds, e.g. --wait 90. `--wait 0` refuses a leased device at once.',
    });
  }

  const idLabel = platform === 'ios' ? 'udid' : 'serial';
  const deadline = d.now() + wait.seconds * 1000;
  const lastLine: { at: number | null } = { at: null };

  const device = idArg
    ? resolveDevice(platform, idArg, d)
    : await poolDevice(platform, idLabel, wait.seconds, deadline, root, d);
  if (isFailure(device)) return report(device);

  for (;;) {
    const outcome = await d.waitForDevice({
      root,
      platform,
      id: device.id,
      idLabel,
      waitSeconds: wait.seconds,
      now: d.now,
      sleep: d.sleep,
      warn: (line: string) => d.note(chalk.yellow(line)),
      io: d.io,
      deadline,
      lastLine,
    });
    if (outcome.status === 'refused') {
      return report({ ...outcome.refusal, lease: outcome.refusal.lease });
    }

    const taken = d.takeLease(
      {
        root,
        platform,
        id: device.id,
        deviceName: device.deviceName,
        kind: 'declared',
        durationMs: duration.ms,
      },
      d.io,
    );
    if (taken.status === 'unreadable') {
      return report({
        code: 'STIM_DEVICE_BUSY',
        message: `The lease file at ${taken.path} does not parse, so Stim cannot tell who holds that device.`,
        remedy: `Read ${taken.path} and, once you know no run depends on it, delete it. \`stim gc\` reports it on every run.`,
        lease: { platform: null, id: null, deviceName: null, holder: null, expiresAt: null },
      });
    }
    if (taken.status === 'held') continue;

    const facts: LockFacts = {
      platform,
      id: taken.lease.id,
      deviceName: taken.lease.deviceName,
      holder: taken.lease.holder,
      kind: 'declared',
      grantedAt: taken.lease.grantedAt,
      expiresAt: taken.lease.expiresAt,
      leaseSeconds: Math.round(duration.ms / 1000),
    };
    if (json) d.out(JSON.stringify(facts));
    else d.out(chalk.green(grantLine(facts, durationText)));
    return facts;
  }
}

export async function runUnlock(
  platformArg: string | undefined,
  opts: UnlockOptions = {},
  overrides: Partial<DeviceDeps> = {},
): Promise<ReleasedLease[] | DeviceFailure> {
  const d: DeviceDeps = { ...DEFAULT_DEPS, ...overrides };
  const json = Boolean(opts.json);
  const report = (failure: DeviceFailure): DeviceFailure => {
    d.note(chalk.red(`${failure.code}: ${failure.message}`));
    if (failure.remedy) d.note(chalk.dim(failure.remedy));
    if (json) d.out(JSON.stringify({ code: failure.code, message: failure.message, remedy: failure.remedy }));
    return failure;
  };

  const platform = platformArg === undefined ? null : readPlatform(platformArg);
  if (platformArg !== undefined && !platform) {
    return report({
      code: 'STIM_BAD_ARG',
      message: `\`stim device unlock\` takes ios or android, not ${JSON.stringify(platformArg)}.`,
      remedy: 'Run `stim device unlock` for every lease this workspace holds, or name one platform.',
    });
  }

  const root = d.findProjectRoot(process.cwd());
  if (!root) {
    return report({
      code: 'STIM_NO_PROJECT',
      message: 'Not in a React Native project (no package.json found).',
      remedy: 'Run this from the app directory -- the one holding package.json.',
    });
  }

  const released = d.releaseLeases(root, { platform }, d.io);
  if (released.length === 0) {
    d.note(
      chalk.dim(
        `No ${platform ? `${platform} ` : ''}device lease to release for ${root}. ` +
          '`stim status` lists every lease on this machine.',
      ),
    );
  }
  if (json) d.out(JSON.stringify(released.map((lease) => ({ ...lease, holder: root }))));
  else for (const lease of released) d.out(chalk.green(releasedLine(lease)));
  return released;
}

export function registerDevice(program: Command, deps: Partial<DeviceDeps> = {}): void {
  const device = program
    .command('device')
    .description('Lease a connected physical device to this workspace, and give it back');

  device
    .command('lock')
    .argument('<platform>', 'ios or android')
    .argument('[id]', 'the UDID or serial to lease; without one, the first free connected device is used')
    .description(
      "Lease a connected physical device to this workspace for a declared time, so another workspace's " +
        '`--device` run waits instead of installing over it. Nothing but this command and a `--device` run moves the expiry.',
    )
    .option(
      '--for <duration>',
      `How long to hold it: a whole number of seconds or minutes from 10s to 30m (default ${DEFAULT_FOR})`,
    )
    .option(
      '--wait <seconds>',
      'How long to wait for a device another workspace holds, before refusing with STIM_DEVICE_BUSY (default 60, 0 refuses at once)',
    )
    .option('--json', 'print the lease as JSON on stdout')
    .action(async (platform: string, id: string | undefined, opts: LockOptions) => {
      const result = await runLock(platform, id, opts, deps);
      if ('code' in result) process.exit(1);
    });

  device
    .command('unlock')
    .argument('[platform]', 'ios or android; without one, every lease this workspace holds is released')
    .description('Release the device lease or leases this workspace holds. Releasing nothing is not an error.')
    .option('--json', 'print the released leases as JSON on stdout')
    .action(async (platform: string | undefined, opts: UnlockOptions) => {
      const result = await runUnlock(platform, opts, deps);
      if (!Array.isArray(result)) process.exit(1);
    });
}

export default function deviceCommand(program: Command): void {
  registerDevice(program);
}
