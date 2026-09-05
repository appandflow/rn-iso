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
stim logs --errors
stim stop
```

For `stim logs --errors`, a clean check requires exit code 0 and no matching
errors in the captured logs. Exit code 0 alone means the query succeeded, even
when it prints errors; an empty result does not prove launch or log capture
succeeded.

Use `stim doctor --platform ios` or `stim doctor --platform android` when only
one native platform is in scope; shared project checks still run.

Stim builds or restores the app, installs it, launches it, and checks launch
readiness. Plain output streams progress and reports the complete result. Use
`--json` when a script needs structured data.

`stim reload [ios|android]` requests a JavaScript reload in the live app on this
workspace's owned local device. Use it after a failed first bundle load, when
an error screen remains after a fix, or when you explicitly need an app
restart. It is not part of the normal workflow and does not build, install,
boot, or launch an app. The platform is optional when only one app is live.
Success confirms that the request was sent; Stim does not observe completion.
Verify the expected UI on the reported device and inspect `stim logs --errors`
before claiming recovery.

For an isolated branch, create the worktree with Git, then warm it:

```bash
git worktree add -b feature/settings ../feature-settings HEAD
cd ../feature-settings
stim worktree warm
```

If a harness already created the linked worktree, run only `stim worktree warm`
there. Warm copies missing ignored state from main, including eligible `.env`
and local configuration files. Existing entries are preserved; existing
ignored directories such as `node_modules` are skipped whole.

After the work is preserved, `stim worktree remove` removes any linked
worktree, warmed or not. Git-created branches stay. See the
[worktree guide](https://appandflow.github.io/stim/docs/worktrees) for exclusions
and cleanup rules.

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
