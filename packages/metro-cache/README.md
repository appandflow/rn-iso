# @rn-iso/metro-cache

One Metro transform cache shared by every worktree on the machine.

Metro's default cache lives under the project, so a second worktree starts cold
and re-transforms the whole module graph — thousands of modules, every time.
Pointing every checkout at one store means only the first one pays.

```bash
npm i -D @rn-iso/metro-cache
```

```js
// metro.config.js
const { sharedCacheStores } = require('@rn-iso/metro-cache');

const config = getDefaultConfig(__dirname);
config.cacheStores = sharedCacheStores('myapp');
module.exports = config;
```

The `FileStore` itself is six lines; what this packages is the housekeeping.
**Metro's cache has no eviction logic whatsoever**, so left alone it grows until
the disk does. Registering it with
[`rn-iso`](https://www.npmjs.com/package/rn-iso) makes it visible:

```bash
npx rn-iso gc --caches                            # what it has grown to
npx rn-iso gc --caches --delete --older-than 30   # drop entries unused for 30 days
```

Entries are trimmed individually — one file per cache key — so trimming costs
only the entries nothing has touched, not the whole cache.

rn-iso is an optional peer. Without it the cache works exactly the same; it is
just invisible to housekeeping.

`RN_ISO_METRO_CACHE` overrides the location.
