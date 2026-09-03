import { getExecutor } from '../exec.ts';
import { createLineReader, stripAnsi, waitForChild } from '../process-output.ts';

export interface IosSimRecord {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  deviceTypeIdentifier: string;
}

export interface IosDeviceType {
  identifier: string;
  name: string;
}

export interface IosRuntime {
  identifier: string;
  name: string;
  version: string;
  supportedDeviceTypes: IosDeviceType[];
}

interface IosCreationPick {
  deviceTypeId: string;
  runtimeId: string;
}

export interface ResolvedIosSim {
  sim?: IosSimRecord;
  missing?: true;
  notOwned?: string;
}

export function parseSimctlList(jsonOutput: string): IosSimRecord[] {
  const data = JSON.parse(jsonOutput) as {
    devices?: Record<
      string,
      Array<{ udid: string; name: string; state: string; deviceTypeIdentifier: string; isAvailable?: boolean }>
    >;
  };
  const sims: IosSimRecord[] = [];
  for (const [runtime, devices] of Object.entries(data.devices || {})) {
    if (!/\.iOS-/.test(runtime)) continue;
    for (const dev of devices) {
      if (!dev.isAvailable) continue;
      sims.push({
        udid: dev.udid,
        name: dev.name,
        state: dev.state,
        runtime,
        deviceTypeIdentifier: dev.deviceTypeIdentifier,
      });
    }
  }
  return sims;
}

export function listAllIosSims({ timeoutMs }: { timeoutMs?: number } = {}): IosSimRecord[] {
  const out = getExecutor().run('xcrun simctl list devices --json', { timeoutMs });
  return parseSimctlList(out);
}

export function listBootedIosSims(): IosSimRecord[] {
  return listAllIosSims().filter((s) => s.state === 'Booted');
}

export function parseOccupyingApps(launchctlOutput: string): string[] {
  if (typeof launchctlOutput !== 'string' || launchctlOutput.length === 0) return [];
  const ids: string[] = [];
  for (const line of launchctlOutput.split('\n')) {
    const m = line.match(/UIKitApplication:([^[\s]+)/);
    if (!m) continue;
    const bundleId = m[1];
    if (bundleId === undefined) continue;
    if (bundleId.startsWith('com.apple.')) continue;
    if (!bundleId.endsWith('.xctrunner')) continue;
    ids.push(bundleId);
  }
  return ids;
}

export function occupyingApps(udid: string): string[] | null {
  let sim: IosSimRecord | undefined;
  try {
    sim = listAllIosSims().find((s) => s.udid === udid);
  } catch {
    sim = undefined;
  }
  if (sim && sim.state !== 'Booted') return [];
  const out = getExecutor().runQuiet(`xcrun simctl spawn ${udid} launchctl list`);
  if (out === null || out === undefined) return null;
  return parseOccupyingApps(out);
}

export function parseRuntimeVersion(runtimeId: string): string {
  const m = runtimeId.match(/iOS-(\d+)(?:-(\d+))?$/);
  if (!m) return runtimeId;
  const major = m[1];
  if (major === undefined) return runtimeId;
  const minor = m[2];
  return minor ? `${major}.${minor}` : major;
}

export const IOS_BOOT_TIMEOUT_MS: number = 600000;
const BOOTSTATUS_ATTEMPT_MS = 240000;
const BOOTSTATUS_ATTEMPT_FLOOR_MS = 1000;
const BOOT_STATE_LIST_TIMEOUT_MS = 30000;

function bootstatusTimeout(udid: string): NodeJS.ErrnoException {
  const e = new Error(`xcrun simctl bootstatus ${udid} -b timed out`) as NodeJS.ErrnoException;
  e.code = 'ETIMEDOUT';
  return e;
}

async function awaitBootstatus(udid: string, attemptMs: number): Promise<void> {
  const lines: string[] = [];
  const reader = createLineReader((raw) => {
    const line = stripAnsi(raw).trim();
    if (!line) return;
    lines.push(line);
    if (lines.length > 10) lines.shift();
  });
  const child = getExecutor().spawn('xcrun', ['simctl', 'bootstatus', udid, '-b'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk) => reader.push(chunk));
  child.stderr?.on('data', (chunk) => reader.push(chunk));
  let timer: NodeJS.Timeout | undefined;
  const attempt = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), attemptMs);
  });
  const result = await Promise.race([waitForChild(child), attempt]);
  clearTimeout(timer);
  reader.flush();
  if (result === 'timeout') {
    child.kill('SIGKILL');
    throw bootstatusTimeout(udid);
  }
  if (result.error) throw result.error;
  if (result.code === 0) return;
  const detail = lines.length ? `: ${lines.join(' | ')}` : '';
  throw new Error(`xcrun simctl bootstatus ${udid} -b failed with exit code ${result.code ?? 'unknown'}${detail}`);
}

export async function bootIosSim(
  udid: string,
  {
    timeoutMs = IOS_BOOT_TIMEOUT_MS,
    attemptMs = BOOTSTATUS_ATTEMPT_MS,
  }: { timeoutMs?: number; attemptMs?: number } = {},
): Promise<void> {
  const exec = getExecutor();
  try {
    exec.run(`xcrun simctl boot ${udid}`);
  } catch (e) {
    if (!String((e as Error)?.message || e).includes('Booted')) throw e;
  }
  const deadline = Date.now() + timeoutMs;
  // `simctl bootstatus -b` blocks until the boot finishes, and a first boot on a
  // CPU-starved host (a CI runner sharing cores with xcodebuild) can legitimately
  // outlast one attempt (#128).
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      try {
        await awaitBootstatus(udid, Math.min(Math.max(remaining, BOOTSTATUS_ATTEMPT_FLOOR_MS), attemptMs));
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== 'ETIMEDOUT') throw e;
      }
    }
    let state: string | null | undefined;
    try {
      state = listAllIosSims({ timeoutMs: BOOT_STATE_LIST_TIMEOUT_MS }).find((s) => s.udid === udid)?.state ?? null;
    } catch {
      state = undefined;
    }
    if (state === 'Booted') break;
    const waited = Math.round((timeoutMs - Math.max(0, deadline - Date.now())) / 1000);
    if (state !== 'Booting' && state !== undefined) {
      throw new Error(`Simulator ${udid} reports "${state ?? 'missing'}" after ${waited}s of boot wait.`);
    }
    if (deadline - Date.now() <= 0) {
      throw new Error(`Simulator ${udid} did not finish booting within ${Math.round(timeoutMs / 1000)}s.`);
    }
  }
  exec.runQuiet('open -a Simulator');
}

export function shutdownIosSim(udid: string): void {
  getExecutor().runQuiet(`xcrun simctl shutdown ${udid}`);
}

export function listIosDeviceTypes(): IosDeviceType[] {
  const exec = getExecutor();
  const out = exec.run('xcrun simctl list devicetypes --json');
  const data = JSON.parse(out) as { devicetypes?: Array<{ identifier: string; name: string }> };
  return (data.devicetypes || []).map((dt) => ({
    identifier: dt.identifier,
    name: dt.name,
  }));
}

function rankIphone(name: string): { gen: number; variant: number } {
  const gen = /^iPhone\s+(\d+)/i.exec(name);
  return {
    gen: gen ? Number(gen[1]) : -1,
    variant: -name.length,
  };
}

export function iosRuntimeMatches(runtime: IosRuntime, requested: string): boolean {
  return runtime.version === requested || runtime.name === requested;
}

export function pickDefaultIosCreation(
  _deviceTypes: IosDeviceType[],
  runtimes: IosRuntime[],
  { deviceType, runtime }: { deviceType?: string; runtime?: string } = {},
): IosCreationPick | null {
  const rts = runtimes.toSorted((a, b) =>
    String(b.version).localeCompare(String(a.version), undefined, { numeric: true }),
  );
  const wantedRts = runtime ? rts.filter((r) => iosRuntimeMatches(r, runtime)) : rts;
  for (const rt of wantedRts) {
    const supported = (rt.supportedDeviceTypes || []).filter((d) =>
      deviceType ? d.name === deviceType : /^iPhone/i.test(d.name),
    );
    if (supported.length === 0) continue;
    const best = supported.toSorted((a, b) => {
      const ra = rankIphone(a.name),
        rb = rankIphone(b.name);
      return rb.gen - ra.gen || rb.variant - ra.variant || b.name.localeCompare(a.name, undefined, { numeric: true });
    })[0];
    if (best === undefined) continue;
    return { deviceTypeId: best.identifier, runtimeId: rt.identifier };
  }
  return null;
}

export function sanitizeDeviceLabel(label: string): string {
  return String(label)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function ownedSimName(label: string): string {
  const clean = sanitizeDeviceLabel(label);
  return `stim-${clean.startsWith('stim-') ? clean.slice('stim-'.length) : clean}`;
}

export function createOwnedIosSim(
  label: string,
  { deviceType, runtime }: { deviceType?: string; runtime?: string } = {},
): { udid: string; name: string; deviceType: string | null; runtime: string | null } {
  const deviceTypes = listIosDeviceTypes();
  const runtimes = listIosRuntimes();
  const pick = pickDefaultIosCreation(deviceTypes, runtimes, { deviceType, runtime });
  if (!pick) {
    throw new Error(
      'No matching simulator device type / runtime is installed. Install one via Xcode, or pass --device-type / --runtime.',
    );
  }
  const name = ownedSimName(label);
  const udid = getExecutor().run(`xcrun simctl create "${name}" "${pick.deviceTypeId}" "${pick.runtimeId}"`).trim();
  return {
    udid,
    name,
    deviceType: deviceTypes.find((d) => d.identifier === pick.deviceTypeId)?.name ?? null,
    runtime: runtimes.find((r) => r.identifier === pick.runtimeId)?.version ?? null,
  };
}

export function resolveOwnedIosSim(udid: string): ResolvedIosSim {
  const sim = listAllIosSims().find((s) => s.udid === udid);
  if (!sim) return { missing: true };
  if (!sim.name?.startsWith('stim-')) return { notOwned: sim.name };
  return { sim };
}

export function deleteIosSim(udid: string): void {
  const result = resolveOwnedIosSim(udid);
  if (result.missing) return;
  if (result.notOwned) {
    throw new Error(
      `Refusing to delete simulator "${result.notOwned}" (${udid}): not a Stim-owned sim (name must start with "stim-").`,
    );
  }
  getExecutor().run(`xcrun simctl delete ${udid}`);
}

export function listIosRuntimes(): IosRuntime[] {
  const out = getExecutor().run('xcrun simctl list runtimes --json');
  const data = JSON.parse(out) as {
    runtimes?: Array<{
      identifier: string;
      name: string;
      version: string;
      isAvailable?: boolean;
      platform?: string;
      supportedDeviceTypes?: Array<{ identifier: string; name: string }>;
    }>;
  };
  return (data.runtimes || [])
    .filter((r) => r.isAvailable && r.platform === 'iOS')
    .map((r) => ({
      identifier: r.identifier,
      name: r.name,
      version: r.version,
      supportedDeviceTypes: (r.supportedDeviceTypes || []).map((d) => ({
        identifier: d.identifier,
        name: d.name,
      })),
    }));
}
