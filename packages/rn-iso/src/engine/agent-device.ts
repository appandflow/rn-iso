import { join } from 'node:path';
import { workspaceDir } from '../paths.ts';
import { sanitizeDeviceLabel } from '../sim/ios.ts';
import type { RemoteDaemon } from './eas-simulator.ts';

export const DAEMON_TOKEN_ENV = 'AGENT_DEVICE_DAEMON_AUTH_TOKEN';

const PROFILE_FILE = 'agent-device.remote.json';

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
  return `rn-iso-${sanitizeDeviceLabel(label)}`;
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
  return [...args, '--remote-config', profilePath];
}

export function connectArgs(profilePath: string): string[] {
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
  const port = url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '');
  return port ? { host: url.hostname, port } : null;
}

export function acceptAlertArgs(profilePath: string): string[] {
  return withProfile(profilePath, ['alert', 'accept']);
}

export function disconnectArgs(profilePath: string): string[] {
  return withProfile(profilePath, ['disconnect']);
}

export function closeArgs(profilePath: string): string[] {
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
