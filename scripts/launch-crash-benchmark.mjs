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

function shellCommand(command) {
  const value = String(command ?? '').trim();
  const body = value.replace(/^\/bin\/(?:zsh|bash|sh) -lc\s+/, '');
  return body.replace(/^["']/, '').replace(/["']$/, '').trim();
}

function launchCommand(command, arm, platform) {
  command = shellCommand(command);
  if (arm === 'stim') return new RegExp(`(?:^|\\s)stim\\s+${platform}(?:\\s|$)`).test(command);
  if (platform === 'android') {
    return (
      /(?:\bexpo|expo\/bin\/cli|node_modules\/\.bin\/expo)\s+run:android\b/.test(command) ||
      /\bgradlew\b[^\n]*(?:install|connected)\w*|\badb\s+shell\s+am\s+start\b/.test(command)
    );
  }
  return (
    /(?:\bexpo|expo\/bin\/cli|node_modules\/\.bin\/expo)\s+run:ios\b/.test(command) ||
    /\bxcrun\s+simctl\s+(?:launch|openurl)\b/.test(command)
  );
}

function errorCaptureCommand(command, arm, platform) {
  command = shellCommand(command);
  if (arm === 'stim') return /(?:^|\s)stim\s+logs\s+--errors(?:\s|$)/.test(command);
  if (platform === 'android') return /\badb\s+logcat\b|\btail\b|\brg\b|\bgrep\b/.test(command);
  return /\bxcrun\s+simctl\s+spawn\b|\blog\s+(?:show|stream)\b|\btail\b|\brg\b|\bgrep\b/.test(command);
}

function timestamp(command, field) {
  const value = Date.parse(command[field] ?? command.endedAt);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function orderedCommands(commands) {
  return commands
    .map((command, originalIndex) => ({ ...command, originalIndex }))
    .toSorted(
      (left, right) =>
        timestamp(left, 'startedAt') - timestamp(right, 'startedAt') || left.originalIndex - right.originalIndex,
    );
}

function sourceInspectionBeforeCapture(command, arm, platform) {
  const value = shellCommand(command);
  if (/(?:\/(?:skills|skill)\/[^\s]+\/|(?:^|\s)workspace\/)SKILL\.md\b/.test(value)) return false;
  if (/(?:^|[;&|]\s*)git\s+(?:diff|show)(?!-ref)(?:\s|$)/.test(value)) return true;
  if (/(?:^|[;&|]\s*)(?:\/[^\s]+\/)?(?:node|python\d*|ruby|perl)\s+(?:-[^-\s]*[ec]|--eval)\b/.test(value)) {
    return true;
  }
  const namesSource = /(?:^|[\s'"`])(?:app|src)\/|\.(?:[cm]?[jt]sx?|swift|kt|java)(?:[\s'"`]|$)/.test(value);
  if (namesSource && !errorCaptureCommand(value, arm, platform)) return true;
  if (/RootLayout|STIM_BENCH_LAUNCH_CRASH_/.test(value) && !errorCaptureCommand(value, arm, platform)) return true;
  return false;
}

function allowedBeforeErrorCapture(command, arm, platform) {
  const value = shellCommand(command);
  if (/^tool:todo_list\b/.test(value)) return true;
  if (/^(?:env\s+)?(?:[^\s=]+=[^\s]+\s+)*agent-device\s+/.test(value)) return true;
  if (sourceInspectionBeforeCapture(value, arm, platform)) return false;
  if (
    /(?:\/(?:skills|skill)\/[^\s]+\/|(?:^|\s)workspace\/)SKILL\.md\b/.test(value) &&
    /(?:^|\s)(?:cat|sed|head)(?:\s|$)/.test(value)
  ) {
    return true;
  }
  if (
    /^(?:pwd|ls(?:\s|$)|du(?:\s|$)|for\s|git\s+(?:rev-parse|show-ref|status|worktree\s+add)(?:\s|$)|mkdir(?:\s|$))/.test(
      value,
    )
  ) {
    return true;
  }
  if (/^cp\b/.test(value) && /(?:node_modules|ios\/Pods|ios\/build|android\/(?:\.gradle|app\/build))/.test(value)) {
    return true;
  }
  if (arm === 'stim') {
    return new RegExp(`^stim\\s+(?:worktree\\s+create|start|${platform}|logs\\s+--errors)(?:\\s|$)`).test(value);
  }
  return (
    /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:\S+|\$\([^)]*\))[;\s]+)*)(?:open\s+-a\s+Simulator|xcrun\s+simctl\s+|npx\s+expo\s+|xcodebuild\b|\.\/gradlew\b|adb\b|nohup\b|launchctl\b|ps\b|sleep\b|tail\b|cat\s+\/?tmp\/|wc\b|lsof\b|command\s+-v\b|test\b|kill\b)/.test(
      value,
    ) ||
    launchCommand(value, arm, platform) ||
    errorCaptureCommand(value, arm, platform)
  );
}

export function launchCrashDiagnosis(commands, { dispatchAt, token, arm = 'stim', platform = 'ios', activities = [] }) {
  const ordered = orderedCommands(commands);
  const sourceMarkers = ['app/_layout.tsx', 'RootLayout'];
  const initialLaunchIndex = ordered.findIndex(
    (command) =>
      successful(command) &&
      launchCommand(command.command, arm, platform) &&
      (arm !== 'stim' || (typeof command.output === 'string' && command.output.includes(token))),
  );
  if (initialLaunchIndex === -1) {
    return { valid: false, reason: 'launch-crash-initial-launch-evidence-missing' };
  }
  const errorCaptureIndex = ordered.findIndex(
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
  const captureEndedAt = timestamp(ordered[errorCaptureIndex], 'endedAt');
  const preCaptureActivity = [...ordered, ...activities].toSorted(
    (left, right) => timestamp(left, 'startedAt') - timestamp(right, 'startedAt'),
  );
  const disallowedBeforeCapture = preCaptureActivity.find(
    (command) =>
      timestamp(command, 'startedAt') < captureEndedAt && !allowedBeforeErrorCapture(command.command, arm, platform),
  );
  if (disallowedBeforeCapture) {
    return {
      valid: false,
      reason: 'launch-crash-pre-capture-command-not-allowed',
      commandId: disallowedBeforeCapture.id,
    };
  }
  const capture = ordered[errorCaptureIndex];
  const captureIsActionable =
    typeof capture.output === 'string' &&
    capture.output.includes(token) &&
    sourceMarkers.some((marker) => capture.output.includes(marker));
  const index = captureIsActionable
    ? errorCaptureIndex
    : ordered.findIndex(
        (command) =>
          timestamp(command, 'startedAt') >= captureEndedAt &&
          successful(command) &&
          typeof command.output === 'string' &&
          command.output.includes(token) &&
          sourceMarkers.some((marker) => command.output.includes(marker)),
      );
  if (index === -1) {
    return { valid: false, reason: 'actionable-launch-crash-diagnosis-missing' };
  }
  const command = ordered[index];
  const observedAt = command.endedAt;
  const dispatchToDiagnosisSeconds = (Date.parse(observedAt) - Date.parse(dispatchAt)) / 1000;
  if (!Number.isFinite(dispatchToDiagnosisSeconds) || dispatchToDiagnosisSeconds < 0) {
    return { valid: false, reason: 'launch-crash-diagnosis-time-invalid' };
  }
  return {
    valid: true,
    observedAt,
    dispatchToDiagnosisSeconds,
    commandCount: ordered.filter((candidate) => timestamp(candidate, 'endedAt') <= Date.parse(observedAt)).length,
    commandId: command.id,
    command: command.command,
    initialLaunchCommandId: ordered[initialLaunchIndex].id,
    errorCaptureCommandId: ordered[errorCaptureIndex].id,
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
  const ordered = orderedCommands(commands);
  const diagnosisCommand = ordered.find((command) => command.id === diagnosis.commandId);
  const diagnosisEndedAt = timestamp(diagnosisCommand ?? {}, 'endedAt');
  const repairedLaunch = ordered.find(
    (command) =>
      timestamp(command, 'startedAt') >= diagnosisEndedAt &&
      successful(command) &&
      launchCommand(command.command, arm, platform) &&
      typeof command.output === 'string' &&
      !command.output.includes('STIM_BENCH_LAUNCH_CRASH_') &&
      (arm !== 'stim' || /\bOK:/.test(command.output)),
  );
  if (!repairedLaunch) return { valid: false, reason: 'launch-crash-repaired-relaunch-missing' };
  if (!screen?.valid) return { valid: false, reason: 'launch-crash-settings-proof-missing' };
  if (!screen.screenshotCommandId) {
    return { valid: false, reason: 'launch-crash-settings-command-missing' };
  }
  const screenshot = ordered.find((command) => command.id === screen.screenshotCommandId);
  if (
    !screenshot ||
    !successful(screenshot) ||
    !/(?:^|\s)agent-device\s+screenshot(?:\s|$)/.test(shellCommand(screenshot.command))
  ) {
    return { valid: false, reason: 'launch-crash-settings-command-invalid' };
  }
  if (
    timestamp(screenshot, 'startedAt') < timestamp(repairedLaunch, 'endedAt') ||
    timestamp({ endedAt: screen.observedAt }, 'endedAt') !== timestamp(screenshot, 'endedAt')
  ) {
    return { valid: false, reason: 'launch-crash-settings-proof-before-relaunch' };
  }
  return {
    valid: true,
    repairedLaunchCommandId: repairedLaunch.id,
    screenshotCommandId: screen.screenshotCommandId,
  };
}
