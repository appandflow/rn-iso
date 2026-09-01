# @stim-cli/expo-build-cache

A local Expo build-cache provider that shares `.app` and `.apk` artifacts across
worktrees and direct Expo builds.
Stim and Expo CLI compute the fingerprint that keys this cache separately, and
Stim ignores two machine-local Android paths (`android/local.properties`,
`android/.idea`) that Expo CLI does not. On a machine where those exist, the
two hashes differ and each side fills its own entry. List them in the project's
`.fingerprintignore` to bring the hashes back together.

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
