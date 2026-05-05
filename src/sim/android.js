import { getExecutor } from '../exec.js';

export function parseAvdList(text) {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('INFO') && !l.startsWith('WARNING'));
}

export function parseAdbDevices(text) {
  const lines = text.split('\n').slice(1); // skip "List of devices attached"
  const emulators = [];
  const unhealthy = []; // serials adb sees but can't talk to (unauthorized/offline)
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [serial, status] = trimmed.split(/\s+/);
    const m = serial.match(/^emulator-(\d+)$/);
    if (!m) continue;
    if (status === 'device') {
      emulators.push({ serial, consolePort: parseInt(m[1], 10) });
    } else {
      unhealthy.push({ serial, consolePort: parseInt(m[1], 10), status });
    }
  }
  return { emulators, unhealthy };
}

export function listAvds() {
  return parseAvdList(getExecutor().run('emulator -list-avds'));
}

export function listAdbDevices() {
  return parseAdbDevices(getExecutor().run('adb devices'));
}

export function nextConsolePort(claimedPorts) {
  if (claimedPorts.length === 0) return 5554;
  const max = Math.max(...claimedPorts);
  return max + 2; // emulator console ports are even
}

// Build the full candidate list: every AVD on disk, paired with whether it
// currently has a running emulator and (if so) on which console port.
// Emulators that fail to respond to `adb emu avd name` are dropped from
// the running map. Returns [] when no AVDs are installed.
export function enumerateAndroidCandidates() {
  const avds = listAvds();
  if (avds.length === 0) return [];

  const adbDevices = listAdbDevices();
  const runningByAvd = {};
  for (const e of adbDevices.emulators) {
    const avdName = getAvdNameForSerial(e.serial);
    if (avdName) runningByAvd[avdName] = e.consolePort;
  }

  return avds.map(avdName => ({
    avdName,
    isRunning: avdName in runningByAvd,
    consolePort: runningByAvd[avdName] ?? null,
  }));
}

export function selectAndroidDevice({ existingAvd, existingConsolePort, claimedAvds, claimedConsolePorts }) {
  const all = enumerateAndroidCandidates();
  if (all.length === 0) return { kind: 'noAvd' };

  if (existingAvd) {
    const found = all.find(c => c.avdName === existingAvd);
    if (found) {
      return {
        kind: 'reuse',
        avdName: existingAvd,
        consolePort: found.consolePort ?? existingConsolePort ?? nextConsolePort(claimedConsolePorts),
        isRunning: found.isRunning,
      };
    }
  }

  const claimedAvdSet = new Set(claimedAvds);
  const unclaimed = all.filter(c => !claimedAvdSet.has(c.avdName));

  if (unclaimed.length === 0) {
    return { kind: 'allClaimed', candidates: sortAndroidCandidates(all) };
  }
  return { kind: 'allocate', candidates: sortAndroidCandidates(unclaimed) };
}

export function sortAndroidCandidates(list) {
  return [...list].sort((a, b) => {
    if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
    return a.avdName.localeCompare(b.avdName);
  });
}

export function bootAndroidEmulator(avdName, consolePort) {
  const exec = getExecutor();
  exec.spawn('emulator', ['-avd', avdName, '-port', String(consolePort)], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

export async function waitForBoot(serial, timeoutMs = 60000) {
  const exec = getExecutor();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // sys.boot_completed is the canonical "system fully up" signal; some
    // older AVD images set dev.bootcomplete sooner. Either is fine.
    const sysBoot = exec.runQuiet(`adb -s ${serial} shell getprop sys.boot_completed`).trim();
    if (sysBoot === '1') return { ok: true };
    const devBoot = exec.runQuiet(`adb -s ${serial} shell getprop dev.bootcomplete`).trim();
    if (devBoot === '1') return { ok: true };
    await new Promise(r => setTimeout(r, 1000));
  }
  // Diagnostic snapshot for the timeout error: shows the user exactly
  // what adb sees and why the polling never resolved.
  const devices = exec.runQuiet('adb devices').trim();
  return {
    ok: false,
    diagnostic: {
      devices,
      sysBoot: exec.runQuiet(`adb -s ${serial} shell getprop sys.boot_completed`).trim(),
      devBoot: exec.runQuiet(`adb -s ${serial} shell getprop dev.bootcomplete`).trim(),
      bootAnim: exec.runQuiet(`adb -s ${serial} shell getprop init.svc.bootanim`).trim(),
    },
  };
}

export function shutdownAndroidEmulator(serial) {
  getExecutor().runQuiet(`adb -s ${serial} emu kill`);
}

export function adbReverse(serial, port) {
  getExecutor().run(`adb -s ${serial} reverse tcp:${port} tcp:${port}`);
}

export function getAvdNameForSerial(serial) {
  const out = getExecutor().runQuiet(`adb -s ${serial} emu avd name`);
  if (!out) return null;
  // `adb emu avd name` returns the AVD name on the first line, "OK" on the second.
  return out.split('\n')[0].trim() || null;
}
