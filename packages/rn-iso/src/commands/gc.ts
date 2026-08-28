// `gc` is the machine-hygiene command: it reports what rn-iso has left behind
// and, with --delete, reclaims it.
//
// Five things still orphan, and none of them is a build artifact any more --
// build output lives inside the global workspace directory and dies with the
// directory that holds it, so the DerivedData sweep and its reverse-mapping
// ambiguity are gone:
//
//   1. dead project entries   a directory deleted by hand leaves a registry
//                             entry and a reserved Metro port behind
//   2. owned devices          orphaned ones, plus (with --older-than) ones
//                             whose project has gone untouched for weeks
//   3. stale device records   the mirror image of 2: the DEVICE is gone and the
//                             live project's record still points at it
//   4. stale build locks      a single-flight lock (engine/build-lock.js) whose
//                             builder is no longer running: a reboot or a
//                             SIGKILL in the middle of a compile
//   5. shared caches          alive by design, never dead, only bigger
//
// The cache paths are prescribed, so there is nothing to register or forget by
// hand; gc just reports them, and there is no separate register / forget / list
// verb. The programmatic `rn-iso/cache-manifest` export stays --
// that is how @rn-iso/metro and src/build-cache.js self-register.
import { existsSync, readdirSync, realpathSync, rmSync, statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import chalk from 'chalk';
import { InvalidArgumentError, type Command } from 'commander';
import { clearDevice, getConfigDir, loadConfig } from '../config.ts';
import { formatBytes, isOnMountedVolume, listMountedVolumes, volumeRootFor } from '../fs-util.ts';
import { listBuildLocks, readBuildLock } from '../engine/build-lock.ts';
import { listBuildSlots, readBuildSlot } from '../engine/build-slots.ts';
import { isPidAlive } from '../metro.ts';
import { reclaimProject } from '../reclaim.ts';
import { listAllIosSims, type IosSimRecord } from '../sim/ios.ts';
import { teardownOwnedIosSim, teardownOwnedAvd } from '../teardown.ts';
import { listAvds } from '../sim/android.ts';
import { declaredCachePaths, discoverCaches, pruneCache, sizeCaches, type CacheDescriptor } from '../caches.ts';
import type { BuildLockInfo, BuildSlotInfo, Config, GcSkip, OrphanedDevice } from '../types.ts';

// --- local report shapes ---------------------------------------------------
//
// The device sweeps and the cache pass produce these; collectGcReport gathers
// them into GcReport, which formatGcReport prints and runGc acts on. Defined
// here rather than in types.ts because they are gc's own working vocabulary --
// types.ts carries the leaf shapes these reuse (OrphanedDevice, GcSkip, the
// build lock/slot info).

// An owned device whose project is registered and on disk but whose checkout
// has gone untouched past --older-than. Producer: findStaleProjectDevices.
interface StaleProjectDevice {
  kind: 'ios' | 'android';
  id: string;
  name: string;
  project: string;
  idleDays: number;
}

// A LIVE project whose recorded device is no longer on the machine -- the
// record is stale, not the device. Producer: findStaleDeviceRecords.
interface StaleDeviceRecord {
  kind: 'ios' | 'android';
  id: string;
  project: string;
  owned: boolean;
}

// A rn-iso-owned device a live config entry still references, kept by the
// orphan sweep with the reason it was spared. Producer: findOrphanedDevices.
interface KeptDevice {
  kind: 'ios' | 'android';
  id: string;
  name: string;
  reason: string;
}

// A shared cache row, annotated by planCacheEmptying with what --all/--older-than
// would do to it. Extends the descriptor caches.ts produces.
interface GcCache extends CacheDescriptor {
  machineGlobal?: string | null;
  willEmpty?: boolean;
  emptySkipped?: string | null;
}

// Everything gc knows, gathered by collectGcReport without writing anything.
interface GcReport {
  skipped: GcSkip[];
  deadProjects: string[];
  orphanedDevices: OrphanedDevice[];
  staleDevices: StaleProjectDevice[];
  staleDeviceRecords: StaleDeviceRecord[];
  buildLocks: { stale: BuildLockInfo[]; live: BuildLockInfo[] };
  buildSlots: { stale: BuildSlotInfo[]; live: BuildSlotInfo[] };
  deviceSweepNotices: string[];
  caches: GcCache[];
  olderThan: number | null;
  all: boolean;
}

interface CollectGcReportOptions {
  olderThan?: number | null;
  all?: boolean;
  now?: number;
  lastTouched?: (path: string) => number;
  unsafeAllowScopedDeviceSweep?: boolean;
}

interface RunGcOptions {
  olderThan?: number;
  all?: boolean;
  delete?: boolean;
  unsafeAllowScopedDeviceSweep?: boolean;
}

// Bounds each device listing so a wedged simctl/emulator daemon can't hang
// `gc` forever -- see the comment above the listAllIosSims/listAvds calls
// in collectGcReport below.
// 30s, not 10s: on a loaded machine (several booted emulators, a busy
// CoreSimulator) `emulator -list-avds` / `simctl list` genuinely take longer
// than 10s to answer, and a premature skip means an orphaned emulator holding
// gigabytes never surfaces. A real hang still bounds out and prints the notice.
const DEVICE_LIST_TIMEOUT_MS = 30000;

const DAY_MS = 24 * 60 * 60 * 1000;

// Pure. Finds rn-iso-owned simulators/AVDs that no live config entry
// references. A device counts as "referenced" the moment ANY project in
// `config` has ANY platform record naming it -- owned or not, and
// regardless of whether that project's path currently exists on disk. Not
// gating on `owned` matters because a device can be named in a non-owned
// record too (e.g. a stale/mid-transition record, or one written before an
// `owned` flag update lands) -- treating only owned records as references
// would let this sweep propose deleting a device an unowned record still
// points at. This is the same fail-closed direction the dead-entry sweep
// takes (CLAUDE.md item 8): a project entry whose directory looks gone only
// because its volume is unplugged right now must not cause its device to
// be swept out from under it, so a reference is honored unconditionally
// rather than gated on existence.
// `isMounted(path)` only shapes the human-readable reason attached to a
// kept device (so a device kept because its owner's volume is not mounted
// reads differently than one kept because its owner is a normal, present
// project) -- it never flips a referenced device into `orphaned`.
// Devices whose name does not start with "rn-iso-" are ignored entirely:
// rn-iso never created them and must never propose touching them.
// `deadProjects` are paths already proven mounted-and-gone by the caller's
// dead-project sweep (gc.js's own check, run just before this). They must
// be excluded from the reference map here, not just pruned from config
// afterward: without this, a dead project's owned device reads as
// "referenced" on this same run (its config entry hasn't been removed
// yet), so the device survives one full `gc --delete` and is only reaped
// on the NEXT run. Excluding them here means dead-project pruning and its
// device sweep land in the same run.
export function findOrphanedDevices({
  sims = [],
  avds = [],
  config,
  isMounted,
  deadProjects = [],
}: {
  sims?: IosSimRecord[];
  avds?: string[];
  config: Config | null;
  isMounted?: (path: string) => boolean;
  deadProjects?: string[];
}): { orphaned: OrphanedDevice[]; kept: KeptDevice[] } {
  const dead = new Set(deadProjects);
  const referenced = new Map<string, { path: string; mounted: boolean }>(); // device id -> { path, mounted }

  for (const [path, proj] of Object.entries(config?.projects || {})) {
    if (dead.has(path)) continue;
    const mounted = isMounted ? isMounted(path) : true;
    const ios = proj?.platforms?.ios;
    if (ios?.deviceUdid) {
      referenced.set(ios.deviceUdid, { path, mounted });
    }
    const android = proj?.platforms?.android;
    if (android?.avdName) {
      referenced.set(android.avdName, { path, mounted });
    }
  }

  function describeKept(ref: { path: string; mounted: boolean }) {
    return ref.mounted
      ? `referenced by ${ref.path}`
      : `referenced by ${ref.path} (volume not mounted; kept just in case)`;
  }

  const orphaned: OrphanedDevice[] = [];
  const kept: KeptDevice[] = [];

  for (const sim of sims) {
    if (!sim?.name?.startsWith('rn-iso-')) continue;
    const ref = referenced.get(sim.udid);
    if (!ref) {
      orphaned.push({ kind: 'ios', id: sim.udid, name: sim.name });
    } else {
      kept.push({ kind: 'ios', id: sim.udid, name: sim.name, reason: describeKept(ref) });
    }
  }

  for (const avdName of avds) {
    if (!avdName?.startsWith('rn-iso-')) continue;
    const ref = referenced.get(avdName);
    if (!ref) {
      orphaned.push({ kind: 'android', id: avdName, name: avdName });
    } else {
      kept.push({ kind: 'android', id: avdName, name: avdName, reason: describeKept(ref) });
    }
  }

  return { orphaned, kept };
}

// Pure. Owned devices whose project is still registered and still on disk, but
// whose checkout nothing has touched in `olderThanDays`.
//
// This is not tidiness. `stop` has no --delete, and a checkout that is not a
// git worktree cannot be `worktree remove`d, so for the main checkout of every
// repo on the machine there is NO command that ever destroys the simulator
// rn-iso created for it. Without this sweep they accumulate one per project,
// forever. `worktree remove` covers worktrees; this covers everything else.
//
// It is deliberately narrower than the orphan sweep in three ways, because it
// is proposing to destroy a device belonging to a project that is still alive:
//   - only `owned: true` records (CLAUDE.md item 2: never touch a device
//     rn-iso did not create),
//   - only devices the LIVE listing confirms are on the machine, so a stale
//     record can never turn into a delete aimed at whatever now answers to
//     that identifier,
//   - only projects the caller has NOT already classified as dead, so the
//     orphan sweep and this one cannot both issue a delete at the same udid.
//
// `lastTouched(path)` returns a millisecond timestamp, or NaN when it cannot
// be read. NaN is treated as "not proven stale" and skipped: an unreadable
// timestamp is doubt, and doubt skips (CLAUDE.md item 8).
export function findStaleProjectDevices({
  config,
  sims = [],
  avds = [],
  olderThanDays,
  now = Date.now(),
  lastTouched,
  deadProjects = [],
}: {
  config: Config | null;
  sims?: IosSimRecord[];
  avds?: string[];
  olderThanDays?: number;
  now?: number;
  lastTouched?: (path: string) => number;
  deadProjects?: string[];
}): StaleProjectDevice[] {
  if (!Number.isFinite(olderThanDays) || typeof lastTouched !== 'function') return [];
  const cutoff = now - (olderThanDays as number) * DAY_MS;
  const dead = new Set(deadProjects);

  const liveSims = new Map<string, string>(
    sims.filter((s) => s?.name?.startsWith('rn-iso-')).map((s) => [s.udid, s.name] as [string, string]),
  );
  const liveAvds = new Set(avds.filter((a) => typeof a === 'string' && a.startsWith('rn-iso-')));

  const stale: StaleProjectDevice[] = [];
  for (const [path, proj] of Object.entries(config?.projects || {})) {
    if (dead.has(path)) continue;
    const touched = lastTouched(path);
    if (!Number.isFinite(touched) || touched >= cutoff) continue;
    const idleDays = Math.floor((now - touched) / DAY_MS);

    const ios = proj?.platforms?.ios;
    if (ios?.owned && ios.deviceUdid && liveSims.has(ios.deviceUdid)) {
      stale.push({
        kind: 'ios',
        id: ios.deviceUdid,
        name: liveSims.get(ios.deviceUdid) as string,
        project: path,
        idleDays,
      });
    }
    const android = proj?.platforms?.android;
    if (android?.owned && android.avdName && liveAvds.has(android.avdName)) {
      stale.push({ kind: 'android', id: android.avdName, name: android.avdName, project: path, idleDays });
    }
  }
  return stale;
}

// Pure. The mirror image of the orphan sweep: a LIVE project whose recorded
// device is no longer on the machine.
//
// This is the gap two field-test runs fell into. `status` warns "recorded sim
// <udid> no longer exists" on every run, forever, and `gc` said nothing about
// it -- the project's path is alive so the dead-entry sweep skips it, and the
// device is gone so the orphan sweep (which starts from the LISTING) cannot see
// it at all. Nothing on the machine could clear the warning except editing
// config.json by hand.
//
// What is stale here is the RECORD, and only the record. There is no device to
// tear down -- that is the premise -- so `--delete` clears the config entry and
// issues nothing at any device, which is why this is safe to act on where the
// orphan sweep needs the ownership guard.
//
// Two directions of doubt, both skipping:
//   - `checked` is false for a platform whose listing could not be read. An
//     absent simctl or a wedged daemon must never be read as "every recorded
//     sim is gone", which would propose clearing every device record on the
//     machine. Same distinction `status` draws with simsAvailable.
//   - projects the caller already classified as dead are excluded: their whole
//     entry is about to go, so proposing a second action on part of it would
//     only report the same thing twice.
//
// Ownership is deliberately NOT required. `owned` gates destruction, and this
// destroys nothing; a legacy record pointing at a simulator that no longer
// exists is exactly as useless as an owned one, and leaving it in place keeps
// `status` warning about a device nothing can ever resolve.
export function findStaleDeviceRecords({
  config,
  sims = [],
  avds = [],
  deadProjects = [],
  simsChecked = true,
  avdsChecked = true,
}: {
  config: Config | null;
  sims?: IosSimRecord[];
  avds?: string[];
  deadProjects?: string[];
  simsChecked?: boolean;
  avdsChecked?: boolean;
}): StaleDeviceRecord[] {
  const dead = new Set(deadProjects);
  const liveSims = new Set(sims.map((s) => s?.udid).filter(Boolean));
  const liveAvds = new Set(avds.filter((a) => typeof a === 'string'));

  const stale: StaleDeviceRecord[] = [];
  for (const [path, proj] of Object.entries(config?.projects || {})) {
    if (dead.has(path)) continue;

    const ios = proj?.platforms?.ios;
    if (simsChecked && ios?.deviceUdid && !liveSims.has(ios.deviceUdid)) {
      stale.push({ kind: 'ios', id: ios.deviceUdid, project: path, owned: Boolean(ios.owned) });
    }
    // `avdName`, never `serial`: a legacy physical record names hardware rn-iso
    // never created and cannot check against an AVD listing, so it is not
    // something this can call stale (CLAUDE.md item 2 -- nothing consumes the
    // physical bucket, and nothing may).
    const android = proj?.platforms?.android;
    if (avdsChecked && android?.avdName && !liveAvds.has(android.avdName)) {
      stale.push({ kind: 'android', id: android.avdName, project: path, owned: Boolean(android.owned) });
    }
  }
  return stale;
}

// The device sweep declined to run, for one of the two reasons below. Saying
// nothing was its own failure mode: a wiped config (or a throwaway
// RN_ISO_HOME) orphaned simulators that nothing would ever surface again.
// Report them by name so a human can judge; never act on them.
export function describeUnverifiableDevices(
  simNames: string[] = [],
  avdNames: string[] = [],
  { reason = 'no rn-iso config found' }: { reason?: string } = {},
): string[] {
  const ours = [...simNames, ...avdNames].filter((n) => typeof n === 'string' && n.startsWith('rn-iso-'));
  if (ours.length === 0) return [`${reason}; device sweep skipped`];
  return [
    `${reason}, so ${ours.length} rn-iso-created device(s) cannot be verified as orphaned: ${ours.join(', ')}`,
    'they were NOT touched. If they are stale, delete them with `xcrun simctl delete <udid>` or `avdmanager delete avd -n <name>`',
  ];
}

// A cache key is a 64-char fingerprint plus its variant and target. The whole
// thing in a report line is noise; enough of it to match against a build's own
// `fingerprint <hash>` line is not. Same rule, and the same shape, as
// shortHash in commands/ios.js.
function shortKey(key: unknown) {
  const text = String(key ?? '');
  return text.length > 6 ? `${text.slice(0, 6)}..` : text;
}

export function formatGcReport({
  skipped = [],
  deadProjects = [],
  orphanedDevices = [],
  staleDevices = [],
  staleDeviceRecords = [],
  buildLocks = { stale: [], live: [] },
  buildSlots = { stale: [], live: [] },
  deviceSweepNotices = [],
  caches = [],
  olderThan = null,
}: Partial<GcReport>): string[] {
  const lines: string[] = [];
  const staleLocks = buildLocks?.stale ?? [];
  const liveLocks = buildLocks?.live ?? [];
  const staleSlots = buildSlots?.stale ?? [];

  if (
    deadProjects.length === 0 &&
    orphanedDevices.length === 0 &&
    staleDevices.length === 0 &&
    staleDeviceRecords.length === 0 &&
    staleLocks.length === 0 &&
    staleSlots.length === 0
  ) {
    const reasons = [];
    if (skipped.length > 0) {
      reasons.push(`${skipped.length} entr${skipped.length === 1 ? 'y' : 'ies'} could not be checked`);
    }
    if (deviceSweepNotices.length > 0) {
      reasons.push('device sweep incomplete');
    }
    if (reasons.length > 0) {
      lines.push(`Nothing to reclaim (${reasons.join('; ')}; see below).`);
    } else {
      lines.push('Nothing to reclaim.');
    }
  }

  if (deadProjects.length) {
    lines.push(`Dead project entries (${deadProjects.length}):`);
    for (const path of deadProjects) lines.push(`  ${path}`);
  }

  if (orphanedDevices.length) {
    lines.push(`Orphaned devices (${orphanedDevices.length}):`);
    for (const d of orphanedDevices) lines.push(`  ${d.kind} ${d.name} (${d.id})`);
  }

  if (staleDevices.length) {
    lines.push(`Stale owned devices (${staleDevices.length}) - project untouched for ${olderThan ?? '?'}d or more:`);
    for (const d of staleDevices) {
      lines.push(`  ${d.kind} ${d.name} (${d.id})`);
      lines.push(`              ${d.project} (idle ${d.idleDays}d)`);
    }
  }

  // Reported apart from the two device sweeps above because the action is
  // different in kind: there is no device left to delete, only a config entry
  // pointing at one. Named so the reader can match it to the warning `status`
  // has been printing on every run.
  if (staleDeviceRecords.length) {
    lines.push(`Stale device records (${staleDeviceRecords.length}) - the device is gone, the project is not:`);
    for (const r of staleDeviceRecords) {
      lines.push(`  ${r.kind} ${r.id} is not on this machine`);
      lines.push(`              recorded by ${r.project}`);
    }
    lines.push('              --delete clears the RECORD only; there is no device left to touch.');
  }

  // A lock whose builder is gone. Harmless -- the next build takes it over on
  // the pid-liveness check rather than waiting on it -- so this is tidiness,
  // and the only thing --delete removes here.
  if (staleLocks.length) {
    lines.push(`Stale build locks (${staleLocks.length}) - the process that was building is gone:`);
    for (const lock of staleLocks) {
      lines.push(`  ${lock.platform} ${shortKey(lock.key)} (pid ${lock.pid ?? '?'} is not running)`);
      lines.push(`              started by ${lock.projectRoot || 'an unrecorded workspace'}`);
    }
  }

  // The opt-in concurrency limit's slots, reported the same way and for the
  // same reason as the locks above: a slot whose builder is gone is debris a
  // reboot or a SIGKILL left behind, and --delete clears it. A LIVE slot is a
  // build in progress and is never listed here.
  if (staleSlots.length) {
    lines.push(`Stale build slots (${staleSlots.length}) - the process that was building is gone:`);
    for (const slot of staleSlots) {
      lines.push(`  slot ${slot.index ?? '?'} (pid ${slot.pid ?? '?'} is not running)`);
      lines.push(`              held by ${slot.projectRoot || 'an unrecorded workspace'}`);
    }
  }

  // Reported and NEVER acted on, which is why it is a separate list rather
  // than a row in the one above. Deleting a live lock would put a second
  // workspace on a 19-minute compile the first one is already running -- the
  // exact duplication single-flight exists to prevent. It is named so a reader
  // wondering why their `rn-iso ios` says "waiting on ..." can see what it is
  // waiting for.
  if (liveLocks.length) {
    lines.push(`Builds in progress (${liveLocks.length}) - NOT touched, by anything:`);
    for (const lock of liveLocks) {
      lines.push(`  ${lock.platform} ${shortKey(lock.key)} (pid ${lock.pid})`);
      lines.push(`              building in ${lock.projectRoot || 'an unrecorded workspace'}`);
    }
  }

  if (deviceSweepNotices.length) {
    lines.push(`Device sweep notices (${deviceSweepNotices.length}):`);
    for (const notice of deviceSweepNotices) lines.push(`  ${notice}`);
  }

  if (skipped.length) {
    lines.push(`Skipped (${skipped.length}) - not classified as dead:`);
    for (const entry of skipped) lines.push(`  ${entry.dir}: ${entry.reason}`);
  }

  // Shared caches are reported apart from everything above, and never counted
  // in the reclaim total: the rest of this report is dead weight, while these
  // are alive and load-bearing. Deleting one costs the next build the time the
  // cache was saving -- it is a performance decision, not cleanup. The
  // registered/detected tag is what `cache list` used to exist for: without
  // it, a report cannot say which rows a project described itself and which
  // ones rn-iso guessed at.
  if (caches.length) {
    const total = caches.reduce((n, c) => n + (c.bytes ?? 0), 0);
    lines.push(`Shared build caches (${caches.length}) - alive, not garbage:`);
    for (const c of caches) {
      const tag = c.source ? ` (${c.source})` : '';
      lines.push(`  ${formatBytes(c.bytes ?? 0).padStart(10)}  ${c.name}${tag}`);
      lines.push(`              ${c.dir}`);
      if (c.note) lines.push(`              ${c.note}`);
      // Only --all annotates these, and it says both halves out loud: what it
      // would empty, and what it refuses to touch and why. A refusal that is
      // not printed is indistinguishable from a cache that was not there.
      if (c.willEmpty) lines.push('              --all would EMPTY this cache');
      else if (c.emptySkipped) lines.push(`              --all skips this cache: ${c.emptySkipped}`);
    }
    lines.push(`  total: ${formatBytes(total)}`);
    const doomed = caches.filter((c) => c.willEmpty);
    if (doomed.length) {
      const doomedBytes = doomed.reduce((n, c) => n + (c.bytes ?? 0), 0);
      lines.push(`  --all would empty ${doomed.length} of these (${formatBytes(doomedBytes)})`);
    }
  }

  return lines;
}

// "Touched" is the project directory's own mtime. Config entries carry no
// timestamp, so this is the cheapest honest proxy for "someone is still
// working in this checkout", and it is coarse in the safe direction: a branch
// switch, a build, or an editor writing into the root all bump it, so a
// project in use reads as recent. A stat that throws returns NaN, which
// findStaleProjectDevices treats as doubt and skips.
function projectLastTouched(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return NaN;
  }
}

// RN_ISO_HOME scopes the CONFIG. Simulators and AVDs are machine-GLOBAL: there
// is one CoreSimulator device set and one AVD home per machine, and no env var
// redirects them. So a config read out of a non-default home describes, at
// best, a subset of the machine's devices -- every rn-iso-* device belonging to
// the real home reads as unreferenced, i.e. orphaned, and `--delete` destroys
// live environments. That is not hypothetical: it destroyed two real
// simulators during this branch's work.
//
// The invariant: a scoped config never sweeps global devices.
//
// This does NOT subsume the `cfg === null` guard below, and the reverse is
// equally false -- they are two distinct holes. A throwaway RN_ISO_HOME stops
// being null the moment any command writes to it, and from then on the sweep
// looked perfectly well-informed while knowing nothing about the machine. Both
// guards stay.
//
// There is deliberately no flag and no env var that lifts this from the
// command line: anything that could turn it off is something an agent could
// turn off. `runGc` takes the decision as a parameter instead, which commander
// never supplies, so only the test suite (driving a mocked device listing) can
// opt in.
function deviceSweepIsScoped(unsafeAllowScopedDeviceSweep?: boolean) {
  return Boolean(process.env.RN_ISO_HOME) && !unsafeAllowScopedDeviceSweep;
}

// The same invariant, one step further out. `deviceSweepIsScoped` says a scoped
// config must never sweep machine-global DEVICES; --all needs the general form:
//
//   RN_ISO_HOME scopes the config. Anything outside the config dir is
//   machine-global. A scoped config must never destroy machine-global state.
//
// It matters here because discoverCaches returns DETECTED caches as well as
// registered ones, and every detected one is machine-global: Xcode's CAS lives
// under ~/Library/Developer/Xcode/DerivedData and Metro's file maps live in
// os.tmpdir(). Neither moves with RN_ISO_HOME. So --all under a throwaway home
// would empty the real machine's caches -- the identical bug that was just
// fixed for devices, aimed at disk instead of at live environments.
//
// The device guard skips the sweep wholesale because there is no such thing as
// a simulator "inside getConfigDir()". Caches do have that distinction, so this
// one filters rather than skips: an in-scope cache is still emptied, and the
// machine-global ones are reported as refused WITH the reason.
//
// There is deliberately no parameter, flag or env var that lifts it, not even
// the test-only kind `deviceSweepIsScoped` accepts. That escape hatch is safe
// there because every device those tests touch is mocked; nothing mocks rmSync,
// so the same hatch here would be a way for a buggy test to empty the real
// machine's CAS. The suite does not need one: a cache placed inside
// getConfigDir() is genuinely in scope and is emptied without any override.
function cacheSweepIsScoped() {
  return Boolean(process.env.RN_ISO_HOME);
}

// Canonicalized so a containment check is not fooled by symlinks (CLAUDE.md
// item 6): on macOS getConfigDir() under a temp dir resolves through
// /var -> /private/var, and comparing one resolved path against one unresolved
// one would answer "outside" for a directory that is plainly inside. A path
// that cannot be realpath'd falls back to `resolve`, which then reads as
// outside -- doubt skips, it does not delete (CLAUDE.md item 8).
function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

// Strictly inside: the config dir ITSELF is not "a cache in scope". It holds
// config.json and the cache manifest, and emptying it would take the record of
// every device rn-iso owns with it.
function isInsideConfigDir(dir: string) {
  const root = canonicalPath(getConfigDir());
  const target = canonicalPath(dir);
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// Annotates each cache with what --all would do to it, so the report and the
// action agree by construction rather than by both re-deciding. Without --all
// no cache is annotated at all, which is what keeps a bare `gc` a report.
// Containment applies to EVERY destructive cache operation, not just --all.
// Trimming is destructive too, and it reaches the same directories: Metro's
// file maps are prune 'entries' living loose in os.tmpdir(), so --older-than
// trims them by age, and os.tmpdir() does not move with RN_ISO_HOME. That hole
// was live until this was pulled out of planCacheEmptying and applied to both
// paths. (The Xcode CAS hid it: being index-backed, pruneCache refuses it by
// design, so the obvious test passes vacuously.)
function machineGlobalReason(cache: CacheDescriptor): string | null {
  if (!cacheSweepIsScoped()) return null;
  // A REGISTERED cache was declared into THIS config's own caches.json, so
  // acting on it is in scope wherever it lives -- a Metro FileStore, an Expo
  // provider's artifact directory or a relocated CAS all legitimately sit
  // outside the config dir, and refusing them would break the case
  // declaredCaches exists for. A scoped manifest only ever lists what that
  // scope declared. DETECTED caches are the opposite: nobody declared them,
  // rn-iso found them by probing machine-global locations.
  if (cache.source === 'registered') return null;
  if (isInsideConfigDir(cache.dir)) return null;
  return `RN_ISO_HOME scopes this config, but ${cache.dir} is outside it and therefore machine-global`;
}

function planCacheEmptying(caches: CacheDescriptor[], all: boolean): GcCache[] {
  const annotated = caches.map((c) => ({ ...c, machineGlobal: machineGlobalReason(c) }));
  if (!all) return annotated;
  return annotated.map((c) => {
    if (c.machineGlobal) {
      return { ...c, willEmpty: false, emptySkipped: c.machineGlobal };
    }
    if (!ownsItsDirectory(c)) {
      return { ...c, willEmpty: false, emptySkipped: `${c.dir} is not a directory this cache owns` };
    }
    return { ...c, willEmpty: true, emptySkipped: null };
  });
}

// A last fail-closed check on the one operation in `gc` that cannot be undone.
// A cache that carries an explicit `files` list does not own its directory --
// Metro's maps live loose in os.tmpdir() alongside everything else's temp
// files -- and a mis-registered `dir` naming a volume root, the user's home,
// the temp dir or the config dir is a typo, never a cache.
function ownsItsDirectory(cache: CacheDescriptor): boolean {
  if (Array.isArray(cache.files)) return false;
  const dir = canonicalPath(cache.dir);
  if (dirname(dir) === dir) return false;
  return ![homedir(), tmpdir(), getConfigDir()].map(canonicalPath).includes(dir);
}

// Emptying, as opposed to --older-than's trimming.
//
// Everything pruneCache can already handle goes through pruneCache: a cutoff
// one day in the FUTURE makes every entry older than it, so an entries-style
// cache empties through the exact code --older-than uses, honouring
// entriesDepth and an explicit `files` list rather than re-deriving either.
//
// An index-backed cache is the one case it cannot: pruneCache refuses it by
// design ("empty it whole or not at all"), and that refusal is the whole reason
// --all exists -- with only age-based trimming on the machine, Xcode's CAS was
// skipped by every path and grew without bound. `prune: 'atomic'` is the
// contract from caches.js and cache-manifest.js; this reads it rather than
// re-deciding which caches are index-backed.
function emptyCache(cache: CacheDescriptor): {
  removed: number;
  bytes: number;
  skipped: string | null;
  failed?: number;
} {
  if (cache.prune !== 'atomic') {
    return pruneCache(cache, { olderThanDays: 0, now: Date.now() + DAY_MS });
  }

  let names: string[];
  try {
    names = readdirSync(cache.dir);
  } catch (e) {
    return { removed: 0, bytes: 0, skipped: `could not read ${cache.dir}: ${(e as Error).message}` };
  }
  // The directory itself stays: it is the cache, and the next build recreates
  // its contents into it. Only what it holds goes, in one step, which is what
  // "emptied whole" means for an index that addresses its own data files.
  let removed = 0;
  let failed = 0;
  for (const name of names) {
    try {
      rmSync(join(cache.dir, name), { recursive: true, force: true });
      removed++;
    } catch {
      failed++;
    }
  }
  return { removed, bytes: failed ? 0 : (cache.bytes ?? 0), failed, skipped: null };
}

// Everything gc knows, gathered without writing anything. `runGc` prints this
// and then, only with --delete, acts on it.
export async function collectGcReport({
  olderThan = null,
  all = false,
  now = Date.now(),
  lastTouched = projectLastTouched,
  unsafeAllowScopedDeviceSweep = false,
}: CollectGcReportOptions = {}): Promise<GcReport> {
  // Reported on every run: the cache paths are prescribed and there is no
  // `cache list`, so this report is the only way to see a registered cache. Sizing walks
  // the directories, which is the cost of the report being complete.
  // With --all each row is annotated with whether it would be emptied and, if
  // not, why -- decided here so the report and the action cannot disagree.
  const caches = planCacheEmptying(sizeCaches(discoverCaches({ declared: declaredCachePaths() })), all);

  // A project path that no longer exists looks "dead" -- but if it lives
  // on a volume that is simply not mounted right now (this machine's
  // repos live on an external SSD), unregistering it would destroy its
  // label, metroPort allocation, and device claims for good. Only prune
  // entries whose volume is confirmed mounted; route the rest into
  // skipped. isOnMountedVolume resolves symlinked ancestors first rather
  // than checking the raw path text -- a config key recorded under a
  // symlinked path (e.g. a home folder symlinked onto an external
  // volume) must not be misread as always-mounted just because it
  // textually starts under "/".
  const mountedVolumes = listMountedVolumes();
  const cfg = loadConfig();
  const deadProjects: string[] = [];
  const skipped: GcSkip[] = [];
  for (const path of Object.keys(cfg?.projects || {})) {
    if (existsSync(path)) continue;
    if (!isOnMountedVolume(path, mountedVolumes)) {
      const volume = volumeRootFor(path);
      skipped.push({ dir: path, reason: `volume ${volume} is not mounted` });
    } else {
      deadProjects.push(path);
    }
  }

  // Tolerate a missing/unresponsive simctl/emulator toolchain (Linux dev
  // box with no Android SDK, or -- as happened on this machine -- a
  // wedged simctl daemon that never answers) the same way `status`
  // does: an unreadable device list means "skip the device sweep for
  // this platform", not a crashed command. `gc` is advertised as the
  // always-safe command for unattended agents, so it must always
  // return promptly; DEVICE_LIST_TIMEOUT_MS bounds each listing so a
  // wedged daemon can't hang it forever (bare execSync has no timeout
  // by default). A skip is never treated as "no devices exist" (which
  // would be indistinguishable from a clean sweep) -- it is recorded in
  // deviceSweepNotices and surfaced in the report, never silently.
  const deviceSweepNotices: string[] = [];
  let orphanedDevices: OrphanedDevice[] = [];
  let staleDevices: StaleProjectDevice[] = [];
  let staleDeviceRecords: StaleDeviceRecord[] = [];

  // A config file that does not exist at all means rn-iso has never
  // registered a project under this home. findOrphanedDevices' reference map
  // would come back empty, which classifies EVERY rn-iso-* sim/AVD on the
  // machine as orphaned. Checked before the scoped-home guard only so its
  // more specific message wins when both apply.
  const unsweepableReason =
    cfg === null
      ? 'no rn-iso config found'
      : deviceSweepIsScoped(unsafeAllowScopedDeviceSweep)
        ? 'RN_ISO_HOME scopes this config, but simulators and AVDs are machine-global'
        : null;

  if (unsweepableReason) {
    // Name what it declined to judge, but never classify or act on it:
    // orphanedDevices stays empty, so --delete has nothing to reach for.
    let simNames: string[] = [];
    let avdNames: string[] = [];
    try {
      simNames = listAllIosSims({ timeoutMs: DEVICE_LIST_TIMEOUT_MS }).map((s) => s.name);
    } catch {
      /* toolchain unavailable: report what we can */
    }
    try {
      avdNames = listAvds({ timeoutMs: DEVICE_LIST_TIMEOUT_MS });
    } catch {
      /* same */
    }
    deviceSweepNotices.push(...describeUnverifiableDevices(simNames, avdNames, { reason: unsweepableReason }));
  } else {
    // Whether each listing was actually READ matters twice over. The orphan
    // sweep reads an unread listing as "no devices", which is harmless (it
    // proposes nothing); the stale-RECORD sweep would read it as "every
    // recorded device is gone", which is the opposite of harmless. So the two
    // flags are tracked rather than inferred from an empty array.
    let sims: IosSimRecord[] = [];
    let simsChecked = true;
    try {
      sims = listAllIosSims({ timeoutMs: DEVICE_LIST_TIMEOUT_MS });
    } catch {
      simsChecked = false;
      deviceSweepNotices.push(
        `ios device sweep skipped: simulator tooling did not answer within ${DEVICE_LIST_TIMEOUT_MS / 1000}s`,
      );
    }
    let avds: string[] = [];
    let avdsChecked = true;
    try {
      avds = listAvds({ timeoutMs: DEVICE_LIST_TIMEOUT_MS });
    } catch {
      avdsChecked = false;
      deviceSweepNotices.push(
        `android device sweep skipped: emulator tooling did not answer within ${DEVICE_LIST_TIMEOUT_MS / 1000}s`,
      );
    }

    const isMounted = (path: string) => isOnMountedVolume(path, mountedVolumes);
    orphanedDevices = findOrphanedDevices({ sims, avds, config: cfg, isMounted, deadProjects }).orphaned;
    staleDeviceRecords = findStaleDeviceRecords({
      config: cfg,
      sims,
      avds,
      deadProjects,
      simsChecked,
      avdsChecked,
    });
    if (olderThan !== null) {
      staleDevices = findStaleProjectDevices({
        config: cfg,
        sims,
        avds,
        olderThanDays: olderThan,
        now,
        lastTouched,
        deadProjects,
      });
    }
  }

  // Build locks live under the config dir, so RN_ISO_HOME scopes them the way
  // it scopes the registry -- unlike simulators and AVDs, which are
  // machine-global and need the guard above. A throwaway home simply has no
  // locks in it.
  const locks = listBuildLocks();
  // Build slots are the opt-in concurrency limit's semaphore, under the config
  // dir like the locks, so RN_ISO_HOME scopes them the same way. A stale slot
  // is a build that died holding one; a live slot is a build in progress.
  const slots = listBuildSlots();

  return {
    skipped,
    deadProjects,
    orphanedDevices,
    staleDevices,
    staleDeviceRecords,
    buildLocks: {
      stale: locks.filter((l) => !l.alive),
      live: locks.filter((l) => l.alive),
    },
    buildSlots: {
      stale: slots.filter((s) => !s.alive),
      live: slots.filter((s) => s.alive),
    },
    deviceSweepNotices,
    caches,
    olderThan,
    all,
  };
}

// Report, then (only with --delete) act. Exported so the suite can drive the
// device sweep with `unsafeAllowScopedDeviceSweep`; commander supplies only
// the flags declared below.
export async function runGc(opts: RunGcOptions = {}): Promise<void> {
  const olderThan = typeof opts.olderThan === 'number' ? opts.olderThan : null;
  // --all reaches CACHES ONLY. It is not "delete everything gc knows about":
  // devices and project entries are reached by --delete alone, exactly as
  // before, so this flag's blast radius is disk rather than live environments.
  const all = Boolean(opts.all);
  const report = await collectGcReport({
    olderThan,
    all,
    unsafeAllowScopedDeviceSweep: opts.unsafeAllowScopedDeviceSweep,
  });
  for (const line of formatGcReport(report)) console.log(line);

  const { deadProjects, orphanedDevices, staleDevices, staleDeviceRecords, buildLocks, buildSlots, caches } = report;
  // Caches only count as actionable with --older-than: emptying one whole is a
  // performance decision aimed at a specific cache, not something a sweep
  // should do on the way past.
  const actionable =
    deadProjects.length > 0 ||
    orphanedDevices.length > 0 ||
    staleDevices.length > 0 ||
    staleDeviceRecords.length > 0 ||
    buildLocks.stale.length > 0 ||
    buildSlots.stale.length > 0 ||
    ((olderThan !== null || all) && caches.length > 0);

  if (!opts.delete) {
    if (all) console.log(chalk.dim('\nDry run. Re-run with --delete --all to empty the caches above.'));
    else if (actionable) console.log(chalk.dim('\nDry run. Re-run with --delete to reclaim.'));
    else if (caches.length) {
      console.log(
        chalk.dim('\nPass --delete --older-than <days> to trim the caches above, or --delete --all to empty them.'),
      );
    }
    return;
  }

  // No early return for "nothing actionable": every loop below is a no-op on
  // an empty list, and falling through is what lets the cache hint at the end
  // reach a machine whose only remaining weight IS the caches.
  let deleteFailures = 0;
  for (const path of deadProjects) {
    const result = await reclaimProject(path);
    if (result.keptEntry) console.log(chalk.yellow(`Could not fully prune ${path}; its registry entry was kept.`));
    else console.log(chalk.green(`Pruned ${path}`));
    for (const dir of result.removedWorkspaceDirs) console.log(chalk.dim(`  removed workspace output ${dir}`));
    for (const dir of result.failedWorkspaceDirs) {
      console.log(chalk.red(`  could not remove workspace output ${dir}`));
      deleteFailures += 1;
    }
    if (result.killedPid) {
      console.log(chalk.dim(`  killed orphaned Metro pid ${result.killedPid}`));
    }
  }

  // Each device's teardown is wrapped in its own try/catch (the pattern
  // reclaim.js uses): one bad record or exec throw must not abort the
  // rest of the sweep. iOS is re-verified against the live sim list
  // right before shutdown, the same way reclaim.js and commands/stop.js
  // both do: the udid came from the listing taken earlier in
  // this run, and shutting down first on the strength of that snapshot
  // "would already have hit whatever real simulator that udid resolves
  // to" if it has since been renamed away from rn-iso ownership or
  // deleted. A stale/renamed record is reported and left alone
  // (notOwned), an already-gone one is reported as such without being
  // treated as a failure (missing), and a probe that itself throws
  // fails CLOSED -- caught below, reported, and left untouched, same as
  // any other teardown failure. Occupancy no longer defers a delete: an
  // orphaned sim referenced by no live project is going away, and leaving
  // it "for a later gc" only asked the same question again forever.
  // Every one of those guards lives in src/teardown.js and nowhere else
  // (CLAUDE.md item 4): gc never issues simctl/avdmanager itself.
  function reap(d: OrphanedDevice | StaleProjectDevice) {
    const r =
      d.kind === 'ios'
        ? teardownOwnedIosSim(d.id, { del: true, label: d.name })
        : teardownOwnedAvd(d.name, { del: true });
    const what = d.kind === 'ios' ? `ios sim ${d.name} (${d.id})` : `android avd ${d.name}`;
    if (r.status === 'torn-down') {
      console.log(chalk.green(`Deleted ${what}`));
    } else if (r.status === 'missing') {
      console.log(chalk.dim(`${what} is already gone; nothing to delete.`));
    } else if (r.status === 'skipped') {
      console.log(chalk.yellow(`Skipped ${what}: ${r.reason} -- left for a later gc`));
    } else {
      deleteFailures++;
      console.log(chalk.red(`Failed to delete ${d.kind} device ${d.name}: ${r.reason}`));
    }
    return r.status;
  }

  for (const d of orphanedDevices) reap(d);

  // A stale device's project is still alive, so -- unlike the orphan sweep --
  // its config entry stays. Only the device record goes, and only once the
  // device is provably no longer on the machine ('torn-down' or 'missing').
  // On a skip or a failure the record is what keeps the device findable, so
  // it survives: dropping it is exactly what turns a failed teardown into a
  // simulator nothing references and nothing will ever reap (CLAUDE.md item
  // 2).
  for (const d of staleDevices) {
    const status = reap(d);
    if (status === 'torn-down' || status === 'missing') {
      clearDevice(d.project, d.kind);
      console.log(chalk.dim(`  cleared the ${d.kind} record for ${d.project}`));
    }
  }

  // The record, and nothing else. There is no device to resolve, no ownership
  // to re-verify and nothing to shut down -- the premise of this list is that
  // the device is already gone -- so this issues no simctl/avdmanager command
  // at all. clearDevice does its read-modify-write inside withConfigLock, which
  // is what keeps it safe beside a `start` or an `ios` running in another
  // worktree (CLAUDE.md: config writes are locked and atomic).
  for (const r of staleDeviceRecords) {
    clearDevice(r.project, r.kind);
    console.log(chalk.green(`Cleared the ${r.kind} record for ${r.project} (${r.id} is not on this machine)`));
  }

  // Stale locks only, and only ever the directory: there is no process to
  // signal (that is what makes it stale) and no artifact to remove. The stale
  // list was built when the report was assembled; a waiter may have reaped and
  // re-created this lock as a LIVE build since (the TOCTOU reapStaleLock closes
  // on the acquire side). Re-read each record right before removing and skip a
  // now-live one -- deleting it would let a second builder acquire the same
  // fingerprint.
  for (const lock of buildLocks.stale) {
    const current = readBuildLock(lock.path);
    if (current?.pid && isPidAlive(current.pid)) continue;
    try {
      rmSync(lock.path, { recursive: true, force: true });
      console.log(
        chalk.green(
          `Cleared the ${lock.platform} build lock left by pid ${lock.pid ?? '?'} (${lock.projectRoot || 'unrecorded workspace'})`,
        ),
      );
    } catch (err) {
      deleteFailures++;
      console.log(chalk.red(`Failed to clear the build lock at ${lock.path}: ${(err as Error)?.message || err}`));
    }
  }

  // Stale build slots, the same way -- and with the same right-before-removal
  // liveness re-check, so a slot re-claimed by a live builder since the report
  // is not deleted out from under it (which would over-subscribe maxBuilds).
  for (const slot of buildSlots.stale) {
    const current = readBuildSlot(slot.path);
    if (current?.pid && isPidAlive(current.pid)) continue;
    try {
      rmSync(slot.path, { recursive: true, force: true });
      console.log(
        chalk.green(
          `Cleared build slot ${slot.index ?? '?'} left by pid ${slot.pid ?? '?'} (${slot.projectRoot || 'unrecorded workspace'})`,
        ),
      );
    } catch (err) {
      deleteFailures++;
      console.log(chalk.red(`Failed to clear the build slot at ${slot.path}: ${(err as Error)?.message || err}`));
    }
  }

  if (deleteFailures) {
    console.log(
      chalk.red(`\n${deleteFailures} entr${deleteFailures === 1 ? 'y' : 'ies'} could not be deleted; see above.`),
    );
  }

  // Trimmed last and reported apart from everything above: this is not
  // reclaimed garbage, it is a cache someone will now have to refill. Only
  // --older-than reaches them, and it trims ENTRIES rather than emptying the
  // cache: a cache is worth keeping, it is only the entries nothing has
  // touched in weeks that are not. A CAS is the exception -- its index would
  // outlive the leaves -- and it says so rather than silently ignoring the
  // flag.
  // --all supersedes --older-than for caches: emptying is what trimming by age
  // could not do to an index-backed cache, and running both would only ask the
  // same directory twice. --older-than still governs the stale-device sweep
  // above, which is why the two flags remain independently useful.
  if (all) {
    emptyCaches(caches);
    return;
  }

  if (olderThan === null) {
    if (caches.length) {
      console.log(
        chalk.dim('Shared caches left alone: pass --older-than <days> to trim them, or --all to empty them.'),
      );
    }
    return;
  }

  let cacheBytes = 0;
  for (const c of caches) {
    if (c.machineGlobal) {
      console.log(chalk.yellow(`Left ${c.name} alone: ${c.machineGlobal}`));
      continue;
    }
    const r = pruneCache(c, { olderThanDays: olderThan });
    if (r.skipped) {
      console.log(chalk.yellow(`Left ${c.name} alone: ${r.skipped}`));
    } else if (r.removed) {
      cacheBytes += r.bytes;
      console.log(
        chalk.green(`Trimmed ${c.name}: ${r.removed} entr${r.removed === 1 ? 'y' : 'ies'} (${formatBytes(r.bytes)})`),
      );
    } else {
      console.log(chalk.dim(`${c.name}: nothing older than ${olderThan}d`));
    }
  }

  if (cacheBytes) {
    console.log(
      chalk.dim(
        `Trimmed ${formatBytes(cacheBytes)} of shared cache. The next build that wanted those entries pays to rebuild them.`,
      ),
    );
  }
}

// The --all half of the cache pass. Kept beside the trim loop it mirrors: both
// report per cache, both total at the end, and neither counts what it removed
// as reclaimed garbage -- a cache is weight someone will now pay to refill.
function emptyCaches(caches: GcCache[]) {
  let cacheBytes = 0;
  for (const c of caches) {
    if (!c.willEmpty) {
      console.log(chalk.yellow(`Left ${c.name} alone: ${c.emptySkipped}`));
      continue;
    }
    const r = emptyCache(c);
    if (r.skipped) {
      console.log(chalk.yellow(`Left ${c.name} alone: ${r.skipped}`));
    } else if (r.removed) {
      cacheBytes += r.bytes;
      console.log(
        chalk.green(`Emptied ${c.name}: ${r.removed} entr${r.removed === 1 ? 'y' : 'ies'} (${formatBytes(r.bytes)})`),
      );
    } else {
      console.log(chalk.dim(`${c.name}: already empty`));
    }
    if (r.failed) {
      console.log(chalk.red(`  ${r.failed} entr${r.failed === 1 ? 'y' : 'ies'} in ${c.dir} could not be removed`));
    }
  }
  if (cacheBytes) {
    console.log(
      chalk.dim(
        `Emptied ${formatBytes(cacheBytes)} of shared cache. Every build that wanted any of it now pays to rebuild it.`,
      ),
    );
  }
}

export default function gcCommand(program: Command): void {
  program
    .command('gc')
    .description(
      'Report what rn-iso has left behind: dead project entries, orphaned owned devices, records of devices that no longer exist, build locks whose builder is gone, and the shared build caches. Reports by default; pass --delete to act.',
    )
    .option('--delete', 'actually prune the reported entries and reap the reported devices')
    .option(
      '--older-than <days>',
      'also reap owned devices whose project has been untouched this long, and trim shared cache entries nothing has used in that time',
      (v: string) => {
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || String(n) !== String(v).trim()) {
          throw new InvalidArgumentError('must be a whole number of days, e.g. --older-than 30');
        }
        return n;
      },
    )
    .option(
      '--all',
      'with --delete, empty every shared cache whole rather than trimming it by age -- the only way to clear an index-backed cache. Reaches caches only, never devices or project entries. Caches outside the config dir are refused while RN_ISO_HOME is set.',
    )
    .action(async (opts: RunGcOptions) => {
      await runGc(opts);
    });
}
