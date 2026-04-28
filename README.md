# rn-iso

Per-project Metro server and dedicated simulator/emulator for React Native / Expo, so multiple worktrees (or coding agents) can build the same app in parallel without port or device collisions.

> **Experimental.** APIs, flags, and on-disk state may change. File issues if anything breaks.

State lives in `~/.rn-iso/config.json`, keyed by absolute project path. Worktrees count as separate projects. There is no shared mutex — each project is pinned to its own port and its own sim.

## Install

```bash
npm install -g rn-iso
```

To install the agent skill (so AI coding agents know how to drive the CLI):

```bash
npx skills add janicduplessis/rn-iso
```

## Quick start

In any RN/Expo project directory:

```bash
rn-iso ios       # ensure sim, allocate port, build/install
rn-iso device    # print the assigned UDID
```

In a different worktree of the same app:

```bash
rn-iso ios       # gets a different sim and Metro port
```

Both run side by side. For non-interactive / agent use, pass `--auto` to skip the picker:

```bash
rn-iso ios --auto
```

## Commands

| Command | Purpose |
|---|---|
| `rn-iso ios [--auto] [--device-type <name>] [--runtime <ver>] [--script <name>] [--pm <name>] [--no-script] [--no-install]` | Ensure iOS sim + Metro + build/install |
| `rn-iso android [--auto] [--script <name>] [--pm <name>] [--no-script] [--no-install]` | Same for Android |
| `rn-iso start` | Start Metro detached, no platform action |
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

- **Config** at `~/.rn-iso/config.json`, keyed by absolute project path. Symlinked worktrees collapse via `realpath`.
- **Port allocation:** assigns 8082, 8083, 8084 etc., reclaiming dead ports on the way.
- **Simulator pool:** prefers the project's existing assignment; otherwise picks any unclaimed booted sim, then any unclaimed shutdown sim (booting it). Does not auto-create new sims — pass `--device-type "iPhone 17 Pro" [--runtime 26.2]` to opt in.
- **Build via your project's `ios` / `android` script** when present. Falls back to `npx expo run:ios` / `npx react-native run-ios --udid <UDID>` when no script exists. Override with `--script <name>` or skip with `--no-script`. Package manager is detected from your lockfile (walks up for monorepos); override with `--pm <npm|yarn|pnpm|bun>`.
- **Metro is started by the build CLI** on the assigned port, not by rn-iso. `rn-iso start` is the standalone "I just want Metro" path. `rn-iso stop` finds Metro by port via `lsof`, so it works regardless of who started it.

If you need a single shared sim with a mutex instead of one-per-project, see [`react-native-worktree`](https://github.com/aleqsio/react-native-worktree).

## Reservations

If you boot a sim outside rn-iso (Xcode, manual `simctl boot`, another tool), reserve it so rn-iso's allocator skips it:

```bash
rn-iso reserve ios <UDID> --label agent-1
rn-iso reserve                # interactive multi-select picker
rn-iso unreserve agent-1      # release by label, UDID, or serial
```

Reserved sims appear greyed-out as `[reserved]` in the picker.

## Requirements

- macOS (iOS); macOS or Linux (Android)
- Node 20+
- Xcode (iOS), Android SDK + at least one AVD (Android)
- `expo` or `react-native` in the project's `package.json`

## License

MIT
