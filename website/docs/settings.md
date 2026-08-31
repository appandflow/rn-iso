---
title: 'Settings reference'
sidebar_position: 2
description: 'Project, repository, machine, and environment settings'
---

Most projects need no settings. Use `stim guide settings` for descriptions that
match the installed version.

## Settings layers

Stim reads the first value found in this order:

1. Project settings in `~/.stim/config.json`, keyed by absolute path.
2. Repository settings in the same machine file, keyed by the git common dir.
3. Committed `.stim.json` at the repository root.
4. The Stim default.

Nested objects merge by key. Arrays replace lower-precedence arrays. Unknown
keys produce a warning.

## Committed settings

`.stim.json` supports these keys:

| Key                           | Purpose                                              |
| ----------------------------- | ---------------------------------------------------- |
| `ios.deviceType`              | iOS Simulator device type                            |
| `ios.runtime`                 | iOS Simulator runtime                                |
| `ios.configuration`           | Xcode configuration, such as `Debug` or `Release`    |
| `ios.remote`                  | Default remote backend, `proxy` or `eas`             |
| `ios.simslimProfile`          | SimSlim profile for local iOS devices                |
| `android.systemImage`         | Android SDK system image                             |
| `android.dataPartitionSizeGb` | AVD data partition size                              |
| `android.avdConfigFile`       | Additional AVD config file                           |
| `android.avdConfig`           | Validated AVD config values                          |
| `android.variant`             | Gradle build variant                                 |
| `android.keystore`            | Release keystore path                                |
| `android.keystorePassword`    | Release keystore password source                     |
| `android.remote`              | Default remote backend, `proxy` or `eas`             |
| `metro.tunnel`                | Remote tunnel mode                                   |
| `metro.ngrokUrl`              | Existing ngrok URL                                   |
| `metro.publicUrl`             | Existing public Metro URL                            |
| `worktreeDir`                 | Parent directory for created worktrees               |
| `worktree.baseRef`            | Default worktree base: `head`, `fresh`, or a git ref |
| `worktree.include`            | Explicit ignored paths to carry                      |
| `worktree.exclude`            | Ignored paths skipped by `--carry-ignored`           |
| `cache.provider`              | Optional second-tier cache provider module           |
| `cache.options`               | Options passed to that provider                      |
| `caches`                      | Additional cache paths reported by `gc`              |

Do not put secrets in a committed `.stim.json`. Keep secrets in ignored files
and carry those files into a worktree.

### Android AVD overrides

`android.avdConfigFile` reads an Android `config.ini` file. `android.avdConfig`
provides the same safe keys as JSON. Stim applies these values only when it
creates a new owned AVD. It never rewrites an existing AVD or changes generated
identity and storage paths.

The validated keys cover CPU count, RAM, heap size, screen density, graphics,
orientation, network conditions, and common hardware switches. On displayless Linux,
Stim also launches the emulator with `-no-window -noaudio -no-boot-anim`.
Run `stim guide settings` for the complete key and value list.

## Machine settings

`~/.stim/config.json` also supports:

```json
{
  "concurrency": { "maxBuilds": 2, "maxDevices": 3 },
  "caches": {
    "buildCache": "/Volumes/Cache/stim/build-cache",
    "metroCache": "/Volumes/Cache/stim/metro-cache"
  }
}
```

The committed `.stim.json` `caches` key and this machine-file `caches` key are
different shapes: the committed key is an array of extra paths for `gc` to
report, and this machine-file key is an object of named cache locations.

## Environment variables

| Variable                | Purpose                                |
| ----------------------- | -------------------------------------- |
| `STIM_HOME`             | Runtime state root. Default: `~/.stim` |
| `STIM_BUILD_CACHE`      | Native artifact cache root             |
| `STIM_METRO_CACHE`      | Metro transform cache root             |
| `STIM_MAX_BUILDS`       | Maximum concurrent native builds       |
| `STIM_MAX_DEVICES`      | Maximum booted owned devices           |
| `STIM_METRO_PUBLIC_URL` | Public Metro URL for remote use        |

Proxy remote devices also use `AGENT_DEVICE_DAEMON_BASE_URL` and
`AGENT_DEVICE_DAEMON_AUTH_TOKEN`. Those variables belong to the optional proxy
service, not to Stim.
