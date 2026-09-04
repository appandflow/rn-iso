import { WebSocket } from 'ws';
import { getExecutor, type Executor } from '../exec.ts';

const TOOL_TIMEOUT_MS = 10_000;
const METRO_TIMEOUT_MS = 2_000;

export interface ReloadToolResult {
  ok?: true;
  failed?: true;
  reason?: string;
}

export interface MetroReloadResult extends ReloadToolResult {
  peers?: number;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function reloadAndroidJs(
  serial: string,
  packageName: string,
  { exec = getExecutor() }: { exec?: Executor } = {},
): ReloadToolResult {
  try {
    exec.runFile(
      'adb',
      ['-s', serial, 'shell', 'am', 'broadcast', '-a', `${packageName}.RELOAD_APP_ACTION`, '-p', packageName],
      { timeoutMs: TOOL_TIMEOUT_MS },
    );
    return { ok: true };
  } catch (error) {
    return { failed: true, reason: `adb could not reload ${packageName} on ${serial}: ${describe(error)}` };
  }
}

export function openIosDeepLink(
  udid: string,
  url: string,
  { exec = getExecutor() }: { exec?: Executor } = {},
): ReloadToolResult {
  try {
    exec.runFile('xcrun', ['simctl', 'openurl', udid, url], { timeoutMs: TOOL_TIMEOUT_MS });
    return { ok: true };
  } catch (error) {
    return { failed: true, reason: `simctl could not open ${url} on ${udid}: ${describe(error)}` };
  }
}

export function reloadIosOverlay(udid: string, { exec = getExecutor() }: { exec?: Executor } = {}): ReloadToolResult {
  try {
    exec.runFile('agent-device', ['press', 'label="Reload"', '--platform', 'ios', '--udid', udid], {
      timeoutMs: TOOL_TIMEOUT_MS,
    });
    return { ok: true };
  } catch {}
  return { failed: true, reason: `agent-device has no usable Reload overlay session for ${udid}.` };
}

export function reloadIosThroughMetro(
  port: number,
  { timeoutMs = METRO_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<MetroReloadResult> {
  return new Promise((resolve) => {
    const requestId = `stim-reload-${process.pid}-${Date.now()}`;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/message`);
    let settled = false;
    const finish = (result: MetroReloadResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ failed: true, reason: `Metro did not answer on port ${port}.` }),
      timeoutMs,
    );

    socket.once('open', () => {
      socket.send(JSON.stringify({ version: 2, method: 'getpeers', target: 'server', id: requestId }));
    });
    socket.on('message', (data) => {
      let message: { id?: unknown; result?: unknown; error?: unknown };
      try {
        message = JSON.parse(data.toString()) as { id?: unknown; result?: unknown; error?: unknown };
      } catch {
        return;
      }
      if (message.id !== requestId) return;
      if (message.result && typeof message.result === 'object') {
        const peers = Object.keys(message.result).length;
        if (peers === 0) {
          finish({ failed: true, peers, reason: `No React Native app is connected to Metro on port ${port}.` });
          return;
        }
        socket.send(JSON.stringify({ version: 2, method: 'reload' }));
        finish({ ok: true, peers });
        return;
      }
      if (
        typeof message.error === 'string' &&
        /Cannot read properties of undefined \(reading ['"]url['"]\)/.test(message.error)
      ) {
        // @react-native-community/cli-server-api 20 reads ws.upgradeReq.url while enumerating a connected peer.
        socket.send(JSON.stringify({ version: 2, method: 'reload' }));
        finish({ ok: true });
        return;
      }
      finish({ failed: true, reason: `Metro could not enumerate connected apps on port ${port}.` });
    });
    socket.once('error', (error) => finish({ failed: true, reason: `Metro reload failed: ${describe(error)}` }));
  });
}
