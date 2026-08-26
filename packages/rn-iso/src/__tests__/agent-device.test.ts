// engine/agent-device.js -- the remote device's control surface, asserted as
// exact argv and as an exact on-disk profile.
//
// Two invariants carry the security of this module and each has a test that
// fails loudly if it regresses:
//   1. The daemon token NEVER reaches disk. It travels as an env var on the
//      child, and the profile written next to it must not contain it.
//   2. The profile is written under <root>/.rn-iso/, never into the project.
import {
  DAEMON_TOKEN_ENV,
  connectArgs,
  daemonEnv,
  disconnectArgs,
  installArgs,
  isLoopbackDaemon,
  openArgs,
  remoteProfile,
  remoteProfilePath,
  sessionNameFor,
} from '../engine/agent-device.ts';

const DAEMON = { baseUrl: 'https://sim-42.eas.dev/daemon', token: 'tok_secret' };

describe('the connection profile', () => {
  test('never contains the token', () => {
    // ADR 0007: "Generated connection profiles are non-secret ... must strip
    // daemon and Metro bearer tokens." A profile is a plain file with no
    // special mode; a token in it outlives the command that needed it.
    const profile = remoteProfile({ daemon: DAEMON, platform: 'ios', label: 'wt' });
    const serialized = JSON.stringify(profile);
    expect(serialized).not.toContain('tok_secret');
    expect(serialized).not.toContain('AuthToken');
  });

  // Live-verified against agent-device 0.20.10 (CLAUDE.md item 9): a profile
  // without these two is refused with
  //   Error (INVALID_ARGS): connect requires tenant in remote config
  //   Error (INVALID_ARGS): connect requires runId in remote config
  // Neither is optional, and no mock would have caught their absence.
  test('carries the tenant and runId connect refuses to run without', () => {
    const profile = remoteProfile({ daemon: DAEMON, platform: 'ios', label: 'wt' });
    expect(profile.tenant).toBe('rn-iso-wt');
    expect(profile.runId).toBe('rn-iso-wt');
    // Metadata without this is not an isolation boundary.
    expect(profile.sessionIsolation).toBe('tenant');
  });

  test('scopes tenant and runId per workspace, so two worktrees never share a lease', () => {
    const a = remoteProfile({ daemon: DAEMON, platform: 'ios', label: 'wt-a' });
    const b = remoteProfile({ daemon: DAEMON, platform: 'ios', label: 'wt-b' });
    expect(a.tenant).not.toBe(b.tenant);
    expect(a.runId).not.toBe(b.runId);
  });

  test('runId is stable across runs of one workspace, so a re-run reuses its own lease', () => {
    // A fresh runId per invocation would leave the previous lease held until
    // its idle expiry, and `rn-iso ios` is idempotent by design.
    const first = remoteProfile({ daemon: DAEMON, platform: 'ios', label: 'wt' });
    const second = remoteProfile({ daemon: DAEMON, platform: 'ios', label: 'wt' });
    expect(first.runId).toBe(second.runId);
  });

  test('carries the routing agent-device needs to reach the daemon and Metro', () => {
    const profile = remoteProfile({ daemon: DAEMON, platform: 'ios', label: 'wt' });
    expect(profile).toMatchObject({
      daemonBaseUrl: 'https://sim-42.eas.dev/daemon',
      daemonTransport: 'http',
      platform: 'ios',
    });
    // Setting metroProjectRoot makes agent-device demand a bridge origin, and
    // the self-hosted proxy has no bridge. Metro stays rn-iso's problem.
    expect('metroProjectRoot' in profile).toBe(false);
  });

  test('the session name is per-workspace, so two worktrees never share one', () => {
    // A shared session name is how worktree A adopts worktree B's connection.
    expect(sessionNameFor('wt-a')).not.toBe(sessionNameFor('wt-b'));
    expect(remoteProfile({ daemon: DAEMON, platform: 'ios', label: 'wt' }).session).toBe(sessionNameFor('wt'));
  });

  test('lives under .rn-iso/, never in the project directory', () => {
    expect(remoteProfilePath('/work/app')).toBe('/work/app/.rn-iso/agent-device.remote.json');
  });
});

describe('the token travels as an environment variable', () => {
  test('daemonEnv uses the name agent-device and eas-cli both already use', () => {
    // eas-cli writes exactly this name in .env.eas-simulator
    // (simulator/utils.ts getRemoteSessionEnvironmentVariables).
    expect(DAEMON_TOKEN_ENV).toBe('AGENT_DEVICE_DAEMON_AUTH_TOKEN');
    expect(daemonEnv(DAEMON)).toEqual({ AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'tok_secret' });
  });
});

describe('argv', () => {
  const profilePath = '/work/app/.rn-iso/agent-device.remote.json';

  test('every command carries the profile, so none of them guess a connection', () => {
    // "Explicit command-line flags override connected defaults" -- an
    // agent-device call with no profile can adopt another workspace's ambient
    // connection, which is exactly the collision rn-iso exists to prevent.
    for (const args of [
      connectArgs(profilePath),
      installArgs(profilePath, '/tmp/My App.app'),
      openArgs(profilePath, 'com.example.app', null),
      disconnectArgs(profilePath),
    ]) {
      expect(args[args.indexOf('--remote-config') + 1]).toBe(profilePath);
    }
  });

  test('install passes the .app path as one literal argv element', () => {
    // A .app path with a space in it must reach the tool as one argument,
    // and the bundle id is not repeated: the .app already carries it.
    const args = installArgs(profilePath, '/tmp/My App.app');
    expect(args[0]).toBe('install');
    expect(args[1]).toBe('/tmp/My App.app');
  });

  test('open with a dev-client url passes it as the url positional', () => {
    // This is the whole reason rn-iso is not blocked by agent-device#1245:
    // `open <app> <url>` runs simctl openurl with the url verbatim, so
    // rn-iso's own expo-dev-client link works without the upstream fix.
    const url = 'myapp://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082';
    const args = openArgs(profilePath, 'com.example.app', url);
    expect(args[0]).toBe('open');
    expect(args[1]).toBe('com.example.app');
    expect(args[2]).toBe(url);
  });

  test('open without a url is a plain launch, not an empty url positional', () => {
    const args = openArgs(profilePath, 'com.example.app', null);
    expect(args[0]).toBe('open');
    expect(args[1]).toBe('com.example.app');
    expect(args).not.toContain('');
  });

  test('open relaunches, so a second rn-iso ios does not attach to a stale process', () => {
    expect(openArgs(profilePath, 'com.example.app', null)).toContain('--relaunch');
  });
});

describe('isLoopbackDaemon', () => {
  // The question behind Metro reachability: a loopback daemon drives a
  // simulator sharing THIS host's loopback, so `localhost:<port>` in the deep
  // link reaches rn-iso's own Metro. Anywhere else, localhost is that machine.
  test('loopback forms are this machine', () => {
    for (const url of ['http://127.0.0.1:4310', 'http://localhost:4310', 'http://[::1]:4310']) {
      expect(isLoopbackDaemon(url)).toBe(true);
    }
  });

  test('anything routable is another machine', () => {
    for (const url of [
      'https://sim-42.eas.dev/daemon',
      'https://x.trycloudflare.com/agent-device',
      'http://192.168.1.9:4310',
    ]) {
      expect(isLoopbackDaemon(url)).toBe(false);
    }
  });

  test('an unparseable url is not assumed local', () => {
    // Guessing "local" here would point a remote app at a Metro it cannot
    // reach and report the launch as fine.
    expect(isLoopbackDaemon('not a url')).toBe(false);
    expect(isLoopbackDaemon('')).toBe(false);
  });
});
