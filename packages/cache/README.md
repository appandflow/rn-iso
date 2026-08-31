# @stim-cli/cache

The cache provider contract Stim uses for Metro transforms and native build
artifacts, plus the tier coordination, timeout, and warning policy that sit in
front of it.

The local filesystem is always the first tier. A project can add one optional
second tier by pointing `cache.provider` at a module that implements this
contract. Stim ships no network provider; writing one is an addition, not a
change to Stim.

If Stim is not installed globally, replace `stim` with `npx stim-cli`.

## Selecting a provider

```json
{
  "cache": {
    "provider": "./tools/cache-provider.cjs",
    "options": { "bucket": "mobile-cache" }
  }
}
```

The reference is a package name or a path relative to the settings file that
declares it. Machine settings override committed `.stim.json` settings, and the
existing nested merge rules apply to `cache.options`. Keep secrets out of
committed settings; read them from the environment or from machine settings.

## Writing a provider

```js
export const apiVersion = 1;

export async function createCacheProvider({ projectRoot, options }) {
  return {
    metro: {
      async get({ key, cacheName, signal }) {
        return null;
      },
      async set({ key, value, cacheName, signal }) {},
    },
    builds: {
      async resolve({ platform, key, destinationDir, signal }) {
        return null;
      },
      async store({ platform, key, sourcePath, overwrite, signal }) {},
    },
  };
}
```

A provider implements one or both capabilities. It owns transport,
serialization, archive format, authentication, and remote retention. Stim owns
fingerprints, cache keys, and local artifact paths.

`metro.get` returns the stored value or `null`. `builds.resolve` places the
artifact for the key under `destinationDir` and returns its path, or returns
`null`. `builds.store` receives the `.app` directory or `.apk` file that Stim
just built.

Every call receives an `AbortSignal`. A provider must honor it: Stim abandons
the call at the deadline and keeps building or bundling with the local tier.

`stim gc` never deletes provider data, and the contract has no delete
operation, so shared team or CI data is never removed by a local command.

## Failure rules

Provider failures are cache misses. A timeout, module error, authentication
error, or network error produces one warning per failure class per command or
supervisor run and never fails a bundle, an install, a launch, or a successful
build.

## Contract tests

Run the shipped checks against your own module:

```js
import { runCacheProviderContract } from '@stim-cli/cache';

const results = await runCacheProviderContract({
  provider: await createCacheProvider({ projectRoot, options }),
  projectRoot,
  workDir,
});

for (const result of results) {
  if (!result.passed) throw new Error(`${result.name}: ${result.error}`);
}
```

`cacheProviderContractChecks()` returns the same checks as individual cases for
a test runner that reports each one separately. Both helpers only check the
capabilities a provider advertises.

The npm scope remains `@stim-cli` until the `@stim` scope is available.
