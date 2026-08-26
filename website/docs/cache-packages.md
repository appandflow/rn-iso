---
title: 'The cache packages'
sidebar_position: 2
description: '@rn-iso/metro and @rn-iso/expo-build-cache: the shared transform cache and the local Expo build cache'
---

Two small packages wire a project's own toolchain into the shared caches. Both are CJS on purpose (they are loaded by `require()` from `metro.config.js` and the Expo CLI), and neither imports rn-iso -- a missing or old CLI never breaks a bundler config or a build.

# @rn-iso/metro

The two things [`rn-iso`](https://www.npmjs.com/package/rn-iso) wires into
Metro: one transform cache shared by every worktree on the machine, and a
reporter that writes the dev server's events as NDJSON.

```bash
npm i -D @rn-iso/metro
```

## The shared transform cache

Metro's default cache lives under the project, so a second worktree starts cold
and re-transforms the whole module graph — thousands of modules, every time.
Pointing every checkout at one store means only the first one pays.

```js
// metro.config.js
const { sharedCacheStores } = require('@rn-iso/metro');

const config = getDefaultConfig(__dirname);
config.cacheStores = sharedCacheStores('myapp');
module.exports = config;
```

The `FileStore` itself is six lines; what this packages is the housekeeping.
**Metro's cache has no eviction logic whatsoever**, so left alone it grows until
the disk does. Registering it with
[`rn-iso`](https://www.npmjs.com/package/rn-iso) makes it visible:

```bash
npx rn-iso gc                            # what it has grown to (reported on every run)
npx rn-iso gc --delete --older-than 30   # drop entries unused for 30 days
```

Entries are trimmed individually — one file per cache key — so trimming costs
only the entries nothing has touched, not the whole cache.

rn-iso is an optional peer. Without it the cache works exactly the same; it is
just invisible to housekeeping.

`RN_ISO_METRO_CACHE` overrides the location.

## The NDJSON log reporter

`ndjsonReporter({ dir })` is a Metro `Reporter` that writes every event the dev
server emits as one JSON object per line: bundler events and transform failures
into `<dir>/metro.ndjson`, forwarded in-app console logs and redboxes into
`<dir>/client.ndjson`.

```js
const { ndjsonReporter } = require('@rn-iso/metro');

config.reporter = ndjsonReporter({ dir: '.rn-iso/logs' });
await Metro.runServer(config, { host, port });
```

**It only survives when you host Metro yourself.** Both the Expo CLI and the
React Native CLI overwrite `config.reporter` after loading `metro.config.js`, so
a reporter set there is discarded without a word. Setting it on a config you
pass to `Metro.runServer` is the path that works, and it is how `rn-iso start`
captures a bare React Native project's logs.

Each record is `{ ts, src, level, msg }` plus, when they apply, `event` (the
Metro event name), `stack` (passed through as Metro gave it) and `marker: true`
(written on a finished bundle build, which is what `rn-iso logs --errors` counts
errors from). `dir` defaults to `.rn-iso/logs` under the working directory.

A logging failure is never a server failure: an unwritable directory or an event
shape from a Metro version this package has never seen is counted on
`reporter.drops` and swallowed, not thrown into Metro's build pipeline.

# @rn-iso/expo-build-cache

A local Expo build cache provider. When no native input has changed, the CLI
installs a cached `.app` / `.apk` instead of compiling — which is the difference
between a JS-only change costing a simulator boot and costing a full native
build.

Local on purpose: a directory under `$HOME` shared by every worktree on the
machine. No account, no network, and a second worktree building the same commit
is a hit rather than a second five-minute build.

```bash
npm i -D @rn-iso/expo-build-cache
```

Point your Expo config at it. **Which key depends on the SDK, and the wrong one
is a silent no-op rather than an error:**

```jsonc
// SDK 54+
{ "expo": { "buildCacheProvider": { "plugin": "@rn-iso/expo-build-cache" } } }

// SDK 53 — reads only the experiments key and ignores the top-level one
{ "expo": { "experiments": { "buildCacheProvider": { "plugin": "@rn-iso/expo-build-cache" } } } }
```

Add a `.fingerprintignore` for anything that changes without changing the build.
`ios/Podfile.lock` is the usual culprit: pod checksums can embed absolute paths,
which makes the fingerprint differ per machine and the cache never hit.

Watch for `[build-cache] hit` or `miss` in the output. A miss means you changed
something native — or that you are the first workspace on this commit.

### Housekeeping

The cache registers itself with [`rn-iso`](https://www.npmjs.com/package/rn-iso)
if it is installed, so it can be reported and trimmed:

```bash
npx rn-iso gc                            # what it has grown to (reported on every run)
npx rn-iso gc --delete --older-than 30   # drop entries unused for 30 days
```

rn-iso is an optional peer. Without it the cache works exactly the same; it is
just invisible to housekeeping.

`RN_ISO_BUILD_CACHE` overrides the location.
