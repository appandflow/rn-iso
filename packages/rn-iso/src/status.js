// The one question a machine running several agents actually raises: who is
// using this Mac right now, and is anything stuck?
//
// The registry alone cannot answer it. A project entry says a simulator was
// assigned, not whether it is booted; it says a port was reserved, not whether
// Metro is listening or whether the thing listening is even ours. Those gaps are
// exactly where a wedged environment hides, so this assembles the live facts
// alongside the recorded ones.
//
// Kept pure: every fact comes in as an argument, so the shape of the report can
// be tested without a simulator, a port or a git repo.

// Rough, and deliberately so. The point is not to model memory accurately, it is
// to notice that a fourth environment on a 16 GB laptop will swap -- and swapping
// is slower than working sequentially, which is the one failure mode a parallel
// agent cannot see for itself.
const IOS_SIM_MB = 1500;
const ANDROID_EMULATOR_MB = 2500;
const METRO_MB = 700;

export function environmentState(project, { simsByUdid = {}, metro = null, worktrees = [] } = {}) {
  const ios = project.platforms?.ios;
  const android = project.platforms?.android;
  const sim = ios ? simsByUdid[ios.deviceUdid] : null;

  // "Live" means something is actually consuming the machine right now: a booted
  // device or a running Metro. A registered-but-idle project costs nothing and
  // should not read as competition for resources.
  const simBooted = Boolean(sim && sim.state === 'Booted');
  const metroRunning = Boolean(metro?.metro);
  const live = simBooted || metroRunning || Boolean(android?.serial);

  let memoryMb = 0;
  if (simBooted) memoryMb += IOS_SIM_MB;
  if (android?.serial) memoryMb += ANDROID_EMULATOR_MB;
  if (metroRunning) memoryMb += METRO_MB;

  const warnings = [];
  // A port reserved for us that something else answers on is the failure that
  // silently builds against the wrong bundler, so it outranks everything else.
  if (metro?.notOurs) warnings.push(`port ${project.metroPort}: ${metro.notOurs}`);
  // A device recorded but no longer present means the record outlived the sim.
  if (ios && !sim) warnings.push(`recorded sim ${ios.deviceUdid} no longer exists`);
  // Booted with no bundler is the shape of an environment somebody walked away
  // from: it holds ~1.5 GB and serves nothing.
  if (simBooted && project.metroPort && !metroRunning) {
    warnings.push('simulator is booted with no Metro serving it');
  }

  return {
    path: project.__path,
    live,
    memoryMb,
    warnings,
    ios: ios
      ? { name: sim?.name ?? null, udid: ios.deviceUdid, owned: Boolean(ios.owned), state: sim?.state ?? 'missing' }
      : null,
    android: android
      ? { name: android.avdName ?? android.serial, owned: Boolean(android.owned), physical: Boolean(android.serial && !android.avdName) }
      : null,
    metro: project.metroPort
      ? { port: project.metroPort, running: metroRunning, pid: metro?.metro?.pid ?? null }
      : null,
    // A worktree whose environment is registered is the normal case; one without
    // is a workspace nobody has provisioned yet, which is worth seeing.
    worktree: worktrees.find(w => w.path === project.__path) ?? null,
  };
}

// Over capacity is the interesting verdict, not exact numbers: past the point
// where committed memory exceeds what the machine has, more parallelism makes
// everything slower, and nothing else in the system will say so.
export function capacity(states, totalMemoryMb) {
  const committedMb = states.reduce((n, s) => n + s.memoryMb, 0);
  const liveCount = states.filter(s => s.live).length;
  return {
    liveCount,
    committedMb,
    totalMemoryMb,
    // Leave room for the OS and an editor; a machine at 100% committed is
    // already swapping.
    overCapacity: Boolean(totalMemoryMb && committedMb > totalMemoryMb * 0.6),
  };
}

// Worktrees rn-iso knows nothing about: a workspace someone created by hand, or
// one whose environment was released. Listing them is what makes this a
// replacement for `worktree list` rather than a second thing to check.
export function unprovisionedWorktrees(worktrees, projectPaths) {
  const known = new Set(projectPaths);
  return worktrees.filter(w => !known.has(w.path));
}
