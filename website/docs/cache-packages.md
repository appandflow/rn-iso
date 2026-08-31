---
title: 'Cache packages'
sidebar_position: 5
description: 'Optional npm packages for builds that run outside Stim'
---

Stim supplies its own cache arguments when it runs Metro and native builds. A
project does not need these packages for `stim start`, `stim ios`, or
`stim android`.

The npm packages are useful when the same project also runs tools outside Stim.

## `@stim-cli/metro`

This package exports a shared Metro `FileStore` and the NDJSON reporter used by
Stim. Add it to a custom Metro process when that process must share transforms
with Stim-managed workspaces.

```bash
npm install --save-dev @stim-cli/metro
```

```js
const { sharedCacheStores } = require('@stim-cli/metro');

config.cacheStores = sharedCacheStores('my-app');
```

## `@stim-cli/expo-build-cache`

This package is a local Expo build-cache provider. It lets direct Expo builds
share native artifacts with Stim.

```bash
npm install --save-dev @stim-cli/expo-build-cache
```

For current Expo SDK versions:

```json
{
  "expo": {
    "buildCacheProvider": {
      "plugin": "@stim-cli/expo-build-cache"
    }
  }
}
```

Expo SDK 53 reads the provider under `expo.experiments.buildCacheProvider`.
Confirm the key for the project's SDK before adding it.

Both packages work without the `stim-cli` npm package. They register their cache
directories in Stim's cache manifest when available, so `stim gc` can report and
trim them.
