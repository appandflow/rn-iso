---
name: rn-iso-init
description: Use when setting up a React Native or Expo repo so that multiple agents or worktrees can build it in parallel without each one paying for a full build - covers the caches that make a second workspace fast and the settings that silently prevent them from working.
---

# Making a repo fast for parallel agents

`npx rn-iso doctor` reports what is costing time. This explains what to do about
it, and why each thing matters — the *why* is the part worth reading, because
the specifics are Xcode- and SDK-version-shaped and will age.

Run the doctor first. Everything below is one of its findings.

```bash
npx rn-iso doctor
```

## The one that blocks, not just slows

**`expo-dev-client` must be installed** for a reserved Metro port to reach the
app at all. `--port` is never compiled into the binary: it travels in the deep
link `expo run:ios` opens, and with no dev client nothing handles that URL. The
app then looks for Metro on 8081, finds nothing, and shows a red `No script URL
provided` that names none of this.

```bash
npx expo install expo-dev-client
```

Do **not** solve this by compiling the port in (`RCT_METRO_PORT`, or the dev
client's `defaultLaunchURL`). A build cache keys on the native fingerprint,
which does not include the port — so a binary built for 8082 would be served to
a workspace holding 8083 and would silently talk to the wrong bundler. Keeping
the port out of the binary is what lets one cached build serve every workspace.

The dev client also puts an onboarding sheet and a floating gear over every
screenshot. Three Info.plist keys turn those off (`expo-dev-menu` reads them as
defaults), and the same names work as `<meta-data>` in AndroidManifest.xml:

```
EXDevMenuIsOnboardingFinished      true
EXDevMenuShowFloatingActionButton  false
EXDevMenuShowsAtLaunch             false
```

## Skip the build entirely

A ticket that changes no native input should not compile anything. Expo's build
cache provider keys a built `.app` on a fingerprint of the native inputs and
installs it instead of building.

Where the key goes moved when the setting left experiments, and the wrong
combination is a silent no-op rather than an error:

| SDK | Reads |
|---|---|
| 53 | `expo.experiments.buildCacheProvider` **only** |
| 54+ | `expo.buildCacheProvider`, falling back to the experiments key |

So top-level is right going forward, and top-level on SDK 53 is the combination
that does nothing at all.

Add `.fingerprintignore` for anything that changes without changing the build.
`ios/Podfile.lock` is the usual culprit: pod checksums can embed absolute paths,
which makes the fingerprint differ per machine and the cache never hit.

**Bare React Native has no equivalent hook** — the community CLI never consults
a provider. `@expo/fingerprint` works standalone, so the pieces exist: fingerprint
the native inputs yourself, store the built `.app` under that key, and install it
instead of building when it matches.

## Share compiled output between workspaces

On Xcode 26+, compilation caching is content-addressed, so it survives a
different DerivedData — but **the default CAS path is inside DerivedData**,
which is per-workspace. Left at the default it shares nothing, which is the only
reason to turn it on. Set it somewhere fixed, in the Podfile's `post_install`:

```ruby
config.build_settings['COMPILATION_CACHE_ENABLE_CACHING'] = 'YES'
config.build_settings['COMPILATION_CACHE_CAS_PATH'] = File.expand_path('~/Library/Caches/<app>-compilation-cache')
```

Cache keys still contain absolute source paths, so a fresh worktree misses
everything until those are canonicalised. `CLANG_OTHER_PREFIX_MAPPINGS` maps
them, and the root must be **normalised** — `$(PODS_ROOT)/../..` expands but is
not normalised and matches nothing:

```ruby
config.build_settings['REPO_ROOT'] = '$(PODS_ROOT)/../..'
config.build_settings['CLANG_ENABLE_PREFIX_MAPPING'] = 'YES'
config.build_settings['CLANG_OTHER_PREFIX_MAPPINGS'] =
  '$(REPO_ROOT:standardizepath)=/^src $(DERIVED_DATA_DIR)=/^build'
```

Leave **Swift** unmapped. `SWIFT_OTHER_PREFIX_MAPPINGS` crashes swift-frontend
whenever a compile batch mixes mapped and unmapped sources
([swiftlang/swift#90698](https://github.com/swiftlang/swift/pull/90698) — fixed
upstream, not yet in a released Xcode). Swift caching cannot hit across
workspaces without it anyway, so turn it off explicitly and silence the
per-target warning it emits:

```ruby
config.build_settings['SWIFT_ENABLE_COMPILE_CACHE'] = 'NO'
```

**Do not enable ccache alongside this.** The ccache launcher is what disables
explicitly built modules, which compilation caching requires, so enabling both
tends to mean neither works. ccache also keys on absolute paths — including
paths *inside* generated files like header maps and VFS overlays, which no
`base_dir` setting can rewrite — so it misses across worktrees regardless.

## Share Metro's transform cache

Metro's default cache lives under the project, so every worktree re-transforms
the whole module graph from cold — thousands of modules, every time. One
`FileStore` outside any project fixes it:

```js
const { FileStore } = require('metro-cache');
config.cacheStores = [
  new FileStore({ root: path.join(os.homedir(), '.<app>-metro-cache') }),
];
```

## Keep it from growing forever

None of these caches prune themselves: Metro's `FileStore` has no eviction logic
at all, and the compilation cache has no size cap. Trim rather than empty —
emptying costs the next build in every project the time the cache was saving:

```bash
npx rn-iso gc --caches                            # what exists, and how big
npx rn-iso gc --caches --delete --older-than 30   # drop entries unused for 30 days
```

Point rn-iso at the caches it cannot detect, since they come from your own
config:

```bash
npx rn-iso config caches '["~/.myapp-metro-cache", "~/.myapp-build-cache"]' --repo
```
