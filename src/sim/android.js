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

export function selectAndroidDevice({ existingAvd, existingConsolePort, claimedAvds, claimedConsolePorts }) {
  const avds = listAvds();
  if (avds.length === 0) return { kind: 'noAvd' };

  const adbDevices = listAdbDevices();
  // Resolve which AVD each running emulator is. Emulators that don't respond
  // to `adb emu avd name` are dropped from the running map.
  const runningByAvd = {};
  for (const e of adbDevices.emulators) {
    const avdName = getAvdNameForSerial(e.serial);
    if (avdName) runningByAvd[avdName] = e.consolePort;
  }

  const buildCandidate = (avdName) => ({
    avdName,
    isRunning: avdName in runningByAvd,
    consolePort: runningByAvd[avdName] ?? null,
  });

  if (existingAvd && avds.includes(existingAvd)) {
    const runningPort = runningByAvd[existingAvd];
    return {
      kind: 'reuse',
      avdName: existingAvd,
      consolePort: runningPort ?? existingConsolePort ?? nextConsolePort(claimedConsolePorts),
      isRunning: runningPort != null,
    };
  }

  const claimedAvdSet = new Set(claimedAvds);
  const all = avds.map(buildCandidate);
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
