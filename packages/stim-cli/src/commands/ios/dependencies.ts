import { loadCacheProvider } from '@stim-cli/cache';
import { fingerprintProject, resolveBuild, storeBuild, untrackedNativeFiles } from '../../build-cache.ts';
import { getConcurrencyLimits, getProject, upsertProject } from '../../config.ts';
import {
  clearOtherUserApps,
  installIosApp,
  launchIosApp,
  verifyLaunch,
  verifyReleaseLaunch,
} from '../../engine/app-install.ts';
import { acquireBuildLock, releaseBuildLock, waitForBuild } from '../../engine/build-lock.ts';
import { acquireBuildSlot, releaseBuildSlot } from '../../engine/build-slots.ts';
import { readPodState, podsAreStale, runPodInstall } from '../../engine/deps.ts';
import { checkDeviceCapacity, clearIosAdoptionPending, ensureBooted, ensureOwnedDevice } from '../../engine/device.ts';
import { listIosRuntimes } from '../../sim/ios.ts';
import {
  ensureRemoteBootOwned,
  ensureMetroReachable,
  remoteIosDeps,
  resolveRemoteContext,
} from '../../engine/device-remote.ts';
import {
  awaitIosDeviceLaunch,
  installIosDeviceApp,
  iosDeviceProcess,
  listIosDevices,
  verifyIosDeviceReleaseLaunch,
} from '../../engine/ios-device.ts';
import { selectFromPool } from '../../engine/device-pool.ts';
import { acquireRunLease, releaseLeaseOnSignal, runLease } from '../../engine/device-lease-run.ts';
import { gateProfileForDevice, sealAppForDevice } from '../../engine/ios-signing.ts';
import { ensureLanReachable } from '../../engine/ios-lan.ts';
import { hostLanCandidates } from '../../engine/lan-address.ts';
import { detectProviders } from '../../engine/metro-reach.ts';
import { needsPrebuild, runPrebuild } from '../../engine/prebuild.ts';
import {
  checkEasAuth,
  loadProjectProvider,
  resolveEasCliBin,
  resolveRemote,
  uploadRemote,
} from '../../engine/remote-cache.ts';
import { readRunEstimates, recordRunStats } from '../../engine/stats.ts';
import { swapJsBundle } from '../../engine/js-swap.ts';
import { buildIos, readBundleExecutable, readBundleId } from '../../engine/xcode.ts';
import { isPidAlive, resolveProjectMetro } from '../../metro.ts';
import { createNdjsonWriter } from '../../ndjson.ts';
import { detectBundleId, detectIsExpo, findProjectRoot, projectShortcut } from '../../project.ts';
import { resolveCacheProviderConfig, resolveSettings } from '../../settings.ts';
import { readWorkspaceState, writeWorkspaceState } from '../../supervisor/state.ts';
import { gitCommonDir, repoRoot } from '../../worktree.ts';
import { resolveMetroWithRetry, ensureWorkspaceStorageSafely } from '../native-runtime.ts';
import { devClientScheme } from '../dev-client.ts';
import { stopPreviousCollector, replaceCollector } from './collector.ts';

export interface IosDeps {
  resolveRemoteContext: typeof resolveRemoteContext;
  ensureMetroReachable: typeof ensureMetroReachable;
  ensureRemoteBootOwned: typeof ensureRemoteBootOwned;
  detectProviders: typeof detectProviders;
  remoteIosDeps: typeof remoteIosDeps;
  resolveEasCliBin: typeof resolveEasCliBin;
  findProjectRoot: typeof findProjectRoot;
  resolveSettings: typeof resolveSettings;
  gitCommonDir: typeof gitCommonDir;
  repoRoot: typeof repoRoot;
  detectBundleId: typeof detectBundleId;
  detectIsExpo: typeof detectIsExpo;
  devClientScheme: typeof devClientScheme;
  getProject: typeof getProject;
  upsertProject: typeof upsertProject;
  projectShortcut: typeof projectShortcut;
  checkDeviceCapacity: typeof checkDeviceCapacity;
  ensureOwnedDevice: typeof ensureOwnedDevice;
  listIosRuntimes: typeof listIosRuntimes;
  ensureBooted: typeof ensureBooted;
  resolveProjectMetro: typeof resolveProjectMetro;
  resolveMetroWithRetry: typeof resolveMetroWithRetry;
  readWorkspaceState: typeof readWorkspaceState;
  isPidAlive: typeof isPidAlive;
  getConcurrencyLimits: typeof getConcurrencyLimits;
  fingerprintProject: typeof fingerprintProject;
  untrackedNativeFiles: typeof untrackedNativeFiles;
  resolveBuild: typeof resolveBuild;
  storeBuild: typeof storeBuild;
  resolveCacheProviderConfig: typeof resolveCacheProviderConfig;
  loadCacheProvider: typeof loadCacheProvider;
  acquireBuildLock: typeof acquireBuildLock;
  releaseBuildLock: typeof releaseBuildLock;
  waitForBuild: typeof waitForBuild;
  acquireBuildSlot: typeof acquireBuildSlot;
  releaseBuildSlot: typeof releaseBuildSlot;
  loadProjectProvider: typeof loadProjectProvider;
  checkEasAuth: typeof checkEasAuth;
  resolveRemote: typeof resolveRemote;
  uploadRemote: typeof uploadRemote;
  needsPrebuild: typeof needsPrebuild;
  runPrebuild: typeof runPrebuild;
  readPodState: typeof readPodState;
  podsAreStale: typeof podsAreStale;
  runPodInstall: typeof runPodInstall;
  buildIos: typeof buildIos;
  listIosDevices: typeof listIosDevices;
  hostLanCandidates: typeof hostLanCandidates;
  ensureLanReachable: typeof ensureLanReachable;
  gateProfileForDevice: typeof gateProfileForDevice;
  sealAppForDevice: typeof sealAppForDevice;
  installIosDeviceApp: typeof installIosDeviceApp;
  awaitIosDeviceLaunch: typeof awaitIosDeviceLaunch;
  acquireRunLease: typeof acquireRunLease;
  runLease: typeof runLease;
  selectFromPool: typeof selectFromPool;
  releaseLeaseOnSignal: typeof releaseLeaseOnSignal;
  iosDeviceProcess: typeof iosDeviceProcess;
  verifyIosDeviceReleaseLaunch: typeof verifyIosDeviceReleaseLaunch;
  readBundleId: typeof readBundleId;
  readBundleExecutable: typeof readBundleExecutable;
  swapJsBundle: typeof swapJsBundle;
  installIosApp: typeof installIosApp;
  clearOtherUserApps: typeof clearOtherUserApps;
  clearIosAdoptionPending: typeof clearIosAdoptionPending;
  launchIosApp: typeof launchIosApp;
  verifyLaunch: typeof verifyLaunch;
  verifyReleaseLaunch: typeof verifyReleaseLaunch;
  ensureWorkspaceStorage: typeof ensureWorkspaceStorageSafely;
  replaceCollector: typeof replaceCollector;
  stopPreviousCollector: typeof stopPreviousCollector;
  writeWorkspaceState: typeof writeWorkspaceState;
  createWriter: typeof createNdjsonWriter;
  recordStats: typeof recordRunStats;
  readEstimates: typeof readRunEstimates;
  now: () => number;
}

export const DEFAULT_DEPS: IosDeps = {
  findProjectRoot,
  resolveSettings,
  gitCommonDir,
  repoRoot,
  detectBundleId,
  detectIsExpo,
  devClientScheme,
  getProject,
  upsertProject,
  projectShortcut,
  checkDeviceCapacity,
  ensureOwnedDevice,
  listIosRuntimes,
  ensureBooted,
  resolveRemoteContext,
  remoteIosDeps,
  ensureMetroReachable,
  ensureRemoteBootOwned,
  detectProviders,
  resolveProjectMetro,
  resolveMetroWithRetry,
  readWorkspaceState,
  isPidAlive,
  getConcurrencyLimits,
  fingerprintProject,
  untrackedNativeFiles,
  resolveBuild,
  storeBuild,
  resolveCacheProviderConfig,
  loadCacheProvider,
  acquireBuildLock,
  releaseBuildLock,
  waitForBuild,
  acquireBuildSlot,
  releaseBuildSlot,
  loadProjectProvider,
  checkEasAuth,
  resolveEasCliBin,
  resolveRemote,
  uploadRemote,
  needsPrebuild,
  runPrebuild,
  readPodState,
  podsAreStale,
  runPodInstall,
  buildIos,
  listIosDevices,
  hostLanCandidates,
  ensureLanReachable,
  gateProfileForDevice,
  sealAppForDevice,
  installIosDeviceApp,
  awaitIosDeviceLaunch,
  acquireRunLease,
  runLease,
  selectFromPool,
  releaseLeaseOnSignal,
  iosDeviceProcess,
  verifyIosDeviceReleaseLaunch,
  readBundleId,
  readBundleExecutable,
  swapJsBundle,
  installIosApp,
  clearOtherUserApps,
  clearIosAdoptionPending,
  launchIosApp,
  verifyLaunch,
  verifyReleaseLaunch,
  ensureWorkspaceStorage: ensureWorkspaceStorageSafely,
  replaceCollector,
  stopPreviousCollector,
  writeWorkspaceState,
  createWriter: createNdjsonWriter,
  recordStats: recordRunStats,
  readEstimates: readRunEstimates,
  now: () => Date.now(),
};
