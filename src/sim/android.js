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
  const physical = []; // USB or adb-over-TCP serials (e.g. R5CR70XXX, 192.168.1.5:5555)
  const unhealthy = []; // serials adb sees but can't talk to (unauthorized/offline)
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [serial, status] = trimmed.split(/\s+/);
    const m = serial.match(/^emulator-(\d+)$/);
    if (m) {
      if (status === 'device') {
        emulators.push({ serial, consolePort: parseInt(m[1], 10) });
      } else {
        unhealthy.push({ serial, kind: 'emulator', consolePort: parseInt(m[1], 10), status });
      }
    } else {
      if (status === 'device') {
        physical.push({ serial });
      } else {
        unhealthy.push({ serial, kind: 'physical', status });
      }
    }
  }
  return { emulators, physical, unhealthy };
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

// Build the full candidate list: every AVD on disk plus every physical
// device adb currently sees. AVDs are paired with whether they have a
// running emulator (and on which console port); physical devices are
// always treated as running. Returns [] when neither exist.
export function enumerateAndroidCandidates() {
  const avds = listAvds();
  const adbDevices = listAdbDevices();

  const runningByAvd = {};
  for (const e of adbDevices.emulators) {
    const avdName = getAvdNameForSerial(e.serial);
    if (avdName) runningByAvd[avdName] = e.consolePort;
  }

  const avdCandidates = avds.map(avdName => ({
    kind: 'avd',
    avdName,
    isRunning: avdName in runningByAvd,
    consolePort: runningByAvd[avdName] ?? null,
  }));

  const physicalCandidates = adbDevices.physical.map(p => ({
    kind: 'physical',
    serial: p.serial,
    isRunning: true,
    consolePort: null,
  }));

  return [...avdCandidates, ...physicalCandidates];
}

export function selectAndroidDevice({
  existingAvd,
  existingSerial,
  existingConsolePort,
  claimedAvds,
  claimedSerials,
  claimedConsolePorts,
}) {
  const all = enumerateAndroidCandidates();
  if (all.length === 0) return { kind: 'noAvd' };

  if (existingSerial) {
    const found = all.find(c => c.kind === 'physical' && c.serial === existingSerial);
    if (found) {
      return {
        kind: 'reuse',
        deviceKind: 'physical',
        serial: existingSerial,
        isRunning: true,
      };
    }
  }

  if (existingAvd) {
    const found = all.find(c => c.kind === 'avd' && c.avdName === existingAvd);
    if (found) {
      return {
        kind: 'reuse',
        deviceKind: 'avd',
        avdName: existingAvd,
        consolePort: found.consolePort ?? existingConsolePort ?? nextConsolePort(claimedConsolePorts),
        isRunning: found.isRunning,
      };
    }
  }

  const claimedAvdSet = new Set(claimedAvds);
  const claimedSerialSet = new Set(claimedSerials || []);
  const unclaimed = all.filter(c => c.kind === 'avd'
    ? !claimedAvdSet.has(c.avdName)
    : !claimedSerialSet.has(c.serial));

  if (unclaimed.length === 0) {
    return { kind: 'allClaimed', candidates: sortAndroidCandidates(all) };
  }
  return { kind: 'allocate', candidates: sortAndroidCandidates(unclaimed) };
}

export function sortAndroidCandidates(list) {
  return [...list].sort((a, b) => {
    if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
    // Mixed lists: physical devices float above AVDs within the same running state.
    if (a.kind !== b.kind) return a.kind === 'physical' ? -1 : 1;
    const an = a.kind === 'physical' ? a.serial : a.avdName;
    const bn = b.kind === 'physical' ? b.serial : b.avdName;
    return an.localeCompare(bn);
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
