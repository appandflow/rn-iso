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
npx stim-cli gc                            # what it has grown to (reported on every run)
npx stim-cli gc --delete --older-than 30   # drop entries unused for 30 days
```

stim-cli is an optional peer. Without it the cache works exactly the same; it is
just invisible to housekeeping.

The location can be overridden by `STIM_CLI_BUILD_CACHE`, or machine-wide by `caches.buildCache` in `~/.stim-cli/config.json` (an absolute path; the env var wins). The CLI and this package resolve both identically, so they always share one store.
