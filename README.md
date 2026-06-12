# rn-iso

Per-project Metro server and dedicated simulator/emulator for React Native / Expo, so multiple worktrees (or coding agents) can build the same app in parallel without port or device collisions.

> **Experimental.** APIs, flags, and on-disk state may change. File issues if anything breaks.

State lives in `~/.rn-iso/config.json`, keyed by absolute project path. Worktrees count as separate projects. There is no shared mutex — each project is pinned to its own port and its own sim.

## Quick start

Run via `npx` from any RN/Expo project directory — no install needed:

```bash
npx rn-iso ios       # ensure sim, allocate port, build/install
npx rn-iso device    # print the assigned UDID
```

In a different worktree of the same app:

```bash
npx rn-iso ios       # gets a different sim and Metro port
```

Both run side by side. For non-interactive / agent use, pass `--auto` to skip the picker (this is also implied automatically when stdin isn't a TTY):

```bash
npx rn-iso ios --auto
```

Forward extra flags to the underlying build command with `--`:

```bash
npx rn-iso ios -- --variant=release
npx rn-iso android -- --mode=diaRelease --terminal=Ghostty
```

For AI coding agents, install the skill so the agent knows how to drive the CLI:

```bash
npx skills add janicduplessis/rn-iso
```

## Commands

All commands below take the same `npx rn-iso` prefix.

| Command | Purpose |
|---|---|
| `ios [--auto] [--device-type <name>] [--runtime <ver>] [--script <name>] [--pm <name>] [--no-script] [--no-install] [-- <extras...>]` | Ensure iOS sim + Metro + build/install. Extras after `--` are forwarded to the build command. |
| `android [--auto] [--script <name>] [--pm <name>] [--no-script] [--no-install] [-- <extras...>]` | Same for Android. |
| `start` | Start Metro detached, no platform action |
| `stop [<port>\|<shortcut>\|<path>]` | Kill Metro. No arg = current project; pass a port (e.g. 8083), a project shortcut (label or unique basename), or an absolute path. |
| `device [--platform ios\|android] [--json]` | Print the assigned device target |
| `status` | Show all projects' state |
| `reserve [ios\|android]` | Lock a manually-started sim/emulator to the current project (no build) |
| `unreserve [ios\|android]` | Drop the current project's lock without shutting the sim down |
| `release [<port>\|<shortcut>\|<path>] [--platform <p>] [--shutdown]` | Free a project's assignment. Target can be a Metro port (`8083`), a shortcut (label or unique basename), or an absolute path. `--shutdown` also stops the sim. |
| `shutdown [<shortcut>\|<path>] [-y] [--keep-sims]` | Kill Metro, shut down sims/emulators, and clear device assignments. No arg = every registered project (end-of-day reset). Pass a shortcut or path to scope to one. |
| `config [<key> [<value>]] [--unset] [--project <target>]` | Get / set a per-project setting (`packageManager`, `ios.script`, `android.script`). |

## How it works

- **Config** at `~/.rn-iso/config.json`, keyed by absolute project path. Symlinked worktrees collapse via `realpath`.
- **Port allocation:** assigns 8082, 8083, 8084 etc., reclaiming dead ports on the way.
- **Simulator / AVD pool:** prefers the project's existing assignment; otherwise picks an unclaimed device — running ones first, shutdown ones next (booting them). On iOS, does not auto-create new sims — pass `--device-type "iPhone 17 Pro" [--runtime 26.2]` to opt in. The interactive picker (iOS or Android) also lets you take over a device claimed by another project after a confirm prompt.
- **Build via your project's `ios` / `android` script** when present. Falls back to `npx expo run:ios` / `npx react-native run-ios --udid <UDID>` when no script exists. Override with `--script <name>` or skip with `--no-script`. Package manager is detected from your lockfile (walks up for monorepos); override with `--pm <npm|yarn|pnpm|bun>`.
- **Metro is started by rn-iso itself** — detached, PID-tracked, output captured in a per-project log file under `~/.rn-iso/logs/`. The build CLI gets `--no-packager` / `--no-bundler` so it never spawns a second Metro, and Metro survives the shell that ran the build (important for coding agents, whose shells are finite). `npx rn-iso start` is the standalone "I just want Metro" path. `npx rn-iso stop` finds Metro by port via `lsof`, so it works regardless of who started it.

If you need a single shared sim with a mutex instead of one-per-project, see [`react-native-worktree`](https://github.com/aleqsio/react-native-worktree).

## Reserving a manually-started sim

If you booted a simulator yourself (Xcode, Simulator.app, `xcrun simctl boot`, or a manual `expo run:ios`) and want rn-iso to know that sim belongs to the current project — so other rn-iso projects skip it:

```bash
npx rn-iso reserve --label agent-1     # picks from booted iOS sims
npx rn-iso reserve android             # picks from running emulators
npx rn-iso unreserve                   # drop the lock without shutting the sim down
```

Reserve binds the sim to the current project the same way `ios` / `android` would, but without running a build. If the sim is already held by another project, the picker prompts you to take it over.

## Per-project settings (`rn-iso config`)

A few options can be persisted per project so you don't have to repeat the same flags every run. Resolution order:

1. CLI flag (`--script`, `--pm`)
2. Stored project setting (this section)
3. Default inferred from the project (`ios` / `android` script if present, package manager from lockfile)

```bash
npx rn-iso config packageManager bun
npx rn-iso config ios.script dev:ios
npx rn-iso config android.script "dev:android --variant=debug"
npx rn-iso config                 # list current project's settings
npx rn-iso config ios.script      # print one
npx rn-iso config ios.script --unset
```

Allowed keys today: `packageManager` (one of `npm|yarn|pnpm|bun`), `ios.script`, `android.script`. Settings live in `~/.rn-iso/config.json` under the project's entry.

## Project shortcuts (--label)

Each registered project has a "shortcut" you can pass to `stop` / `release` instead of the full path. The first time you run `ios`, `android`, or `reserve` interactively you'll be prompted for one (the directory basename is the default — hit enter to accept). Override any time with `--label <name>`:

```bash
npx rn-iso ios --label agent-1
npx rn-iso stop agent-1            # later, from anywhere
npx rn-iso release agent-1 --shutdown
```

Under `--auto` (or any non-TTY invocation) the prompt is skipped — the project's basename serves as its shortcut by default. Shortcut collisions (two projects sharing the same basename, or two labels colliding) error out and list the candidates so you can disambiguate with the absolute path.

## Requirements

- macOS (iOS); macOS or Linux (Android)
- Node 20+
- Xcode (iOS), Android SDK + at least one AVD (Android)
- `expo` or `react-native` in the project's `package.json`

## License

MIT
