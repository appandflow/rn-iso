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
