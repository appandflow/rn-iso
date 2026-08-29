import {
  DAEMON_TOKEN_ENV,
  closeArgs,
  connectArgs,
  daemonEnv,
  disconnectArgs,
  installArgs,
  isLoopbackDaemon,
  metroHintFrom,
  openArgs,
  remoteProfile,
  remoteProfilePath,
  sessionNameFor,
} from '../engine/agent-device.ts';

const DAEMON = { baseUrl: 'https://sim-42.eas.dev/daemon', token: 'tok_secret' };

describe('the connection profile', () => {
  test('never contains the token', () => {
    const profile = remoteProfile({ daemon: DAEMON, platform: 'ios', label: 'wt' });
    const serialized = JSON.stringify(profile);
    expect(serialized).not.toContain('tok_secret');
    expect(serialized).not.toContain('AuthToken');
  });

  test('carries the tenant and runId connect refuses to run without', () => {
    const profile = remoteProfile({ daemon: DAEMON, platform: 'ios', label: 'wt' });
    expect(profile.tenant).toBe('stim-cli-wt');
    expect(profile.runId).toBe('stim-cli-wt');
    expect(profile.sessionIsolation).toBe('tenant');
  });

  test('scopes tenant and runId per workspace, so two worktrees never share a lease', () => {
    const a = remoteProfile({ daemon: DAEMON, platform: 'ios', label: 'wt-a' });
    const b = remoteProfile({ daemon: DAEMON, platform: 'ios', label: 'wt-b' });
    expect(a.tenant).not.toBe(b.tenant);
    expect(a.runId).not.toBe(b.runId);
  });

  test('runId is stable across runs of one workspace, so a re-run reuses its own lease', () => {
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
    expect('metroProjectRoot' in profile).toBe(false);
  });

  test('the session name is per-workspace, so two worktrees never share one', () => {
    expect(sessionNameFor('wt-a')).not.toBe(sessionNameFor('wt-b'));
    expect(remoteProfile({ daemon: DAEMON, platform: 'ios', label: 'wt' }).session).toBe(sessionNameFor('wt'));
  });

  test('lives in global workspace storage, never in the project directory', () => {
    const previous = process.env.STIM_CLI_HOME;
    process.env.STIM_CLI_HOME = '/stim-cli-home';
    try {
      expect(remoteProfilePath('/work/app')).toMatch(
        /^\/stim-cli-home\/workspaces\/app--[a-f0-9]{16}\/agent-device\.remote\.json$/,
      );
    } finally {
      if (previous === undefined) delete process.env.STIM_CLI_HOME;
      else process.env.STIM_CLI_HOME = previous;
    }
  });
});

describe('the token travels as an environment variable', () => {
  test('daemonEnv uses the name agent-device and eas-cli both already use', () => {
    expect(DAEMON_TOKEN_ENV).toBe('AGENT_DEVICE_DAEMON_AUTH_TOKEN');
    expect(daemonEnv(DAEMON)).toEqual({ AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'tok_secret' });
  });
});

describe('argv', () => {
  const profilePath = '/work/app/.stim-cli/agent-device.remote.json';

  test('every command carries the profile, so none of them guess a connection', () => {
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
    const args = installArgs(profilePath, '/tmp/My App.app');
    expect(args[0]).toBe('install');
    expect(args[1]).toBe('/tmp/My App.app');
  });

  test('open with a dev-client url passes it as the url positional', () => {
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

  test('open relaunches, so a second stim ios does not attach to a stale process', () => {
    expect(openArgs(profilePath, 'com.example.app', null)).toContain('--relaunch');
  });
});

describe('isLoopbackDaemon', () => {
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
    expect(isLoopbackDaemon('not a url')).toBe(false);
    expect(isLoopbackDaemon('')).toBe(false);
  });
});

describe('the bare-RN Metro hint', () => {
  const profilePath = '/w/.stim-cli/agent-device.remote.json';

  test('open carries the host and port a bare RN app reads', () => {
    const args = openArgs(profilePath, 'com.example.app', null, { host: 'localhost', port: '8085' });
    expect(args[args.indexOf('--metro-host') + 1]).toBe('localhost');
    expect(args[args.indexOf('--metro-port') + 1]).toBe('8085');
  });

  test('no hint is sent when there is none to send', () => {
    expect(openArgs(profilePath, 'com.example.app', null, null)).not.toContain('--metro-host');
  });

  test('metroHintFrom splits an origin with an explicit port', () => {
    expect(metroHintFrom('http://localhost:8085')).toEqual({ host: 'localhost', port: '8085' });
  });

  test('a portless origin takes its port from the scheme', () => {
    expect(metroHintFrom('https://abc.trycloudflare.com')).toEqual({ host: 'abc.trycloudflare.com', port: '443' });
    expect(metroHintFrom('http://abc.example.com')).toEqual({ host: 'abc.example.com', port: '80' });
  });

  test('an unparseable origin yields no hint', () => {
    expect(metroHintFrom('not a url')).toBeNull();
  });
});

describe('closeArgs', () => {
  test('closes through the profile, so it targets this workspace session', () => {
    const args = closeArgs('/w/.stim-cli/agent-device.remote.json');
    expect(args[0]).toBe('close');
    expect(args[args.indexOf('--remote-config') + 1]).toBe('/w/.stim-cli/agent-device.remote.json');
  });
});
