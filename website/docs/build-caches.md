---
title: 'Build caches'
sidebar_position: 3
description: 'Fingerprint-keyed native builds shared across worktrees, and single-flight compiles'
---

Everything `gc` reclaims is _dead_: a project entry whose directory no longer
exists belongs to nobody, and a `stim-cli-*` simulator nothing references is
never coming back. Shared build caches are the opposite -- alive by design,
shared by every project on the machine, and pruned by nothing:

- **Metro's `FileStore`** has no eviction logic whatsoever.
- **Xcode's compilation cache** has no size cap.
- **Metro file maps** accumulate one file per project root ever served.

So every `gc` run reports them -- in their own bucket, tagged _registered_ or
_detected_, and never counted in the reclaim total -- and a plain `gc --delete`
_never_ touches them:

```bash
npx stim-cli gc                            # report everything, caches included
npx stim-cli gc --delete --older-than 30   # trim entries unused for 30 days
npx stim-cli gc --delete --all             # empty them completely
```

Prefer trimming. Most of these caches are a flat collection of independent
entries -- one file per key for Metro's `FileStore`, one directory per
fingerprint for a build cache -- so the ones nothing has touched in weeks
can go while the rest keep working. "Unused" means neither read nor written: a
cache hit reads an entry without rewriting it, so pruning on modification time
alone would evict exactly the entries that are earning their keep.

Xcode's compilation cache is the exception. It is an LLVM CAS whose `v4.actions`
index references its `v9.*.leaf` data files, so removing leaves individually
would leave the index pointing at data that is gone. `--older-than` reports it
as left alone; it can only be emptied whole, which is what `--all` does.

Emptying is a performance decision, not cleanup: the next build in every
project pays to refill what you removed. The summary says so.

### Registering a cache stim-cli cannot detect

A Metro `FileStore` root, a build-cache provider's artifact directory, a
relocated `COMPILATION_CACHE_CAS_PATH` -- all come from a project's own config,
so stim-cli cannot guess them. The cache names itself instead, once, from code:

```js
// A setup script, a build-cache provider -- anywhere that creates the cache.
// `stim-cli/cache-manifest` is ESM, so a CJS caller needs `await import(...)`.
import { register } from 'stim-cli/cache-manifest';

register({
  dir: '~/.myapp-metro-cache',
  name: 'Metro transforms',
  entriesDepth: 2,
});
register({ dir: '~/.myapp-cas', prune: 'atomic' }); // index-backed: emptied whole or not at all
```

`entriesDepth` says how far below the directory one entry sits, and it is
what keeps trimming safe. The default, 1, is a flat store: every child of the
root is an entry. A root with a layer of grouping _above_ the entries registers
2 -- Metro's `FileStore` shards its keys across 256 directories, and a build
cache is keyed `<platform>/<key>` -- so `gc --delete --older-than 30`
trims one transform or one build instead of a 256th of every transform on the
machine, or an entire platform's builds.

Registration is idempotent and keyed on the directory, so a cache can call it on
every build; `@stim-cli/metro` and `@stim-cli/expo-build-cache` both do (by writing
the manifest directly, so they need no stim-cli installed at all).

The `caches` setting is the no-code alternative and is still read: a list of
paths under `caches` in a committed `.stim-cli.json` is reported alongside the
registered ones. Every path in it is treated as a flat store, so register from
code for anything that needs a depth or `atomic`.

```json
{ "caches": ["~/.myapp-metro-cache", "~/.myapp-build-cache"] }
```

## The cache packages

Two optional packages ship alongside the CLI. Both register themselves with
stim-cli the first time they run, so `gc` reports and trims them, and
both work fine without stim-cli installed -- it is an optional peer.

- **[`@stim-cli/metro`](https://www.npmjs.com/package/@stim-cli/metro)**
  -- one Metro transform cache shared by every worktree, instead of Metro's
  per-project default that makes each new workspace re-transform the whole
  module graph. It also carries the NDJSON reporter stim-cli uses to capture a
  dev server's logs, which is not a cache and is not wired up by `init`.
- **[`@stim-cli/expo-build-cache`](https://www.npmjs.com/package/@stim-cli/expo-build-cache)**
  -- a local Expo build cache provider. When no native input changed, the Expo
  CLI installs a cached `.app` / `.apk` instead of compiling. Wire it to
  `expo.buildCacheProvider` on SDK 54+, or `expo.experiments.buildCacheProvider`
  on SDK 53, which reads only that key and ignores the top-level one in silence.

Each package's README has the wiring. Neither is needed for `stim-cli ios` /
`stim-cli android`, which address the build cache directly: the Expo provider is
for builds run _outside_ stim-cli (`expo run:ios` by hand, or EAS), so that the two
share artifacts instead of filling two caches with the same builds. Bare React
Native has no provider hook at all and needs none.

What every entry point does need is `@expo/fingerprint`, resolved from the
project, to compute the key. It works on a project with no Expo in it at all.
Without it `stim-cli ios` refuses with `STIM_CLI_NO_FINGERPRINT` rather than
compiling from scratch forever.

Entries are keyed `<fingerprintHash>-<variant>-<target>`, identically by every
entry point. The fingerprint covers what the project _is_, never how it was
built, so the variant (the Xcode configuration on iOS, the gradle variant on
Android; `debug` when unset) and the target class (`sim` unless the device
selector says otherwise) are part of the key. Without them a Release build would
answer a Debug lookup and a device build would answer a simulator one -- both
silently, both producing a binary that cannot run. stim-cli builds Debug for a
simulator and nothing else, so those fields are constant here; they exist
because the Expo provider and any future release path share the same keyspace.
