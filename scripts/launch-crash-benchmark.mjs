import { createHash } from 'node:crypto';

export function launchCrashToken(runId) {
  const digest = createHash('sha256').update(runId).digest('hex').slice(0, 12).toUpperCase();
  return `STIM_BENCH_LAUNCH_CRASH_${digest}`;
}

export function injectRootRenderCrash(source, token) {
  if (!/^STIM_BENCH_LAUNCH_CRASH_[0-9A-F]{12}$/.test(token)) {
    throw new Error('launch-crash token has an unexpected format');
  }
  if (source.includes(token)) throw new Error('launch-crash token is already present');
  const rootLayout = 'export default function RootLayout() {\n';
  const at = source.indexOf(rootLayout);
  if (at === -1) throw new Error('RootLayout function was not found');
  const insertion = at + rootLayout.length;
  return `${source.slice(0, insertion)}  throw new Error('${token}');\n${source.slice(insertion)}`;
}

function successful(command) {
  return command.exitCode === undefined || command.exitCode === null || command.exitCode === 0;
}

function launchCommand(command, arm, platform) {
  if (arm === 'stim') return new RegExp(`(?:^|\\s)stim\\s+${platform}(?:\\s|$)`).test(command);
  if (platform === 'android') {
    return /\bexpo\s+run:android\b|\bgradlew\b|\badb\s+shell\s+am\s+start\b/.test(command);
  }
  return /\bexpo\s+run:ios\b|\bxcodebuild\b|\bxcrun\s+simctl\s+launch\b/.test(command);
}

function errorCaptureCommand(command, arm, platform) {
  if (arm === 'stim') return /(?:^|\s)stim\s+logs\s+--errors(?:\s|$)/.test(command);
  if (platform === 'android') return /\badb\s+logcat\b|\btail\b|\brg\b|\bgrep\b/.test(command);
  return /\bxcrun\s+simctl\s+spawn\b|\blog\s+(?:show|stream)\b|\btail\b|\brg\b|\bgrep\b/.test(command);
}

function sourceInspectionCommand(command, token) {
  if (/(?:^|\s)git\s+(?:diff|show)(?:\s|$)/.test(command)) return true;
  return (
    /(?:^|\s)(?:rg|grep|sed|cat|head|tail)(?:\s|$)/.test(command) &&
    (command.includes(token) || /app\/_layout\.tsx|RootLayout/.test(command))
  );
}

export function launchCrashDiagnosis(commands, { dispatchAt, token, arm = 'stim', platform = 'ios' }) {
  const sourceMarkers = ['app/_layout.tsx', 'RootLayout'];
  const initialLaunchIndex = commands.findIndex(
    (command) =>
      successful(command) &&
      launchCommand(command.command, arm, platform) &&
      typeof command.output === 'string' &&
      command.output.includes(token),
  );
  if (initialLaunchIndex === -1) {
    return { valid: false, reason: 'launch-crash-initial-launch-evidence-missing' };
  }
  const errorCaptureIndex = commands.findIndex(
    (command, index) =>
      index > initialLaunchIndex &&
      successful(command) &&
      errorCaptureCommand(command.command, arm, platform) &&
      typeof command.output === 'string' &&
      command.output.includes(token),
  );
  if (errorCaptureIndex === -1) {
    return { valid: false, reason: 'launch-crash-error-capture-missing' };
  }
  const earlyInspection = commands.findIndex(
    (command, index) => index < errorCaptureIndex && sourceInspectionCommand(command.command, token),
  );
  if (earlyInspection !== -1) {
    return { valid: false, reason: 'launch-crash-source-inspected-before-error-capture' };
  }
  const index = commands.findIndex(
    (command, commandIndex) =>
      commandIndex >= errorCaptureIndex &&
      successful(command) &&
      typeof command.output === 'string' &&
      command.output.includes(token) &&
      sourceMarkers.some((marker) => command.output.includes(marker)),
  );
  if (index === -1) {
    return { valid: false, reason: 'actionable-launch-crash-diagnosis-missing' };
  }
  const command = commands[index];
  const observedAt = command.endedAt;
  const dispatchToDiagnosisSeconds = (Date.parse(observedAt) - Date.parse(dispatchAt)) / 1000;
  if (!Number.isFinite(dispatchToDiagnosisSeconds) || dispatchToDiagnosisSeconds < 0) {
    return { valid: false, reason: 'launch-crash-diagnosis-time-invalid' };
  }
  return {
    valid: true,
    observedAt,
    dispatchToDiagnosisSeconds,
    commandCount: index + 1,
    commandId: command.id,
    command: command.command,
    initialLaunchCommandId: commands[initialLaunchIndex].id,
    errorCaptureCommandId: commands[errorCaptureIndex].id,
  };
}

export function launchCrashRepair(source, token, expectedSha256) {
  if (source.includes(token)) return { valid: false, reason: 'launch-crash-token-remains-in-source' };
  if (!source.trim()) return { valid: false, reason: 'launch-crash-repaired-source-empty' };
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  if (expectedSha256 && sourceSha256 !== expectedSha256) {
    return { valid: false, reason: 'launch-crash-source-not-restored', sourceSha256 };
  }
  return { valid: true, sourceSha256 };
}

export function launchCrashRecovery(commands, { diagnosis, arm = 'stim', platform = 'ios', screen }) {
  if (!diagnosis?.valid) return { valid: false, reason: 'launch-crash-diagnosis-missing' };
  const diagnosisIndex = commands.findIndex((command) => command.id === diagnosis.commandId);
  const repairedLaunch = commands.find(
    (command, index) =>
      index > diagnosisIndex &&
      successful(command) &&
      launchCommand(command.command, arm, platform) &&
      typeof command.output === 'string' &&
      /\bOK:/.test(command.output),
  );
  if (!repairedLaunch) return { valid: false, reason: 'launch-crash-repaired-relaunch-missing' };
  if (!screen?.valid) return { valid: false, reason: 'launch-crash-settings-proof-missing' };
  return { valid: true, repairedLaunchCommandId: repairedLaunch.id };
}
