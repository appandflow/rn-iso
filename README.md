# rn-iso

[![CI](https://github.com/appandflow/rn-iso/actions/workflows/ci.yml/badge.svg)](https://github.com/appandflow/rn-iso/actions/workflows/ci.yml)

The React Native / Expo CLI for AI agents. Humans never run it — your agent
does. Each agent gets an isolated dev environment: its own Metro port, its own
simulator or emulator, native builds that install from a shared cache, and a
queryable log timeline — so several agents can build the same app on one
machine at the same time without stepping on each other.

**rn-iso needs no project changes to run.** Point it at a clean checkout and
the whole loop works, caches included — the Xcode compilation cache, Gradle's
build cache and a shared Metro transform cache all ride on the command lines
rn-iso composes itself, not on files your repo has to commit. Trying it out
costs no PR.

## Getting started

Two steps. **There is no setup step and nothing to commit** — rn-iso runs on a
clean checkout, caches included.

**1. Install the agent skill.** This is the only command a human runs:

```bash
npx skills add appandflow/rn-iso
```

**2. Describe what you want:**

```
Build and run the app on the iOS simulator and fix anything that breaks.
```

The agent drives the whole loop through rn-iso — a supervised dev server on a
reserved port, an owned simulator, a build that installs from cache when
nothing native changed, and `logs --errors` to check its own work — in about
ten lines of output per cycle, `--json` everywhere.

If something is blocked or slow, `npx rn-iso doctor` is the read-only second
opinion: it reports only what rn-iso cannot handle on its own (a missing
`expo-dev-client`, ccache, a checkout that does not fingerprint like a fresh
worktree) plus the settings that matter only for builds rn-iso does not drive
(Xcode, `npx expo run:ios`, Android Studio, CI). A clean run means there is
nothing rn-iso needs from your repo.

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
pnpm install                      # one-time, from the workspace root
pnpm test                         # runs the rn-iso suite
cd packages/rn-iso && npm link    # put the dev CLI on your PATH
```

[`CLAUDE.md`](./CLAUDE.md) is the orientation for anyone (human or agent)
changing the code. [`RELEASE.md`](./RELEASE.md) is the publish workflow: all
three packages carry the same version and go out together.

## License

MIT
