# rn-iso

[![CI](https://github.com/appandflow/rn-iso/actions/workflows/ci.yml/badge.svg)](https://github.com/appandflow/rn-iso/actions/workflows/ci.yml)

The React Native / Expo CLI for AI agents. Humans never run it — your agent
does. Each agent gets an isolated dev environment: its own Metro port, its own
simulator or emulator, native builds that install from a shared cache, and a
queryable log timeline — so several agents can build the same app on one
machine at the same time without stepping on each other.

## Getting started

Install the agent skill. This is the only command a human runs:

```bash
npx skills add appandflow/rn-iso
```

Then, in your app's repo, have the agent set the project up:

```
/rn-iso-init
```

From then on, just describe what you want:

```
Build and run the app on the iOS simulator and fix anything that breaks.
```

The agent drives the whole loop through rn-iso — a supervised dev server on a
reserved port, an owned simulator, a build that installs from cache when
nothing native changed, and `logs --errors` to check its own work — in about
ten lines of output per cycle, `--json` everywhere.

## What's in the box

| Package                                                   | What it is                                                                                                                                                                                                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`rn-iso`](./packages/rn-iso)                             | The CLI the agent runs: `start` (supervised dev server), `ios` / `android` (owned device, cached build, launch), `logs --errors` (what broke, symbolicated), `worktree` / `stop` / `gc` (isolation and cleanup). Never prompts, prints ~10 lines, `--json` everywhere. |
| [`@rn-iso/metro`](./packages/metro)                       | One Metro transform cache shared by every worktree, instead of Metro's per-project default that makes each new workspace re-transform the whole module graph. Plus the NDJSON reporter behind the log timeline.                                                        |
| [`@rn-iso/expo-build-cache`](./packages/expo-build-cache) | A local Expo build cache provider. When no native input changed, the Expo CLI installs a cached `.app` / `.apk` instead of compiling.                                                                                                                                  |

How it works — the ownership model, the command surface, worktrees, settings,
cache housekeeping — is documented on the
**[website](https://appandflow.github.io/rn-iso/)** and in the
[`rn-iso` package README](./packages/rn-iso/README.md).

## Working in this repo

```bash
npm install                       # one-time, from the workspace root
npm test                          # runs the rn-iso suite
cd packages/rn-iso && npm link    # put the dev CLI on your PATH
```

[`CLAUDE.md`](./CLAUDE.md) is the orientation for anyone (human or agent)
changing the code. [`RELEASE.md`](./RELEASE.md) is the publish workflow: all
three packages carry the same version and go out together.

## License

MIT
