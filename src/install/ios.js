// src/install/ios.js
//
// Defensive install + launch step. Both `expo run:ios` and `react-native
// run-ios` have bugs/heuristics that occasionally install the freshly-built
// app on the wrong simulator (whichever was "default" at xcodebuild time)
// even when --device/--simulator was passed. After the build completes we
// locate the .app in DerivedData and re-install on the UDID rn-iso assigned.
// If the build already targeted the right sim, this is a no-op reinstall.

import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getExecutor } from '../exec.js';

const DERIVED_DATA = join(homedir(), 'Library/Developer/Xcode/DerivedData');

export function findRecentAppByBundleId(bundleId, { maxAgeMs = 30 * 60 * 1000, root = DERIVED_DATA } = {}) {
  if (!existsSync(root)) return null;
  const apps = collectAppBundles(root);
  const now = Date.now();
  const matches = [];
  for (const p of apps) {
    const stat = safeStat(p);
    if (!stat) continue;
    if (now - stat.mtimeMs > maxAgeMs) continue;
    if (!appHasBundleId(p, bundleId)) continue;
    matches.push({ path: p, mtime: stat.mtimeMs });
  }
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches[0]?.path || null;
}

function collectAppBundles(root, depth = 0, out = []) {
  // DerivedData layout: <Project>-<hash>/Build/Products/<Config>-<sdk>/<App>.app
  // Cap depth to keep this fast even on big DerivedData folders.
  if (depth > 6) return out;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = join(root, e.name);
    if (e.name.endsWith('.app')) {
      out.push(p);
      continue; // do not descend into .app
    }
    collectAppBundles(p, depth + 1, out);
  }
  return out;
}

function safeStat(p) {
  try { return statSync(p); } catch { return null; }
}

function appHasBundleId(appPath, bundleId) {
  const plistPath = join(appPath, 'Info.plist');
  if (!existsSync(plistPath)) return false;
  // Info.plist is binary; plutil extracts the value as plain text.
  const out = getExecutor().runQuiet(`plutil -extract CFBundleIdentifier raw "${plistPath}"`);
  return out?.trim() === bundleId;
}

export function installOnSim(udid, appPath) {
  getExecutor().run(`xcrun simctl install ${udid} "${appPath}"`);
}

export function launchOnSim(udid, bundleId) {
  const exec = getExecutor();
  // Terminate first so the launch picks up the new binary if it was already
  // running from a previous install. Errors are ignored (terminate fails when
  // the app isn't running).
  exec.runQuiet(`xcrun simctl terminate ${udid} ${bundleId}`);
  exec.run(`xcrun simctl launch ${udid} ${bundleId}`);
}
