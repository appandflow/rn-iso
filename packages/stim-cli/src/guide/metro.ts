export default {
  summary: 'The dev server: `stim start`, the supervisor, and starting your own',
  body: () => `THE DEV SERVER

  stim start
  stim start --remote   # prepare Metro for a remote device

Reserves (or reuses) this workspace's Metro port, starts the dev server under a
detached SUPERVISOR, and waits until it both answers AND verifies as this
project's before exiting. You get your shell back with a bundler running: no
backgrounding idiom, no sleep, no poll loop, and no chance of building against
another worktree's bundler.

  --json            one line of facts on stdout, everything else on stderr:
                      { port, supervisorPid, mode, logsDir, alreadyRunning }
  --wait <seconds>  how long to wait for server and remote tunnel readiness
                    (default 60 for each)
  --remote          expose Metro for a remote device

Plain \`stim start\` is local and does not create a public tunnel. Remote intent
comes from \`start --remote\`, \`ios.remote\`, or \`android.remote\`. The
\`metro.tunnel\` setting selects the provider after remote intent exists.

REMOTE DEVICE BACKENDS
  Metro exposure and device selection are separate:

    stim start --remote          prepare public Metro
    stim ios --remote proxy      use an agent-device daemon
    stim android --remote eas    create an EAS Simulator session

  The command or the matching ios.remote/android.remote setting selects the
  backend. Environment variables never select the backend.

  The proxy backend connects to an agent-device daemon on another machine. It
  requires AGENT_DEVICE_DAEMON_BASE_URL and
  AGENT_DEVICE_DAEMON_AUTH_TOKEN. Stim creates no remote session for it.

  The EAS backend needs eas-cli and an account with EAS Simulator access. An
  EAS session is billable. EAS does not inherit the proxy credentials. Always
  tear the session down: \`stop\`, \`worktree remove\`, and \`gc --delete\`
  can end sessions that Stim proves it owns.

IDEMPOTENT
  A healthy dev server on the reserved port is a no-op: \`start\` prints the
  facts with alreadyRunning: true and starts nothing. A foreign process holding
  the reserved port moves the RESERVATION instead, so the project is never
  stranded on a port it can never use.

WHAT THE SUPERVISOR IS
  One detached process per workspace. There is no machine-wide daemon, nothing
  to install, and no cross-project state. It hosts the dev server, writes its
  output as NDJSON into the global workspace logs directory
  ($STIM_HOME/workspaces/<project>--<digest>/logs; see \`guide logs\`), and
  records itself in that workspace's state.json before it starts serving. Two modes,
  chosen by ecosystem detection:

    bare-inproc  bare React Native: Metro is hosted INSIDE the supervisor,
                 from the project's own node_modules, with Stim's reporter
                 attached. Bundler events, in-app console logs and redboxes
                 all arrive structured.
    expo-child   Expo: the project's own \`expo start --port <port>\` runs as
                 a child and its stdout is parsed into records. Levels are
                 INFERRED from each line, so those records carry raw: true.

  In expo-child mode, remote intent plus metro.tunnel "expo" makes \`start\` pass
  \`--tunnel\` and EXPO_UNSTABLE_TUNNEL_V2=1 (the legacy ws-tunnel path is
  locked to port 8081, which every reserved port but the first collides with)
  and records the URL Expo reports under state.json's metroTunnel. This has to
  happen here: \`ios --remote <proxy|eas>\` / \`android --remote <proxy|eas>\`
  cannot add \`--tunnel\` to
  an already-running dev server. A later \`start --remote\` refuses with a
  stop-and-restart remedy when a healthy local Expo supervisor has no recorded
  Expo tunnel. See \`guide settings\` for metro.tunnel.

  \`stim status\` reports the pid, the mode, and whether it is answering.
  \`stim stop\` is the inverse of \`start\`: it halts the supervisor, reaps
  the device-log collectors, shuts the owned device down (never deletes it)
  and frees the port.

  ENVIRONMENT: the supervisor -- and through it the dev server, including a
  metro.config.js evaluated inside the expo child -- inherits the environment
  of the \`start\` call that SPAWNED it. A later \`start\` that finds a healthy
  supervisor is a no-op and cannot change a running supervisor's env: to apply
  a new env var, \`stop\` first, then \`start\` with it set.

  The supervisor's own stdio goes to the global workspace logs/supervisor.log, which is NOT
  part of the NDJSON timeline. It is what a supervisor that died before it
  could write a structured record leaves behind. In expo-child mode the child's
  output is parsed into the TIMELINE instead, so a dev server that dies on a
  config error leaves supervisor.log empty and its death cry in metro.ndjson.
  A failed \`start\` quotes both for you: the supervisor.log tail when it has
  one, and this attempt's error records from the timeline.

STARTING YOUR OWN BUNDLER STILL WORKS
  A dev server YOU started is detected and left alone: \`start\` reports it
  with supervisorPid: null and mode: null, exits 0, and starts nothing over it.
  Starting a second bundler on a working one is the actual failure. For
  \`start --remote\`, an external Expo server also needs metro.publicUrl because
  Stim cannot add Expo tunnel mode to a process it does not supervise.

  Start it from INSIDE the project directory, on the reserved port, or nothing
  can attribute it to you:

    Expo                      npx expo start --port <port>
    Bare React Native         npx react-native start --port <port>
    Has its own start script  run it and append --port <port>; it may carry
                              flags that matter (e.g. --client-logs)
    Monorepo                  run from the APP directory, not the repo root

  The reserved port comes from \`stim status\` or from a previous
  \`start --json\`. Then \`stim ios\` accepts it: its Metro gate checks that
  the process on the port answers /status AND runs from inside this project,
  and yours does.

  The cost is logs. Stim captures only a dev server it hosted, so
  \`stim logs\` stays empty -- which is indistinguishable from a clean run --
  and finding output is back to redirecting it to a file yourself. Prefer
  \`start\`.

  The same identity check governs teardown: started elsewhere, \`stop\` refuses
  to kill it without \`--force\`.`,
};
