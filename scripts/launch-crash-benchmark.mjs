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

export function launchCrashDiagnosis(commands, { dispatchAt, token }) {
  const sourceMarkers = ['app/_layout.tsx', 'RootLayout'];
  const index = commands.findIndex(
    (command) =>
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
  };
}

export function launchCrashRepair(source, token) {
  return source.includes(token) ? { valid: false, reason: 'launch-crash-token-remains-in-source' } : { valid: true };
}
