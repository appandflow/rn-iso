import { join } from 'node:path';
import { workspaceDir } from '../paths.ts';
import { sanitizeDeviceLabel } from '../sim/ios.ts';
import type { RemoteDaemon } from './eas-simulator.ts';

// agent-device and eas-cli share this token name. The token stays in the child environment.
export const DAEMON_TOKEN_ENV = 'AGENT_DEVICE_DAEMON_AUTH_TOKEN';

const PROFILE_FILE = 'agent-device.remote.json';

/** agent-device ADR 0007 requires generated profiles to omit bearer tokens. */
export interface RemoteProfile {
  daemonBaseUrl: string;
  daemonTransport: 'http';
  platform: 'ios' | 'android';
  session: string;
  tenant: string;
  runId: string;
  sessionIsolation: 'tenant';
}

export function sessionNameFor(label: string): string {
  return `stim-${sanitizeDeviceLabel(label)}`;
}

export function remoteProfilePath(root: string): string {
  return join(workspaceDir(root), PROFILE_FILE);
}

export function remoteProfile({
  daemon,
  platform,
  label,
}: {
  daemon: RemoteDaemon;
  platform: 'ios' | 'android';
  label: string;
}): RemoteProfile {
  const scope = sessionNameFor(label);
  // agent-device 0.20.10 requires metroProjectRoot to expose a bridge URL; the self-hosted proxy has none.
  // agent-device 0.20.10 requires tenant and runId in remote profiles.
  return {
    daemonBaseUrl: daemon.baseUrl,
    daemonTransport: 'http',
    platform,
    session: scope,
    tenant: scope,
    runId: scope,
    sessionIsolation: 'tenant',
  };
}

export function daemonEnv(daemon: RemoteDaemon): Record<string, string> {
  return { [DAEMON_TOKEN_ENV]: daemon.token };
}

function withProfile(profilePath: string, args: string[]): string[] {
  // Explicit profiles prevent agent-device from reusing another workspace's active connection.
  return [...args, '--remote-config', profilePath];
}

export function connectArgs(profilePath: string): string[] {
  // agent-device 0.20.10 rejects a changed daemon URL unless connect uses --force.
  return withProfile(profilePath, ['connect', '--force']);
}

export function installArgs(profilePath: string, artifactPath: string): string[] {
  return withProfile(profilePath, ['install', artifactPath]);
}

export function openArgs(
  profilePath: string,
  bundleId: string,
  url: string | null,
  metro: { host: string; port: string } | null = null,
): string[] {
  const positional = url ? [bundleId, url] : [bundleId];
  // The deep link bypasses https://github.com/callstack/agent-device/issues/1245 for Expo dev clients.
  const hint = metro ? ['--metro-host', metro.host, '--metro-port', metro.port] : [];
  return withProfile(profilePath, ['open', ...positional, '--relaunch', ...hint]);
}

export function metroHintFrom(origin: string): { host: string; port: string } | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  // agent-device writes RCT_jsLocation, so portless tunnels must override any stale Metro port.
  const port = url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '');
  return port ? { host: url.hostname, port } : null;
}

export function acceptAlertArgs(profilePath: string): string[] {
  // Fresh iOS simulators block the first app URL behind a confirmation alert.
  return withProfile(profilePath, ['alert', 'accept']);
}

export function disconnectArgs(profilePath: string): string[] {
  return withProfile(profilePath, ['disconnect']);
}

export function closeArgs(profilePath: string): string[] {
  // agent-device claims outlive leases, so close clears a prior workspace claim.
  return withProfile(profilePath, ['close']);
}

export function isLoopbackDaemon(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}
