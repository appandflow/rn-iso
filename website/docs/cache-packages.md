---
title: 'The cache packages'
sidebar_position: 2
description: '@stim-cli/metro and @stim-cli/expo-build-cache: the shared transform cache and the local Expo build cache'
---

Two small ESM packages wire a project's own toolchain into the shared caches. Their `module-sync` exports support `require()` from `metro.config.js` and the Expo CLI. Neither package imports stim-cli, so a missing or old CLI does not break a bundler config or build.

# @stim-cli/metro

The two things [`stim-cli`](https://www.npmjs.com/package/stim-cli) wires into
Metro: one transform cache shared by every worktree on the machine, and a
reporter that writes the dev server's events as NDJSON.

```bash
npm i -D @stim-cli/metro
```

## The shared transform cache

Metro's default cache lives under the project, so a second worktree starts cold
and re-transforms the whole module graph — thousands of modules, every time.
Pointing every checkout at one store means only the first one pays.

```js
// metro.config.js
const { sharedCacheStores } = require('@stim-cli/metro');

const config = getDefaultConfig(__dirname);
config.cacheStores = sharedCacheStores('myapp');
module.exports = config;
```

The `FileStore` itself is six lines; what this packages is the housekeeping.
**Metro's cache has no eviction logic whatsoever**, so left alone it grows until
the disk does. Registering it with
[`stim-cli`](https://www.npmjs.com/package/stim-cli) makes it visible:

```bash
npx --package=stim-cli stim gc                            # what it has grown to (reported on every run)
npx --package=stim-cli stim gc --delete --older-than 30   # drop entries unused for 30 days
```

Entries are trimmed individually — one file per cache key — so trimming costs
only the entries nothing has touched, not the whole cache.

stim-cli is an optional peer. Without it the cache works exactly the same; it is
just invisible to housekeeping.

`STIM_CLI_METRO_CACHE` overrides the location.

## The NDJSON log reporter

`ndjsonReporter({ dir })` is a Metro `Reporter` that writes every event the dev
server emits as one JSON object per line: bundler events and transform failures
into `<dir>/metro.ndjson`, forwarded in-app console logs and redboxes into
`<dir>/client.ndjson`.

```js
const { ndjsonReporter } = require('@stim-cli/metro');

config.reporter = ndjsonReporter({ dir: '.stim-cli/logs' });
await Metro.runServer(config, { host, port });
```

**It only survives when you host Metro yourself.** Both the Expo CLI and the
React Native CLI overwrite `config.reporter` after loading `metro.config.js`, so
a reporter set there is discarded without a word. Setting it on a config you
pass to `Metro.runServer` is the path that works, and it is how `stim start`
captures a bare React Native project's logs.

Each record is `{ ts, src, level, msg }` plus, when they apply, `event` (the
Metro event name), `stack` (passed through as Metro gave it) and `marker: true`
(written on a finished bundle build, which is what `stim logs --errors` counts
errors from). `dir` defaults to `.stim-cli/logs` under the working directory.

A logging failure is never a server failure: an unwritable directory or an event
shape from a Metro version this package has never seen is counted on
`reporter.drops` and swallowed, not thrown into Metro's build pipeline.

# @stim-cli/expo-build-cache

A local Expo build cache provider. When no native input has changed, the CLI
installs a cached `.app` / `.apk` instead of compiling — which is the difference
between a JS-only change costing a simulator boot and costing a full native
build.

Local on purpose: a directory under `$HOME` shared by every worktree on the
machine. No account, no network, and a second worktree building the same commit
is a hit rather than a second five-minute build.

```bash
npm i -D @stim-cli/expo-build-cache
```

Point your Expo config at it. **Which key depends on the SDK, and the wrong one
is a silent no-op rather than an error:**

```jsonc
// SDK 54+
{ "expo": { "buildCacheProvider": { "plugin": "@stim-cli/expo-build-cache" } } }

// SDK 53 — reads only the experiments key and ignores the top-level one
{ "expo": { "experiments": { "buildCacheProvider": { "plugin": "@stim-cli/expo-build-cache" } } } }
```

Add a `.fingerprintignore` for anything that changes without changing the build.
`ios/Podfile.lock` is the usual culprit: pod checksums can embed absolute paths,
which makes the fingerprint differ per machine and the cache never hit.

Watch for `[build-cache] hit` or `miss` in the output. A miss means you changed
something native — or that you are the first workspace on this commit.

### Housekeeping

The cache registers itself with [`stim-cli`](https://www.npmjs.com/package/stim-cli)
if it is installed, so it can be reported and trimmed:

```bash
npx --package=stim-cli stim gc                            # what it has grown to (reported on every run)
npx --package=stim-cli stim gc --delete --older-than 30   # drop entries unused for 30 days
```

stim-cli is an optional peer. Without it the cache works exactly the same; it is
just invisible to housekeeping.

`STIM_CLI_BUILD_CACHE` overrides the location.
