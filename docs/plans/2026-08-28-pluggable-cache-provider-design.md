# Pluggable Cache Provider Design

## Goal

Make the cache writes owned by Stim pluggable. The first version covers
Metro transforms and native build artifacts. It keeps the local filesystem as
the fast first tier and permits one optional project provider as the second
tier.

Expo `buildCacheProvider` remains a separate compatibility path. The new API
also works for bare React Native projects.

## Scope

The provider system covers:

- Metro transform cache reads and writes from `@stim-cli/metro`.
- Native `.app` and `.apk` cache reads and writes from `stim ios` and
  `stim android`.

The first implementation supplies the filesystem provider and contract tests.
It does not supply a network provider.

The provider system does not cover compiler-owned caches such as Gradle,
CocoaPods, or Xcode CAS. Those systems have different protocols and lifecycle
rules.

## Architecture

Add a small `@stim-cli/cache` package. The package owns:

- public provider types;
- provider validation and loading;
- timeout and warning policy;
- tier coordination;
- contract-test helpers for provider authors.

A provider factory returns one or both capabilities:

```ts
interface CacheProvider {
  metro?: MetroCacheCapability;
  builds?: BuildCacheCapability;
}
```

`@stim-cli/metro` keeps the Metro adapter. The Stim CLI keeps the native build
adapter. The existing filesystem code becomes the built-in first-tier
provider. The refactor preserves existing paths, keys, APFS copies, pruning,
and `gc` behavior.

A project can configure one optional second tier:

```json
{
  "cache": {
    "provider": "./tools/cache-provider.cjs",
    "options": {
      "bucket": "mobile-cache"
    }
  }
}
```

The existing settings order applies. Machine or repository settings can
override committed project settings. Relative module references resolve from
the settings source that declares them. Provider options use the existing
nested settings merge rules.

Secrets remain outside committed settings. Providers read secrets from the
environment or machine settings.

Each provider declares `apiVersion: 1`. The loader validates the factory and
each advertised capability before the first call. A provider can implement
only Metro or only native builds.

## Cache Contracts

The capability API keeps the two cache data forms separate.

The Metro capability uses Metro's asynchronous cache-store model. It reads and
writes keyed transform values. The composite adapter owns local backfill and
the remote upload queue.

The build capability works with local artifact paths. A build provider can
download an artifact into a destination owned by Stim and can upload an
`.app` directory or `.apk` file. The provider chooses its transport and archive
format. Stim continues to own fingerprint generation and cache keys.

Provider calls receive:

- the cache kind;
- the logical cache key;
- the project root;
- the Metro cache name when applicable;
- the native platform when applicable;
- the configured provider options;
- an `AbortSignal`.

## Metro Data Flow

`@stim-cli/metro` exposes one composite Metro store.

1. Read the local filesystem.
2. On a miss, read the project provider.
3. Copy a provider hit into the local filesystem.
4. Write new transforms to the local filesystem.
5. Queue the same transform for the project provider.

The remote upload queue has fixed concurrency and memory limits. A full queue
skips remote writes and emits one concise warning. The local Metro process
continues.

Metro `clear()` clears only the local filesystem tier. It never deletes shared
remote data.

## Native Build Data Flow

Native builds use this lookup order:

1. Read the local build cache.
2. Read the new project provider.
3. Read Expo `buildCacheProvider` when the Expo project configures one.
4. Join an active build for the same fingerprint.
5. Build when all cache levels miss.

A provider hit is copied into the local cache before installation. A new build
writes to the local cache first. Stim then starts uploads to the new provider
and the Expo provider independently.

`--no-build-cache` skips every cache read. It still replaces the local entry
and uploads the fresh result.

The new provider does not change fingerprint generation, cache keys, artifact
paths, or build-lock keys.

## Expo Compatibility

Expo `buildCacheProvider` stays independent. Stim does not expose the Expo
provider contract through `@stim-cli/cache`.

When both systems are configured, the new project provider runs before the
Expo provider. A new build uploads to both providers. This order preserves the
current Expo behavior while projects adopt the Stim provider API.

## Failure Rules

Cache failures never fail Metro, installation, launch, or a successful native
build.

Stim applies fixed time limits to:

- Metro reads;
- Metro background uploads;
- native build downloads;
- native build uploads.

A timeout, module error, authentication error, or network error produces one
warning for each failure class during one command or supervisor run. The
operation then continues with the local tier.

Metro shutdown can abandon queued uploads. Shutdown does not wait without a
limit. Native commands collect pending uploads near command completion, which
matches the current Expo provider behavior.

The provider runs as trusted project code. A provider must honor the supplied
`AbortSignal` so a timed-out network operation does not keep the process alive.

## Cache Management

The first version keeps remote lifecycle management outside `stim gc`.
`gc` continues to report, trim, and clear only local caches. The provider
contract has no remote deletion operation.

This rule avoids an implicit command that could delete a cache shared by a
team or CI system.

## Testing

The first version uses an in-memory provider as its test second tier. The test
suite proves:

- existing filesystem paths and cache keys remain unchanged;
- a local hit does not call the second tier;
- a provider hit backfills the local tier;
- a miss writes locally before it schedules a provider write;
- Metro queue limits prevent unbounded memory use;
- provider timeouts and errors preserve normal builds and bundles;
- Metro-only and build-only providers load correctly;
- project and machine settings use the existing resolution order;
- iOS and Android use local, new provider, Expo provider, then build lock;
- `--no-build-cache` skips reads and keeps writes;
- `gc` never calls a remote deletion method;
- CommonJS and ESM provider modules load from the project root.

A small end-to-end fixture loads a provider module from `.stim.json`. It
proves that Metro and native build adapters receive the same provider
configuration.

## Compatibility Requirement

The refactor must not change behavior when no second-tier provider is
configured. Existing projects must keep the same local cache hits, command
output, JSON facts, cache registration, and cleanup behavior.
