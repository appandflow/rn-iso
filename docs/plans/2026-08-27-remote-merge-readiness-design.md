# Remote merge-readiness design

## Goal

Make PR #19 safe to merge. Keep local runs local. Ensure every billable remote
session and every managed tunnel has a verified owner and a reliable teardown
path.

## Remote intent

`--remote` remains an explicit choice. It is accepted by `start`, `ios`, and
`android`.

- `stim start` starts a local dev server and does not create a tunnel.
- `stim start --remote` prepares a dev server for a later remote device run.
- An `ios.remote` or `android.remote` backend setting also gives `start` remote
  intent.
- `metro.tunnel` selects the tunnel provider only after remote intent exists.
- `metro.ngrokUrl` supplies a stable endpoint for the managed ngrok provider.
  It requires `metro.tunnel: "ngrok"`.
- An explicit `metro.publicUrl` remains an operator-supplied remote origin.

For an Expo project, `start --remote` can pass `--tunnel` to Expo. The tunnel
must exist when Expo starts because Expo writes the public origin into its
manifest. A healthy local supervisor cannot gain that option later. In that
case, `start --remote` refuses with a remedy to run `stop` and then
`start --remote`.

`metro.tunnel: "ngrok"` and `metro.tunnel: "cloudflared"` select the two
managed providers. `auto` prefers ngrok and then cloudflared for a bare React
Native project. On Expo, `auto` selects Expo's own tunnel. A managed provider
starts during `start --remote`, before the dev server, so Expo can advertise
the public origin in its manifest. The later device command reuses the
recorded tunnel.

Provider readiness requires a tunnel URL, not only a binary on `PATH`.
For bare React Native under `auto`, Stim tries ngrok first. If ngrok exits
before it returns a URL, including an authentication refusal, Stim cleans up
that attempt and tries cloudflared when available. An explicit
`metro.tunnel: "ngrok"` never falls back to a different provider.

A configured ngrok URL is passed with `ngrok http <port> --url <url>`. Stim
still owns and stops that process. `metro.publicUrl` remains different: it
describes an already-running tunnel that Stim never stops.

A plain `start` against an existing remote-ready supervisor leaves it running.
The command does not restart a healthy server only to remove a tunnel.

## Remote backend choice

`start --remote` prepares Metro only. The device command chooses the backend.

- `stim ios --remote proxy` and `stim android --remote proxy` connect to an
  existing agent-device daemon. They require
  `AGENT_DEVICE_DAEMON_BASE_URL` and `AGENT_DEVICE_DAEMON_AUTH_TOKEN`. The
  daemon can run on another machine. Stim sends authenticated device
  operations to that URL. Stim creates no EAS session and owns no session
  teardown.
- `stim ios --remote eas` and `stim android --remote eas` use `eas-cli` to
  create an EAS Simulator session. Stim records the session ID and owns its
  teardown. Daemon environment variables do not change this selection.
- `ios.remote` and `android.remote` accept `"proxy"` or `"eas"` as the
  settings equivalent of the command argument.

A missing backend, an unknown backend, or incomplete proxy credentials is an
error. Stim does not infer a backend from environment variables.

## Android lifecycle

The Android remote path follows the same order as iOS:

1. Verify the local Metro server.
2. Resolve and gate the public Metro origin for debug builds.
3. Create or connect to the remote device.
4. Record an stim-created EAS session immediately after boot.
5. Build, install, and launch through the remote adapter.

The session record is written before any later build or launch failure can
return. `stop`, `gc`, and `worktree remove` can therefore end a billable
session after every failure path.

Release builds need no Metro origin. They still launch through the remote
adapter because the device is remote.

## Destructive identity checks

A stored identifier is not proof of ownership.

Before an EAS stop, Stim reads the live session and requires its name to
start with `stim-`. A missing, unauthenticated, or unparseable lookup does
not authorize a stop. The state record remains so the operator can retry.

Before a managed tunnel receives `SIGTERM`, Stim reads the live process
command and requires it to match the recorded provider and port. A reused PID
does not authorize a signal. A mismatch remains recorded and is reported.

## Orphan EAS sessions

`gc` lists live `stim-` sessions for the current EAS project. It compares
their IDs with every readable workspace session record.

- A dry run reports unmatched live sessions.
- `gc --delete` stops only sessions returned by the owned-name listing.
- An EAS lookup failure becomes a notice and does not block local cleanup.
- A stop failure is reported and makes deletion incomplete.

The EAS list is project-scoped. `gc` does not claim it can find sessions from
unrelated EAS projects.

## Skill and documentation

The shipped Stim skill documents:

- `start --remote` before a remote debug run;
- plain `start` as the local path;
- explicit `--remote proxy` and `--remote eas` device commands;
- the agent-device daemon URL and token contract for proxy mode;
- explicit ngrok and cloudflared provider settings;
- stable managed ngrok URLs versus operator-owned `metro.publicUrl`;
- Stim ownership only for sessions it creates;
- the required teardown and billing warning.

The generated guide and PR description use the same command sequence.

## Verification

Each behavior change starts with a failing unit test. Focused suites cover the
command order, failure paths, identity checks, and `gc` output. The complete
format, typecheck, unit, lint, and Knip checks run after integration with
current `main`.

The final field test runs local, proxy, and EAS paths. The local run must show
no public tunnel. Managed tunnel tests must prove the provider choice, ngrok
authentication fallback, and the ngrok `--url` argument. A proxy contract
test must use only the selected daemon. The remote iOS EAS run must create one
session, fetch a bundle through the public origin, report no errors, and stop
the session.
