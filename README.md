# rn-iso

Isolated React Native / Expo dev environments per project or worktree. Each project gets its own Metro server and dedicated simulator/emulator. Designed for running multiple AI coding agents in parallel without port or device collisions.

## Install

```bash
npm install -g rn-iso
```

For AI agents, install the skill:

```bash
# Claude Code
mkdir -p ~/.claude/skills/rn-iso && curl -fsSL https://raw.githubusercontent.com/.../rn-iso/main/skill/SKILL.md -o ~/.claude/skills/rn-iso/SKILL.md
```

## Quick start

In any RN/Expo project directory:

```bash
rn-iso ios       # ensure sim, Metro, build/install
rn-iso device    # print the assigned UDID
```

In a different worktree of the same app:

```bash
rn-iso ios       # gets a different sim and Metro port automatically
```

Both run side-by-side, no contention.

## Commands

| Command | Purpose |
|---|---|
| `rn-iso ios [--auto] [--device-type <name>] [--no-install]` | Ensure iOS sim + Metro + build/install |
| `rn-iso android [--no-install]` | Same for Android |
| `rn-iso start` | Just start Metro, no platform action |
| `rn-iso device [--platform ios\|android] [--json]` | Print the assigned device target |
| `rn-iso status` | Show all projects' state |
| `rn-iso release [--platform <p>]` | Unbind device assignment(s) for current project |
| `rn-iso shutdown [--platform <p>]` | Release and shut down sims for current project |
| `rn-iso prune [--shutdown]` | GC dead entries machine-wide |
| `rn-iso logs` | Tail Metro log for current project |
| `rn-iso stop` | Kill Metro for current project |

## How it works

- **Config** at `~/.rn-iso/config.json`, keyed by absolute project path. Worktrees produce different paths -> different entries.
- **Port allocation:** assigns 8082, 8083, 8084 etc. Reclaims dead ports on assignment.
- **Simulator pool:** prefers reusing your project's existing assignment; falls back to any booted-and-unclaimed sim; prompts to boot a new one if needed (`--auto` skips the prompt).
- **No locking:** your sim is yours; other projects' sims are theirs. If you're on tight hardware and want one shared sim with a mutex, use [`react-native-worktree`](https://github.com/aleqsio/react-native-worktree) instead.

## Requirements

- macOS (iOS support); Linux/macOS (Android support)
- Node 20+
- Xcode (iOS), Android SDK + at least one AVD (Android)
- Either `expo` in `package.json` (Expo workflow) or `react-native` (bare workflow)

## License

MIT
