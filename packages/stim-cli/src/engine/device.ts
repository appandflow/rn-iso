import chalk from 'chalk';
import {
  allConsolePortsAndSerials,
  clearDevice,
  loadConfig,
  setDevice,
  type Config,
  type ProjectRecord,
} from '../config.ts';
import { isPidAlive } from '../metro.ts';
import { bootIosSim, createOwnedIosSim, listAllIosSims, listIosDeviceTypes, resolveOwnedIosSim } from '../sim/ios.ts';
import {
  bootAndroidEmulator,
  configureNewOwnedAvd,
  createOwnedAvd,
  listAdbDevices,
  listAvds,
  nextConsolePort,
  ownedAvdName,
  resolveOwnedAvdSerial,
  waitForBoot,
} from '../sim/android.ts';
import { androidAvdConfigSetting, androidDataPartitionSizeGbSetting, iosSimSlimProfileSetting } from '../settings.ts';
import { teardownOwnedAvd } from '../teardown.ts';
import { reconcileSimSlim } from './simslim.ts';

export interface OwnedDeviceRecord {
  deviceUdid?: string;
  deviceName?: string;
  owned?: boolean;
  created?: boolean;
  avdName?: string;
  consolePort?: number;
  serial?: string;
  setupIncomplete?: boolean;
  simslimManaged?: boolean;
}

interface DeviceSettings {
  ios?: { deviceType?: string; runtime?: string; simslimProfile?: string };
  android?: {
    systemImage?: string;
    dataPartitionSizeGb?: number;
    avdConfigFile?: string;
    avdConfig?: Record<string, unknown>;
  };
}

interface DeviceFlags {
  deviceType?: string;
  runtime?: string;
  systemImage?: string;
}

type Notify = (msg: string) => void;

type Liveness = (pid: number) => boolean;

interface EmulatorLogging {
  logFile?: string | null;
  alive?: Liveness;
}

type SimRecord = ReturnType<typeof listAllIosSims>[number];
type DeviceTypeInfo = ReturnType<typeof listIosDeviceTypes>[number];
type AdbDevices = ReturnType<typeof listAdbDevices>;
type EmulatorRecord = AdbDevices['emulators'][number];

interface CapacityRefusal {
  code: string;
  message: string;
  remedy: string;
}

export async function ensureOwnedDevice({
  platform,
  project,
  projectPath,
  settingsRoot = projectPath,
  label,
  settings,
  flags = {},
  note = () => {},
  out = () => {},
  logFile = null,
  alive = isPidAlive,
  configureAvd = configureNewOwnedAvd,
  teardownAvd = teardownOwnedAvd,
  reconcileIosSimulator = reconcileSimSlim,
}: {
  platform: string;
  project?: ProjectRecord | null;
  projectPath: string;
  settingsRoot?: string;
  label: string;
  settings: DeviceSettings;
  flags?: DeviceFlags;
  note?: Notify;
  out?: Notify;
  configureAvd?: typeof configureNewOwnedAvd;
  teardownAvd?: typeof teardownOwnedAvd;
  reconcileIosSimulator?: typeof reconcileSimSlim;
} & EmulatorLogging): Promise<OwnedDeviceRecord> {
  const record = (project?.platforms?.[platform] as OwnedDeviceRecord | undefined) ?? null;
  if (platform === 'ios') {
    return ensureOwnedIosDevice({
      record,
      projectPath,
      settingsRoot,
      label,
      settings,
      flags,
      note,
      out,
      reconcileIosSimulator,
    });
  }
  return ensureOwnedAndroidDevice({
    record,
    projectPath,
    settingsRoot,
    label,
    settings,
    flags,
    note,
    out,
    logFile,
    alive,
    configureAvd,
    teardownAvd,
  });
}

async function ensureOwnedIosDevice({
  record,
  projectPath,
  settingsRoot,
  label,
  settings,
  flags,
  note,
  out,
  reconcileIosSimulator,
}: {
  record: OwnedDeviceRecord | null;
  projectPath: string;
  settingsRoot: string;
  label: string;
  settings: DeviceSettings;
  flags: DeviceFlags;
  note: Notify;
  out: Notify;
  reconcileIosSimulator: typeof reconcileSimSlim;
}): Promise<OwnedDeviceRecord> {
  const simslimProfile = iosSimSlimProfileSetting(settings, settingsRoot);
  if (record?.deviceUdid) {
    if (record.owned) {
      const resolved = resolveOwnedIosSim(record.deviceUdid);
      if (resolved.notOwned) {
        note(
          chalk.yellow(
            `Note: recorded sim is now named "${resolved.notOwned}", not stim-cli-owned by name -- creating a fresh owned sim instead of booting it.`,
          ),
        );
      } else if (resolved.missing) {
      } else {
        const sim = resolved.sim as SimRecord;
        const wantedType = flags.deviceType || settings?.ios?.deviceType;
        const mismatch = deviceTypeMismatch(sim.deviceTypeIdentifier, wantedType, listIosDeviceTypes());
        if (mismatch) {
          throw new Error(
            `${mismatch}. stim-cli will not silently boot a different model. ` +
              'Run `stim worktree remove` (or `stim gc --delete`) to reap the current sim, then `stim ios` again to create the requested one.',
          );
        }
        if (sim.state !== 'Booted') {
          out(chalk.dim(`Booting owned sim ${sim.name} (${sim.udid})...`));
          bootIosSim(sim.udid);
        }
        const updated = {
          deviceUdid: sim.udid,
          owned: true,
          deviceName: record.deviceName ?? sim.name,
          ...(record.simslimManaged ? { simslimManaged: true } : {}),
        };
        return configureOwnedIosSim({
          record: updated,
          projectPath,
          profile: simslimProfile,
          out,
          reconcileIosSimulator,
        });
      }
    } else {
      const sim = listAllIosSims().find((s) => s.udid === record.deviceUdid);
      if (sim) {
        if (sim.state !== 'Booted') {
          note(
            chalk.yellow(
              `Note: assigned sim ${sim.name} (${sim.udid}) is shut down and is not owned by stim-cli, so it will not be booted automatically.`,
            ),
          );
          note(
            chalk.dim(
              'Boot it yourself, or run `stim gc --delete` to clear the assignment so stim-cli can create an owned sim.',
            ),
          );
        }
        return record;
      }
    }
  }

  const created = createOwnedIosSim(label, {
    deviceType: flags.deviceType || settings.ios?.deviceType,
    runtime: flags.runtime || settings.ios?.runtime,
  });
  out(chalk.dim(`Created owned sim ${created.name} (${created.udid})`));
  const newRecord = { deviceUdid: created.udid, owned: true, deviceName: created.name };
  setDevice(projectPath, 'ios', newRecord);
  bootIosSim(created.udid);
  const configured = await configureOwnedIosSim({
    record: newRecord,
    projectPath,
    profile: simslimProfile,
    out,
    reconcileIosSimulator,
  });
  return { ...configured, created: true };
}

async function configureOwnedIosSim({
  record,
  projectPath,
  profile,
  out,
  reconcileIosSimulator,
}: {
  record: OwnedDeviceRecord & { deviceUdid: string };
  projectPath: string;
  profile: string | null;
  out: Notify;
  reconcileIosSimulator: typeof reconcileSimSlim;
}): Promise<OwnedDeviceRecord> {
  if (profile) out(chalk.dim(`Applying the configured SimSlim profile to ${record.deviceUdid}...`));
  else if (record.simslimManaged) out(chalk.dim(`Restoring stock simulator services on ${record.deviceUdid}...`));

  const previouslyManaged = Boolean(record.simslimManaged);
  if (profile && !record.simslimManaged) {
    const pending = { ...record, simslimManaged: true };
    setDevice(projectPath, 'ios', pending);
    record = pending;
  }
  const result = await reconcileIosSimulator({
    udid: record.deviceUdid,
    profile,
    previouslyManaged,
    out,
  });
  const updated = { ...record };
  if (result.managed) updated.simslimManaged = true;
  else delete updated.simslimManaged;
  setDevice(projectPath, 'ios', updated);
  return updated;
}

function findOtherProjectOwningAvd(avdName: string, projectPath: string): string | null {
  const cfg = loadConfig();
  for (const [path, proj] of Object.entries(cfg?.projects || {})) {
    if (path === projectPath) continue;
    if (proj?.platforms?.android?.avdName === avdName) return path;
  }
  return null;
}

async function ensureOwnedAndroidDevice({
  record,
  projectPath,
  settingsRoot,
  label,
  settings,
  flags,
  note,
  out,
  logFile,
  alive,
  configureAvd,
  teardownAvd,
}: {
  record: OwnedDeviceRecord | null;
  projectPath: string;
  settingsRoot: string;
  label: string;
  settings: DeviceSettings;
  flags: DeviceFlags;
  note: Notify;
  out: Notify;
  configureAvd: typeof configureNewOwnedAvd;
  teardownAvd: typeof teardownOwnedAvd;
} & EmulatorLogging): Promise<OwnedDeviceRecord> {
  const avdConfig = androidAvdConfigSetting(settings, settingsRoot);
  if (record?.setupIncomplete && record.avdName) {
    const cleanup = teardownAvd(record.avdName, { del: true });
    if (cleanup.status === 'failed' || cleanup.status === 'skipped') {
      throw new Error(
        `Owned AVD ${record.avdName} has incomplete setup and could not be deleted (${cleanup.reason || cleanup.status}). Fix the cause, then retry; stim-cli kept the device record for cleanup.`,
      );
    }
    clearDevice(projectPath, 'android');
    record = null;
  }
  if (record?.avdName) {
    if (record.owned) {
      const resolved = resolveOwnedAvdSerial(record.avdName);
      if (resolved.notOwned) {
        note(
          chalk.yellow(
            `Note: recorded AVD ${record.avdName} is not stim-cli-owned by name -- creating a fresh owned AVD instead of reusing it.`,
          ),
        );
      } else if (resolved.serial) {
        const consolePort = Number(resolved.serial.replace(/^emulator-/, ''));
        const updated = {
          avdName: record.avdName,
          consolePort,
          owned: true,
          deviceName: record.deviceName ?? record.avdName,
        };
        setDevice(projectPath, 'android', updated);
        return updated;
      } else if (!resolved.missing) {
        out(
          chalk.dim(
            `Recorded port for owned AVD ${record.avdName} is not currently ours; booting it on a freshly allocated port...`,
          ),
        );
        return await bootOwnedAvdOnFreshPort({
          avdName: record.avdName,
          projectPath,
          deviceName: record.deviceName,
          out,
          logFile,
          alive,
        });
      }
    } else {
      const avdExists = listAvds().includes(record.avdName);
      if (avdExists) {
        const adb = listAdbDevices();
        const running = adb.emulators.some((e) => e.consolePort === record.consolePort);
        if (!running) {
          note(
            chalk.yellow(
              `Note: assigned AVD ${record.avdName} (emulator-${record.consolePort}) is shut down and is not owned by stim-cli, so it will not be booted automatically.`,
            ),
          );
          note(
            chalk.dim(
              'Boot it yourself, or run `stim gc --delete` to clear the assignment so stim-cli can create an owned AVD.',
            ),
          );
        }
        return record;
      }
    }
  } else if (record?.serial) {
    note(
      chalk.yellow(
        `Note: this project is assigned physical device ${record.serial}, and stim-cli no longer supports physical devices.`,
      ),
    );
    note(chalk.dim('Creating an owned emulator instead. The serial is not touched, connected or not.'));
  }

  let created: { avdName: string };
  let fresh = false;
  try {
    created = createOwnedAvd(label, { systemImage: flags.systemImage || settings.android?.systemImage });
    fresh = true;
  } catch (e) {
    const message = String((e as Error)?.message || e);
    const avdName = ownedAvdName(label);
    if (message.includes('already exists') && listAvds().includes(avdName)) {
      const owner = findOtherProjectOwningAvd(avdName, projectPath);
      if (owner) {
        throw new Error(
          `AVD ${avdName} already exists and is owned by another project (${owner}). Pass a distinct --label to avoid the collision instead of hijacking it.`,
          { cause: e },
        );
      }
      const current = loadConfig()?.projects?.[projectPath]?.platforms?.android;
      if (current?.avdName === avdName) {
        const state = current.setupIncomplete ? 'has incomplete setup' : 'was registered';
        throw new Error(
          `AVD ${avdName} ${state} by another concurrent stim-cli run. Retry after that run finishes so the recorded device is resolved safely.`,
          { cause: e },
        );
      }
      created = { avdName };
      out(chalk.dim(`Recovered existing owned AVD ${avdName} (unrecorded from a prior run)`));
    } else {
      throw e;
    }
  }
  if (fresh) {
    setDevice(projectPath, 'android', {
      avdName: created.avdName,
      owned: true,
      deviceName: created.avdName,
      setupIncomplete: true,
    });
    try {
      configureAvd(created.avdName, {
        dataPartitionSizeGb: androidDataPartitionSizeGbSetting(settings),
        avdConfig,
      });
    } catch (error) {
      const cleanup = teardownAvd(created.avdName, { del: true });
      const kept = cleanup.status === 'failed' || cleanup.status === 'skipped';
      if (!kept) clearDevice(projectPath, 'android');
      const orphan = kept
        ? ` The owned AVD remains tracked for cleanup (${cleanup.reason || cleanup.status}); fix the cause, then retry or run \`stim gc --delete\`.`
        : '';
      throw new Error(
        `Created owned AVD ${created.avdName}, but could not configure its AVD settings: ${String((error as Error)?.message || error)}${orphan}`,
        { cause: error },
      );
    }
  }
  out(chalk.dim(`Created owned AVD ${created.avdName}`));
  return bootOwnedAvdOnFreshPort({
    avdName: created.avdName,
    projectPath,
    deviceName: created.avdName,
    out,
    logFile,
    alive,
  });
}

async function bootOwnedAvdOnFreshPort({
  avdName,
  projectPath,
  deviceName,
  out,
  logFile = null,
  alive = isPidAlive,
}: {
  avdName: string;
  projectPath: string;
  deviceName?: string;
  out: Notify;
} & EmulatorLogging): Promise<OwnedDeviceRecord> {
  const adbLive = listAdbDevices();
  const livePorts: number[] = [
    ...adbLive.emulators.map((e) => e.consolePort),
    ...adbLive.unhealthy.map((u) => u.consolePort).filter((p): p is number => p != null),
  ];
  const claimedPorts = [...allConsolePortsAndSerials().androidConsolePorts, ...livePorts];
  const consolePort = nextConsolePort(claimedPorts);
  const newRecord = { avdName, consolePort, owned: true, deviceName: deviceName ?? avdName };
  setDevice(projectPath, 'android', newRecord);
  const pid = bootAndroidEmulator(avdName, consolePort, { logFile });
  const serial = `emulator-${consolePort}`;
  out(chalk.dim(`Waiting for ${serial} to finish booting...`));
  const result = await waitForBoot(serial, 120000, { aborted: emulatorGone(pid, alive) });
  if (!result.ok) {
    throw new Error(
      `${bootFailurePrefix(serial, result.exited, 120000)} Diagnostic: ${JSON.stringify(result.diagnostic)}`,
    );
  }
  return { ...newRecord, serial };
}

function emulatorGone(pid: number | null, alive: Liveness): () => boolean {
  if (!pid) return () => false;
  return () => !alive(pid);
}

function bootFailurePrefix(serial: string, exited: boolean | undefined, timeoutMs: number): string {
  return exited
    ? `The emulator process for ${serial} exited before the device finished booting.`
    : `Emulator ${serial} did not finish booting within ${Math.round(timeoutMs / 1000)}s.`;
}

export function liveOwnedDeviceCount({
  sims = [],
  adbEmulators = [],
  config = null,
}: { sims?: SimRecord[]; adbEmulators?: EmulatorRecord[]; config?: Config | null } = {}): number {
  let count = 0;
  for (const sim of sims) {
    if (sim?.state === 'Booted' && sim.name?.startsWith('stim-cli-')) count++;
  }
  const livePorts = new Set(adbEmulators.map((e) => e.consolePort));
  for (const proj of Object.values(config?.projects || {})) {
    const android = proj?.platforms?.android;
    if (
      android?.owned &&
      android.avdName &&
      typeof android.consolePort === 'number' &&
      livePorts.has(android.consolePort)
    ) {
      count++;
    }
  }
  return count;
}

function workspaceHasLiveDevice({
  platform,
  project,
  sims = [],
  adbEmulators = [],
}: Partial<{
  platform: string;
  project: ProjectRecord | null;
  sims: SimRecord[];
  adbEmulators: EmulatorRecord[];
}> = {}) {
  if (!platform) return false;
  const record = project?.platforms?.[platform];
  if (!record) return false;
  if (platform === 'ios') {
    return sims.some((s) => s.udid === record.deviceUdid && s.state === 'Booted');
  }
  return typeof record.consolePort === 'number' && adbEmulators.some((e) => e.consolePort === record.consolePort);
}

export function deviceCapacityRefusal({
  platform,
  project,
  max,
  sims = [],
  adb = null,
  config = null,
}: Partial<{
  platform: string;
  project: ProjectRecord | null;
  max: number;
  sims: SimRecord[];
  adb: AdbDevices | null;
  config: Config | null;
}> = {}): CapacityRefusal | null {
  if (!max || max <= 0) return null;
  const adbEmulators = adb?.emulators || [];
  if (workspaceHasLiveDevice({ platform, project, sims, adbEmulators })) return null;
  const count = liveOwnedDeviceCount({ sims, adbEmulators, config });
  if (count < max) return null;
  return {
    code: 'STIM_CLI_AT_CAPACITY',
    message: `${count} stim-cli device(s) are already booted and concurrency.maxDevices is ${max}, so booting another would exceed the cap.`,
    remedy: 'stop an environment (stim stop) or raise concurrency.maxDevices',
  };
}

export function checkDeviceCapacity({
  platform,
  project,
  max,
  sims = listAllIosSims,
  adb = listAdbDevices,
  config = loadConfig,
}: Partial<{
  platform: string;
  project: ProjectRecord | null;
  max: number;
  sims: SimRecord[] | (() => SimRecord[]);
  adb: AdbDevices | (() => AdbDevices);
  config: Config | null | (() => Config | null);
}> = {}): CapacityRefusal | null {
  if (!max || max <= 0) return null;
  let simList: SimRecord[] = [];
  let adbRes: AdbDevices = { emulators: [], physical: [], unhealthy: [] };
  try {
    simList = typeof sims === 'function' ? sims() || [] : sims || [];
  } catch {}
  try {
    adbRes = typeof adb === 'function' ? adb() || adbRes : adb || adbRes;
  } catch {}
  let cfg: Config | null = null;
  try {
    cfg = typeof config === 'function' ? config() : (config ?? null);
  } catch {}
  return deviceCapacityRefusal({ platform, project, max, sims: simList, adb: adbRes, config: cfg });
}

export function deviceTypeMismatch(
  recordedTypeId: string | undefined | null,
  requestedName: string | undefined | null,
  deviceTypes: DeviceTypeInfo[],
): string | null {
  if (!requestedName || !recordedTypeId) return null;
  const wanted = (deviceTypes || []).find((d) => d.name === requestedName);
  if (!wanted) return null;
  if (wanted.identifier === recordedTypeId) return null;
  const recorded = (deviceTypes || []).find((d) => d.identifier === recordedTypeId);
  return `this project's sim is ${recorded ? recorded.name : recordedTypeId}, but --device-type asked for ${requestedName}`;
}

const BOOT_POLL_MS = 500;

interface BootResult {
  ok?: boolean;
  udid?: string;
  serial?: string;
  failed?: boolean;
  reason?: string;
}

export async function ensureBooted({
  platform,
  device,
  timeoutMs = 240000,
  pollMs = BOOT_POLL_MS,
  out = () => {},
  logFile = null,
  alive = isPidAlive,
}: Partial<
  {
    platform: string;
    device: OwnedDeviceRecord | null;
    timeoutMs: number;
    pollMs: number;
    out: Notify;
  } & EmulatorLogging
> = {}): Promise<BootResult> {
  if (platform === 'ios') return ensureIosBooted({ device, timeoutMs, pollMs, out });
  if (platform === 'android') return ensureAndroidBooted({ device, timeoutMs, out, logFile, alive });
  return { failed: true, reason: `Unknown platform "${platform}".` };
}

async function ensureIosBooted({
  device,
  timeoutMs,
  pollMs,
  out,
}: {
  device?: OwnedDeviceRecord | null;
  timeoutMs: number;
  pollMs: number;
  out: Notify;
}): Promise<BootResult> {
  const udid = device?.deviceUdid;
  if (!udid) return { failed: true, reason: 'No iOS simulator is recorded for this project.' };

  let resolved;
  try {
    resolved = resolveOwnedIosSim(udid);
  } catch (e) {
    return { failed: true, reason: `Could not list simulators: ${(e as Error)?.message || e}` };
  }
  if (resolved.missing) {
    return {
      failed: true,
      reason: `Simulator ${udid} no longer exists. Run \`stim ios\` again to create a fresh owned sim.`,
    };
  }
  if (resolved.notOwned) {
    return {
      failed: true,
      reason: `Simulator ${udid} is now named "${resolved.notOwned}" and is not stim-cli-owned; refusing to boot it.`,
    };
  }
  const sim = resolved.sim as SimRecord;
  if (sim.state === 'Booted') return { ok: true, udid };

  out(chalk.dim(`Booting sim ${sim.name} (${udid})...`));
  try {
    bootIosSim(udid);
  } catch (e) {
    return { failed: true, reason: `Could not boot simulator ${udid}: ${(e as Error)?.message || e}` };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    let state = null;
    try {
      state = listAllIosSims().find((s) => s.udid === udid)?.state ?? null;
    } catch {}
    if (state === 'Booted') return { ok: true, udid };
  }
  return {
    failed: true,
    reason: `Simulator ${udid} did not reach the Booted state within ${Math.round(timeoutMs / 1000)}s.`,
  };
}

async function ensureAndroidBooted({
  device,
  timeoutMs,
  out,
  logFile = null,
  alive = isPidAlive,
}: {
  device?: OwnedDeviceRecord | null;
  timeoutMs: number;
  out: Notify;
} & EmulatorLogging): Promise<BootResult> {
  if (!device?.avdName) {
    return { failed: true, reason: 'No owned Android emulator is recorded for this project.' };
  }

  let resolved;
  try {
    resolved = resolveOwnedAvdSerial(device.avdName);
  } catch (e) {
    return { failed: true, reason: `Could not list AVDs: ${(e as Error)?.message || e}` };
  }
  if (resolved.missing) {
    return {
      failed: true,
      reason: `AVD ${device.avdName} no longer exists. Run \`stim android\` again to create a fresh owned AVD.`,
    };
  }
  if (resolved.notOwned) {
    return { failed: true, reason: `AVD ${device.avdName} is not stim-cli-owned by name; refusing to boot it.` };
  }
  if (resolved.serial) {
    const ready = await waitForBoot(resolved.serial, timeoutMs);
    if (!ready.ok) {
      return {
        failed: true,
        reason: `Emulator ${resolved.serial} never reported boot completion. Diagnostic: ${JSON.stringify(ready.diagnostic)}`,
      };
    }
    return { ok: true, serial: resolved.serial };
  }

  const freshSerial = `emulator-${device.consolePort}`;
  if (device.owned && device.serial === freshSerial) {
    const ready = await waitForBoot(freshSerial, timeoutMs);
    if (ready.ok) return { ok: true, serial: freshSerial };
    return {
      failed: true,
      reason: `Emulator ${freshSerial} never reported boot completion. Diagnostic: ${JSON.stringify(ready.diagnostic)}`,
    };
  }

  const serial = `emulator-${pickConsolePort(device.consolePort)}`;
  out(chalk.dim(`Booting owned AVD ${device.avdName} as ${serial}...`));
  let pid: number | null = null;
  try {
    pid = bootAndroidEmulator(device.avdName, Number(serial.replace(/^emulator-/, '')), { logFile });
  } catch (e) {
    return {
      failed: true,
      reason: `Could not start emulator for AVD ${device.avdName}: ${(e as Error)?.message || e}`,
    };
  }
  const ready = await waitForBoot(serial, timeoutMs, { aborted: emulatorGone(pid, alive) });
  if (!ready.ok) {
    return {
      failed: true,
      reason: `${bootFailurePrefix(serial, ready.exited, timeoutMs)} Diagnostic: ${JSON.stringify(ready.diagnostic)}`,
    };
  }
  return { ok: true, serial };
}

function pickConsolePort(recorded: number | undefined) {
  const adb = listAdbDevices();
  const live: number[] = [
    ...adb.emulators.map((e) => e.consolePort),
    ...adb.unhealthy.map((u) => u.consolePort).filter((p): p is number => p != null),
  ];
  if (recorded && !live.includes(Number(recorded))) return Number(recorded);
  return nextConsolePort([...allConsolePortsAndSerials().androidConsolePorts, ...live]);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
