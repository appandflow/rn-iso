// src/engine/agent-device.ts -- the remote device's control surface.
//
// Once a session exists (engine/eas-simulator.ts made it, or an operator ran
// `agent-device proxy`), everything rn-iso does to the device goes through
// the agent-device CLI pointed at that daemon. This module composes those
// calls; it never decides WHETHER the device is remote.
//
// The workflow is agent-device's own documented remote one:
//   connect --remote-config <profile>
//   install <bundleId> <path>
//   open <bundleId> [url] --relaunch
//   disconnect --remote-config <profile>
// `connect` is what defers and then performs Metro preparation, and
// `disconnect` is what "release[s] the lease and stop[s] the owned Metro
// companion". rn-iso therefore does NOT drive `metro prepare` itself: the
// companion tunnel that makes rn-iso's local Metro reachable from a cloud
// simulator is agent-device's to own, and a second driver would fight it.
//
// TWO INVARIANTS, both covered by tests that fail loudly:
//
// 1. THE TOKEN NEVER REACHES DISK. It travels as an env var on the child
//    process. agent-device's own ADR 0007 says the same thing about its
//    generated profiles -- "must strip daemon and Metro bearer tokens" --
//    and a profile is an ordinary file with no special mode, so a token
//    written there outlives the command that needed it.
//
// 2. THE PROFILE IS RN-ISO'S FILE. It lives in global workspace storage,
//    never in the project directory.
import { join } from 'node:path';
import { workspaceDir } from '../paths.ts';
import { sanitizeDeviceLabel } from '../sim/ios.ts';
import type { RemoteDaemon } from './eas-simulator.ts';

// The name agent-device reads a token from, and the name eas-cli writes into
// .env.eas-simulator (simulator/utils.ts,
// getRemoteSessionEnvironmentVariables). The two agreeing is what lets one
// backend serve EAS Simulator and a self-hosted proxy unchanged.
export const DAEMON_TOKEN_ENV = 'AGENT_DEVICE_DAEMON_AUTH_TOKEN';

const PROFILE_FILE = 'agent-device.remote.json';

/** The non-secret half of a connection: routing only, per ADR 0007. */
export interface RemoteProfile {
  daemonBaseUrl: string;
  daemonTransport: 'http';
  platform: 'ios' | 'android';
  session: string;
  tenant: string;
  runId: string;
  sessionIsolation: 'tenant';
}

// PURE. agent-device's session name for this workspace.
//
// Per-workspace by construction. agent-device's docs are explicit that a
// flagless command "can reuse active connection state", so two worktrees
// sharing a session name is how one of them adopts the other's connection --
// the same collision rn-iso's port and device ownership exist to prevent.
export function sessionNameFor(label: string): string {
  return `rn-iso-${sanitizeDeviceLabel(label)}`;
}

// PURE. Where rn-iso keeps the profile: its own directory, not the project's.
export function remoteProfilePath(root: string): string {
  return join(workspaceDir(root), PROFILE_FILE);
}

// PURE. The profile, with no credential in it.
//
// `daemonTransport: 'http'` is stated rather than left to discovery: a remote
// daemon is reached over HTTP by definition, and socket discovery against a
// remote URL is a wasted probe on every command.
//
// `tenant` and `runId` are REQUIRED by `agent-device connect --remote-config`,
// which refuses with INVALID_ARGS when either is absent. Both are the
// workspace label because the workspace is genuinely both things here: it is
// the isolation boundary (worktree A must not adopt worktree B's lease) and
// it has exactly one live run at a time.
//
// Deriving runId from the workspace rather than minting a fresh one per
// invocation is deliberate. `rn-iso ios` is idempotent, and a new runId each
// time would leave the previous lease held until its idle expiry, so a
// re-run would contend with itself.
//
// `sessionIsolation: 'tenant'` is what makes the tenant scoping apply rather
// than being metadata.
//
// NO `metroProjectRoot`, deliberately. Setting it makes agent-device treat
// Metro as its to prepare and then refuse without a bridge origin:
//   INVALID_ARGS: Deferred Metro preparation requires metroPublicBaseUrl or
//   metroProxyBaseUrl when Metro settings are provided.
// rn-iso already owns Metro, and the self-hosted `agent-device proxy` serves
// no bridge at all (`/api/metro/bridge` is a 404 there; its routes are
// /health, /rpc, /upload and /artifacts). Both facts were established against
// agent-device 0.20.10. Metro reachability is therefore rn-iso's problem, and
// it is solved in device-remote.ts by choosing the deep link's host.
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

// PURE. The env additions a child agent-device call needs.
export function daemonEnv(daemon: RemoteDaemon): Record<string, string> {
  return { [DAEMON_TOKEN_ENV]: daemon.token };
}

// Every argv below carries --remote-config. agent-device falls back to an
// "active connection" when a command has no explicit selectors, which in a
// repo with several worktrees means adopting a connection that belongs to a
// different one.
function withProfile(profilePath: string, args: string[]): string[] {
  return [...args, '--remote-config', profilePath];
}

// PURE. Establish the connection.
//
// `--force` is required, not defensive. rn-iso rewrites the profile on every
// run, and a remote session hands back a different daemon URL each time, so
// the second run of a workspace hits
//   INVALID_ARGS: Active remote connection config changed.
//   Run agent-device connect --force to refresh it.
// Verified against agent-device 0.20.10.
export function connectArgs(profilePath: string): string[] {
  return withProfile(profilePath, ['connect', '--force']);
}

// PURE. Push a locally-built artifact to the remote device.
//
// The one-positional form (`install <path>`, as opposed to
// `install <app> <path>`) is deliberate: a `.app` carries its own bundle id,
// so naming it again would be a second source of truth for the same fact.
// It also keeps this signature identical to the local installIosApp, which
// is what lets the remote path drop into the existing dep seam unchanged.
//
// The path is its own argv element, so a `.app` under a directory with a
// space in it arrives as one argument. Against a remote daemon the client
// uploads the file and the daemon materializes it
// (src/daemon/install-source-resolution.ts, the `path` + uploadedArtifactId
// branch), which is why a local build needs no public URL and no EAS Build.
export function installArgs(profilePath: string, artifactPath: string): string[] {
  return withProfile(profilePath, ['install', artifactPath]);
}

// PURE. Launch, optionally via a deep link.
//
// `open <app> <url>` runs `simctl openurl` with the URL verbatim
// (platforms/apple/core/app-launch.ts). That is what lets rn-iso pass its own
// expo-dev-client link and sidestep callstack/agent-device#1245, where
// agent-device's Metro hint writes only bare-RN's RCT_jsLocation and a
// dev-client ignores it.
//
// `--relaunch` because rn-iso's contract is that `ios` produces a freshly
// launched app on this workspace's Metro. Attaching to a process left over
// from a previous run would report success while running an older bundle.
export function openArgs(
  profilePath: string,
  bundleId: string,
  url: string | null,
  metro: { host: string; port: string } | null = null,
): string[] {
  const positional = url ? [bundleId, url] : [bundleId];
  // The bare-RN half of Contract 6. A dev-client app is pointed by the deep
  // link above; a bare RN app reads RCT_jsLocation, which locally rn-iso
  // writes itself with `simctl spawn defaults write`. It cannot do that on a
  // device it has no simctl for, so agent-device's own hint carries it --
  // these two flags are exactly that write, and they are correct here because
  // the thing they do not reach is expo-dev-client (#1245), which rn-iso is
  // already handling with its own URL.
  //
  // Without this a remote bare-RN app asks for the compiled-in default 8081,
  // never reaches this workspace's reserved port, and the run reports
  // UNVERIFIED. Observed live before the flags were added.
  const hint = metro ? ['--metro-host', metro.host, '--metro-port', metro.port] : [];
  return withProfile(profilePath, ['open', ...positional, '--relaunch', ...hint]);
}

// PURE. Split a Metro origin into the host and port agent-device's hint flags
// take, defaulting the port FROM THE SCHEME when the URL omits it.
//
// The default is not a convenience, it is the fix for a live failure. A
// tunnel URL is normally portless (`https://x.trycloudflare.com`), and
// returning null for it sent no hint at all -- which left whatever
// RCT_jsLocation already held on the device in charge. The app then composed
// the tunnel's HOST with a stale local PORT and asked for
//
//   https://x.trycloudflare.com:8085/index.ts.bundle
//
// which can never resolve: the tunnel listens on 443. Observed on a real EAS
// simulator, and it survived passing `:443` in the deep link, because
// RCTBundleURLProvider prefers RCT_jsLocation over the launch URL
// (packagerServerHostPort, line 267). Naming the port explicitly is what
// takes that decision away from the device.
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

// PURE. Accept the alert that OUR OWN url open just raised.
//
// iOS asks "Open in <app>?" the first time a URL is opened into an app on a
// simulator, and a cloud simulator is always a fresh one -- so a remote
// dev-client launch lands behind that alert every single time. The bundle is
// never requested until someone answers it, which made `verify` report
// UNVERIFIED on a launch that was in fact fine, on every remote run.
//
// Safe to accept without reading it: this runs immediately after rn-iso's own
// `open <app> <url>`, so the alert in front of us is the one that open just
// caused. Best-effort at the call site -- no alert is the normal case on a
// bare-RN launch, and on a device that never shows one this is a no-op.
export function acceptAlertArgs(profilePath: string): string[] {
  return withProfile(profilePath, ['alert', 'accept']);
}

// PURE. Release the lease and stop the Metro companion this workspace owns.
export function disconnectArgs(profilePath: string): string[] {
  return withProfile(profilePath, ['disconnect']);
}

// PURE. End the device session, releasing its claim on the device.
//
// Run BEFORE connect, best-effort. agent-device holds a device claim per
// session that outlives both the lease and the daemon (it is a file under
// ~/.agent-device/device-claims). rn-iso deliberately leaves the app running
// when `ios` finishes, so it never reaches a natural close, and the next run
// then fails one of two ways depending on timing:
//   DEVICE_IN_USE: Device is already in use by session "<name>"
//   UNAUTHORIZED:  Lease does not match session owner (leaseId)
// Both observed live. Closing first makes a re-run idempotent, which is the
// contract `rn-iso ios` already promises.
export function closeArgs(profilePath: string): string[] {
  return withProfile(profilePath, ['close']);
}

// PURE. Is this daemon on the machine rn-iso is running on?
//
// The whole question behind Metro reachability. A loopback daemon drives a
// simulator that shares THIS host's loopback, so the app can be pointed at
// `localhost:<reserved port>` and reach rn-iso's own Metro. Any other daemon
// is on another machine, where `localhost` is that machine.
export function isLoopbackDaemon(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}
