# rn-iso

Isolated React Native / Expo dev environments per project or worktree. Each project gets its own Metro server and its own dedicated simulator/emulator, so you can run multiple builds — or multiple AI coding agents — side by side without port or device collisions.

## Why

Spin up two worktrees of the same RN app and run `expo run:ios` in both: they fight over port 8081, both target whichever sim happens to be booted, and the second build clobbers the first install. Hand the same setup to two coding agents in parallel and it gets worse.

`rn-iso` keeps a tiny per-project state file (`~/.rn-iso/config.json`, keyed by project path) that pins each project to its own Metro port and its own simulator. Worktrees count as separate projects. No locking, no shared mutex — your sim is yours.

## Install

```bash
npm install -g rn-iso
```

For AI agents (e.g. Claude Code), install the skill so the agent knows how to use the CLI:

```bash
mkdir -p ~/.claude/skills/rn-iso \
  && curl -fsSL https://raw.githubusercontent.com/janicduplessis/rn-iso/main/skill/SKILL.md \
       -o ~/.claude/skills/rn-iso/SKILL.md
```

## Quick start

In any RN/Expo project directory:

```bash
rn-iso ios       # ensure sim, allocate port, build/install
rn-iso device    # print the assigned UDID
```

In a different worktree of the same app:

```bash
rn-iso ios       # gets a different sim and Metro port automatically
```

Both run side-by-side with zero contention. For non-interactive / agent use, pass `--auto` to skip the picker:

```bash
rn-iso ios --auto
```

## Commands

| Command | Purpose |
|---|---|
| `rn-iso ios [--auto] [--device-type <name>] [--runtime <ver>] [--script <name>] [--pm <name>] [--no-script] [--no-install]` | Ensure iOS sim + Metro + build/install |
| `rn-iso android [--auto] [--script <name>] [--pm <name>] [--no-script] [--no-install]` | Same for Android |
| `rn-iso start` | Just start Metro detached, no platform action |
| `rn-iso device [--platform ios\|android] [--json]` | Print the assigned device target |
| `rn-iso status` | Show all projects' state and reservations |
| `rn-iso reserve [<platform> <id>] [--label <name>] [--list]` | Mark an external sim/emulator as in-use so rn-iso skips it |
| `rn-iso unreserve [<id\|label>] [--all]` | Release a reservation |
| `rn-iso release [<project\|label\|udid>] [--platform <p>]` | Unbind a project assignment or reservation |
| `rn-iso shutdown [--platform <p>]` | Release and shut down sims for current project |
| `rn-iso prune [--shutdown]` | GC dead entries machine-wide |
| `rn-iso logs` | Tail Metro log for current project |
| `rn-iso stop` | Kill Metro for current project |

## How it works

- **Config** at `~/.rn-iso/config.json`, keyed by absolute project path. Symlinked worktrees collapse via `realpath`. Worktrees of the same repo are different projects.
- **Port allocation:** assigns 8082, 8083, 8084 etc., reclaiming dead ports on the way.
- **Simulator pool:** prefers reusing the project's existing assignment; falls back to any booted unclaimed sim; falls back to any shutdown unclaimed sim (boots it). Never auto-creates new sims — pass `--device-type "iPhone 17 Pro" [--runtime 26.2]` to opt in to creating one.
- **No locking:** your sim is yours; other projects' sims are theirs. If you need a single shared sim with a mutex instead, use [`react-native-worktree`](https://github.com/aleqsio/react-native-worktree).
- **Build via your project's `ios` / `android` script** when present — respects custom flags and the right CLI (Expo vs RN). Falls back to `npx expo run:ios` / `npx react-native run-ios --udid <UDID>` when no script exists. Override with `--script <name>` or skip with `--no-script`. Package manager is detected from your lockfile (walks up for monorepos); override with `--pm <npm|yarn|pnpm|bun>`.
- **Metro is started by the build CLI**, not by rn-iso, on the assigned port. `rn-iso start` is for the standalone "I just want Metro" case. `rn-iso stop` finds Metro by port via `lsof`, so it works regardless of who started it.

## Reservations

If you boot a sim outside rn-iso (Xcode, manual `simctl boot`, another tool), reserve it so rn-iso's allocator skips it:

```bash
rn-iso reserve ios <UDID> --label agent-1
rn-iso reserve                # interactive multi-select picker
rn-iso unreserve agent-1      # release by label, UDID, or serial
```

Reserved sims show greyed-out as `[reserved]` in the picker.

## Requirements

- macOS (iOS support); macOS or Linux (Android support)
- Node 20+
- Xcode (iOS), Android SDK + at least one AVD (Android)
- Either `expo` or `react-native` in the project's `package.json`

## License

MIT
