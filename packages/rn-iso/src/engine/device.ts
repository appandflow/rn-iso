// src/engine/device.js -- the owned-device guarantee, shared by every command
// that needs a device to install onto.
//
// `ensureOwnedDevice` moved here from the deleted `commands/up.js` when `ios`
// and `android` came to need the same guarantee: two copies of the ownership
// rule is exactly the drift CLAUDE.md item 2 warns about.
//
// The ownership rule (CLAUDE.md item 2) is the invariant everything below
// enforces: rn-iso only ever creates, boots, or destroys a device it created
// itself, named `rn-iso-<label>` and recorded with `owned: true`. rn-iso has no
// physical-device support, so that rule has NO carve-out: there is no
// path through this file that touches hardware, and every ambiguous record
// resolves toward creating an owned emulator instead.
import chalk from 'chalk';
import { allConsolePortsAndSerials, loadConfig, setDevice, type Config, type ProjectRecord } from '../config.ts';
import { bootIosSim, createOwnedIosSim, listAllIosSims, listIosDeviceTypes, resolveOwnedIosSim } from '../sim/ios.ts';
import {
  bootAndroidEmulator,
  createOwnedAvd,
  listAdbDevices,
  listAvds,
  nextConsolePort,
  ownedAvdName,
  resolveOwnedAvdSerial,
  waitForBoot,
} from '../sim/android.ts';

// The fields this module actually reads and writes on a project's platform
// record. Distinct from config.ts's DeviceRecord (which names the same ideas
// `udid`/`name`): this module has always used `deviceUdid`/`deviceName`, and
// config's index signature is what keeps the two compatible where they meet
// (setDevice's parameter, and the cast where a record is read back out).
export interface OwnedDeviceRecord {
  deviceUdid?: string;
  deviceName?: string;
  owned?: boolean;
  avdName?: string;
  consolePort?: number;
  serial?: string;
}

// The settings/flags bags callers pass in -- a subset of a project's
// `settings.json` and a command's own flags, both optional throughout.
interface DeviceSettings {
  ios?: { deviceType?: string; runtime?: string };
  android?: { systemImage?: string };
}

interface DeviceFlags {
  deviceType?: string;
  runtime?: string;
  systemImage?: string;
}

type Notify = (msg: string) => void;

// Derived from the real functions rather than duplicated: sim/ios.ts and
// sim/android.ts already carry the true shapes, and a hand-written copy here
// would be one more place for the two to drift apart.
type SimRecord = ReturnType<typeof listAllIosSims>[number];
type DeviceTypeInfo = ReturnType<typeof listIosDeviceTypes>[number];
type AdbDevices = ReturnType<typeof listAdbDevices>;
type EmulatorRecord = AdbDevices['emulators'][number];

// The refusal deviceCapacityRefusal / checkDeviceCapacity hand back, flat and
// all-optional to match the pattern every other engine module in this layer
// uses (a data verdict, never a throw).
interface CapacityRefusal {
  code: string;
  message: string;
  remedy: string;
}

// Reuse the recorded device for `platform`, booting it if we own it and it
// is shut down; create a new owned one if there is no usable record.
//
// Ownership rule: never boot, shut down, or destroy a device rn-iso did not
// create. A legacy record (no `owned: true`) is reused only if it is
// already live; if it is shut down / not running we do NOT boot it -- we
// print a note and leave it as-is (the port is still reserved by the
// caller). A recorded device that no longer exists at all (deleted sim,
// removed AVD) is dropped and falls through to creation, as is a legacy
// PHYSICAL Android assignment: rn-iso has no physical support, and the safe
// direction for an unsupported record is a fresh owned emulator, never a
// command aimed at somebody's phone.
export async function ensureOwnedDevice({
  platform,
  project,
  projectPath,
  label,
  settings,
  flags = {},
  note = () => {},
  out = () => {},
}: {
  platform: string;
  project?: ProjectRecord | null;
  projectPath: string;
  label: string;
  settings: DeviceSettings;
  flags?: DeviceFlags;
  note?: Notify;
  out?: Notify;
}): Promise<OwnedDeviceRecord> {
  const record = (project?.platforms?.[platform] as OwnedDeviceRecord | undefined) ?? null;
  if (platform === 'ios') {
    return ensureOwnedIosDevice({ record, projectPath, label, settings, flags, note, out });
  }
  return ensureOwnedAndroidDevice({ record, projectPath, label, settings, flags, note, out });
}

function ensureOwnedIosDevice({
  record,
  projectPath,
  label,
  settings,
  flags,
  note,
  out,
}: {
  record: OwnedDeviceRecord | null;
  projectPath: string;
  label: string;
  settings: DeviceSettings;
  flags: DeviceFlags;
  note: Notify;
  out: Notify;
}): OwnedDeviceRecord {
  if (record?.deviceUdid) {
    if (record.owned) {
      // Re-verify identity against the LIVE sim list by name BEFORE
      // booting -- a raw udid lookup would boot whatever simulator that
      // udid now resolves to, even if it has since been renamed away from
      // rn-iso- ownership (or the record is stale/mistyped).
      const resolved = resolveOwnedIosSim(record.deviceUdid);
      if (resolved.notOwned) {
        note(
          chalk.yellow(
            `Note: recorded sim is now named "${resolved.notOwned}", not rn-iso-owned by name -- creating a fresh owned sim instead of booting it.`,
          ),
        );
        // Fall through to creation below; do NOT boot a sim we don't own.
      } else if (resolved.missing) {
        // Sim was deleted out from under the record: fall through to creation.
      } else {
        // Neither notOwned nor missing: resolveOwnedIosSim's third outcome,
        // `{ sim }`, is what's left.
        const sim = resolved.sim as SimRecord;
        // Honour --device-type / settings on REUSE, not just on creation.
        // Silently booting the old model made the flag look broken.
        const wantedType = flags.deviceType || settings?.ios?.deviceType;
        const mismatch = deviceTypeMismatch(sim.deviceTypeIdentifier, wantedType, listIosDeviceTypes());
        if (mismatch) {
          throw new Error(
            `${mismatch}. rn-iso will not silently boot a different model. ` +
              'Run `rn-iso worktree remove` (or `rn-iso gc --delete`) to reap the current sim, then `rn-iso ios` again to create the requested one.',
          );
        }
        if (sim.state !== 'Booted') {
          out(chalk.dim(`Booting owned sim ${sim.name} (${sim.udid})...`));
          bootIosSim(sim.udid);
        }
        const updated = { deviceUdid: sim.udid, owned: true, deviceName: record.deviceName ?? sim.name };
        setDevice(projectPath, 'ios', updated);
        return updated;
      }
    } else {
      // Legacy: reuse only if already live; never boot it ourselves.
      const sim = listAllIosSims().find((s) => s.udid === record.deviceUdid);
      if (sim) {
        if (sim.state !== 'Booted') {
          note(
            chalk.yellow(
              `Note: assigned sim ${sim.name} (${sim.udid}) is shut down and is not owned by rn-iso, so it will not be booted automatically.`,
            ),
          );
          note(
            chalk.dim(
              'Boot it yourself, or run `rn-iso gc --delete` to clear the assignment so rn-iso can create an owned sim.',
            ),
          );
        }
        return record;
      }
      // Sim was deleted out from under the record: fall through to creation.
    }
  }

  const created = createOwnedIosSim(label, {
    deviceType: flags.deviceType || settings.ios?.deviceType,
    runtime: flags.runtime || settings.ios?.runtime,
  });
  out(chalk.dim(`Created owned sim ${created.name} (${created.udid})`));
  // Record ownership BEFORE booting: if boot throws (timeout, etc.) the
  // record must already exist so a retry reuses this sim instead of
  // creating another one.
  const newRecord = { deviceUdid: created.udid, owned: true, deviceName: created.name };
  setDevice(projectPath, 'ios', newRecord);
  bootIosSim(created.udid);
  return newRecord;
}

// True if some OTHER registered project's android record already names
// avdName. Used by the avdmanager "already exists" recovery path to tell a
// genuine same-project retry (safe to adopt) apart from a label collision
// with a different project (must error, not silently hijack).
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
  label,
  settings,
  flags,
  note,
  out,
}: {
  record: OwnedDeviceRecord | null;
  projectPath: string;
  label: string;
  settings: DeviceSettings;
  flags: DeviceFlags;
  note: Notify;
  out: Notify;
}): Promise<OwnedDeviceRecord> {
  if (record?.avdName) {
    if (record.owned) {
      // Verify identity against the LIVE adb list before deciding "ours is
      // running" -- the recorded consolePort is a slot, not an identity,
      // and may now be held by a foreign emulator (e.g. Android Studio's
      // own default on 5554). Deciding liveness from the port alone would
      // adb-reverse onto, and report the facts of, someone else's emulator.
      const resolved = resolveOwnedAvdSerial(record.avdName);
      if (resolved.notOwned) {
        note(
          chalk.yellow(
            `Note: recorded AVD ${record.avdName} is not rn-iso-owned by name -- creating a fresh owned AVD instead of reusing it.`,
          ),
        );
        // Fall through to creation below.
      } else if (resolved.serial) {
        // Ours is genuinely running at this serial: reuse it as recorded.
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
        // notRunning: the recorded port is either idle or held by a
        // foreign emulator. Boot OUR avd on a newly allocated port instead
        // of trusting the recorded one -- the union port-picking logic
        // below already avoids ports currently in use.
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
        });
      }
      // resolved.missing: AVD was deleted out from under the record --
      // fall through to creation below.
    } else {
      // Legacy: reuse only if already running; never boot it ourselves.
      const avdExists = listAvds().includes(record.avdName);
      if (avdExists) {
        const adb = listAdbDevices();
        const running = adb.emulators.some((e) => e.consolePort === record.consolePort);
        if (!running) {
          note(
            chalk.yellow(
              `Note: assigned AVD ${record.avdName} (emulator-${record.consolePort}) is shut down and is not owned by rn-iso, so it will not be booted automatically.`,
            ),
          );
          note(
            chalk.dim(
              'Boot it yourself, or run `rn-iso gc --delete` to clear the assignment so rn-iso can create an owned AVD.',
            ),
          );
        }
        return record;
      }
      // AVD was deleted out from under the record: fall through to creation.
    }
  } else if (record?.serial) {
    // A legacy PHYSICAL assignment (rn-iso has no `--serial` flow). rn-iso has
    // no physical support (spec, "Out of scope"), so there is nothing that
    // can honour this record. It is reported once and then ignored: the run
    // falls through to creating an owned emulator, which is the direction that
    // never sends a command at hardware rn-iso does not own.
    note(
      chalk.yellow(
        `Note: this project is assigned physical device ${record.serial}, and rn-iso no longer supports physical devices.`,
      ),
    );
    note(chalk.dim('Creating an owned emulator instead. The serial is not touched, connected or not.'));
  }

  let created: { avdName: string };
  try {
    created = createOwnedAvd(label, { systemImage: flags.systemImage || settings.android?.systemImage });
  } catch (e) {
    // A prior run may have created the AVD and then thrown before recording
    // it (e.g. a boot timeout, back when the record was written after
    // boot) -- avdmanager then refuses every subsequent create with
    // "already exists", permanently wedging this project. Since the AVD is
    // ours by name, adopt it instead of failing forever.
    const message = String((e as Error)?.message || e);
    const avdName = ownedAvdName(label);
    if (message.includes('already exists') && listAvds().includes(avdName)) {
      // Guard against hijacking another project's device: the "already
      // exists" recovery above exists for THIS project's own abandoned AVD
      // from a prior run, not for adopting a different project's AVD just
      // because its label sanitized to the same name (e.g. two monorepo
      // app-dir projects with no distinguishing --label).
      const owner = findOtherProjectOwningAvd(avdName, projectPath);
      if (owner) {
        throw new Error(
          `AVD ${avdName} already exists and is owned by another project (${owner}). Pass a distinct --label to avoid the collision instead of hijacking it.`,
          { cause: e },
        );
      }
      created = { avdName };
      out(chalk.dim(`Recovered existing owned AVD ${avdName} (unrecorded from a prior run)`));
    } else {
      throw e;
    }
  }
  out(chalk.dim(`Created owned AVD ${created.avdName}`));
  return bootOwnedAvdOnFreshPort({ avdName: created.avdName, projectPath, deviceName: created.avdName, out });
}

// Boots avdName on a freshly allocated console port and records ownership
// BEFORE booting: if boot throws (timeout, etc.) the record must already
// exist so a retry reuses/boots this AVD instead of hitting avdmanager's
// "already exists" wedge on re-creation. Shared by fresh-AVD creation and
// by the owned-reuse path's "recorded port isn't ours" fallback (I6).
async function bootOwnedAvdOnFreshPort({
  avdName,
  projectPath,
  deviceName,
  out,
}: {
  avdName: string;
  projectPath: string;
  deviceName?: string;
  out: Notify;
}): Promise<OwnedDeviceRecord> {
  // Union config-recorded console ports with ports adb currently sees in
  // use (live emulators, plus unhealthy entries that still carry a
  // console port) -- a foreign emulator (e.g. Android Studio's default on
  // 5554) has no rn-iso config entry, so config-only allocation would spawn
  // straight onto it.
  const adbLive = listAdbDevices();
  const livePorts: number[] = [
    ...adbLive.emulators.map((e) => e.consolePort),
    ...adbLive.unhealthy.map((u) => u.consolePort).filter((p): p is number => p != null),
  ];
  const claimedPorts = [...allConsolePortsAndSerials().androidConsolePorts, ...livePorts];
  const consolePort = nextConsolePort(claimedPorts);
  const newRecord = { avdName, consolePort, owned: true, deviceName: deviceName ?? avdName };
  setDevice(projectPath, 'android', newRecord);
  bootAndroidEmulator(avdName, consolePort);
  const serial = `emulator-${consolePort}`;
  out(chalk.dim(`Waiting for ${serial} to finish booting...`));
  const result = await waitForBoot(serial, 120000);
  if (!result.ok) {
    throw new Error(`Emulator ${serial} did not finish booting. Diagnostic: ${JSON.stringify(result.diagnostic)}`);
  }
  return newRecord;
}

// --- the OPT-IN device concurrency cap -----------------------------------
//
// concurrency.maxDevices caps how many rn-iso-owned devices are booted at
// once. Unlike the build slots, this does NOT queue: booting a device is
// interactive-shaped (a person is waiting on `rn-iso ios`), so at the cap the
// command REFUSES with RN_ISO_AT_CAPACITY rather than blocking. The refusal is
// only for a NEW device: a workspace whose own device is already live is
// idempotent and never refused, so re-running `rn-iso ios` on an environment
// you already have costs nothing.
//
// PURE: the sim list, the adb result and the config all come in as arguments,
// so the verdict is testable without a simulator. checkDeviceCapacity below is
// the thin I/O wrapper that gathers them.

// The machine-wide count of LIVE rn-iso-owned devices. iOS ownership is by the
// `rn-iso-` name prefix on a Booted sim; an Android emulator carries no name in
// `adb devices`, so its ownership is read from the registry -- a running
// console port recorded by some project as an owned AVD.
export function liveOwnedDeviceCount({
  sims = [],
  adbEmulators = [],
  config = null,
}: { sims?: SimRecord[]; adbEmulators?: EmulatorRecord[]; config?: Config | null } = {}) {
  let count = 0;
  for (const sim of sims) {
    if (sim?.state === 'Booted' && sim.name?.startsWith('rn-iso-')) count++;
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

// Does THIS workspace already have a live device of its own for `platform`?
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

// PURE. The refusal, or null when a device may be booted. `null` covers three
// cases: no cap set, under the cap, or this workspace already booted its own.
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
    code: 'RN_ISO_AT_CAPACITY',
    message: `${count} rn-iso device(s) are already booted and concurrency.maxDevices is ${max}, so booting another would exceed the cap.`,
    remedy: 'stop an environment (rn-iso stop) or raise concurrency.maxDevices',
  };
}

// The thin I/O wrapper `ios` / `android` call: gathers the live sim list, adb
// devices and the config, and returns deviceCapacityRefusal's verdict. A
// tool failure while gathering fails OPEN (returns null): a cap is an
// optimisation for a busy machine, and a flaky simctl must not block a build.
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
  } catch {
    /* fail open */
  }
  try {
    adbRes = typeof adb === 'function' ? adb() || adbRes : adb || adbRes;
  } catch {
    /* fail open */
  }
  let cfg: Config | null = null;
  try {
    cfg = typeof config === 'function' ? config() : (config ?? null);
  } catch {
    /* fail open */
  }
  return deviceCapacityRefusal({ platform, project, max, sims: simList, adb: adbRes, config: cfg });
}

// Pure. Answers "is the sim we already own the model the caller just asked
// for?" -- returns a human-readable mismatch or null. Before this, the
// requested device type was consulted only on CREATION, so asking for a
// different model against an existing environment silently booted the old one
// and the setting looked broken. Returns null when either side is unknown: an unrecognized requested
// name is creation's error to report, not ours.
export function deviceTypeMismatch(
  recordedTypeId: string | undefined | null,
  requestedName: string | undefined | null,
  deviceTypes: DeviceTypeInfo[],
) {
  if (!requestedName || !recordedTypeId) return null;
  const wanted = (deviceTypes || []).find((d) => d.name === requestedName);
  if (!wanted) return null;
  if (wanted.identifier === recordedTypeId) return null;
  const recorded = (deviceTypes || []).find((d) => d.identifier === recordedTypeId);
  return `this project's sim is ${recorded ? recorded.name : recordedTypeId}, but --device-type asked for ${requestedName}`;
}

// --- the booted guarantee -------------------------------------------------
//
// `ensureOwnedDevice` records and STARTS a device; it does not wait for one.
// `ios` / `android` install onto the device in the very next step, and
// `simctl install` against a sim that is still "Booting" fails, so the wait
// has to happen somewhere -- here, once, rather than in each command.
//
// Returns the ready-to-install handle for the platform:
//   ios     { ok: true, udid }
//   android { ok: true, serial }
// and never throws on a tool failure: { failed: true, reason } instead, the
// same shape every other engine module in this layer uses, so a command
// branches on data rather than on catching.
const BOOT_POLL_MS = 500;

// The ready-to-install handle, or a failure -- flat and all-optional
// (CLAUDE.md pattern 3), matching the defensive JS shape.
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
  // 240s, not 120: the FIRST boot of a freshly created AVD does a full cold
  // Android boot, and on a loaded host (or software rendering on a CI runner)
  // that genuinely takes 2-4 minutes. The wait returns the moment the device
  // reports booted; the timeout only bounds the worst case.
  timeoutMs = 240000,
  pollMs = BOOT_POLL_MS,
  out = () => {},
}: Partial<{
  platform: string;
  device: OwnedDeviceRecord | null;
  timeoutMs: number;
  pollMs: number;
  out: Notify;
}> = {}): Promise<BootResult> {
  if (platform === 'ios') return ensureIosBooted({ device, timeoutMs, pollMs, out });
  if (platform === 'android') return ensureAndroidBooted({ device, timeoutMs, out });
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

  // Same rule as teardown: re-resolve against the LIVE sim list before
  // issuing anything at the udid. A sim renamed away from the rn-iso- prefix
  // is not ours to boot, and one that is simply gone is not bootable at all.
  let resolved;
  try {
    resolved = resolveOwnedIosSim(udid);
  } catch (e) {
    return { failed: true, reason: `Could not list simulators: ${(e as Error)?.message || e}` };
  }
  if (resolved.missing) {
    return {
      failed: true,
      reason: `Simulator ${udid} no longer exists. Run \`rn-iso ios\` again to create a fresh owned sim.`,
    };
  }
  if (resolved.notOwned) {
    return {
      failed: true,
      reason: `Simulator ${udid} is now named "${resolved.notOwned}" and is not rn-iso-owned; refusing to boot it.`,
    };
  }
  // Neither notOwned nor missing: resolveOwnedIosSim's third outcome, `{ sim }`.
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
    } catch {
      // simctl can fail transiently while a device set is being written;
      // keep polling until the deadline rather than failing on one bad read.
    }
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
}: {
  device?: OwnedDeviceRecord | null;
  timeoutMs: number;
  out: Notify;
}): Promise<BootResult> {
  // Every device this reaches is an owned AVD: ensureOwnedDevice creates one
  // rather than ever handing back a physical record. A record with no avdName
  // is therefore a bug or a legacy leftover, not a phone to go looking for.
  if (!device?.avdName) {
    return { failed: true, reason: 'No owned Android emulator is recorded for this project.' };
  }

  // The recorded console port is a slot, not an identity: resolve the AVD
  // against the live emulator list first, exactly as teardown does.
  let resolved;
  try {
    resolved = resolveOwnedAvdSerial(device.avdName);
  } catch (e) {
    return { failed: true, reason: `Could not list AVDs: ${(e as Error)?.message || e}` };
  }
  if (resolved.missing) {
    return {
      failed: true,
      reason: `AVD ${device.avdName} no longer exists. Run \`rn-iso android\` again to create a fresh owned AVD.`,
    };
  }
  if (resolved.notOwned) {
    return { failed: true, reason: `AVD ${device.avdName} is not rn-iso-owned by name; refusing to boot it.` };
  }
  if (resolved.serial) {
    // Running, but "running" is not "finished booting" -- an emulator answers
    // adb long before the framework is up, and `adb install` against it fails
    // with "Can't find service: package".
    const ready = await waitForBoot(resolved.serial, timeoutMs);
    if (!ready.ok) {
      return {
        failed: true,
        reason: `Emulator ${resolved.serial} never reported boot completion. Diagnostic: ${JSON.stringify(ready.diagnostic)}`,
      };
    }
    return { ok: true, serial: resolved.serial };
  }

  // notRunning: boot it on the recorded port, and only fall back to a fresh
  // one when that port is currently taken by something else.
  const serial = `emulator-${pickConsolePort(device.consolePort)}`;
  out(chalk.dim(`Booting owned AVD ${device.avdName} as ${serial}...`));
  try {
    bootAndroidEmulator(device.avdName, Number(serial.replace(/^emulator-/, '')));
  } catch (e) {
    return {
      failed: true,
      reason: `Could not start emulator for AVD ${device.avdName}: ${(e as Error)?.message || e}`,
    };
  }
  const ready = await waitForBoot(serial, timeoutMs);
  if (!ready.ok) {
    return {
      failed: true,
      reason: `Emulator ${serial} did not finish booting within ${Math.round(timeoutMs / 1000)}s. Diagnostic: ${JSON.stringify(ready.diagnostic)}`,
    };
  }
  return { ok: true, serial };
}

// The recorded port when nothing live holds it, a freshly allocated one when
// something does. Booting onto an occupied console port silently attaches us
// to a foreign emulator, which is the failure resolveOwnedAvdSerial exists to
// prevent on the teardown side.
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
