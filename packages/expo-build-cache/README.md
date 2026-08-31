# @stim-cli/expo-build-cache

A local Expo build-cache provider that shares `.app` and `.apk` artifacts across
worktrees and direct Expo builds.

If Stim is not installed globally, replace `stim` with `npx stim-cli`.

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

Expo SDK 53 reads this value under `expo.experiments.buildCacheProvider`.

The provider works without the `stim-cli` npm package. When Stim is available,
the provider registers its cache so `stim gc` can report and trim it.

Set `STIM_BUILD_CACHE` to override the cache location.

See the [cache package documentation](https://appandflow.github.io/stim/docs/cache-packages)
for current setup and cleanup guidance.
