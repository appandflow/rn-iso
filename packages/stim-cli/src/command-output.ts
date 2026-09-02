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

export function phaseLine(label: unknown, text: string): string {
  return `  ${String(label).padEnd(LABEL_WIDTH)} ${text}`;
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
  'carry',
  'compilation cache',
  'device',
  'error',
  'failed',
  'fingerprint',
  'gems',
  'install',
  'ip.txt',
  'lan',
  'launch',
  'lease',
  'log',
  'logs',
  'metro',
  'pods',
  'port',
  'prebuild',
  'ready',
  'remedy',
  'setting',
  'state',
  'stats',
  'stop',
  'swap',
  'verify',
];

export function isOutputLabel(label: unknown): boolean {
  return OUTPUT_LABELS.includes(String(label));
}

export interface LaunchErrorRecord {
  src?: unknown;
  proc?: unknown;
  msg?: unknown;
}

/**
 * Splits the error-level records a verified launch collected into the OS-log
 * noise the run summarizes and the records it still prints one by one.
 */
export function launchErrorReport(
  records: readonly LaunchErrorRecord[],
  { appId, fromApp }: { appId: string; fromApp: (record: LaunchErrorRecord) => boolean },
): { summary: string | null; lines: string[] } {
  const noise = records.filter((record) => record.src === 'device' && !fromApp(record));
  const lines = records
    .filter((record) => !noise.includes(record))
    .map((record) => (record.msg === undefined || record.msg === null ? '' : String(record.msg)))
    .filter((msg) => msg !== '');
  const noun = noise.length === 1 ? 'line' : 'lines';
  const summary =
    noise.length === 0
      ? null
      : `${noise.length} error-level OS log ${noun} during launch, none from ${appId} (logs --source device)`;
  return { summary, lines };
}
