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

For AI coding agents, install the skill so the agent knows how to drive the CLI:

```bash
npx skills add janicduplessis/rn-iso
```

## Commands

All commands below take the same `npx rn-iso` prefix.

| Command | Purpose |
|---|---|
| `ios [--auto] [--device-type <name>] [--runtime <ver>] [--script <name>] [--pm <name>] [--no-script] [--no-install]` | Ensure iOS sim + Metro + build/install |
| `android [--auto] [--script <name>] [--pm <name>] [--no-script] [--no-install]` | Same for Android |
| `start` | Start Metro detached, no platform action |
| `stop` | Kill Metro for current project |
| `device [--platform ios\|android] [--json]` | Print the assigned device target |
| `status` | Show all projects' state |
| `reserve [ios\|android]` | Lock a manually-started sim/emulator to the current project (no build) |
| `unreserve [ios\|android]` | Drop the current project's lock without shutting the sim down |
| `release [<project>] [--platform <p>] [--shutdown]` | Free a project's assignment; `--shutdown` also stops the sim |

## How it works

- **Config** at `~/.rn-iso/config.json`, keyed by absolute project path. Symlinked worktrees collapse via `realpath`.
- **Port allocation:** assigns 8082, 8083, 8084 etc., reclaiming dead ports on the way.
- **Simulator / AVD pool:** prefers the project's existing assignment; otherwise picks an unclaimed device — running ones first, shutdown ones next (booting them). On iOS, does not auto-create new sims — pass `--device-type "iPhone 17 Pro" [--runtime 26.2]` to opt in. The interactive picker (iOS or Android) also lets you take over a device claimed by another project after a confirm prompt.
- **Build via your project's `ios` / `android` script** when present. Falls back to `npx expo run:ios` / `npx react-native run-ios --udid <UDID>` when no script exists. Override with `--script <name>` or skip with `--no-script`. Package manager is detected from your lockfile (walks up for monorepos); override with `--pm <npm|yarn|pnpm|bun>`.
- **Metro is started by the build CLI** on the assigned port, not by rn-iso. `npx rn-iso start` is the standalone "I just want Metro" path. `npx rn-iso stop` finds Metro by port via `lsof`, so it works regardless of who started it.

If you need a single shared sim with a mutex instead of one-per-project, see [`react-native-worktree`](https://github.com/aleqsio/react-native-worktree).

## Reserving a manually-started sim

If you booted a simulator yourself (Xcode, Simulator.app, `xcrun simctl boot`, or a manual `expo run:ios`) and want rn-iso to know that sim belongs to the current project — so other rn-iso projects skip it:

```bash
npx rn-iso reserve            # picks from booted iOS sims
npx rn-iso reserve android    # picks from running emulators
npx rn-iso unreserve          # drop the lock without shutting the sim down
```

Reserve binds the sim to the current project the same way `ios` / `android` would, but without running a build. If the sim is already held by another project, the picker prompts you to take it over.

## Requirements

- macOS (iOS); macOS or Linux (Android)
- Node 20+
- Xcode (iOS), Android SDK + at least one AVD (Android)
- `expo` or `react-native` in the project's `package.json`

## License

MIT
