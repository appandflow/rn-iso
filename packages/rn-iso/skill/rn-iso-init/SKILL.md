---
name: rn-iso-init
description: Use when setting up a React Native or Expo repo so that multiple agents or worktrees can build it in parallel without each one paying for a full build - covers the caches that make a second workspace fast and the settings that silently prevent them from working.
---

# Making a repo fast for parallel agents

## Start here

```bash
npx rn-iso init      # writes the docs and the run script, then reports what is left
```

`init` writes what can be generated safely: a `WORKFLOW.md` describing the loop,
an executable `scripts/dev` that reserves an environment and runs against it, and
a `.worktreeexclude`. It adapts to the project — Expo or bare, which SDK, which
package manager, and whether the repo has its own `ios`/`start` scripts to prefer
over invented commands. It never overwrites an existing file without `--force`.

Then it runs `rn-iso doctor` and lists what it could not fix itself.

## What doctor reports, and what it does not

`doctor` reads five things and nothing else. Every one of them is a file it can
read statically:

| Finding | Read from |
|---|---|
| `expo-dev-client` is not installed | `package.json` |
| Metro cache is per-project | `metro.config.js` (is there a `cacheStores`?) |
| Compilation caching off, or left at its default CAS path | `ios/Podfile` |
| ccache and compilation caching both enabled | `ios/Podfile` + `ios/Podfile.properties.json` |
| `buildCacheProvider` missing, or on the key this SDK ignores | `app.json` (an `app.config.ts` is code, so it says so instead of guessing) |

**Everything else on this page is yours to check by hand.** doctor does not read
`.fingerprintignore`, does not look at `CLANG_OTHER_PREFIX_MAPPINGS` or
`SWIFT_ENABLE_COMPILE_CACHE`, and does not check the `EXDevMenu` Info.plist
keys. A clean `doctor` run does not mean those are right — it means it had
nothing to say about the five things it reads. Each section below says which
kind it is.

The findings it does report are left to you rather than auto-fixed because each
one edits a file the project already owns — a `metro.config.js` with its own
transformer, a `Podfile` with existing `post_install` logic, an app config that
may be TypeScript. A generator that rewrites those is a generator that
eventually corrupts one, so read the current contents, make the smallest edit
that fits, and re-run `rn-iso doctor` to confirm it landed.

## The one that blocks, not just slows

*doctor reports this.*

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

### Quieting the dev menu (check this by hand)

The dev client also puts an onboarding sheet and a floating gear over every
screenshot. Three Info.plist keys turn those off (`expo-dev-menu` reads them as
defaults), and the same names work as `<meta-data>` in AndroidManifest.xml.
**doctor does not check these** — open the Info.plist and look:

```
EXDevMenuIsOnboardingFinished      true
EXDevMenuShowFloatingActionButton  false
EXDevMenuShowsAtLaunch             false
```

## Skip the build entirely

*doctor reports whether a provider is configured, and whether it is on the key
this SDK reads. It does not check `.fingerprintignore`.*

A ticket that changes no native input should not compile anything. Expo's build
cache provider keys a built `.app` on a fingerprint of the native inputs and
installs it instead of building.

**Use the packaged provider rather than writing one.** It is the same cache
`rn-iso build-cache` uses, it registers itself with rn-iso so `gc` can report
and trim it, and it works with no rn-iso installed:

```bash
npm i -D @rn-iso/expo-build-cache
```

Where the key goes moved when the setting left experiments, and the wrong
combination is a silent no-op rather than an error:

| SDK | Reads |
|---|---|
| 53 | `expo.experiments.buildCacheProvider` **only** |
| 54+ | `expo.buildCacheProvider`, falling back to the experiments key |

```jsonc
// SDK 54+
{ "expo": { "buildCacheProvider": { "plugin": "@rn-iso/expo-build-cache" } } }
```

So top-level is right going forward, and top-level on SDK 53 is the combination
that does nothing at all.

What the provider does, if you need to write your own: Expo hands it the
platform, a fingerprint hash of the native inputs, and the run options. It
returns the path of a matching `.app`/`.apk` or null, and is called again after
a build to store one. Key on the fingerprint **plus** the build configuration
and the target class — a Release build must not answer a Debug lookup, and a
device build must not answer a simulator one, because both produce a binary that
cannot run and neither says so.

Add `.fingerprintignore` for anything that changes without changing the build.
`ios/Podfile.lock` is the usual culprit: pod checksums can embed absolute paths,
which makes the fingerprint differ per machine and the cache never hit. Nothing
checks this for you; a cache that never hits looks exactly like a cache that is
not configured.

**Bare React Native has no equivalent hook** — the community CLI never consults
a provider. Ask rn-iso directly instead:

```bash
APP=$(npx rn-iso build-cache resolve --platform ios) || {
  npx react-native run-ios --udid "$UDID" --port "$PORT"
  npx rn-iso build-cache store --platform ios --path "$BUILT_APP"
}
```

It needs `@expo/fingerprint`, which works on a project with no Expo in it at all.

## Share compiled output between workspaces

*doctor reports whether compilation caching is on and whether its CAS path is
outside DerivedData, and whether ccache conflicts with it. It does not check the
prefix mappings or the Swift setting below.*

On Xcode 26+, compilation caching is content-addressed, so it survives a
different DerivedData — but **the default CAS path is inside DerivedData**,
which is per-workspace. Left at the default it shares nothing, which is the only
reason to turn it on. Set it somewhere fixed, in the Podfile's `post_install`:

```ruby
config.build_settings['COMPILATION_CACHE_ENABLE_CACHING'] = 'YES'
config.build_settings['COMPILATION_CACHE_CAS_PATH'] = File.expand_path('~/Library/Caches/<app>-compilation-cache')
```

Cache keys still contain absolute source paths, so a fresh worktree misses
everything until those are canonicalised. **doctor does not check this** — read
the Podfile. `CLANG_OTHER_PREFIX_MAPPINGS` maps them, and the root must be
**normalised**: `$(PODS_ROOT)/../..` expands but is not normalised and matches
nothing:

```ruby
config.build_settings['REPO_ROOT'] = '$(PODS_ROOT)/../..'
config.build_settings['CLANG_ENABLE_PREFIX_MAPPING'] = 'YES'
config.build_settings['CLANG_OTHER_PREFIX_MAPPINGS'] =
  '$(REPO_ROOT:standardizepath)=/^src $(DERIVED_DATA_DIR)=/^build'
```

Leave **Swift** unmapped, and again check by hand.
`SWIFT_OTHER_PREFIX_MAPPINGS` crashes swift-frontend whenever a compile batch
mixes mapped and unmapped sources
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

*doctor reports whether `metro.config.js` sets any `cacheStores` at all. It does
not check where they point.*

Metro's default cache lives under the project, so every worktree re-transforms
the whole module graph from cold — thousands of modules, every time. One
`FileStore` outside any project fixes it:

```bash
npm i -D @rn-iso/metro-cache
```

```js
// metro.config.js
const { sharedCacheStores } = require('@rn-iso/metro-cache');
config.cacheStores = sharedCacheStores('myapp');
```

The `FileStore` itself is the easy part — that call is equivalent to:

```js
const { FileStore } = require('metro-cache');
config.cacheStores = [
  new FileStore({ root: path.join(os.homedir(), '.myapp-metro-cache') }),
];
```

What the package adds is registering the store with rn-iso, at the right entry
depth, so the next section actually works on it. Hand-roll the `FileStore` if
you prefer, then register it yourself.

## Keep it from growing forever

None of these caches prune themselves: Metro's `FileStore` has no eviction logic
at all, and the compilation cache has no size cap. Trim rather than empty —
emptying costs the next build in every project the time the cache was saving:

```bash
npx rn-iso gc                            # every cache, how big, registered or detected
npx rn-iso gc --delete --older-than 30   # drop entries unused for 30 days
npx rn-iso gc --delete --all             # empty them whole, including the Xcode CAS
```

Caches are part of every `gc` report, not something you ask for — there is no
`--caches` flag. A bare `gc` writes nothing.

rn-iso only detects the caches it was taught to recognise (Xcode's CAS, Metro's
file maps). Anything chosen by a project's own config has to name itself, from
code:

```js
import { register } from 'rn-iso/cache-manifest';

register({ dir: '~/.myapp-metro-cache', name: 'Metro transforms', entriesDepth: 2 });
register({ dir: '~/.myapp-cas', prune: 'atomic' }); // index-backed: emptied whole or not at all
```

`entriesDepth` is what makes trimming safe, and the default of 1 is wrong for
both caches above. A Metro `FileStore` shards its keys across 256 directories
and a build cache is keyed `<platform>/<key>`, so at depth 1 a single removal
takes a 256th of every transform on the machine, or an entire platform's builds.
Register 2 and `--older-than` trims one transform or one build. Registration is
idempotent and keyed on the directory, so a cache can do it on every build —
which is exactly what `@rn-iso/metro-cache` and `@rn-iso/expo-build-cache`
already do for you.

The `caches` setting is the no-code alternative: a list of paths under `caches`
in a committed `.rn-iso.json` is reported alongside the registered ones. It has
no `rn-iso config` key of its own, and every path in it is treated as a flat
store, so register from code for anything needing a depth or `atomic`.

```json
{ "caches": ["~/.myapp-metro-cache", "~/.myapp-build-cache"] }
```
