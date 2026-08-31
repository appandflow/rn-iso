---
title: 'Build speed and caches'
sidebar_position: 1
description: 'How Stim keeps worktree builds warm'
---

Stim shares four types of work across projects and git worktrees:

| Layer                    | What it avoids                                            |
| ------------------------ | --------------------------------------------------------- |
| Native artifact cache    | A complete iOS or Android build when native inputs match  |
| Xcode compilation cache  | Recompiling unchanged native units on an artifact miss    |
| Gradle caches and output | Repeating Android dependency and task work                |
| Metro transform cache    | Transforming the same JavaScript modules in each worktree |

## Native artifact cache

Stim uses `@expo/fingerprint` to identify native inputs in both Expo and bare
React Native projects. The cache key also includes the platform, target, and
build configuration or variant.

`stim ios` and `stim android` first check the machine-wide artifact cache. A hit
installs the saved `.app` or `.apk`. A miss runs the native build and stores the
result. Two matching misses use one build through a single-flight lock.

Release configurations use separate keys. Their embedded JavaScript and assets
are regenerated for the current workspace before installation.

## Keep the main checkout warm

Run `stim doctor` before native worktree work. It checks whether the main
checkout has current dependencies and CocoaPods state. On a checkout without
installed dependencies, it also checks whether a fresh worktree produces the
same native fingerprint.

When several native tasks are coming, build the main checkout once:

```bash
stim start
stim ios                  # or: stim android
stim stop
```

Later worktrees can reuse that cache entry. `stim worktree create
--carry-ignored` can also copy installed dependencies, Pods, and native output
from the source checkout.

## Inspect and clean caches

```bash
stim gc
stim gc --delete --older-than 30
stim gc --delete --cache all
```

The first command only reports sizes. Age-based cleanup removes unused entries.
`--cache all` empties managed caches and makes future builds cold; it reaps
nothing, so `gc --delete` on its own remains the way to prune stale entries.
`--cache "compilation cache"` empties one cache instead of every one.

Set `STIM_BUILD_CACHE` or `STIM_METRO_CACHE` to place the shared caches on a
different volume. The same values can live in the machine config under
`caches.buildCache` and `caches.metroCache`.
