# Stim

Fast, isolated React Native environments for coding agents.

Stim gives each project or git worktree its own Metro port and owned simulator
or emulator. It shares native artifacts, Xcode compilation data, Gradle output,
and Metro transforms across worktrees. Agents can work in parallel without
sharing live resources, then clean up every resource Stim created.

Stim supports React Native Community CLI and Expo projects. Builds run locally.
Apps can launch on local or configured remote simulators.

## Install

The npm package is named `stim-cli`. It installs the `stim` command.

```bash
npm install --global stim-cli
npx skills add appandflow/stim
```

Then ask your coding agent to build and run the app. The normal loop is:

```bash
stim doctor
stim start
stim ios                  # or: stim android
stim logs --errors
stim stop
```

Stim needs no project initialization. Runtime state stays under `~/.stim` by
default.

## Documentation

Read the [Stim documentation](https://appandflow.github.io/stim/) for the
motivation, setup, concepts, command reference, and settings reference.

The installed version also includes its own reference:

```bash
stim guide
stim guide lifecycle
stim guide settings
```

## Packages

- [`stim-cli`](./packages/stim-cli) provides the `stim` command.
- [`@stim-cli/metro`](./packages/metro) shares Metro transforms and records logs.
- [`@stim-cli/expo-build-cache`](./packages/expo-build-cache) lets direct Expo
  builds share native artifacts with Stim.
- [`@stim-cli/cache`](./packages/cache) holds the cache provider contract and
  the local-first tier coordination behind both caches.
- [`@stim-cli/core`](./packages/core) contains shared internal cache contracts.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

Stim is licensed under the MIT License.
