import { createLineReader, stripAnsi, waitForChild } from '../process-output.ts';
import { makeChildProcess } from './_factories.ts';

const ESC = '\u001B';

test('stripAnsi removes colour and OSC sequences', () => {
  expect(stripAnsi(`${ESC}[32mStarting Metro${ESC}[39m`)).toBe('Starting Metro');
  expect(stripAnsi(`${ESC}]0;expo${ESC}\\done`)).toBe('done');
});

test('createLineReader reassembles split lines and flushes the final line', () => {
  const lines: string[] = [];
  const reader = createLineReader((line) => lines.push(line));
  reader.push('Starting ');
  reader.push('Metro\niOS Bun');
  reader.push('dled 10ms\nError: partial');
  expect(lines).toEqual(['Starting Metro', 'iOS Bundled 10ms']);
  reader.flush();
  reader.flush();
  expect(lines).toEqual(['Starting Metro', 'iOS Bundled 10ms', 'Error: partial']);
});

test('waitForChild resolves the first exit result', async () => {
  const child = makeChildProcess();
  const result = waitForChild(child);
  child.emit('exit', 3, 'SIGTERM');
  child.emit('error', new Error('late'));
  await expect(result).resolves.toEqual({ code: 3, signal: 'SIGTERM' });
});

test('waitForChild resolves a spawn error', async () => {
  const child = makeChildProcess();
  const result = waitForChild(child);
  const error = new Error('spawn failed');
  child.emit('error', error);
  await expect(result).resolves.toEqual({ error });
});
