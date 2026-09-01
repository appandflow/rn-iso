import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { getExecutor } from './exec.ts';

export const PROCESS_COMMAND_TIMEOUT_MS: number = 1_000;
export const PROCESS_COMMAND_MAX_BYTES: number = 32 * 1024;

export type ReadProcCommand = (path: string, maxBytes: number) => Buffer;
export type RunPsCommand = (pid: number, timeoutMs: number) => string;
export type ReadUptimeSeconds = () => number | null;

export function readProcFile(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, 'r');
  const buffer = Buffer.alloc(maxBytes + 1);
  let bytesRead = 0;
  try {
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
  } finally {
    closeSync(fd);
  }
  if (bytesRead > maxBytes) throw new Error(`process command exceeds ${maxBytes} bytes`);
  return buffer.subarray(0, bytesRead);
}

function defaultRunPsCommand(pid: number, timeoutMs: number): string {
  return getExecutor().runFile('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { timeoutMs });
}

function parseProcCommand(data: Buffer, maxBytes: number): string[] | null {
  if (data.length === 0 || data.length > maxBytes || data[data.length - 1] !== 0) return null;
  let end = data.length;
  while (end > 0 && data[end - 1] === 0) end -= 1;
  const args = data.subarray(0, end).toString('utf-8').split('\0');
  return args.length > 0 && args.every((arg) => arg.length > 0) ? args : null;
}

function parsePsCommand(command: string): string[] | null {
  const input = command.trim();
  if (!input || input.includes('\0') || input.includes('\n') || input.includes('\r')) return null;

  const args: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  const finishArg = () => {
    if (!started) return;
    args.push(current);
    current = '';
    started = false;
  };

  for (const char of input) {
    if (escaped) {
      current += char;
      started = true;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      finishArg();
      continue;
    }
    current += char;
    started = true;
  }
  if (quote || escaped) return null;
  finishArg();
  return args.length > 0 && args.every((arg) => arg.length > 0) ? args : null;
}

export function readProcessArgs(
  pid: number,
  {
    platform = process.platform,
    readProcCommand = readProcFile,
    runPsCommand = defaultRunPsCommand,
  }: {
    platform?: NodeJS.Platform;
    readProcCommand?: ReadProcCommand;
    runPsCommand?: RunPsCommand;
  } = {},
): string[] | null {
  try {
    if (platform === 'linux') {
      return parseProcCommand(
        readProcCommand(`/proc/${pid}/cmdline`, PROCESS_COMMAND_MAX_BYTES),
        PROCESS_COMMAND_MAX_BYTES,
      );
    }
    if (platform === 'win32') return null;
    return parsePsCommand(runPsCommand(pid, PROCESS_COMMAND_TIMEOUT_MS));
  } catch {
    return null;
  }
}

export function runPsStartCommand(pid: number, timeoutMs: number): string {
  return getExecutor().runFile('ps', ['-ww', '-o', 'lstart=', '-p', String(pid)], { timeoutMs });
}

export function parseLstartOutput(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed || trimmed.includes('\0') || trimmed.includes('\n') || trimmed.includes('\r')) return null;
  const normalized = trimmed.replace(/\s+/g, ' ');
  return normalized || null;
}

export function parseLinuxStartTicks(data: Buffer, maxBytes: number): number | null {
  if (data.length === 0 || data.length > maxBytes || data.includes(0)) return null;
  const stat = data.toString('utf-8').trim();
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 2 || stat[commandEnd + 1] !== ' ') return null;
  const fields = stat.slice(commandEnd + 2).split(' ');
  const startTicks = fields[19];
  return startTicks && /^\d+$/.test(startTicks) ? Number(startTicks) : null;
}

// glibc's sysconf(_SC_CLK_TCK) is fixed at 100 on Linux regardless of the kernel's actual HZ,
// so /proc/[pid]/stat's starttime field (in clock ticks since boot) converts with a flat /100.
const LINUX_CLK_TCK = 100;

function defaultReadUptimeSeconds(): number | null {
  try {
    const raw = readFileSync('/proc/uptime', 'utf-8');
    const first = Number.parseFloat(raw.split(' ')[0] ?? '');
    return Number.isFinite(first) ? first : null;
  } catch {
    return null;
  }
}

export function readProcessStartTime(
  pid: number,
  {
    platform = process.platform,
    readProcStat = readProcFile,
    readUptimeSeconds = defaultReadUptimeSeconds,
    runPsCommand = runPsStartCommand,
    now = Date.now,
  }: {
    platform?: NodeJS.Platform;
    readProcStat?: ReadProcCommand;
    readUptimeSeconds?: ReadUptimeSeconds;
    runPsCommand?: RunPsCommand;
    now?: () => number;
  } = {},
): Date | null {
  try {
    if (platform === 'linux') {
      const ticks = parseLinuxStartTicks(
        readProcStat(`/proc/${pid}/stat`, PROCESS_COMMAND_MAX_BYTES),
        PROCESS_COMMAND_MAX_BYTES,
      );
      if (ticks === null) return null;
      const uptimeSeconds = readUptimeSeconds();
      if (uptimeSeconds === null) return null;
      const bootMs = now() - uptimeSeconds * 1000;
      return new Date(bootMs + (ticks / LINUX_CLK_TCK) * 1000);
    }
    if (platform === 'win32') return null;
    const raw = parseLstartOutput(runPsCommand(pid, PROCESS_COMMAND_TIMEOUT_MS));
    if (!raw) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
}
