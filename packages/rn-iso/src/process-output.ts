import type { ChildProcess } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

export interface ChildResult {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
}

export function stripAnsi(text: unknown): string {
  return stripVTControlCharacters(String(text ?? ''));
}

export function createLineReader(onLine: (line: string) => void): { push(chunk: unknown): void; flush(): void } {
  let buffered = '';
  return {
    push(chunk: unknown) {
      buffered += String(chunk);
      const parts = buffered.split('\n');
      buffered = parts.pop() ?? '';
      for (const part of parts) onLine(part);
    },
    flush() {
      if (!buffered) return;
      const rest = buffered;
      buffered = '';
      onLine(rest);
    },
  };
}

export function waitForChild(child: ChildProcess): Promise<ChildResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: ChildResult) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    child.on('exit', (code, signal) => done({ code, signal }));
    child.on('error', (error) => done({ error }));
  });
}
