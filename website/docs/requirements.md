---
title: 'Requirements'
sidebar_position: 3
description: 'Local and optional remote requirements'
---

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim-cli`.

## All projects

- Node 20.19.4 or later on Node 20, or Node 22.12.0 or later.
- A project with `expo` or `react-native` in `package.json`.
- Git for `stim worktree` commands.

## iOS

- macOS with Xcode. Local simulator runs also need an installed iOS Simulator
  runtime.
- A compatible Ruby and CocoaPods setup when the project uses pods. Install
  Bundler when the project pins CocoaPods in `Gemfile.lock`.
- `expo-dev-client` for an Expo Debug build on a reserved Metro port.

## Android

- macOS or Linux with the Android SDK.
- For an emulator, an installed Android system image matching the host:
  `arm64-v8a` on ARM64 or `x86_64` on x64.
- A working Java and Gradle setup for the project.

Install the host tools and JavaScript dependencies before building. Stim runs
`pod install` when an iOS project's installed Pods are missing or stale. When
the project pins CocoaPods and Bundler is available, it installs missing bundled
gems and runs `bundle exec pod install`. Run `stim doctor` to check the setup.

## Optional remote devices

- The `proxy` backend needs an Agent Device daemon URL and token.
- The `eas` backend needs the EAS CLI, an authenticated Expo account, and a
  configured EAS project. EAS simulator use can be billable.
