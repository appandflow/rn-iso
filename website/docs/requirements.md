---
title: 'Requirements'
sidebar_position: 3
description: 'Local and optional remote requirements'
---

## All projects

- Node 20.19.4 or later on Node 20, or Node 22.12.0 or later.
- A project with `expo` or `react-native` in `package.json`.
- Git for `stim worktree` commands.

## iOS

- macOS with Xcode and at least one iOS Simulator runtime.
- CocoaPods when the project uses pods.
- `expo-dev-client` for an Expo Debug build on a reserved Metro port.

## Android

- macOS or Linux with the Android SDK.
- At least one installed ARM64 Android system image.
- A working Java and Gradle setup for the project.

Stim does not install Xcode, Android SDK packages, project dependencies, or
CocoaPods dependencies. Run `stim doctor` to find missing or stale prerequisites
before native worktree work.

## Optional remote devices

- The `proxy` backend needs an Agent Device daemon URL and token.
- The `eas` backend needs the EAS CLI, an authenticated Expo account, and a
  configured EAS project. EAS simulator use can be billable.
