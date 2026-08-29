# stim-cli

[![CI](https://github.com/appandflow/stim-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/appandflow/stim-cli/actions/workflows/ci.yml)

The React Native / Expo CLI for AI agents. Humans never run it — your agent
does. Each agent gets an isolated dev environment: its own Metro port, its own
simulator or emulator, native builds that install from a shared cache, and a
queryable log timeline — so several agents can build the same app on one
machine at the same time without stepping on each other.

**stim-cli needs no project changes to run.** Point it at a clean checkout and
the whole loop works, caches included — the Xcode compilation cache, Gradle's
build cache and a shared Metro transform cache all ride on the command lines
stim-cli composes itself, not on files your repo has to commit. Trying it out
costs no PR.

## Getting started

Install the agent skill:

```bash
npx skills add appandflow/stim-cli
```

The package exports only `stim`. Run it without installing, or install it once:

```bash
npx stim-cli <command>
npm install --global stim-cli
```

Later examples use `stim`. If it is not installed globally, replace `stim`
with the `npx` form above.

Then tell your agent what you want:

```
Build and run the app on the iOS simulator and fix anything that breaks.
```

That's it. The agent drives the whole loop through stim-cli — a supervised dev
server on a reserved port, an owned simulator, a build that installs from a
shared cache when nothing native changed, and `logs --errors` to check its own
work — in about ten lines of output per cycle, `--json` everywhere.

If a build is ever blocked or slower than it should be, `stim doctor` says why,
read-only.

## What's in the box

| Package                                                     | What it is                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`stim-cli`](./packages/stim-cli)                           | The CLI the agent runs: `start` (supervised dev server), `ios` / `android` (owned device, cached build, launch), `logs --errors` (what broke, symbolicated), `worktree` / `stop` / `gc` (isolation and cleanup). Never prompts, prints ~10 lines, `--json` everywhere. |
| [`@stim-cli/metro`](./packages/metro)                       | One Metro transform cache shared by every worktree, instead of Metro's per-project default that makes each new workspace re-transform the whole module graph. Plus the NDJSON reporter behind the log timeline.                                                        |
| [`@stim-cli/expo-build-cache`](./packages/expo-build-cache) | A local Expo build cache provider. When no native input changed, the Expo CLI installs a cached `.app` / `.apk` instead of compiling.                                                                                                                                  |

How it works — the ownership model, the command surface, worktrees, settings,
cache housekeeping — is documented on the
**[website](https://appandflow.github.io/stim-cli/)** and in the
[`stim-cli` package README](./packages/stim-cli/README.md).

## Working in this repo

```bash
pnpm install                      # one-time, from the workspace root
pnpm test                         # runs the stim-cli suite
cd packages/stim-cli && npm link    # put the dev CLI on your PATH
```

[`CLAUDE.md`](./CLAUDE.md) is the orientation for anyone (human or agent)
changing the code. [`RELEASE.md`](./RELEASE.md) is the publish workflow: all
four packages carry the same version and go out together.

## License

MIT
