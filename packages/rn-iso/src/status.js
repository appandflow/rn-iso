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

// `simsAvailable: false` means the sim listing could not be read at all
// (simctl missing, or a failing simctl). An empty map then says nothing about
// any recorded sim, so this reports the state as unknown instead of claiming
// every recorded device is gone.
export function environmentState(project, { simsByUdid = {}, metro = null, worktrees = [], simsAvailable = true } = {}) {
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
  if (ios && !sim && simsAvailable) warnings.push(`recorded sim ${ios.deviceUdid} no longer exists`);
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
      ? {
        name: sim?.name ?? null,
        udid: ios.deviceUdid,
        owned: Boolean(ios.owned),
        state: sim?.state ?? (simsAvailable ? 'missing' : 'unknown'),
      }
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

// Free disk, parsed from `df -k <path>`. rn-iso reports RAM commitment but was
// silent about disk, and disk is what actually ran out: two member-app
// environments filled a 926 GB volume, and once it was full nothing could run
// at all -- including `gc`, the command that exists to reclaim space.
//
// `df -k` rather than `-h` so the number needs no unit parsing. Returns null on
// any surprise: this is a hint printed beside a summary, never a gate.
export function parseDfFree(output) {
  const lines = String(output || '').trim().split('\n');
  if (lines.length < 2) return null;
  // Fields: Filesystem 1024-blocks Used Available Capacity ... Mounted-on.
  // The filesystem name can contain spaces, so count from the RIGHT of the
  // capacity field rather than assuming field 0 is one token.
  const m = /\s(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%/.exec(lines[lines.length - 1]);
  if (!m) return null;
  const totalKb = Number(m[1]);
  const availableKb = Number(m[3]);
  if (!Number.isFinite(totalKb) || !Number.isFinite(availableKb) || totalKb <= 0) return null;
  return { availableMb: Math.round(availableKb / 1024), totalMb: Math.round(totalKb / 1024) };
}

// Below this, a single iOS build can fail partway with a disk error that names
// nothing about disk. Worth saying before it happens, not after.
export function diskIsTight(disk) {
  return Boolean(disk && disk.availableMb < 25 * 1024);
}

// Worktrees rn-iso knows nothing about: a workspace someone created by hand, or
// one whose environment was released. Listing them is what makes this a
// replacement for `worktree list` rather than a second thing to check.
export function unprovisionedWorktrees(worktrees, projectPaths) {
  const known = new Set(projectPaths);
  return worktrees.filter(w => !known.has(w.path));
}
