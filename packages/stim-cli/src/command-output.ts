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

export function phaseLine(label: unknown, text: string): string {
  return `  ${String(label).padEnd(LABEL_WIDTH)} ${text}`;
}

export function shortHash(hash: unknown): string {
  const text = String(hash ?? '');
  return text.length > 8 ? `${text.slice(0, 6)}..` : text;
}
