# @stim-cli/metro

Optional Metro integration for Stim. It exports a transform cache shared across
worktrees and an NDJSON reporter for structured Metro and client logs.

If Stim is not installed globally, replace `stim` with `npx stim-cli`.

```bash
npm install --save-dev @stim-cli/metro
```

## Shared transforms

```js
const { sharedCacheStores } = require('@stim-cli/metro');

config.cacheStores = sharedCacheStores('my-app');
```

Set `STIM_METRO_CACHE` to override the shared cache location.

## Optional second tier

The filesystem cache above is always the first tier. When the project selects a
cache provider, the exported store reads it after a local miss, writes provider
hits back to the filesystem, and queues new transforms for the provider without
blocking Metro. Provider failures are misses.

```json
{
  "cache": {
    "provider": "./tools/cache-provider.cjs",
    "options": { "bucket": "mobile-cache" }
  }
}
```

Under `stim start` the supervisor passes the resolved selection to Metro. A
Metro process outside Stim reads the nearest committed `.stim.json`. See
[`@stim-cli/cache`](https://www.npmjs.com/package/@stim-cli/cache) for the
provider contract. `clear()` only clears the local tier.

## Log reporter

```js
const { ndjsonReporter } = require('@stim-cli/metro');

config.reporter = ndjsonReporter({ dir: '/absolute/log/directory' });
```

The reporter must be attached to the config passed directly to
`Metro.runServer`. React Native and Expo CLIs can replace a reporter declared in
`metro.config.js`.

Stim supplies this integration automatically for Stim-managed servers. Add the
package directly only for Metro processes that run outside Stim.

See the [cache package documentation](https://appandflow.github.io/stim/docs/cache-packages)
for current usage and cleanup guidance.
