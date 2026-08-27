---
name: rn-iso-init
description: Use when setting up a React Native or Expo repo so that multiple agents or worktrees can build it in parallel without each one paying for a full build - covers the caches that make a second workspace fast and the settings that silently prevent them from working.
user_invocable: true
---

# Making a repo fast for parallel agents

## Start here

```bash
npx rn-iso doctor    # read-only: what is silently costing this repo build time
```

**rn-iso needs no project changes to run.** Point it at a clean checkout of
somebody else's repo and the whole loop works: `start`, `ios`, `android`,
`logs`, `worktree`, `stop`, `gc`, the fingerprint build cache, and the three
performance caches that used to be setup steps -- Xcode's compilation cache,
Gradle's build cache and a shared Metro transform cache. rn-iso puts each of
those on the command line it composes itself (`xcodebuild SETTING=value`,
`gradlew --build-cache`, a cacheStore appended to the dev server it hosts), so
none of them is a file you have to edit or a PR you have to open. Evaluating
rn-iso costs nothing but running it.

**So this page is about the OTHER half:** what a repo commits so that the same
caches also serve the builds rn-iso does not drive -- Xcode, `npx expo
run:ios`, Android Studio, CI -- plus the handful of things that genuinely do
block or silently defeat rn-iso itself (a missing dev client, ccache, a
fingerprint that differs per workspace). Nothing here is a prerequisite. Every
section says which kind it is.

**It is a playbook you apply by hand.** There is no `rn-iso init`. It was
removed, along with the `scripts/dev` it generated, because almost nothing here
can be generated safely: every fix lands in a file the project already owns -- a
`metro.config.js` with its own transformer, a `Podfile` with existing
`post_install` logic, an app config that may be TypeScript -- and a generator
that rewrites those is a generator that eventually corrupts one.

So the loop is:

1. **Run `rn-iso doctor`.** It reports; it changes nothing and always exits 0.
2. **For each finding, open the file it names and read what is already there.**
   The correct edit is the smallest one that fits the code in front of you, not
   the snippet on this page pasted over it.
3. **Re-run `rn-iso doctor`** to confirm the finding is gone. Two classes of
   note can NEVER clear, by design, and count as done once you have verified
   the thing by hand: a metro config that only re-exports another package's
   config (doctor will not evaluate code -- wire the store in the delegated
   file and move on), and an `app.config.ts`/`.js` (same reason -- check
   `npx expo config --json` yourself).
4. **Then work through the sections below that doctor cannot check at all.** A
   clean `doctor` run does not mean this repo is set up; it means doctor had
   nothing to say about the handful of things it reads. Each section says which
   kind it is.

### What you do NOT have to do

- **`.rn-iso/` in `.gitignore`.** `start`, `ios` and `android` each add the entry
  themselves if it is missing, and say so once on stderr (`note   added .rn-iso/
to .gitignore`). It was the one edit safe to generate, so it stopped being a
  setup step. (doctor still reports a missing entry, because doctor is read-only
  and runs on repos no rn-iso command has touched yet.)

  **Do commit it, though, with whatever PR the agent is already opening.** It is
  a one-line repo-hygiene edit every checkout wants, and committing it is what
  makes it stop being written -- which matters for the cache: the file is a
  working-tree file, so `@expo/fingerprint` sees it. Every workspace that runs
  rn-iso writes the identical block and so fingerprints identically to every
  other one; the mismatch is only against a tree that has NEVER run rn-iso (a
  clean CI checkout, a worktree whose first build has not happened yet), and
  committing the entry ends that difference for good. Symptom while it lasts:
  the first `rn-iso ios` in a new worktree misses a cache entry another
  worktree stored for the same commit, then hits from then on.

- **A `.worktreeexclude` for it.** `.rn-iso/` holds a workspace's own derived
  data, its logs and the supervisor pidfile -- build output keyed to a path a new
  worktree does not have, and a pidfile for a process that is not running -- so
  `worktree create --carry-ignored` skips it unconditionally, at any depth (a
  monorepo has one per app directory). That lives in code, not in a pattern file:
  there is no repo for which carrying it is right, and a rule kept in a generated
  file is a rule that goes missing. A `.worktreeexclude` at the **repo root**
  (`git rev-parse --show-toplevel`, which is where `worktree create` reads it)
  still works for a repo's own additions -- `bench/results`, a fixture tree --
  and only ever _adds_ to the skip list; nothing in it can bring `.rn-iso/` back.
- **A run script.** rn-iso runs the dev server and the build itself, so there is
  no bundler or build command left to wrap. Write one only if this repo needs
  something _around_ those two steps -- a codegen pass, a workspace filter, an
  env file to source. A `scripts/dev` or `WORKFLOW.md` an older version generated
  belongs to the repo now; neither describes this version, and nothing here
  touches them.

## What doctor reports, and what it does not

`doctor` reads a fixed handful of things and nothing else. Every one of them is
a file it can read statically:

| Finding                                                                  | Read from                                                                  | Blocks rn-iso?                       |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------ |
| `expo-dev-client` is not installed                                       | `package.json`                                                             | yes, on Expo -- the port cannot land |
| ccache is on, so rn-iso will not add compilation caching                 | `ios/Podfile` + `ios/Podfile.properties.json`                              | yes -- it costs rn-iso the cache     |
| This checkout does not fingerprint like a fresh worktree of HEAD         | a real fingerprint, twice (see "Fingerprint hygiene" below)                | yes -- every worktree misses         |
| `metro.config.js` sets no `cacheStores`, or only wires one conditionally | `metro.config.js`, read and never evaluated                                | no -- rn-iso supplies its own        |
| Compilation caching off in the Podfile, or left at its default CAS path  | `ios/Podfile`                                                              | no -- rn-iso supplies its own        |
| Gradle's build cache off (`org.gradle.caching=true` not set)             | `android/gradle.properties` (absent on CNG -> skipped)                     | no -- rn-iso passes --build-cache    |
| A configured `buildCacheProvider` on the key this SDK ignores            | `app.json` (an `app.config.ts` is code, so it says so instead of guessing) | no -- rn-iso has its own cache       |
| `.rn-iso/` missing from `.gitignore`                                     | the project's `.gitignore`                                                 | no -- start/ios/android add it       |

**The bottom five are not setup steps.** They report a repo-side setting that
rn-iso already supplies on its own invocations, and are worth acting on only if
you ALSO build outside rn-iso. Each one's `fix` line now says so. A provider
that is MISSING is not on the list at all -- see "The build cache needs no
setup" below.

**Everything else on this page is yours to check by hand.** doctor does not read
`.fingerprintignore`, does not look at `CLANG_OTHER_PREFIX_MAPPINGS` or
`SWIFT_ENABLE_COMPILE_CACHE`, and does not check the `EXDevMenu` Info.plist
keys. A clean `doctor` run does not mean those are right — it means it had
nothing to say about the things it reads. Each section below says which kind it
is.

Findings carry a `fix` line naming what to change. Treat it as the _intent_ of
the edit, not its text: apply it in the style of the file you are editing.

## The one that blocks, not just slows

_doctor reports this._

**`expo-dev-client` must be installed** for a reserved Metro port to reach the
app at all. The port is never compiled into the binary: it travels in the
`<scheme>://expo-development-client/?url=...` deep link `rn-iso ios` opens after
launching, and with no dev client nothing handles that URL. The app then looks
for Metro on 8081, finds nothing, and shows a red `No script URL provided` that
names none of this.

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

## The build cache needs no setup

rn-iso's own cache covers every build rn-iso drives: `rn-iso ios` /
`rn-iso android` fingerprint the native inputs and share built artifacts
through `~/.rn-iso/build-cache` on their own, on Expo and bare projects alike.
An Expo build cache **provider** is optional and deliberately not part of
setup: `@rn-iso/expo-build-cache` extends the same cache to expo runs made
outside rn-iso (`npx expo run:ios` by hand), and `"eas"` shares builds across a
team. Configure one only when this repo needs those cases -- doctor no longer
asks for one, and whatever provider the project already has is kept exactly
where it is (rn-iso never consults it for its own builds and never replaces
it).

### A provider that IS configured can still break, silently

_doctor reports this, from `app.json`. An `app.config.ts` is code, so doctor
says it cannot check instead of guessing -- answer it yourself with
`npx expo config --json | grep -i buildCacheProvider` (an `undefined` behind an
env-var ternary counts as configured too)._

Where the key goes moved when the setting left experiments, and the wrong
combination is a silent no-op rather than an error:

| SDK | Reads                                                          |
| --- | -------------------------------------------------------------- |
| 53  | `expo.experiments.buildCacheProvider` **only**                 |
| 54+ | `expo.buildCacheProvider`, falling back to the experiments key |

So top-level is right going forward, and top-level on SDK 53 is the combination
that does nothing at all.

### `"buildCacheProvider": "eas"` needs a session, and says nothing when it has none

_doctor checks this: eas-cli resolvable, logged in, and on an account that
covers the project's `expo.owner`._

The EAS provider is the one whose failure mode is **silence by construction**.
Both of its entry points wrap `npx eas-cli` in a `try { ... } catch { return
null }` (read `eas-build-cache-provider/build/index.js` if you want to see it),
so an expired session, a missing CLI and a genuinely empty cache all produce the
same thing: a miss, on every build, with nothing in any log about
authentication. A team can lose its shared cache for weeks this way.

So a repo that opts into `"eas"` is opting every workspace into a login:

- **Interactive machines**: `eas login`, once. The session lives in
  `~/.expo/state.json` and is shared with the Expo CLI, so it survives across
  worktrees and projects -- it is per machine, not per checkout.
- **CI and headless agents**: `EXPO_TOKEN`. It overrides the stored session
  entirely, and `eas whoami` then prints
  `<name> (authenticated using EXPO_TOKEN)`.
- **The account has to be the right one.** `expo.owner` in the app config is
  what names it (`eas.json` has no owner field -- it is not there to check). A
  session on an account that does not cover that owner reads and writes
  nothing, and looks exactly like an empty cache.
- **`eas.json` must exist in the project directory.** The provider returns
  `null` before doing anything at all when it does not, which is the one
  "configured but never hits" case that has nothing to do with auth.

`rn-iso doctor` reports three findings here -- no eas-cli (cost), not logged in
(cost), and a session whose accounts do not include `expo.owner` (a note: the
account list `eas whoami` prints is not always complete, and access is the
server's decision). `rn-iso ios` / `rn-iso android` run the same check before
they consult the provider and print one yellow line when the session is
definitively broken, then **build with the local cache only** -- a missing
session costs the team tier, never the build. Offline is not an auth failure and
is never reported as one.

## Fingerprint hygiene: what makes the cache actually hit

_doctor's LAST check measures this directly ("fingerprint parity"): in a git
repo it creates one temporary detached worktree of HEAD in the OS tmpdir,
computes a real fingerprint in both trees, compares, and always removes the
worktree again. It is doctor's most expensive check -- two real fingerprints --
and it briefly touches `.git/worktrees` metadata (cleaned up on every exit
path). A mismatch is a note naming the differing sources and the tracked
files git reports dirty; it means worktrees will MISS every cache entry this
checkout fills until the dirty inputs are committed (or fingerprint-ignored).
doctor does not read `.fingerprintignore` itself._

Add `.fingerprintignore` for anything that changes without changing the build.
`ios/Podfile.lock` is the usual culprit: pod checksums can embed absolute paths,
which makes the fingerprint differ per machine and the cache never hit. Nothing
checks this for you; a cache that never hits looks exactly like a cache that is
not configured.

The same file bites a second way, from the other direction. `pod install`
rewrites `Podfile.lock` -- observed on `hermes-engine`, whose checksum changed
on a plain re-install with no dependency change -- and `Podfile.lock` is a
fingerprint input, so a build that ran `pod install` fingerprints differently
from the commit it was built at, and the next worktree on that same commit
misses. `rn-iso ios` / `rn-iso android` scope the fingerprint to the platform
they are building (`platforms: ['ios']` / `['android']`), so this file can no
longer cost you an ANDROID hit -- but it still costs you the iOS one, and a
provider you write yourself gets whatever hash Expo hands it, which is
UNSCOPED (`createFingerprintAsync(projectRoot)` with no options, in
`@expo/cli`'s `build-cache-providers`). Scope it in `calculateFingerprintHash`
if you want the same behaviour there. A repo that wants cross-worktree hits should commit a _settled_
`Podfile.lock`: run `pod install` once, commit whatever it produced, and check
that a second run leaves it alone. The diagnostic when two workspaces that
should agree do not is to fingerprint both and diff the sources rather than the
hash:

```bash
npx @expo/fingerprint fingerprint:generate > /tmp/fp-a.json   # in workspace A
npx @expo/fingerprint fingerprint:generate > /tmp/fp-b.json   # in workspace B
diff <(jq -S . /tmp/fp-a.json) <(jq -S . /tmp/fp-b.json)
```

The differing source names the file, which is the answer: either commit it, or
add it to `.fingerprintignore` if it genuinely does not change the build.

**Bare React Native has no equivalent hook** — the community CLI never consults
a provider, so there is nothing to configure and nothing to write. Use `rn-iso
ios` / `rn-iso android`: they do the fingerprint lookup, the store on a miss and
the install themselves, on a bare project exactly as on an Expo one.

Either way the repo needs `@expo/fingerprint` to be **resolvable from the
project**, which works on a project with no Expo in it at all. Without it
`rn-iso ios` refuses with `RN_ISO_NO_FINGERPRINT` rather than silently compiling
every time.

Resolvable, not listed: in a monorepo it is usually hoisted and pulled in
transitively by `expo`, so the app's own `dependencies` will not mention it while
`require.resolve('@expo/fingerprint')` from the app root finds it perfectly well.
Check by resolving it, not by reading the manifest:

```bash
node -e "require.resolve('@expo/fingerprint')"   # run from the app directory
```

If it genuinely is not there, install it with **the package manager this repo
uses** -- `pnpm add -D`, `yarn add -D`, or `npm i -D`. `npm i -D` inside a pnpm
workspace writes a second lockfile and installs into a directory nothing
resolves from.

## Share compiled output between workspaces

_rn-iso already does this on its own builds. doctor reports the Podfile side as
a note about builds you make outside rn-iso._

**There is nothing to do here for `rn-iso ios`.** It passes the compilation
cache on its own `xcodebuild` command line, where a `SETTING=value` override
reaches every target including the Pods:

```
COMPILATION_CACHE_ENABLE_CACHING=YES
COMPILATION_CACHE_CAS_PATH=~/.rn-iso/compilation-cache
SWIFT_ENABLE_COMPILE_CACHE=NO
CLANG_ENABLE_PREFIX_MAPPING=YES
CLANG_OTHER_PREFIX_MAPPINGS=<this workspace's root>=/^src
```

The prefix mapping is what makes it worth having: cache keys otherwise contain
absolute source paths, so a fresh worktree misses everything. rn-iso maps the
workspace root it already knows, so every worktree of the same commit computes
the same keys. It prints one dim line naming the CAS path when it applies, and
it skips entirely on two conditions: an Xcode older than 26 (or one it could
not read -- the settings do nothing there), and a project with
`apple.ccacheEnabled=true` in `ios/Podfile.properties.json`.

### Commit it only for builds rn-iso does not drive

Xcode itself, `npx expo run:ios`, CI. Those fall back to the per-workspace
default, and this is the Podfile block that fixes them -- **inside a loop over
every target's build configurations**, adding one if `post_install` does not
already have it:

```ruby
post_install do |installer|
  # ... whatever is already here ...

  installer.pods_project.targets.each do |target|
    target.build_configurations.each do |config|
      config.build_settings['COMPILATION_CACHE_ENABLE_CACHING'] = 'YES'
      config.build_settings['COMPILATION_CACHE_CAS_PATH'] = File.expand_path('~/.rn-iso/compilation-cache')
      # Cache keys contain absolute source paths, so canonicalise them.
      # Count YOUR OWN depth: PODS_ROOT is <app>/ios/Pods, so '../..' reaches
      # the app dir; a monorepo's apps/<app>/ios/Pods needs '../../../..'.
      config.build_settings['REPO_ROOT'] = '$(PODS_ROOT)/../..'
      config.build_settings['CLANG_ENABLE_PREFIX_MAPPING'] = 'YES'
      config.build_settings['CLANG_OTHER_PREFIX_MAPPINGS'] =
        '$(REPO_ROOT:standardizepath)=/^src $(DERIVED_DATA_DIR)=/^build'
      # SWIFT_OTHER_PREFIX_MAPPINGS crashes swift-frontend whenever a compile
      # batch mixes mapped and unmapped sources (swiftlang/swift#90698, fixed
      # upstream, not yet released), and Swift caching cannot hit across
      # workspaces without it -- so turn it off explicitly.
      config.build_settings['SWIFT_ENABLE_COMPILE_CACHE'] = 'NO'
    end
  end
end
```

Three things that get missed, and doctor cannot see any of them:

- **The loop.** A `post_install` whose only iteration is over resource bundles
  (the Xcode 14 code-signing workaround many Expo Podfiles carry) accepts two
  bare `config.build_settings` lines and applies them to nothing. It compiles,
  it builds, and it caches nothing.
- **`installer.pods_project.targets` is the Pods project only** -- it does not
  reach your app's own target. Fine for most RN/Expo apps; add a second loop if
  your app target compiles significant native code.
- **The mapped root must be normalised.** `$(PODS_ROOT)/../..` expands but is
  not normalised and matches nothing; `:standardizepath` is what fixes it.

Use `~/.rn-iso/compilation-cache` unless you have a reason not to: it is where
rn-iso's own builds put it, so the two share entries instead of filling two
caches, and `gc` detects it without being told.

**Do not enable ccache alongside this** -- and note that ccache is now the one
thing that makes rn-iso skip its own compilation cache too, so a repo with
`apple.ccacheEnabled=true` gets neither. The ccache launcher is what disables
explicitly built modules, which compilation caching requires; ccache also keys
on absolute paths -- including paths _inside_ generated header maps and VFS
overlays, which no `base_dir` setting can rewrite -- so it misses across
worktrees regardless. doctor reports this one as a real cost.

## Turn on Gradle's build cache

_rn-iso already does this on its own builds. doctor reports the
`gradle.properties` side as a note about builds you make outside rn-iso._

**There is nothing to do here for `rn-iso android`.** It passes `--build-cache`
on its own `./gradlew` invocation, which turns the task-output cache on for
that build whatever the properties file says. The cache lives under the Gradle
user home (`~/.gradle` unless something overrides it), which every worktree on
the machine already shares, so it is cross-worktree by construction.

Commit the property only for gradle runs rn-iso does not make -- Android
Studio, a plain `./gradlew`, CI -- which otherwise re-run every task from
scratch:

```properties
# android/gradle.properties
org.gradle.caching=true
```

Note the difference from the caches Gradle has anyway: the dependency and
wrapper caches under `~/.gradle` are always shared, but they only spare the
downloads. The build cache is what lets worktree B reuse worktree A's **task
outputs** (compiled classes, processed resources).

## Share Metro's transform cache

_rn-iso already does this on the dev server it runs. doctor reports the
`metro.config.js` side as a note about Metro runs made outside rn-iso._

**There is nothing to do here for `rn-iso start`.** It installs a shared
`FileStore` under `~/.rn-iso/metro-cache/<package name>` itself, and it
**appends** -- whatever `cacheStores` the project configured stay exactly where
they are, in order. How it gets there depends on which dev server this is:

- **bare React Native**: rn-iso hosts Metro in-process, so it adds the store to
  the config it loaded.
- **Expo**: the dev server is the project's own `expo start`, so rn-iso spawns
  it with `NODE_OPTIONS` extended by `--require <shim>` (appended to any
  `NODE_OPTIONS` you set, never replacing it). The shim appends the same store
  inside that process. It **fails soft**: anything it cannot resolve or patch
  becomes one line on stderr -- which lands in `rn-iso logs` -- and the dev
  server runs with whatever cache it would have had.

Turn it off machine-wide, without touching the repo, in `~/.rn-iso/config.json`:

```json
{ "caches": { "injectMetroStore": false } }
```

### Commit a store only for Metro runs rn-iso does not host

`npx expo start` by hand, a teammate's editor task, CI. Metro's default
transform cache is `$TMPDIR/metro-cache` -- machine-global, but a location the
OS periodically wipes and that nothing versions or reclaims. (Do not benchmark
"cold" by deleting `node_modules`: `$TMPDIR` stays warm, and the real cold
number only shows after the store moves.)

```bash
npm i -D @rn-iso/metro
```

```js
// metro.config.js
const { sharedCacheStores } = require('@rn-iso/metro');
config.cacheStores = sharedCacheStores('myapp');
```

That resolves the same root rn-iso does, so the two share entries rather than
filling two caches. The `FileStore` itself is the easy part -- the call is
equivalent to:

```js
const { FileStore } = require('metro-cache');
config.cacheStores = [new FileStore({ root: path.join(os.homedir(), '.myapp-metro-cache') })];
```

What the package adds is registering the store with rn-iso, at the right entry
depth, so the next section works on it. Hand-roll the `FileStore` if you
prefer, then register it yourself.

**Wire it unconditionally.** A store built behind an opt-in flag --

```js
const stores = process.env.APP_SHARED_METRO_CACHE === '1' ? [new FileStore(...)] : undefined;
const config = { ...(stores ? { cacheStores: stores } : {}), /* ... */ };
```

-- is off for every workspace that does not set the flag, which is all of them
by default. doctor cannot tell (it reads the file, it does not run it) so it
reports a note rather than a pass.

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
which is exactly what `@rn-iso/metro` and `@rn-iso/expo-build-cache` already do
for you.

The `caches` setting is the no-code alternative: a list of paths under `caches`
in a committed `.rn-iso.json` is reported alongside the registered ones. (There
is no `rn-iso config` command — settings are files; see `rn-iso guide
settings`.) Every path in it is treated as a flat store, so register from code
for anything needing a depth or `atomic`.

```json
{ "caches": ["~/.myapp-metro-cache", "~/.myapp-build-cache"] }
```

## Optional: cap parallelism on a machine that cannot take it

Everything above makes a second workspace cheap; none of it limits how many run
at once, and by default rn-iso imposes no limit. If a machine genuinely cannot
host as many parallel builds or booted simulators as there are agents, two
machine-level caps are the opt-in. They are NOT per-project (the resource being
shared — cores, RAM, booted sims — is the whole machine's), so they live under a
top-level `concurrency` key in `~/.rn-iso/config.json`, not in a committed
`.rn-iso.json`:

```json
{ "concurrency": { "maxBuilds": 2, "maxDevices": 3 } }
```

`RN_ISO_MAX_BUILDS` / `RN_ISO_MAX_DEVICES` override the file for a single run.
Unset, `0`, or any non-positive value means no enforcement — the default.

- `maxBuilds` caps concurrent **compiles**. A build over the cap WAITS for a
  free slot (batch-shaped), the same way a second workspace waits on the
  single-flight build lock. A waiter that only installs another workspace's
  cached artifact never consumes a slot.
- `maxDevices` caps **booted** rn-iso devices. A new `rn-iso ios`/`android` at
  the cap is REFUSED with `RN_ISO_AT_CAPACITY` (interactive-shaped — it does not
  queue). Re-running on a workspace whose device is already booted is never
  refused. Free one with `rn-iso stop`, or raise the cap.

`rn-iso doctor` prints one note echoing the caps and the current live count, but
only when a cap is set. `rn-iso gc` reports stale build slots (a builder that
died holding one) the way it reports stale build locks, and `gc --delete`
clears them. There is no `rn-iso config` command — this is a file and two env
vars; see `rn-iso guide lifecycle` and `guide settings`.
