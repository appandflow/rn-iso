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
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [serial, status] = trimmed.split(/\s+/);
    if (status !== 'device') continue;
    const m = serial.match(/^emulator-(\d+)$/);
    if (m) emulators.push({ serial, consolePort: parseInt(m[1], 10) });
  }
  return { emulators };
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
    const out = exec.runQuiet(`adb -s ${serial} shell getprop sys.boot_completed`);
    if (out && out.trim() === '1') return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
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
