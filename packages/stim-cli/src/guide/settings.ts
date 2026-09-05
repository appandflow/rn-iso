import { ANDROID_AVD_CONFIG_HELP } from '../settings.ts';

export default {
  summary: 'Settings Stim reads, and where they can live',
  body: () => `SETTINGS

There is no \`stim config\` command: Stim's commands take no device flags, so
settings are FILES, edited by hand or committed.

Resolution order, first match wins:
  1. project layer   ~/.stim/config.json, under this project's entry
  2. repo layer      ~/.stim/config.json, under this repo's git common dir
  3. committed       .stim.json at the repo root  <- normally the one you want
  4. Stim default

The committed file is plain JSON and is the only layer that travels with the
repo, so a device model or a carry-over rule every worktree should share
belongs there:

  {
    "ios": {
      "deviceType": "iPhone 17 Pro",
      "runtime": "26.2",
      "simslimProfile": ".simslim/dev.json"
    },
    "android": { "variant": "productionDebug" },
    "worktree": { "baseRef": "head" },
    "caches": ["~/.myapp-metro-cache"]
  }

KEYS STIM READS
  ios.deviceType        e.g. "iPhone 17 Pro" -- the simulator model this
                        workspace's owned sim is created as, spelled exactly as
                        \`xcrun simctl list devicetypes\` names it, and one an
                        installed runtime can create. The \`--device-type\`
                        flag overrides this per invocation. A name no installed
                        runtime offers is STIM_BAD_ARG and the creatable names
                        are printed
  ios.runtime           e.g. "26.2" -- the iOS runtime that sim is created on,
                        as a version ("26.2") or a runtime's full name
                        ("iOS 26.2"); nothing else matches. The \`--runtime\`
                        flag overrides this per invocation, and an uninstalled
                        version refuses the same way
  ios.configuration     e.g. "Release" -- the Xcode configuration to build
                        (simulator only). Committing
                        { "ios": { "configuration": "Release" } } makes every
                        \`stim ios\` in the repo a release-shaped build:
                        embedded JS, no Metro, cache keyed -release-sim, and
                        a JS-bundle swap on cache hits. The \`--configuration\`
                        flag overrides this per invocation. Unset means Debug.
  ios.remote            "proxy" or "eas" to use that remote backend, the same
                        as passing \`--remote proxy\` or \`--remote eas\`. The
                        build still runs here; only the device is elsewhere.
  ios.simslimProfile    a SimSlim JSON profile under the repository root (or
                        project root outside Git), at most 64 KiB. Install the
                        external tool once with
                        \`brew install mobai-app/tap/simslim\`. SimSlim requires
                        an iOS 18 or newer simulator. Each local \`stim ios\`
                        reconciles the profile on its Stim-owned simulator.
                        The first change can reboot it; a matching profile is a
                        fast no-op. Removing the setting restores stock services
                        when Stim applied the profile. Absolute paths, root or
                        symlink escapes, and missing files are refused before
                        simulator creation. Remote and unowned simulators are
                        never changed.
  ios.signingIdentity   e.g. "Apple Development: Jane (TEAMID5678)" -- the
                        keychain identity to re-seal a \`--device\` build with,
                        overriding the one Stim derives from the artifact's own
                        embedded.mobileprovision. Discovery is zero-config, so
                        this exists only for the case discovery cannot cover.
                        The name must be one \`security find-identity -v -p
                        codesigning\` prints.
  ios.signingIdentitySha1
                        the 40-character hex SHA-1 hash printed beside that
                        name. Set it when two certificates share one common
                        name: Stim is non-interactive, so it refuses an
                        ambiguous identity rather than picking one. It wins
                        over ios.signingIdentity.
  ios.lanHost           e.g. "192.168.1.42" -- the address a phone uses to
                        reach this workspace's Metro on an \`ios --device\`
                        Debug run, pinning the interface on a multi-NIC Mac
                        whose en0 is not the one the phone shares. A bare
                        address or hostname ONLY: never a scheme, a port, or a
                        URL, because the channels that carry it to the phone
                        (the dev-client deep link and the bundle's ip.txt)
                        compose the URL themselves. Unset means Stim orders the
                        host's non-internal IPv4 interfaces en0 first, then the
                        remaining en* by index -- react-native-xcode.sh's own
                        heuristic, so Stim and a plain Xcode run pick the same
                        interface.
  android.systemImage   e.g. "system-images;android-36;google_apis;arm64-v8a"
                        -- the sdkmanager package id the owned AVD is created
                        from. The \`--system-image\` flag overrides this per
                        invocation, and an id this SDK has not installed is
                        STIM_BAD_ARG with the installed ids printed
  android.dataPartitionSizeGb
                        whole GiB for a newly created owned AVD's data
                        partition. Defaults to 8; accepts 6 through 16384.
                        Existing AVDs are never resized because Android
                        userdata grows but does not shrink. Recreate the
                        environment to adopt a changed value.
  android.avdConfigFile
                        path under the repository root (or project root
                        outside Git) to a flat native key=value INI fragment,
                        at most 64 KiB. Stim parses it and
                        merges supported values into avdmanager's generated
                        config.ini before first boot; it is never used as a
                        replacement file. Absolute paths, repository or
                        symlink escapes, malformed or duplicate lines, and
                        unsupported keys are refused before AVD creation.
  android.avdConfig     flat object of the same native keys. It merges key by
                        key across settings layers and overrides the selected
                        avdConfigFile fragment. Boolean values accept true,
                        false, "yes", or "no"; numbers and enums are checked.
                        Supported keys and values:
${ANDROID_AVD_CONFIG_HELP.map((line) => `                          ${line}`).join('\n')}
                        Identity, architecture, host path, storage, image,
                        kernel, camera, snapshot, boot-lifecycle, and unknown
                        keys are protected. The emulator may normalize a valid
                        value. These overrides apply only to a newly created
                        AVD; existing and recovered AVDs are never rewritten.
                        On displayless Linux, Stim launches with
                        -gpu swiftshader_indirect -noaudio; those arguments
                        override hw.gpu.enabled, hw.gpu.mode, hw.audioInput,
                        and hw.audioOutput for that headless launch.
  android.variant       e.g. "productionDebug" -- the gradle variant to
                        assemble and install on a project with product
                        flavors. A repo like tlon-mobile with
                        flavorDimensions "profile" and production/preview
                        flavors has NO plain assembleDebug output: commit
                        { "android": { "variant": "productionDebug" } } and
                        \`stim android\` runs assembleProductionDebug,
                        finds the APK in apk/production/debug/ and keys the
                        build cache on the variant. The \`--variant\` flag
                        overrides this per invocation. Unset means plain
                        assembleDebug. A variant whose name ENDS IN Release
                        (\`release\`, \`productionRelease\`) is a release
                        build: embedded JS, no Metro, cache keyed on the
                        variant, and an APK re-pack on cache hits. See
                        \`guide lifecycle\`.
  android.keystore      the keystore a RE-PACKED release APK is signed with,
                        absolute or relative to the project root. Unset means
                        android/app/debug.keystore, which every RN and Expo
                        android project carries -- the right default, because
                        what this signs is a local emulator install and never
                        anything distributed. Set it only when the release
                        variant must be signed with the repo's own key.
  android.keystorePassword
                        the password for it. apksigner's SCHEMED form is
                        passed through unchanged (\`env:MY_KS_PASS\`,
                        \`file:/keys/pw.txt\`, \`stdin\`), which is how a
                        committed .stim.json avoids carrying a secret; a
                        bare string is used as the literal password. Unset
                        means the debug keystore's fixed "android".
  android.remote        "proxy" or "eas"; the Android half of ios.remote
  metro.tunnel          selects how a remote device reaches this workspace's
                        Metro after remote intent exists. Plain \`start\` stays
                        local. For Expo and bare React Native, "auto" (default)
                        first tries an authenticated and working ngrok.
                        After an auth refusal,
                        or any failure before ngrok returns a URL, it falls back
                        to cloudflared. "off" asserts the device
                        shares this machine and is the only mode that needs no
                        tunnel. "expo" lets the Expo dev server tunnel itself.
                        "cloudflared" and "ngrok" name a managed provider
                        explicitly. Any other value is refused as invalid.
  metro.ngrokUrl        the stable managed ngrok URL. It requires metro.tunnel
                        "ngrok" and passes --url to ngrok http. Stim owns
                        this process.
  metro.publicUrl       an existing tunnel's URL. Takes precedence over
                        starting one, whatever metro.tunnel says -- Stim
                        did not create it, so a Metro request through it is
                        still gated the same way a managed tunnel's is. Set it
                        before Expo start so the manifest advertises it.
  worktreeDir           where worktrees are created. A relative value resolves
                        against the settings root (the repository root), not the
                        current directory, so a committed .stim.json can place
                        worktrees inside the repo. worktree create --dir
                        overrides it for one run and resolves against the
                        current directory instead.
  worktree.baseRef      "head" (current HEAD) or "fresh" (origin/HEAD).
                        Unset means "head". It is a default, not an assertion:
                        only the --base FLAG triggers the
                        STIM_WORKTREE_BRANCH_EXISTS refusal, so a create that
                        finds an existing worktree-<name> still attaches to it
                        and says which ref was not applied.
  worktree.include      carry-over patterns, same role as .worktreeinclude
  worktree.exclude      additional --carry-ignored skip list, same role as
                        .worktreeexclude. Registered nested Git worktrees are
                        always skipped.
  cache.provider        one optional SECOND-TIER cache provider: a module
                        path relative to the settings file that names it, or a
                        package name. It implements the @stim-cli/cache
                        contract and can serve Metro transforms, native build
                        artifacts, or both. The local filesystem stays tier
                        one; a provider is read only after a local miss and
                        written after the local write. Failures and timeouts
                        are cache misses, never build or bundle failures.
                        Stim ships no provider and never configures one.
                        This module is EXECUTABLE CODE that every worktree on
                        this repository runs; review a committed value the way
                        you review a build script.
                        \`stim ios\` and \`stim android\` always use it. Metro
                        uses it only when the project's own metro.config.js
                        calls \`sharedCacheStores()\` from @stim-cli/metro: the
                        store Stim injects for you (bare in-process, or the
                        Expo config override) stays local-only.
  cache.options         free-form object handed to that module's factory. It
                        merges key by key across settings layers. Keep secrets
                        out of the committed file: read them from the
                        environment or the machine layers.
  caches                extra shared-cache paths for \`gc\` to report. A JSON
                        array; every path is treated as a flat store.

Every key above takes ONE type: a string, an array of strings, a number, or,
for android.avdConfig and cache.options, an object. A value of the wrong type is
refused by name on every command that resolves settings, so a wrong shape never
falls back to a default silently. \`stim doctor\` reports it as a finding
instead of refusing.

Anything else is IGNORED, and Stim warns about it by name on every run that
resolves settings. If you see such a warning, the key was either renamed or
removed -- check this list rather than assuming it still applies.

CONCURRENCY LIMITS ARE MACHINE-LEVEL, NOT A PER-PROJECT SETTING
The caps above are not in the layered settings -- they are not per-project,
because the resource they share (cores, RAM, booted simulators) is the whole
machine's. They live under a top-level \`concurrency\` key in
~/.stim/config.json, edited by hand:

  {
    "concurrency": { "maxBuilds": 2, "maxDevices": 3 }
  }

or via the environment, which overrides the file:

  STIM_MAX_BUILDS=2 STIM_MAX_DEVICES=3 stim ios

Unset, 0, or any non-positive value means NO enforcement -- the default, where
Stim limits nothing. See \`guide lifecycle\` for what each cap does.

THE SIMULATOR POOL BOUND IS MACHINE-LEVEL TOO
\`pool.iosParkedMax\` caps how many parked simulators \`worktree remove\` may
leave behind for a later workspace to adopt. It is machine-level for the same
reason: the disk they sit on is the whole machine's, about 2.5 GB each.

  {
    "pool": { "iosParkedMax": 3 }
  }

in ~/.stim/config.json, or STIM_POOL_IOS_PARKED_MAX in the environment, which
overrides the file. Absent means 3. \`0\` turns parking and adoption off:
\`worktree remove\` deletes the simulator, \`ios\` never adopts, and a pool
that already exists stays where it is until \`gc --delete\`. A value that is
not a whole number 0 or more is refused by name on \`worktree remove\` and
\`ios\`, and warned about by \`status\`, \`gc\` and \`doctor\`.

When STIM_HOME is set, parking and adoption are OFF unless
STIM_POOL_IOS_PARKED_MAX is set too. A redirected home is a scoped config --
test suites and the end-to-end harness use one -- and a scoped config must not
leave simulators on the machine it cannot account for. A redirected home that
wants a pool says so with the variable.

STIM NEEDS NO PROJECT CHANGES TO RUN
Nothing above is required to use Stim. The performance caches that used to
be setup steps are supplied by Stim on the command lines it composes itself:

  xcodebuild   COMPILATION_CACHE_ENABLE_CACHING / COMPILATION_CACHE_CAS_PATH /
               SWIFT_ENABLE_COMPILE_CACHE / CLANG_ENABLE_PREFIX_MAPPING /
               CLANG_OTHER_PREFIX_MAPPINGS -- so no Podfile post_install block
               (Xcode 26+ only, and skipped when the project configured ccache,
               which defeats it)
  gradlew      --build-cache -- so no org.gradle.caching=true in a committed
               gradle.properties. Debug builds add
               -PreactNativeArchitectures=<target ABI> when the owned
               emulator system image or physical device proves the ABI;
               unknown targets and Release builds stay universal. The same run
               carries the ccache launcher and CCACHE_BASEDIR /
               CCACHE_NOHASHDIR when ccache is on PATH -- so no
               externalNativeBuild cmake arguments in a committed
               build.gradle.
  start        a shared Metro FileStore, APPENDED to whatever the project
               configured -- so no metro.config.js. On a bare project Stim
               hosts Metro itself and adds it to the config it loaded; on Expo
               SDK 54+ the child loads Stim's config adapter through
               EXPO_OVERRIDE_METRO_CONFIG. Expo SDK 53 and older run with
               their normal Metro cache.

Each of those prints one dim line saying it happened. There is no setup skill
and no init command; \`stim doctor\` reports the project-side settings as
things you need only if you ALSO build outside Stim.

TURNING THE METRO STORE OFF (MACHINE-LEVEL)
The Expo injection is the invasive one, so it has a switch -- and the switch is
machine-level, because a committed file would be exactly the repo change this
feature exists to avoid:

  {
    "caches": { "injectMetroStore": false }
  }

in ~/.stim/config.json. It turns the store off on BOTH dev servers. Only the
literal false does; anything else leaves it on. The Expo adapter also fails
soft when it cannot create a FileStore: it writes one line to stderr (which
lands in the timeline) and the dev server runs with whatever cache it would
have had.

Reading the timeline for it: on Expo, \`cache_store_requested\` is Stim saying
it asked (it set EXPO_OVERRIDE_METRO_CONFIG on a process it does not run, which
is all this side can know), and \`cache_store_added\` is the adapter reporting
from inside that process that the store is in the config Metro loaded. Only the
second one means transforms are being shared. A bare project writes
\`cache_store_added\` directly, because there Stim adds the store itself.

CACHE LOCATIONS ARE MACHINE-LEVEL TOO
The shared build cache and Metro transform cache default to living under
~/.stim. To relocate them (say, to an external disk), set a top-level
\`caches\` key in ~/.stim/config.json, edited by hand -- absolute paths:

  {
    "caches": { "buildCache": "/Volumes/SSD/stim/build-cache",
                "metroCache": "/Volumes/SSD/stim/metro-cache" }
  }

STIM_BUILD_CACHE / STIM_METRO_CACHE in the environment override the file.
The CLI and both cache packages resolve these identically, so every process
finds the same store regardless of shell profile. A relative path is ignored.
The Metro value is a PARENT root. The sanitized package name is appended below
it, so apps remain separately reportable and prunable. Earlier releases used an
overridden Metro root as one flat store. A new registration replaces that legacy
parent entry and marks the named layout. If an older package registers it again,
current gc ignores the exact unmarked legacy parent while a marked child exists.
A marked store that later becomes another override parent remains visible but is
report-only while its marked child exists. Root-level legacy files remain
untouched for manual cleanup.

PREFER SELF-REGISTRATION OVER THE 'caches' SETTING
There is no 'cache' command. A cache registers itself from code instead, once,
and every 'gc' report shows it from then on, tagged (registered):

  import { register } from 'stim-cli/cache-manifest';
  register({ dir: '<dir>', name: '<what to call it>', entriesDepth: 2 });

entriesDepth is how far below dir one entry sits (default 1, a flat store).
Pass 2 for a root with a layer of grouping above the entries -- a Metro
FileStore shards across 256 directories, a build cache is keyed
<platform>/<key> -- or 'gc --delete --older-than N' removes a whole shard or
platform instead of one entry. Pass prune: 'atomic' for a cache whose index
references its own data (an LLVM CAS): it is then left alone by --older-than
and emptied whole only by 'gc --delete --cache all'.
Registration is idempotent and keyed on the directory.`,
};
