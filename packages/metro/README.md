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
