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
| `ios [--auto] [--managed-metro] [--device-type <name>] [--runtime <ver>] [--script <name>] [--pm <name>] [--no-script] [--no-install] [-- <extras...>]` | Ensure iOS sim + Metro + build/install. Extras after `--` are forwarded to the build command. |
| `android [--auto] [--script <name>] [--pm <name>] [--no-script] [--no-install] [-- <extras...>]` | Same for Android. |
| `start` | Start Metro detached, no platform action |
| `stop [<port>\|<shortcut>\|<path>]` | Kill Metro. No arg = current project; pass a port (e.g. 8083), a project shortcut (label or unique basename), or an absolute path. |
| `logs [<port>\|<shortcut>\|<path>] [-n <lines>] [--follow]` | Print the managed Metro log (bundle progress, resolution errors, client logs). |
| `prune` | Remove entries for deleted project directories, freeing their devices and ports. |
| `device [--platform ios\|android] [--json]` | Print the assigned device target |
| `status` | Show all projects' state |
| `reserve [ios\|android]` | Lock a manually-started sim/emulator to the current project (no build) |
| `unreserve [ios\|android]` | Drop the current project's lock without shutting the sim down |
| `release [<port>\|<shortcut>\|<path>] [--platform <p>] [--shutdown]` | Free a project's assignment. Target can be a Metro port (`8083`), a shortcut (label or unique basename), or an absolute path. `--shutdown` also stops the sim. |
| `shutdown [<shortcut>\|<path>] [-y] [--keep-sims]` | Kill Metro, shut down sims/emulators, and clear device assignments. No arg = every registered project (end-of-day reset). Pass a shortcut or path to scope to one. |
| `config [<key> [<value>]] [--unset] [--project <target>]` | Get / set a per-project setting (`packageManager`, `ios.script`, `android.script`). |
| `worktree create <name> [--base fresh\|head] [--no-install] [--label <name>]` | Create an isolated git worktree: carries over gitignored files, runs the setup pipeline, prints the worktree path. |
| `worktree remove <path> [--force]` | Remove a worktree, reclaiming its build artifacts, sim/emulator claim, and Metro port. Refuses if it has uncommitted or unpushed work unless `--force`. |
| `worktree list` | List this repo's worktrees with their setup status. |
| `gc [--delete] [--older-than <days>]` | Report (or, with `--delete`, reclaim) orphaned Xcode DerivedData and dead project entries left behind by deleted worktrees. Reports only by default. |

## How it works

- **Config** at `~/.rn-iso/config.json`, keyed by absolute project path. Symlinked worktrees collapse via `realpath`.
- **Port allocation:** assigns 8082, 8083, 8084 etc., reclaiming dead ports on the way.
- **Simulator / AVD pool:** prefers the project's existing assignment; otherwise picks an unclaimed device — running ones first, shutdown ones next (booting them). On iOS, does not auto-create new sims — pass `--device-type "iPhone 17 Pro" [--runtime 26.2]` to opt in. The interactive picker (iOS or Android) also lets you take over a device claimed by another project after a confirm prompt.
- **Build via your project's `ios` / `android` script** when present. Falls back to `npx expo run:ios` / `npx react-native run-ios --udid <UDID>` when no script exists. Override with `--script <name>` or skip with `--no-script`. Package manager is detected from your lockfile (walks up for monorepos); override with `--pm <npm|yarn|pnpm|bun>`.
- **Metro is started by the build CLI by default** (interactive bundler UX preserved). Pass `--managed-metro` to have rn-iso start it instead — detached, PID-tracked, output captured in a per-project log file under `~/.rn-iso/logs/`; the build CLI then gets `--no-packager` / `--no-bundler` so it never spawns a second Metro. Managed Metro survives the shell that ran the build, which is why coding agents (finite shells) should always pass the flag. `npx rn-iso start` is the standalone "I just want Metro" path. `npx rn-iso stop` finds Metro by port via `lsof`, so it works regardless of who started it.

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

## Worktrees

```bash
npx rn-iso worktree create feature-x        # creates ../<repo>-worktrees/feature-x
npx rn-iso worktree list                    # shows every worktree + its setup status
npx rn-iso worktree remove <path>           # removes it, freeing its sim/Metro too
```

`worktree create <name>` does four things in one step: creates the git worktree itself (branched `worktree-<name>` off `origin/HEAD` by default — pass `--base head` to branch off the current `HEAD` instead), carries over gitignored files (see "Carry-over" below), runs the project's setup pipeline (`--no-install` to skip), and registers a label for the worktree root so `rn-iso` shortcuts don't collide across a monorepo's worktrees (every worktree of a monorepo shares the same app-dir basename). Prefer it over a raw `git worktree add` for that reason. It prints only the resulting worktree path to stdout; everything else goes to stderr (see "Wiring into Claude Code" below).

`worktree remove <path>` reclaims the worktree's build artifacts, sim/emulator claim, and Metro port before removing the git worktree itself. It refuses if the worktree has uncommitted changes, untracked files, or commits that exist on no remote — pass `--force` to override, but note `--force` only discards uncommitted/untracked state; committed work stays safe on the branch either way.

`worktree list` shows every worktree with a setup status: `setup ok`, `setup incomplete` (the install pipeline failed — `rn-iso ios` / `rn-iso android` will also warn about this), or `unmanaged` (created some other way, e.g. raw `git worktree add`).

### Carry-over

Gitignored files (like `.env`, local certs, or IDE state) don't exist in a fresh worktree by default. `worktree create` copies any gitignored file matching a pattern from either:

- `.worktreeinclude` at the repo root — one gitignore-style pattern per line (`#` comments allowed), e.g.:
  ```
  .env
  .env.*
  **/*.local.json
  ```
- or the `worktree.include` setting (see "Settings" below), if no `.worktreeinclude` file exists.

Only files that are both gitignored and pattern-matched are copied — tracked files are never duplicated into the worktree.

### Why worktrees live next to the repo, not inside it

`worktree create` places new worktrees in a sibling directory (`../<repo>-worktrees/<name>`), never under the repo root. A worktree nested inside the repo puts a second copy of every `package.json` inside Metro's watch root, which causes jest-haste-map naming collisions (two files claiming the same module name). Its multi-gigabyte `node_modules` also gets walked by Metro, TypeScript, and ESLint on every run. Gitignoring the nested worktree directory does not fix either problem: those tools walk the filesystem directly, not `git`, so a `.gitignore` entry is invisible to them.

### Wiring into Claude Code (`WorktreeCreate` hook)

Claude Code's `WorktreeCreate` hook fires when a session for a new worktree starts, and uses the hook command's stdout as the directory for that session. `rn-iso worktree create` is built for exactly this contract — it prints only the resulting path to stdout, and always exits 0 (even when its setup pipeline fails), so a broken `npm install` never breaks the hook itself. Wire it in `.claude/settings.json`:

```json
{
  "hooks": {
    "WorktreeCreate": [
      { "hooks": [{ "type": "command", "command": "rn-iso worktree create \"$(jq -r .name)\"" }] }
    ]
  }
}
```

## Settings

`worktree create` (and, for `packageManager`, `ios`/`android`) resolve settings from three layers, merged with the first match winning (nested objects merge key by key; arrays — like `worktree.install` — are replaced wholesale, never concatenated):

1. **Project settings** — per absolute project path, stored in `~/.rn-iso/config.json`. Set with `npx rn-iso config <key> <value>` (see above). Highest precedence.
2. **Repo settings** — shared by every worktree of the same repository (keyed by the repo's git common dir), also stored in `~/.rn-iso/config.json`. Local to this machine.
3. **Committed settings** — `.rn-iso.json` at the repo root, checked into git and shared with everyone who clones the repo. Lowest precedence, but the only layer that travels with the repo.

Recognized keys include `packageManager`, and, under `worktree`: `baseRef` (`"fresh"` or `"head"`), `install` (`false` to skip the setup pipeline, or a string/array of commands to run instead of the default `<package manager> install`), and `include` (carry-over patterns, same role as `.worktreeinclude`). Example `.rn-iso.json`:

```json
{
  "packageManager": "pnpm",
  "worktree": {
    "baseRef": "fresh",
    "install": ["pnpm install", "pnpm run codegen"],
    "include": [".env", ".env.*"]
  }
}
```

**Never put secrets in `.rn-iso.json`.** It's committed to git and readable by anyone with repo access. Secrets belong in gitignored files (`.env` and friends) that `worktree create`'s carry-over feature copies into each new worktree — that mechanism exists specifically so gitignored, secret-bearing files reach a fresh worktree without ever being committed to `.rn-iso.json` or anywhere else in git history.

## Requirements

- macOS (iOS); macOS or Linux (Android)
- Node 20+
- Xcode (iOS), Android SDK + at least one AVD (Android)
- `expo` or `react-native` in the project's `package.json`

## License

MIT
