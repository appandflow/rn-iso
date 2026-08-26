---
name: rn-iso-init
description: Use when setting up a React Native or Expo repo so that multiple agents or worktrees can build it in parallel without each one paying for a full build - covers the caches that make a second workspace fast and the settings that silently prevent them from working.
---

# Making a repo fast for parallel agents

## Start here

```bash
npx rn-iso doctor    # read-only: what is silently costing this repo build time
```

**This page is a playbook you apply by hand.** There is no `rn-iso init`. It was
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
3. **Re-run `rn-iso doctor`** to confirm the finding is gone.
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
  and only ever *adds* to the skip list; nothing in it can bring `.rn-iso/` back.
- **A run script.** rn-iso runs the dev server and the build itself, so there is
  no bundler or build command left to wrap. Write one only if this repo needs
  something *around* those two steps -- a codegen pass, a workspace filter, an
  env file to source. A `scripts/dev` or `WORKFLOW.md` an older version generated
  belongs to the repo now; neither describes this version, and nothing here
  touches them.

## What doctor reports, and what it does not

`doctor` reads a fixed handful of things and nothing else. Every one of them is
a file it can read statically:

| Finding | Read from |
|---|---|
| `expo-dev-client` is not installed | `package.json` |
| Metro cache is per-project, or its `cacheStores` is only wired conditionally | `metro.config.js`, read and never evaluated |
| Compilation caching off, or left at its default CAS path | `ios/Podfile` |
| ccache and compilation caching both enabled | `ios/Podfile` + `ios/Podfile.properties.json` |
| `buildCacheProvider` missing, or on the key this SDK ignores | `app.json` (an `app.config.ts` is code, so it says so instead of guessing) |
| `.rn-iso/` missing from `.gitignore` | the project's `.gitignore` |

**Everything else on this page is yours to check by hand.** doctor does not read
`.fingerprintignore`, does not look at `CLANG_OTHER_PREFIX_MAPPINGS` or
`SWIFT_ENABLE_COMPILE_CACHE`, and does not check the `EXDevMenu` Info.plist
keys. A clean `doctor` run does not mean those are right — it means it had
nothing to say about the things it reads. Each section below says which kind it
is.

Findings carry a `fix` line naming what to change. Treat it as the *intent* of
the edit, not its text: apply it in the style of the file you are editing.

## The one that blocks, not just slows

*doctor reports this.*

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

## Skip the build entirely

*doctor reports whether a provider is configured, and whether it is on the key
this SDK reads. It does not check `.fingerprintignore`.*

A ticket that changes no native input should not compile anything. Expo's build
cache provider keys a built `.app` on a fingerprint of the native inputs and
installs it instead of building.

This matters for builds run **outside** rn-iso — `npx expo run:ios` by hand, or
EAS. `rn-iso ios` / `rn-iso android` consult the same cache directly and need no
provider at all; configuring one makes the two share artifacts instead of
filling two caches with the same builds.

**An existing provider is kept, never replaced.** If the project already
configures one -- `"buildCacheProvider": "eas"` on newer SDKs is common, and it
serves the whole team a remote cache -- leave it exactly where it is. Do not
swap it for `@rn-iso/expo-build-cache`: `rn-iso ios` / `rn-iso android` never
consult the provider (they build directly and use rn-iso's local cache), so
the EAS cache keeps serving `expo run` / CI builds while rn-iso's cache serves
the agent loop. The two coexist; replacing one with the other only removes a
cache someone was using.

### `"buildCacheProvider": "eas"` needs a session, and says nothing when it has none

*doctor checks this: eas-cli resolvable, logged in, and on an account that
covers the project's `expo.owner`.*

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

**When the config is code, find out before you conclude anything.** doctor will
not execute an `app.config.ts` to read it, so its finding there says only that
it could not check. One command answers it without running a build:

```bash
npx expo config --json | grep -i buildCacheProvider
```

An `undefined` behind an env-var ternary counts as configured too -- read what
the default branch produces, not just that the key is present.

**Where the project has NO provider, use the packaged one rather than writing
your own.** It addresses the same
`~/.rn-iso/build-cache` that `rn-iso ios` does, it registers itself with rn-iso
so `gc` can report and trim it, and it works with no rn-iso installed:

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
if you want the same behaviour there. A repo that wants cross-worktree hits should commit a *settled*
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

*doctor reports whether compilation caching is on and whether its CAS path is
outside DerivedData, and whether ccache conflicts with it. It does not check the
prefix mappings or the Swift setting below.*

On Xcode 26+, compilation caching is content-addressed, so it survives a
different DerivedData — but **the default CAS path is inside DerivedData**,
which is per-workspace. Left at the default it shares nothing, which is the only
reason to turn it on. Set it somewhere fixed, in the Podfile's `post_install` --
**inside a loop over every target's build configurations**, adding one if
`post_install` does not already have it:

```ruby
post_install do |installer|
  # ... whatever is already here ...

  # rn-iso: share compiled output between workspaces (Xcode 26+).
  # The default CAS path is inside DerivedData, which is per-workspace, so
  # leaving it there shares nothing. Pin it outside instead.
  installer.pods_project.targets.each do |target|
    target.build_configurations.each do |config|
      config.build_settings['COMPILATION_CACHE_ENABLE_CACHING'] = 'YES'
      config.build_settings['COMPILATION_CACHE_CAS_PATH'] = File.expand_path('~/.rn-iso/compilation-cache')
    end
  end
end
```

Paste the whole block **inside** the existing `post_install do |installer|`,
adding a `post_install` if the Podfile has none. It brings its own loop on
purpose (see below). Write the path relative to `$HOME` and expand it at
`pod install` time, as above: a Podfile is committed, and every machine's home
directory is a different absolute path.

`~/.rn-iso/compilation-cache` is a suggestion, not a requirement -- anywhere
fixed and outside DerivedData works. It is the useful default because it sits
beside rn-iso's other caches; a relocated CAS is not one of the two locations
`gc` knows how to detect, so tell it where this one went (see "Keep it from
growing forever" below) or `gc` will report every cache on the machine except
the one this repo just created.

The loop is the part that gets skipped. A `post_install` whose only iteration is
over resource bundles (the Xcode 14 code-signing workaround, which many Expo
Podfiles carry) accepts two bare `config.build_settings` lines pasted into it and
applies them to nothing -- it compiles, it builds, and it caches nothing. doctor
sees `COMPILATION_CACHE_ENABLE_CACHING` in the file either way, so this one is
on you to read.

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

*doctor reports whether `metro.config.js` sets any `cacheStores` at all, and
downgrades to a note when every mention of it sits behind a conditional. It does
not check where they point, and it never evaluates the file.*

Metro's default cache lives under the project, so every worktree re-transforms
the whole module graph from cold — thousands of modules, every time. One
`FileStore` outside any project fixes it:

```bash
npm i -D @rn-iso/metro
```

```js
// metro.config.js
const { sharedCacheStores } = require('@rn-iso/metro');
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

**Wire it unconditionally.** A store built behind an opt-in flag --

```js
const stores = process.env.APP_SHARED_METRO_CACHE === '1' ? [new FileStore(...)] : undefined;
const config = { ...(stores ? { cacheStores: stores } : {}), /* ... */ };
```

-- is off for every workspace that does not set the flag, which is all of them
by default, and costs exactly what having no store costs. doctor cannot tell
(it reads the file, it does not run it) so it reports a note rather than a pass;
either drop the flag or make sure every agent's environment sets it.

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
