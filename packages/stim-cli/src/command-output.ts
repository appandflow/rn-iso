const LABEL_WIDTH = 11;

export function formatDuration(ms: unknown): string {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return 'unknown';
  if (value < 1000) return `${Math.round(value)}ms`;
  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds >= 60) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds - minutes * 60;
    return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  }
  const seconds = Math.round(value / 100) / 10;
  return `${seconds}s`;
}

export function formatLongDuration(ms: unknown): string {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return 'unknown';
  const totalSeconds = Math.round(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds - hours * 3600) / 60);
  const seconds = totalSeconds - hours * 3600 - minutes * 60;
  if (hours > 0) return minutes > 0 ? `${hours}h${String(minutes).padStart(2, '0')}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${minutes}m`;
  return `${seconds}s`;
}

export function formatElapsed(ms: unknown): string {
  const totalSeconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

export function plural(count: number, singular: string, many = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : many}`;
}

export function clockTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return [at.getHours(), at.getMinutes(), at.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** The fields `stop` and `worktree remove` need to report a released device lease. */
export interface ReleasedLeaseFact {
  platform: string;
  id: string;
  expiresAt: string;
}

export function releasedLeaseFact(lease: ReleasedLeaseFact): string {
  return `released the ${lease.platform} lease on ${lease.id} (it ran until ${clockTime(lease.expiresAt)})`;
}

export function phaseLine(label: unknown, text: string): string {
  return `  ${String(label).padEnd(LABEL_WIDTH)} ${text}`;
}

export function shortUdid(udid: unknown): string {
  const text = String(udid ?? '');
  return text.length > 4 ? `${text.slice(0, 4)}..` : text;
}

export function shortHash(hash: unknown): string {
  const text = String(hash ?? '');
  return text.length > 8 ? `${text.slice(0, 6)}..` : text;
}

/**
 * Every label Stim prints in the phase-line column. `''` is the continuation
 * label for a wrapped fact. `app` and `compilation cache` appear only in the
 * stdout summary block a successful run ends with.
 */
export const OUTPUT_LABELS: readonly string[] = [
  '',
  'app',
  'branch',
  'build',
  'cache',
  'caches',
  'carry',
  'compilation cache',
  'device',
  'devices',
  'error',
  'failed',
  'findings',
  'fingerprint',
  'gems',
  'install',
  'ip.txt',
  'lan',
  'launch',
  'lease',
  'log',
  'logs',
  'meaning',
  'metro',
  'pods',
  'port',
  'prebuild',
  'project',
  'ready',
  'remedy',
  'removed',
  'result',
  'services',
  'setting',
  'settings',
  'setup',
  'state',
  'stats',
  'stop',
  'swap',
  'verify',
  'workspace',
];

export function isOutputLabel(label: unknown): boolean {
  return OUTPUT_LABELS.includes(String(label));
}

/** The two fields a launch report reads off a collector's NDJSON record. */
export interface LaunchErrorRecord {
  src?: unknown;
  msg?: unknown;
  [key: string]: unknown;
}

/**
 * Splits the error-level records a verified launch collected into the device
 * log the run counts and the records it still prints one by one.
 */
export function launchErrorReport(records: readonly LaunchErrorRecord[]): { summary: string | null; lines: string[] } {
  const fromDevice = records.filter((record) => record.src === 'device');
  const lines = records
    .filter((record) => record.src !== 'device')
    .map((record) => (record.msg === undefined || record.msg === null ? '' : String(record.msg)))
    .filter((msg) => msg !== '');
  const summary =
    fromDevice.length === 0
      ? null
      : `${plural(fromDevice.length, 'error-level record')} in the device log during launch (logs --errors --source device)`;
  return { summary, lines };
}

export const SLOW_STEP_MS = 2000;

export function stepClock(now: () => number = Date.now): () => number {
  const t0 = now();
  return () => now() - t0;
}

export function stepTimer(now: () => number = Date.now): () => string {
  const elapsed = stepClock(now);
  return () => `(${formatDuration(elapsed())})`;
}
