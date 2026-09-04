import { WebSocketServer } from 'ws';
import { openIosDeepLink, reloadAndroidJs, reloadIosThroughMetro } from '../engine/reload.ts';
import type { Executor } from '../exec.ts';

function recordingExecutor() {
  const calls: { file: string; args: string[]; timeoutMs: number | undefined }[] = [];
  const exec = {
    runFile(file: string, args: string[], options?: { timeoutMs?: number }) {
      calls.push({ file, args, timeoutMs: options?.timeoutMs });
      return '';
    },
  } as Executor;
  return { calls, exec };
}

test('Android reload sends the React Native debug broadcast to the exact emulator and package', () => {
  const { calls, exec } = recordingExecutor();

  expect(reloadAndroidJs('emulator-5554', 'com.example.app', { exec })).toEqual({ ok: true });
  expect(calls).toEqual([
    {
      file: 'adb',
      args: [
        '-s',
        'emulator-5554',
        'shell',
        'am',
        'broadcast',
        '-a',
        'com.example.app.RELOAD_APP_ACTION',
        '-p',
        'com.example.app',
      ],
      timeoutMs: 10_000,
    },
  ]);
});

test('iOS deep-link reload targets the exact simulator', () => {
  const { calls, exec } = recordingExecutor();

  expect(openIosDeepLink('U1', 'example://reload', { exec })).toEqual({ ok: true });
  expect(calls).toEqual([
    {
      file: 'xcrun',
      args: ['simctl', 'openurl', 'U1', 'example://reload'],
      timeoutMs: 10_000,
    },
  ]);
});

test('Metro reload requires a connected peer and sends the version 2 reload broadcast', async () => {
  const messages: unknown[] = [];
  let sawReload!: () => void;
  const reloadSeen = new Promise<void>((resolve) => {
    sawReload = resolve;
  });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/message' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { id?: string; method?: string };
      messages.push(message);
      if (message.method === 'getpeers') {
        socket.send(JSON.stringify({ version: 2, id: message.id, result: { 'client#1': { platform: 'ios' } } }));
      }
      if (message.method === 'reload') sawReload();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');

  try {
    await expect(reloadIosThroughMetro(address.port)).resolves.toEqual({ ok: true, peers: 1 });
    await reloadSeen;
    expect(messages).toEqual([
      expect.objectContaining({ version: 2, method: 'getpeers', target: 'server' }),
      { version: 2, method: 'reload' },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Metro reload reports that no app is connected without broadcasting', async () => {
  const messages: unknown[] = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/message' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { id?: string; method?: string };
      messages.push(message);
      socket.send(JSON.stringify({ version: 2, id: message.id, result: {} }));
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');

  try {
    await expect(reloadIosThroughMetro(address.port)).resolves.toEqual({
      failed: true,
      peers: 0,
      reason: `No React Native app is connected to Metro on port ${address.port}.`,
    });
    expect(messages).toHaveLength(1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Metro reload tolerates the CLI 20 peer enumeration error when an app is connected', async () => {
  const messages: unknown[] = [];
  let sawReload!: () => void;
  const reloadSeen = new Promise<void>((resolve) => {
    sawReload = resolve;
  });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/message' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { id?: string; method?: string };
      messages.push(message);
      if (message.method === 'getpeers') {
        socket.send(
          JSON.stringify({
            version: 2,
            id: message.id,
            error: "TypeError: Cannot read properties of undefined (reading 'url')",
          }),
        );
      }
      if (message.method === 'reload') sawReload();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');

  try {
    await expect(reloadIosThroughMetro(address.port)).resolves.toEqual({ ok: true });
    await reloadSeen;
    expect(messages).toEqual([
      expect.objectContaining({ version: 2, method: 'getpeers', target: 'server' }),
      { version: 2, method: 'reload' },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
