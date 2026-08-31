# Pluggable Cache Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add one project-selected cache provider for Metro transforms and native build artifacts while preserving the local filesystem as tier one.

**Architecture:** A new `@stim-cli/cache` package owns the public capability contract, provider loading, bounded calls, and tier helpers. `@stim-cli/metro` adapts the Metro capability, while the Stim CLI adapts the build capability and keeps Expo `buildCacheProvider` as a later independent tier.

**Tech Stack:** TypeScript, Node.js 22, Metro `CacheStore`, Commander, Vitest, Node test runner

---

Use `@superpowers:test-driven-development` for each implementation task. Keep every existing cache path and key unchanged. Do not add a network provider in this change.

### Task 1: Add the provider contract and loader

**Files:**

- Create: `packages/cache/package.json`
- Create: `packages/cache/tsconfig.json`
- Create: `packages/cache/tsdown.config.ts`
- Create: `packages/cache/index.ts`
- Create: `packages/cache/__tests__/provider.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Step 1: Write failing contract tests**

Create `packages/cache/__tests__/provider.test.ts`. Cover these cases:

```ts
test('loads a CommonJS provider from the project root', async () => {
  const loaded = await loadCacheProvider({
    projectRoot,
    config: { provider: './cache.cjs', options: { bucket: 'mobile' }, baseDir: projectRoot },
  });
  expect(loaded.name).toBe('./cache.cjs');
  expect(loaded.provider?.metro).toBeDefined();
});

test('loads an ESM provider from the project root', async () => {
  // Write cache.mjs with apiVersion: 1 and createCacheProvider().
  // Assert that the factory receives projectRoot and options.
});

test('accepts providers with only one capability', async () => {
  // Check Metro-only and build-only modules.
});

test('rejects an unsupported API version without throwing', async () => {
  expect(loaded).toMatchObject({ unavailable: expect.stringMatching(/apiVersion/) });
});

test('rejects malformed capability methods without throwing', async () => {
  expect(loaded).toMatchObject({ unavailable: expect.stringMatching(/metro.*get.*set/) });
});
```

Use temporary project directories. Write fixture provider modules inside each directory. Do not add permanent fixture packages.

**Step 2: Run the tests and verify failure**

Run:

```bash
npx vitest run packages/cache/__tests__/provider.test.ts
```

Expected: FAIL because `@stim-cli/cache` and `loadCacheProvider` do not exist.

**Step 3: Add the workspace package**

Use this package shape:

```json
{
  "name": "@stim-cli/cache",
  "version": "1.2.0",
  "description": "Cache provider contract and tier coordination for Stim",
  "license": "MIT",
  "files": ["dist", "README.md", "LICENSE"],
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "scripts": { "build": "tsdown" },
  "engines": { "node": ">=22" }
}
```

Configure `tsdown` to emit ESM, CJS, and declarations from `index.ts`. Extend `../../tsconfig.base.json`. Add `packages/cache/tsconfig.json` to the root `typecheck` script.

Run `npm install --package-lock-only --ignore-scripts` to register the new workspace in `package-lock.json`. The command must not add external dependencies.

**Step 4: Add the public capability types**

Add these contracts to `packages/cache/index.ts`:

```ts
export const CACHE_PROVIDER_API_VERSION = 1 as const;

export interface CacheProviderConfig {
  provider: string;
  options: Record<string, unknown>;
  baseDir: string;
}

export interface MetroCacheContext {
  projectRoot: string;
  cacheName: string;
  signal: AbortSignal;
}

export interface MetroCacheCapability {
  get(input: MetroCacheContext & { key: Buffer }): unknown | null | Promise<unknown | null>;
  set(input: MetroCacheContext & { key: Buffer; value: unknown }): void | Promise<void>;
}

export interface BuildCacheContext {
  projectRoot: string;
  platform: 'ios' | 'android';
  key: string;
  signal: AbortSignal;
}

export interface BuildCacheCapability {
  resolve(input: BuildCacheContext & { destinationDir: string }): string | null | Promise<string | null>;
  store(input: BuildCacheContext & { sourcePath: string; overwrite: boolean }): void | Promise<void>;
}

export interface CacheProvider {
  metro?: MetroCacheCapability;
  builds?: BuildCacheCapability;
}

export interface CacheProviderModule {
  apiVersion: 1;
  createCacheProvider(input: {
    projectRoot: string;
    options: Record<string, unknown>;
  }): CacheProvider | Promise<CacheProvider>;
}
```

Do not add `clear` or delete operations to the remote capability contract.

**Step 5: Implement provider resolution and validation**

Implement `loadCacheProvider()` with these rules:

1. Return `{ none: true }` for an absent config.
2. Resolve package names and relative paths with `createRequire(join(baseDir, 'package.json')).resolve(reference)`.
3. Load the resolved file with dynamic `import(pathToFileURL(resolved).href)`.
4. Unwrap `module.default` only when the namespace does not carry `apiVersion`.
5. Require `apiVersion === 1` and `createCacheProvider` as a function.
6. Validate each advertised capability.
7. Require at least one capability.
8. Return `{ unavailable }` for all load and validation errors.

Use this result shape:

```ts
export interface LoadCacheProviderResult {
  provider?: CacheProvider;
  name?: string;
  none?: true;
  unavailable?: string;
}
```

The loader must not log. Callers own warning format and deduplication.

**Step 6: Run focused checks**

Run:

```bash
npx vitest run packages/cache/__tests__/provider.test.ts
npm run typecheck
```

Expected: all provider tests pass and TypeScript exits 0.

**Step 7: Commit**

```bash
git add package.json package-lock.json packages/cache
git commit -m "feat(cache): add provider contract"
```

### Task 2: Resolve project provider settings and pass them to Metro

**Files:**

- Modify: `packages/stim-cli/src/settings.ts`
- Modify: `packages/stim-cli/src/commands/start.ts:214-300`
- Modify: `packages/stim-cli/src/__tests__/settings.test.ts`
- Modify: `packages/stim-cli/src/__tests__/start.test.ts`
- Modify: `packages/cache/index.ts`
- Modify: `packages/cache/__tests__/provider.test.ts`

**Step 1: Write failing settings tests**

Add tests that prove:

- `cache.provider` and `cache.options` are known settings.
- Project settings override repository and committed settings.
- Repository settings override committed settings.
- Provider options use the current nested merge rules.
- The returned `baseDir` belongs to the layer that supplied `cache.provider`.
- A relative committed provider resolves from the directory containing `.stim.json`.

Use this target helper:

```ts
resolveCacheProviderConfig({ projectPath, gitCommonDir, repoRoot });
// -> { provider, options, baseDir } | null
```

For machine project settings, use `projectPath` as `baseDir`. For machine repository settings and committed settings, use `repoRoot`.

**Step 2: Write failing environment handoff tests**

Add provider-package tests for:

```ts
const env = cacheProviderEnv(config);
expect(cacheProviderConfigFromEnv(env)).toEqual(config);
```

Add `start` tests that assert the detached supervisor receives the encoded provider config. Also assert no internal environment variable is added when no provider is configured.

**Step 3: Run tests and verify failure**

Run:

```bash
npx vitest run packages/stim-cli/src/__tests__/settings.test.ts packages/stim-cli/src/__tests__/start.test.ts packages/cache/__tests__/provider.test.ts
```

Expected: FAIL because the cache settings and environment helpers do not exist.

**Step 4: Implement settings resolution**

Add `cache.provider` and `cache.options` to `KNOWN_SETTINGS`.

Implement `resolveCacheProviderConfig()` beside `resolveSettings()`. Inspect the three source layers before merging so the provider reference keeps its base directory. Normalize missing or non-object options to `{}`. Return `null` for an absent provider. Return an invalid value to callers only as an `unavailable` provider result; do not make unrelated commands fail.

**Step 5: Implement the supervisor environment handoff**

In `@stim-cli/cache`, export a private-looking but public transport constant and helpers:

```ts
export const CACHE_PROVIDER_ENV = 'STIM_CACHE_PROVIDER_CONFIG';
export function cacheProviderEnv(config: CacheProviderConfig): string;
export function cacheProviderConfigFromEnv(env?: NodeJS.ProcessEnv): CacheProviderConfig | null;
```

Encode only JSON data. Reject malformed JSON and invalid shapes as `null`.

In `start.ts`, resolve the provider config after the project root is known. Pass a copied environment to the supervisor:

```ts
const childEnv = { ...process.env };
if (providerConfig) childEnv[CACHE_PROVIDER_ENV] = cacheProviderEnv(providerConfig);
else delete childEnv[CACHE_PROVIDER_ENV];
```

Do not mutate `process.env`.

**Step 6: Run focused checks**

Run the command from Step 3. Expected: all tests pass.

**Step 7: Commit**

```bash
git add packages/cache packages/stim-cli/src/settings.ts packages/stim-cli/src/commands/start.ts packages/stim-cli/src/__tests__/settings.test.ts packages/stim-cli/src/__tests__/start.test.ts
git commit -m "feat(cache): resolve project providers"
```

### Task 3: Add the tiered Metro store

**Files:**

- Create: `packages/cache/metro.ts`
- Create: `packages/cache/__tests__/metro.test.ts`
- Modify: `packages/cache/index.ts`
- Modify: `packages/cache/tsdown.config.ts`
- Modify: `packages/metro/index.ts:32-166`
- Modify: `packages/metro/package.json`
- Modify: `packages/stim-cli/src/__tests__/cache-packages.test.ts`
- Modify: `packages/metro/README.md`

**Step 1: Write failing tier tests**

Use fake local and remote stores. Cover:

```ts
test('a local hit does not load or call the provider', async () => {});
test('a provider hit is written locally before it is returned', async () => {});
test('a total miss returns null', async () => {});
test('set waits for the local write but not the provider write', async () => {});
test('clear calls only the local store', async () => {});
test('a provider timeout returns a local miss', async () => {});
test('one provider error emits one warning per failure class', async () => {});
test('the queue enforces item and byte limits', async () => {});
```

Pin constants in tests:

```ts
METRO_READ_TIMEOUT_MS = 2_000;
METRO_WRITE_TIMEOUT_MS = 10_000;
METRO_UPLOAD_CONCURRENCY = 4;
METRO_UPLOAD_MAX_ITEMS = 128;
METRO_UPLOAD_MAX_BYTES = 32 * 1024 * 1024;
```

Use injected limits in saturation tests so the test does not allocate 32 MB.

**Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run packages/cache/__tests__/metro.test.ts packages/stim-cli/src/__tests__/cache-packages.test.ts
```

Expected: FAIL because `createTieredMetroStore` does not exist.

**Step 3: Implement bounded calls**

In `packages/cache/index.ts`, add `callWithTimeout()`. It creates an `AbortController`, passes its signal into the provider call, aborts at the deadline, and always clears the timer.

Return a flat result:

```ts
{ value?: T; failed?: string; timedOut?: true }
```

The timeout wrapper must not log or throw provider errors.

**Step 4: Implement the Metro composite**

Create `createTieredMetroStore()` in `packages/cache/metro.ts`.

The returned object must satisfy Metro's structural contract:

```ts
interface MetroStore {
  name?: string;
  get(key: Buffer): Promise<unknown | null>;
  set(key: Buffer, value: unknown): Promise<void>;
  clear(): void | Promise<void>;
}
```

Implement these exact rules:

- `get`: local, provider, local backfill, return.
- `set`: await local, estimate value bytes, enqueue provider write, return.
- `clear`: local only.
- Provider load and call failures use `warnOnce(code, message)`.
- Buffer size is `value.length`.
- Other values use `Buffer.byteLength(JSON.stringify(value))`.
- A value that cannot serialize skips the provider write and warns once.
- Queue completion releases its item and byte reservation in `finally`.

Export a `flush()` method only on the richer return type for tests and bounded supervisor shutdown. Metro ignores this extra method.

**Step 5: Wire `@stim-cli/metro`**

Add `@stim-cli/cache` as a workspace dependency.

Keep `sharedCacheStores(name, options)` synchronous. Construct the existing `FileStore` first. Read provider configuration in this order:

1. `STIM_CACHE_PROVIDER_CONFIG` from the supervisor.
2. The nearest committed `.stim.json` when Metro runs outside Stim.
3. No second tier.

Pass a lazy provider loader to `createTieredMetroStore()`. Return one composite store in the array. Preserve `cacheRoot(name)` and cache registration unchanged.

Keep the existing `FileStore` injection option. Add loader and warning injections for tests.

**Step 6: Run focused checks**

Run:

```bash
npx vitest run packages/cache/__tests__/metro.test.ts packages/stim-cli/src/__tests__/cache-packages.test.ts
npm run typecheck
```

Expected: all tests pass. The existing path-equality tests still pass.

**Step 7: Commit**

```bash
git add packages/cache packages/metro packages/stim-cli/src/__tests__/cache-packages.test.ts package-lock.json
git commit -m "feat(metro): add provider cache tier"
```

### Task 4: Add the tiered build-cache coordinator

**Files:**

- Create: `packages/cache/builds.ts`
- Create: `packages/cache/__tests__/builds.test.ts`
- Modify: `packages/cache/index.ts`
- Modify: `packages/cache/tsdown.config.ts`
- Modify: `packages/stim-cli/src/build-cache.ts:198-260`
- Modify: `packages/stim-cli/src/__tests__/build-cache.test.ts`
- Modify: `packages/stim-cli/package.json`

**Step 1: Write failing build-tier tests**

Cover these behaviors with fake capabilities:

```ts
test('local hit does not call the provider', async () => {});
test('provider hit is stored locally and returns tier provider', async () => {});
test('local backfill failure still returns the downloaded artifact', async () => {});
test('skipRead bypasses both tiers', async () => {});
test('fresh build stores locally before provider upload starts', async () => {});
test('provider timeout and failure return a miss', async () => {});
```

Pin these constants:

```ts
BUILD_RESOLVE_TIMEOUT_MS = 30_000;
BUILD_UPLOAD_TIMEOUT_MS = 60_000;
```

**Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run packages/cache/__tests__/builds.test.ts packages/stim-cli/src/__tests__/build-cache.test.ts
```

Expected: FAIL because the build coordinator and filesystem capability do not exist.

**Step 3: Implement the filesystem build capability**

Wrap the current functions without moving cache paths or copy logic:

```ts
export function filesystemBuildCapability(root = cacheRoot()): BuildCacheCapability {
  return {
    resolve: ({ platform, key }) => resolveBuild(platform, key, root),
    store: ({ platform, key, sourcePath, overwrite }) => {
      storeBuild(platform, key, sourcePath, { root, overwrite });
    },
  };
}
```

Keep `resolveBuild()` and `storeBuild()` exported for compatibility and focused tests.

**Step 4: Implement build tier helpers**

Export:

```ts
resolveTieredBuild({ local, provider, context, destinationDir, skipRead, warn });
// -> { path: string; tier: 'local' | 'provider'; providerName?: string } | null

storeTieredBuild({ local, provider, context, sourcePath, overwrite, warn });
// -> { localPath: string | null; providerUpload: Promise<ProviderCallResult<void>> | null }
```

The resolve helper copies a provider hit into the local tier before it returns. The store helper completes the local store first and then starts the provider upload. It returns the upload promise without awaiting it.

**Step 5: Run focused checks**

Run the command from Step 2 and `npm run typecheck`. Expected: all checks pass.

**Step 6: Commit**

```bash
git add packages/cache packages/stim-cli/src/build-cache.ts packages/stim-cli/src/__tests__/build-cache.test.ts packages/stim-cli/package.json package-lock.json
git commit -m "feat(cache): coordinate build cache tiers"
```

### Task 5: Integrate the project provider into iOS builds

**Files:**

- Modify: `packages/stim-cli/src/commands/ios.ts:929-1174`
- Modify: `packages/stim-cli/src/commands/ios.ts:1360-1425`
- Modify: `packages/stim-cli/src/__tests__/ios-command.test.ts`

**Step 1: Write failing iOS command tests**

Extend the existing dependency harness. Add call records for provider config resolution, provider loading, tier resolution, and provider upload.

Add tests that prove:

- A local hit does not load either second tier.
- A bare React Native project can use the new provider.
- A new-provider hit occurs before Expo provider loading.
- An Expo provider runs after the new provider misses.
- A build uploads to the new provider and Expo provider independently.
- `--no-build-cache` skips both lookups and starts both uploads.
- Provider load, resolve, and upload failures print one cache note and preserve success.
- `cacheHit` remains `"remote"` for either second-tier hit.
- No configured new provider preserves the existing output and call order.

**Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run packages/stim-cli/src/__tests__/ios-command.test.ts
```

Expected: the new-provider tests fail because iOS only knows the local and Expo tiers.

**Step 3: Load the new provider once**

Resolve `cache.provider` from the same settings context already created at line 929. Load it after fingerprinting and only when the local tier misses or a fresh build will need upload.

Report an unusable configured provider once:

```text
cache  provider not usable (<reference>): <reason>; using local cache
```

Do not run Expo authentication checks for the new provider.

**Step 4: Insert the new lookup before Expo**

Use `resolveTieredBuild()` for local plus new-provider lookup. Preserve the current fingerprint line. On a project-provider hit:

```text
cache  provider hit (<reference>) -> stored locally
```

Only load and resolve Expo `buildCacheProvider` when both earlier tiers miss.

Keep build-lock acquisition after both provider systems miss.

**Step 5: Upload after a build**

Use `storeTieredBuild()` to write locally and start the new-provider upload. Start the Expo upload independently, as the command does now. Collect both promises near command completion. A failure or timeout becomes a note and does not change the command result.

Do not combine the two provider result types.

**Step 6: Run focused tests**

Run the command from Step 2. Expected: all iOS command tests pass.

**Step 7: Commit**

```bash
git add packages/stim-cli/src/commands/ios.ts packages/stim-cli/src/__tests__/ios-command.test.ts
git commit -m "feat(ios): use project cache provider"
```

### Task 6: Integrate the project provider into Android builds

**Files:**

- Modify: `packages/stim-cli/src/commands/android.ts:853-1080`
- Modify: `packages/stim-cli/src/commands/android.ts` build-store and completion sections
- Modify: `packages/stim-cli/src/__tests__/android-command.test.ts`

**Step 1: Write failing Android command tests**

Mirror the iOS cases. Assert the exact order:

```text
local -> project provider -> Expo provider -> build lock -> build
```

Also prove that a bare React Native Android app uses the new provider without reading Expo config.

**Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run packages/stim-cli/src/__tests__/android-command.test.ts
```

Expected: the new-provider tests fail.

**Step 3: Apply the same coordinator flow**

Use the shared settings, loader, resolve helper, and store helper. Keep Android-specific facts and diagnostics unchanged. Keep the current Expo provider logic after the new tier.

Do not copy the coordinator implementation into `android.ts`. Only command-specific sequencing belongs there.

**Step 4: Run focused tests**

Run:

```bash
npx vitest run packages/stim-cli/src/__tests__/android-command.test.ts packages/stim-cli/src/__tests__/ios-command.test.ts packages/cache/__tests__/builds.test.ts
```

Expected: all tests pass.

**Step 5: Commit**

```bash
git add packages/stim-cli/src/commands/android.ts packages/stim-cli/src/__tests__/android-command.test.ts
git commit -m "feat(android): use project cache provider"
```

### Task 7: Document the provider system

**Files:**

- Create: `packages/cache/README.md`
- Create: `packages/cache/LICENSE`
- Modify: `README.md`
- Modify: `packages/stim-cli/README.md`
- Modify: `packages/metro/README.md`
- Modify: `packages/stim-cli/src/commands/guide.ts`
- Modify: `packages/stim-cli/src/__tests__/guide.test.ts`
- Modify: `packages/stim-cli/skill/SKILL.md`

**Step 1: Write failing guide tests**

Add guide assertions for:

- `cache.provider` and `cache.options`.
- Local-first lookup order.
- Metro and native build capabilities.
- Expo `buildCacheProvider` independence.
- Secrets outside committed JSON.
- Remote data exclusion from `gc`.

**Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run packages/stim-cli/src/__tests__/guide.test.ts
```

Expected: FAIL because the guide and doctor do not describe the new provider.

**Step 3: Write provider author documentation**

Document one complete provider module in `packages/cache/README.md`:

```ts
export const apiVersion = 1;

export async function createCacheProvider({ projectRoot, options }) {
  return {
    metro: {
      async get({ key, signal }) {},
      async set({ key, value, signal }) {},
    },
    builds: {
      async resolve({ platform, key, destinationDir, signal }) {},
      async store({ platform, key, sourcePath, overwrite, signal }) {},
    },
  };
}
```

State that the provider owns transport, serialization, archive format, authentication, and remote retention.

**Step 4: Update user documentation**

Add `@stim-cli/cache` to the root package table. Update the shared-cache section and command guide. Keep Expo provider documentation, but place it after the new provider order.

Update the shipped skill because agents use it as the operational contract. State that provider failures remain cache misses and that `gc` does not delete remote objects.

**Step 5: Run focused checks**

Run the command from Step 2. Expected: all tests pass.

**Step 6: Commit**

```bash
git add README.md packages/cache packages/metro/README.md packages/stim-cli/README.md packages/stim-cli/src/commands/guide.ts packages/stim-cli/src/__tests__/guide.test.ts packages/stim-cli/skill/SKILL.md
git commit -m "docs(cache): document provider API"
```

### Task 8: Add the end-to-end provider fixture

**Files:**

- Create: `test/e2e/cache-provider-flow.e2e.js`
- Modify: `docs/e2e-and-ci.md`

**Step 1: Write the failing end-to-end test**

Create a temporary bare React Native project with:

- `.stim.json` containing one relative provider module;
- a provider that records factory input and capability calls as NDJSON;
- a fake local Metro store;
- a synthetic `.app` or `.apk` artifact.

The test must prove:

1. `@stim-cli/metro` loads the committed provider and passes its options.
2. A provider Metro hit backfills the fake local store.
3. Stim settings resolve the same provider reference and options.
4. The build coordinator uses the provider artifact and backfills the real temporary filesystem cache.
5. The provider record contains the same project root for both capabilities.
6. No provider deletion call exists.

**Step 2: Run the test and verify failure**

Run:

```bash
node --test test/e2e/cache-provider-flow.e2e.js
```

Expected: FAIL until the full provider path is wired.

**Step 3: Make only fixture-level corrections**

Fix exports, build paths, or fixture setup exposed by the end-to-end test. Do not add new provider behavior in this task.

**Step 4: Run both cache end-to-end tests**

Run:

```bash
node --test test/e2e/cache-flow.e2e.js test/e2e/cache-provider-flow.e2e.js
```

Expected: both files pass.

**Step 5: Commit**

```bash
git add test/e2e/cache-provider-flow.e2e.js docs/e2e-and-ci.md
git commit -m "test(cache): verify provider flow end to end"
```

### Task 9: Run release checks and review the diff

**Files:**

- Modify only files required to fix failures caused by this feature.

**Step 1: Run formatting**

Run:

```bash
npm run format
npm run format:check
```

Expected: both commands exit 0.

**Step 2: Run static checks**

Run:

```bash
npm run typecheck
npm run lint
npm run knip
```

Expected: all commands exit 0.

**Step 3: Run unit and end-to-end tests**

Run:

```bash
npm test
npm run test:e2e
```

Expected: all tests pass.

**Step 4: Build every package**

Run:

```bash
npm run build
```

Expected: `@stim-cli/cache`, `@stim-cli/metro`, `@stim-cli/expo-build-cache`, and `Stim` build successfully with declarations.

**Step 5: Inspect the final diff**

Run:

```bash
git status --short
git diff --stat HEAD~8..HEAD
git diff --check HEAD~8..HEAD
```

Confirm that unrelated untracked files remain unchanged. Confirm that no cache
path, fingerprint key, or Expo provider contract changed.

**Step 6: Use completion verification**

Invoke `@superpowers:verification-before-completion`. Record the commands and results before claiming success.

**Step 7: Commit any check-only corrections**

If Step 1 changed formatting or a release check required a scoped correction:

```bash
git add <only-the-files-corrected>
git commit -m "fix(cache): pass release checks"
```

If no file changed, do not create an empty commit.
