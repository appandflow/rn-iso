# Stim

The `stim-cli` npm package installs the `stim` command.

Stim gives coding agents fast, isolated React Native and Expo environments. Each
project or git worktree gets its own Metro port and owned device. Shared caches
keep native and JavaScript builds warm across worktrees.

## Install

```bash
npm install --global stim-cli
npx skills add appandflow/stim
```

Run without a global install when needed:

```bash
npx stim-cli <command>
```

Node 20.19.4 or later on Node 20, or Node 22.12.0 or later, is required.

## Normal workflow

```bash
stim doctor
stim start
stim ios                  # or: stim android
stim reload               # after a JS-only edit when Fast Refresh needs help
stim logs --errors
stim stop
```

For `stim logs --errors`, a clean check requires exit code 0 and no matching
errors in the captured logs. Exit code 0 alone means the query succeeded, even
when it prints errors; an empty result does not prove launch or log capture
succeeded.

Use `stim doctor --platform ios` or `stim doctor --platform android` when only
one native platform is in scope; shared project checks still run.

Create a warm isolated worktree with:

```bash
stim worktree create feature/settings --carry-ignored
```

Slash-separated names keep the matching Git branch hierarchy while the
worktree itself remains one directory under the configured worktree root. Its
default device label includes a stable hash so a flat name cannot collide.

Stim builds or restores the app, installs it, launches it, and checks launch
readiness. Plain output streams progress and reports the complete result. Use
`--json` when a script needs structured data.

`stim reload [ios|android]` reloads JavaScript in the live app on this
workspace's owned local device. It does not build, install, boot, or launch an
app. The platform is optional when only one app is live.

## Reference

The [documentation website](https://appandflow.github.io/stim/) explains the
human workflow and all commands.

The installed CLI contains version-matched operational guidance:

```bash
stim guide agent
stim --help
stim <command> --help
stim guide
```

Runtime state defaults to `~/.stim`. Set `STIM_HOME` to move it. Stim manages
owned simulators and emulators, leases connected physical devices, and supports
configured remote devices.

## Package name

The product and command are named Stim. The npm package remains `stim-cli` until
the unscoped `stim` package name is available.

MIT License.
