// engine/eas-simulator.js -- the `eas sim` session, asserted as exact argv
// and against eas-cli's real JSON shapes.
//
// The shapes below are eas-cli's own, read from source rather than guessed:
//   commands/simulator/index.ts  printJsonOnlyOutput({id, name, type,
//                                deviceRunSessionUrl, remoteConfig})
//   simulator/utils.ts           AgentDeviceRunSessionRemoteConfig carries
//                                agentDeviceRemoteSessionUrl / ...Token
//   commands/simulator/list.ts   printJsonOnlyOutput({sessions, pageInfo})
//   commands/simulator/stop.ts   printJsonOnlyOutput({id, status})
import type { Executor } from '../exec.ts';
import {
  createSessionArgs,
  getSessionArgs,
  inspectSessionForTeardown,
  isDefinitiveMissingSessionError,
  isOwnedSessionName,
  listOwnedSessionsArgs,
  ownedSessionName,
  parseCreatedSession,
  parseSessionList,
  parseStoppedSession,
  remoteDaemonFrom,
  stopSessionArgs,
} from '../engine/eas-simulator.ts';

// eas-cli emits pure JSON on stdout under --json; every non-JSON message goes
// to stderr. These fixtures are therefore whole-stdout, not fragments.
const AGENT_DEVICE_CONFIG = {
  __typename: 'AgentDeviceRunSessionRemoteConfig',
  agentDeviceRemoteSessionUrl: 'https://sim-42.eas.dev/daemon',
  agentDeviceRemoteSessionToken: 'tok_secret',
  webPreviewUrl: 'https://expo.dev/preview/42',
};

function recordingExec(outputs: Record<string, string> = {}): Executor & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runFile(file: string, args: string[] = []) {
      calls.push([file, ...args]);
      const key = [file, ...args].join(' ');
      for (const [match, value] of Object.entries(outputs)) {
        if (key.includes(match)) return value;
      }
      return '';
    },
    run() {
      throw new Error('eas-simulator must use runFile, not the shell');
    },
    runQuiet() {
      throw new Error('eas-simulator must use runFile, not the shell');
    },
    spawn() {
      throw new Error('eas-simulator does not spawn');
    },
  };
}

describe('ownership by session name', () => {
  test('a session is named rn-iso-<label>, the marker every destructive path checks', () => {
    expect(ownedSessionName('my-worktree')).toBe('rn-iso-my-worktree');
  });

  test('a label that already carries the prefix is not doubled', () => {
    expect(ownedSessionName('rn-iso-test')).toBe('rn-iso-test');
  });

  test('a label with characters eas would reject is sanitized', () => {
    expect(ownedSessionName('feat/my thing')).toBe('rn-iso-feat-my-thing');
  });

  test('isOwnedSessionName refuses anything without the prefix', () => {
    expect(isOwnedSessionName('rn-iso-a')).toBe(true);
    expect(isOwnedSessionName('someone-elses-session')).toBe(false);
    expect(isOwnedSessionName(undefined)).toBe(false);
  });
});

describe('stored-session teardown authorization', () => {
  test('authorizes an owned live session', () => {
    expect(
      inspectSessionForTeardown(JSON.stringify({ id: 'drs_42', name: 'rn-iso-wt', status: 'IN_PROGRESS' }), 'drs_42'),
    ).toEqual({ action: 'stop', name: 'rn-iso-wt', status: 'IN_PROGRESS' });
  });

  test('refuses an unowned live session', () => {
    const result = inspectSessionForTeardown(
      JSON.stringify({ id: 'drs_42', name: 'other-tool', status: 'IN_PROGRESS' }),
      'drs_42',
    );
    expect(result.action).toBe('refused');
    if (result.action === 'refused') expect(result.reason).toContain('not owned by rn-iso');
  });

  test.each(['STOPPED', 'ERRORED'])('treats verified terminal status %s as already stopped', (status) => {
    expect(inspectSessionForTeardown(JSON.stringify({ id: 'drs_42', name: 'rn-iso-wt', status }), 'drs_42')).toEqual({
      action: 'already-stopped',
      name: 'rn-iso-wt',
      status,
    });
  });

  test.each([
    ['another tool', 'other-tool'],
    ['no name', undefined],
  ])('refuses a terminal session owned by %s', (_owner, name) => {
    const result = inspectSessionForTeardown(JSON.stringify({ id: 'drs_42', name, status: 'STOPPED' }), 'drs_42');
    expect(result.action).toBe('refused');
    if (result.action === 'refused') expect(result.reason).toContain('not owned by rn-iso');
  });

  test('refuses malformed output', () => {
    const result = inspectSessionForTeardown('not json', 'drs_42');
    expect(result.action).toBe('refused');
    if (result.action === 'refused') expect(result.reason).toContain('valid JSON');
  });

  test('refuses a response for a different session', () => {
    const result = inspectSessionForTeardown(
      JSON.stringify({ id: 'drs_other', name: 'rn-iso-wt', status: 'IN_PROGRESS' }),
      'drs_42',
    );
    expect(result.action).toBe('refused');
    if (result.action === 'refused') expect(result.reason).toContain('drs_other');
  });

  test('refuses an unknown status', () => {
    const result = inspectSessionForTeardown(
      JSON.stringify({ id: 'drs_42', name: 'rn-iso-wt', status: 'PAUSED' }),
      'drs_42',
    );
    expect(result.action).toBe('refused');
    if (result.action === 'refused') expect(result.reason).toContain('PAUSED');
  });
});

describe('definitive missing-session errors', () => {
  test('accepts a simulator-specific not-found result', () => {
    expect(isDefinitiveMissingSessionError({ stderr: 'Device run session drs_42 was not found.' }, 'drs_42')).toBe(
      true,
    );
  });

  test.each([
    'request failed: getaddrinfo ENOTFOUND api.expo.dev',
    'Authentication failed. Log in to EAS.',
    'The request timed out.',
    'Device run session drs_other was not found.',
    'Device run session drs_other was not found. Command: eas simulator:get --id drs_42',
    'Failed to fetch simulator session drs_42.\nProject project_9 was not found.',
    'Command target: device run session drs_42.\nRequested resource does not exist.',
  ])('fails closed for %s', (stderr) => {
    expect(isDefinitiveMissingSessionError({ stderr }, 'drs_42')).toBe(false);
  });
});

describe('createSessionArgs', () => {
  test('never writes .env.eas-simulator into the project', () => {
    const args = createSessionArgs({ label: 'wt', platform: 'ios' });
    // --out-config-type env makes eas PRINT the config instead of writing a
    // dotenv into the project dir, which it does even under --json.
    const i = args.indexOf('--out-config-type');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('env');
  });

  test('is non-interactive and json, so it returns instead of blocking', () => {
    const args = createSessionArgs({ label: 'wt', platform: 'ios' });
    expect(args).toContain('--json');
    expect(args).toContain('--non-interactive');
  });

  test('carries the ownership name and the platform', () => {
    const args = createSessionArgs({ label: 'wt', platform: 'ios' });
    expect(args.slice(0, 3)).toEqual(['sim', '--platform', 'ios']);
    expect(args[args.indexOf('--name') + 1]).toBe('rn-iso-wt');
  });

  test('omits --max-duration-minutes unless one was chosen', () => {
    expect(createSessionArgs({ label: 'wt', platform: 'ios' })).not.toContain('--max-duration-minutes');
    const bounded = createSessionArgs({ label: 'wt', platform: 'ios', maxDurationMinutes: 30 });
    expect(bounded[bounded.indexOf('--max-duration-minutes') + 1]).toBe('30');
  });
});

describe('parseCreatedSession', () => {
  test('reads the id, name and daemon out of a real create payload', () => {
    const stdout = JSON.stringify({
      id: 'drs_42',
      name: 'rn-iso-wt',
      type: 'agent-device',
      deviceRunSessionUrl: 'https://expo.dev/accounts/a/projects/p/simulators/drs_42',
      remoteConfig: AGENT_DEVICE_CONFIG,
    });
    expect(parseCreatedSession(stdout)).toEqual({
      id: 'drs_42',
      name: 'rn-iso-wt',
      url: 'https://expo.dev/accounts/a/projects/p/simulators/drs_42',
      daemon: {
        baseUrl: 'https://sim-42.eas.dev/daemon',
        token: 'tok_secret',
        webPreviewUrl: 'https://expo.dev/preview/42',
      },
    });
  });

  test('a session with no id yet is not a session', () => {
    expect(parseCreatedSession(JSON.stringify({ name: 'rn-iso-wt' }))).toBeNull();
  });

  test('unparseable output is null, never a throw', () => {
    expect(parseCreatedSession('Checking availability...')).toBeNull();
    expect(parseCreatedSession('')).toBeNull();
  });
});

describe('remoteDaemonFrom', () => {
  test('extracts the two values rn-iso needs from an agent-device session', () => {
    expect(remoteDaemonFrom(AGENT_DEVICE_CONFIG)).toEqual({
      baseUrl: 'https://sim-42.eas.dev/daemon',
      token: 'tok_secret',
      webPreviewUrl: 'https://expo.dev/preview/42',
    });
  });

  test('refuses a session of another type rather than half-reading it', () => {
    // rn-iso drives agent-device. An appium or argent session is a real
    // session that this backend cannot speak to, so it must not look usable.
    expect(remoteDaemonFrom({ __typename: 'AppiumRunSessionRemoteConfig', appiumUrl: 'x' })).toBeNull();
    expect(remoteDaemonFrom(null)).toBeNull();
    expect(remoteDaemonFrom(undefined)).toBeNull();
  });

  test('a config missing its token is unusable, not partially usable', () => {
    expect(
      remoteDaemonFrom({
        __typename: 'AgentDeviceRunSessionRemoteConfig',
        agentDeviceRemoteSessionUrl: 'https://x',
      }),
    ).toBeNull();
  });
});

describe('parseSessionList', () => {
  test('reads the sessions array', () => {
    const stdout = JSON.stringify({
      sessions: [
        { id: 'a', name: 'rn-iso-one', status: 'IN_PROGRESS', platform: 'IOS' },
        { id: 'b', name: 'someone-else', status: 'NEW', platform: 'IOS' },
      ],
      pageInfo: {},
    });
    expect(parseSessionList(stdout)).toEqual([
      { id: 'a', name: 'rn-iso-one', status: 'IN_PROGRESS', platform: 'IOS' },
      { id: 'b', name: 'someone-else', status: 'NEW', platform: 'IOS' },
    ]);
  });

  test('an empty or unparseable list is an empty array, never a throw', () => {
    expect(parseSessionList(JSON.stringify({ sessions: [] }))).toEqual([]);
    expect(parseSessionList('nope')).toEqual([]);
  });

  test('a session with no id is dropped rather than carried as a partial record', () => {
    const stdout = JSON.stringify({ sessions: [{ name: 'rn-iso-x' }, { id: 'ok', name: 'rn-iso-y' }] });
    expect(parseSessionList(stdout).map((s) => s.id)).toEqual(['ok']);
  });
});

describe('the read and destroy argv', () => {
  test('getSessionArgs asks for one session as json', () => {
    expect(getSessionArgs('drs_42')).toEqual(['simulator:get', '--id', 'drs_42', '--json', '--non-interactive']);
  });

  test('stopSessionArgs names the session explicitly, never the ambient dotenv', () => {
    // stop defaults to .env.eas-simulator when --id is absent, which would
    // reach for whatever session that file names -- possibly another
    // workspace's.
    expect(stopSessionArgs('drs_42')).toEqual(['simulator:stop', '--id', 'drs_42', '--json', '--non-interactive']);
  });

  test('listOwnedSessionsArgs asks only for live rn-iso sessions', () => {
    const args = listOwnedSessionsArgs();
    expect(args[args.indexOf('--name') + 1]).toBe('rn-iso-');
    expect(args).toContain('--status');
    expect(args).toContain('new');
    expect(args).toContain('in-progress');
  });

  test('parseStoppedSession reports the status eas confirmed', () => {
    expect(parseStoppedSession(JSON.stringify({ id: 'drs_42', status: 'STOPPED' }))).toEqual({
      id: 'drs_42',
      status: 'STOPPED',
    });
    expect(parseStoppedSession('boom')).toBeNull();
  });
});

describe('the executor seam', () => {
  test('every eas call runs through runFile, in the project directory', () => {
    // eas sim resolves its project from cwd and takes no positional for it,
    // unlike `expo config --json <root>`.
    const exec = recordingExec();
    exec.runFile('/bin/eas', createSessionArgs({ label: 'wt', platform: 'ios' }), { cwd: '/work/app' });
    expect(exec.calls[0]?.[0]).toBe('/bin/eas');
    expect(exec.calls[0]?.[1]).toBe('sim');
  });
});

describe('the shape eas sim actually prints', () => {
  // VERBATIM from a live `eas sim --platform ios --json` against appandflow.
  // The point of this fixture is what it does NOT have: __typename. That
  // field exists on eas-cli's in-memory GraphQL object, which is what its own
  // source switches on, but printJsonOnlyOutput does not serialize it.
  // Requiring it rejected every real session -- the bug this pins.
  const LIVE = JSON.stringify({
    id: '01a03fb5-c9f7-7403-8810-712f74e6cafc',
    name: 'rn-iso endpoint probe',
    type: 'agent-device',
    deviceRunSessionUrl: 'https://expo.dev/accounts/appandflow/projects/rniso-eas-test/simulator-sessions/01a03fb5',
    remoteConfig: {
      agentDeviceRemoteSessionUrl: 'https://agent-device-a8bf16d9.eas-simulator.ngrok.dev',
      agentDeviceRemoteSessionToken: '9ec138b696c76c29e4d5987770d1febf78445771e3295063',
      webPreviewUrl: 'https://web-preview-a883570a.eas-simulator.ngrok.dev',
    },
  });

  test('a real payload yields a usable daemon', () => {
    const created = parseCreatedSession(LIVE);
    expect(created?.id).toBe('01a03fb5-c9f7-7403-8810-712f74e6cafc');
    expect(created?.daemon).toEqual({
      baseUrl: 'https://agent-device-a8bf16d9.eas-simulator.ngrok.dev',
      token: '9ec138b696c76c29e4d5987770d1febf78445771e3295063',
      webPreviewUrl: 'https://web-preview-a883570a.eas-simulator.ngrok.dev',
    });
  });

  test('__typename is honoured when present but never required', () => {
    // A caller reading the GraphQL object directly still gets the strict
    // answer; a caller reading the CLI's JSON is not punished for its absence.
    expect(
      remoteDaemonFrom({
        __typename: 'AppiumRunSessionRemoteConfig',
        agentDeviceRemoteSessionUrl: 'https://x',
        agentDeviceRemoteSessionToken: 't',
      }),
    ).toBeNull();
    expect(remoteDaemonFrom({ agentDeviceRemoteSessionUrl: 'https://x', agentDeviceRemoteSessionToken: 't' })).toEqual({
      baseUrl: 'https://x',
      token: 't',
    });
  });

  test('another session type has neither field, so it is still refused', () => {
    expect(remoteDaemonFrom({ appiumUrl: 'https://x', capabilities: {} })).toBeNull();
  });
});
