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
npx stim-cli gc                            # what it has grown to (reported on every run)
npx stim-cli gc --delete --older-than 30   # drop entries unused for 30 days
```

Entries are trimmed individually — one file per cache key — so trimming costs
only the entries nothing has touched, not the whole cache.

stim-cli is an optional peer. Without it the cache works exactly the same; it is
just invisible to housekeeping.

The parent location can be overridden by `STIM_CLI_METRO_CACHE`, or
machine-wide by `caches.metroCache` in `~/.stim-cli/config.json` (an absolute
path; the env var wins). The sanitized name passed to `sharedCacheStores` is
always appended below that parent, so `sharedCacheStores('@scope/app')` uses
`<parent>/-scope-app`. The CLI and this package resolve both identically.

Earlier versions wrote a named store directly into an overridden parent. A new
registration marks the named layout and replaces an exact unmarked legacy
parent entry. If an older package registers the parent again later, current
`stim-cli gc` ignores that provably legacy entry while a marked child is
registered, so it cannot prune the child at the wrong depth. A marked named
store that later becomes another override parent remains visible but report-only
while its marked child exists. The old root-level cache files are left untouched
for manual cleanup.

## The NDJSON log reporter

`ndjsonReporter({ dir })` is a Metro `Reporter` that writes every event the dev
server emits as one JSON object per line: bundler events and transform failures
into `<dir>/metro.ndjson`, forwarded in-app console logs and redboxes into
`<dir>/client.ndjson`.

```js
const { ndjsonReporter } = require('@stim-cli/metro');

config.reporter = ndjsonReporter({
  dir: '~/.stim-cli/workspaces/my-app--<16hex-path-digest>/logs',
});
await Metro.runServer(config, { host, port });
```

**It only survives when you host Metro yourself.** Both the Expo CLI and the
React Native CLI overwrite `config.reporter` after loading `metro.config.js`, so
a reporter set there is discarded without a word. Setting it on a config you
pass to `Metro.runServer` is the path that works, and it is how `stim-cli start`
captures a bare React Native project's logs.

Each record is `{ ts, src, level, msg }` plus, when they apply, `event` (the
Metro event name), `stack` (passed through as Metro gave it) and `marker: true`
(written on a finished bundle build, which is what `stim-cli logs --errors` counts
errors from). When used by stim-cli, `dir` defaults to
`$STIM_CLI_HOME/workspaces/<readable-project-slug>--<16hex-path-digest>/logs`
(by default `~/.stim-cli/workspaces/...`), outside the working directory.

A logging failure is never a server failure: an unwritable directory or an event
shape from a Metro version this package has never seen is counted on
`reporter.drops` and swallowed, not thrown into Metro's build pipeline.
