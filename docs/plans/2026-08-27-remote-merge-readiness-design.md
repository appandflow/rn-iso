# Remote merge-readiness design

## Goal

Make PR #19 safe to merge. Keep local runs local. Ensure every billable remote
session and every managed tunnel has a verified owner and a reliable teardown
path.

## Remote intent

`--remote` remains an explicit choice. It is accepted by `start`, `ios`, and
`android`.

- `rn-iso start` starts a local dev server and does not create a tunnel.
- `rn-iso start --remote` prepares a dev server for a later remote device run.
- `ios.remote: true` or `android.remote: true` also gives `start` remote intent.
- `metro.tunnel` selects the tunnel provider only after remote intent exists.
- An explicit `metro.publicUrl` remains an operator-supplied remote origin.

For an Expo project, `start --remote` can pass `--tunnel` to Expo. The tunnel
must exist when Expo starts because Expo writes the public origin into its
manifest. A healthy local supervisor cannot gain that option later. In that
case, `start --remote` refuses with a remedy to run `stop` and then
`start --remote`.

A plain `start` against an existing remote-ready supervisor leaves it running.
The command does not restart a healthy server only to remove a tunnel.

## Remote backend choice

`start --remote` prepares Metro only. The device command chooses the backend.

1. If `AGENT_DEVICE_DAEMON_BASE_URL` and
   `AGENT_DEVICE_DAEMON_AUTH_TOKEN` are both present, rn-iso uses that daemon.
   This covers `agent-device proxy` and an externally created EAS session.
   rn-iso creates no session and owns no session teardown.
2. Otherwise, rn-iso uses `eas-cli` to create an EAS Simulator session. rn-iso
   records the session ID and owns its teardown.
3. If neither source is available, the device command refuses before a build
   or billable session starts.

One partial daemon environment variable is an error. rn-iso does not guess
which backend the operator intended.

## Android lifecycle

The Android remote path follows the same order as iOS:

1. Verify the local Metro server.
2. Resolve and gate the public Metro origin for debug builds.
3. Create or connect to the remote device.
4. Record an rn-iso-created EAS session immediately after boot.
5. Build, install, and launch through the remote adapter.

The session record is written before any later build or launch failure can
return. `stop`, `gc`, and `worktree remove` can therefore end a billable
session after every failure path.

Release builds need no Metro origin. They still launch through the remote
adapter because the device is remote.

## Destructive identity checks

A stored identifier is not proof of ownership.

Before an EAS stop, rn-iso reads the live session and requires its name to
start with `rn-iso-`. A missing, unauthenticated, or unparseable lookup does
not authorize a stop. The state record remains so the operator can retry.

Before a managed tunnel receives `SIGTERM`, rn-iso reads the live process
command and requires it to match the recorded provider and port. A reused PID
does not authorize a signal. A mismatch remains recorded and is reported.

## Orphan EAS sessions

`gc` lists live `rn-iso-` sessions for the current EAS project. It compares
their IDs with every readable workspace session record.

- A dry run reports unmatched live sessions.
- `gc --delete` stops only sessions returned by the owned-name listing.
- An EAS lookup failure becomes a notice and does not block local cleanup.
- A stop failure is reported and makes deletion incomplete.

The EAS list is project-scoped. `gc` does not claim it can find sessions from
unrelated EAS projects.

## Skill and documentation

The shipped rn-iso skill documents:

- `start --remote` before a remote debug run;
- plain `start` as the local path;
- environment daemon precedence over EAS session creation;
- rn-iso ownership only for sessions it creates;
- the required teardown and billing warning.

The generated guide and PR description use the same command sequence.

## Verification

Each behavior change starts with a failing unit test. Focused suites cover the
command order, failure paths, identity checks, and `gc` output. The complete
format, typecheck, unit, lint, and Knip checks run after integration with
current `main`.

The final field test runs both local and remote Expo starts. The local run must
show no public tunnel. The remote iOS run must create one EAS session, fetch a
bundle through the public origin, report no errors, and stop the session.
