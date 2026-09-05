import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { launchCrashDiagnosis, launchCrashRecovery } from './launch-crash-benchmark.mjs';

const modelPricing = {
  'gpt-5.6-luna': {
    inputPerMillion: 0.2,
    cachedInputPerMillion: 0.02,
    outputPerMillion: 1.2,
    source: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
  },
  'gpt-5.6-sol': {
    inputPerMillion: 4,
    cachedInputPerMillion: 0.4,
    outputPerMillion: 20,
    source: 'https://developers.openai.com/api/docs/models/gpt-5.6-sol',
  },
};

const absolutePathPattern =
  /(?<![A-Za-z0-9._/])\/(?:Applications|Library|System|Users|Volumes|private|tmp|var|opt|Pods\.build|XPCServices)(?![A-Za-z0-9._+-])(?:\/[^\s'"`,;()<>[\]]+)*/g;
const webUrlPattern = /https?:\/\/[^\s'"`<>]+/gi;
const nestedPrivateAbsolutePathPattern =
  /([A-Za-z0-9._+-])(\/(?:Users|Volumes)(?![A-Za-z0-9._+-])(?:\/[^\s'"`,;()<>[\]]+)*)/g;
const compilerFlagAbsolutePathPattern =
  /(-[FLI])((?:\/(?:Applications|Library|System|Users|Volumes|private|tmp|var|opt))(?![A-Za-z0-9._+-])(?:\/[^\s'"`,;()<>[\]]+)*)/g;
const fileUrlAbsolutePathPattern =
  /file:\/\/(\/(?:Applications|Library|System|Users|Volumes|private|tmp|var|opt)(?![A-Za-z0-9._+-])(?:\/[^\s'"`,;()<>[\]]+)*)/g;
const systemAbsolutePathPattern = /(?<![A-Za-z0-9._/-])\/(?:usr\/(?:s?bin)|bin|sbin)\/[A-Za-z0-9._+-]+/g;
const homebrewExecutablePattern = /\/opt\/homebrew\/bin\/([A-Za-z0-9._+-]+)/g;
const shellPathPattern = /\bPATH=(?:"[^"]*"|'[^']*'|[^\s]+)/g;
const ipAddressPattern = /(?:\d{1,3}\.){3}\d{1,3}/g;
const ipv6LoopbackPattern = /\[::1\]|(?<![A-Za-z0-9:])::1(?![A-Za-z0-9:])/g;
const simulatorIdPattern = /\b[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\b/gi;
const simulatorIdPrefixPattern = /\b(?=[0-9A-F]{8}\b)(?=[0-9A-F]*[A-F])[0-9A-F]{8}\b/g;
const simulatorShortIdPattern = /\b[0-9A-F]{4}\.\./gi;
const localHostnamePattern = /\b(?:[A-Za-z0-9-]+\.)+local\b/gi;
const remoteBranchUserPattern = /(\bremotes\/[^/\s]+\/)@[^/\s]+(?=\/)/g;
const agentDeviceBundlePattern = /\b(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9.-]*agentdevice[A-Za-z0-9.-]*\b/gi;
const processInspectionPattern = /\b(?:ps|pgrep)(?:\s|$)/;
const deviceInventoryPattern = /\b(?:agent-device devices|xcrun simctl list devices)\b/;
const machineStoragePattern = /\b(?:df|diskutil)(?:\s|$)/;
const branchInventoryPattern = /\bgit\s+(?:branch|for-each-ref)(?:\s|$)/;
const interactiveShellPattern = /^(?:bash|sh|zsh)$/;
const adbPublicKeyMessagePattern = /(\bSending adb public key \[)[A-Za-z0-9+/=]{80,}(?:\s+[^\]\r\n]*)?(\])/g;
const adbPublicKeyBootArgumentPattern = /(\bandroidboot\.qemu\.adb\.pubkey=)[A-Za-z0-9+/=]{80,}/g;
const simulatorIdExactPattern = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function clipped(value, max = 16_000) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}\n... output clipped for the viewer`;
}

function publicRunId(record) {
  return `${record.variant}-${record.arm}`;
}

function formatStage(stage) {
  return stage
    .split('-')
    .map((part, index) => {
      const releaseCandidate = part.match(/^rc(\d+)$/);
      if (releaseCandidate) return `rc.${releaseCandidate[1]}`;
      if (part === 'android') return 'Android';
      if (part === 'ios') return 'iOS';
      return index === 0 ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part;
    })
    .join(' ');
}

function displaySimulator(meta) {
  if (meta.platform === 'android') {
    const expected = meta.expectedControlSimulator ?? meta.expectedStimDevice ?? {};
    return [expected.deviceTypeIdentifier, expected.runtimeIdentifier, expected.systemImage]
      .filter(Boolean)
      .join(' / ');
  }
  const parked = meta.preflight?.parkedSimulator ?? meta.expectedParkedSimulator;
  const model = parked?.deviceTypeIdentifier
    ?.replace('com.apple.CoreSimulator.SimDeviceType.', '')
    .replaceAll('-', ' ');
  const runtimeId = parked?.runtimeIdentifier?.replace('com.apple.CoreSimulator.SimRuntime.', '');
  const runtimeMatch = runtimeId?.match(/^([A-Za-z]+)-(\d+)-(\d+)$/);
  const runtime = runtimeMatch
    ? `${runtimeMatch[1]} ${runtimeMatch[2]}.${runtimeMatch[3]}`
    : runtimeId?.replaceAll('-', ' ');
  return [model, runtime].filter(Boolean).join(' / ') || 'Not recorded';
}

export function benchmarkEnvironment(meta, machine = {}) {
  const actual = meta.preflight?.actual ?? {};
  const androidEmulatorVersion = actual.ANDROID_EMULATOR_VERSION?.replace(/^(\d+\.\d+\.\d+)\.0\b/, '$1');
  return {
    machine: {
      model: machine.model ?? actual.MACHINE_MODEL ?? 'Not recorded',
      chip: machine.chip ?? actual.MACHINE_CHIP ?? 'Not recorded',
      memory: machine.memory ?? actual.MACHINE_MEMORY ?? 'Not recorded',
    },
    macos:
      [actual.MACOS_VERSION && `macOS ${actual.MACOS_VERSION}`, actual.MACOS_BUILD && `(${actual.MACOS_BUILD})`]
        .filter(Boolean)
        .join(' ') || 'Not recorded',
    xcode:
      meta.platform === 'android'
        ? actual.ANDROID_SDK_VERSION
          ? [
              `Android SDK ${actual.ANDROID_SDK_VERSION}`,
              androidEmulatorVersion && `Emulator ${androidEmulatorVersion}`,
              actual.ADB_VERSION && `adb ${actual.ADB_VERSION}`,
            ]
              .filter(Boolean)
              .join(' / ')
          : 'Android SDK (version not recorded)'
        : [actual.XCODE_VERSION && `Xcode ${actual.XCODE_VERSION}`, actual.XCODE_BUILD && `(${actual.XCODE_BUILD})`]
            .filter(Boolean)
            .join(' ') || 'Not recorded',
    node: actual.NODE_VERSION ? `Node ${actual.NODE_VERSION}` : 'Not recorded',
    simulator: displaySimulator(meta),
  };
}

function replacementLabel(path) {
  if (path.startsWith('/Applications/Xcode.app/Contents/Developer/')) {
    return `Xcode/${path.slice('/Applications/Xcode.app/Contents/Developer/'.length)}`;
  }
  if (/^\/(?:usr\/)?(?:s?bin)\/[^/]+$/.test(path)) return basename(path);
  if (path.startsWith('/Pods.build/')) return `build/${path.slice(1)}`;
  if (path === '/XPCServices' || path.startsWith('/XPCServices/')) return `app${path}`;
  if (path.startsWith('/Library/') || path.startsWith('/System/')) return `system/${path.slice(1)}`;
  const parts = path.split('/').filter(Boolean);
  const worktreeIndex = parts.findIndex((part) => part.includes('worktree'));
  if (worktreeIndex >= 0) return `worktree/${parts.slice(worktreeIndex + 1).join('/') || 'project'}`;
  const stimHomeIndex = parts.findIndex((part) => part === 'stim-home');
  if (stimHomeIndex >= 0) return `stim-home/${parts.slice(stimHomeIndex + 1).join('/')}`;
  const proofIndex = parts.findIndex((part) => part === 'proof');
  if (proofIndex >= 0) return `proof/${parts.slice(proofIndex + 1).join('/')}`;
  if (path.startsWith('/tmp/') || path.startsWith('/private/tmp/')) return `tmp/${basename(path)}`;
  return `workspace/${basename(path)}`;
}

function unwrapShellCommand(command) {
  return String(command)
    .replace(/^\/bin\/(?:zsh|bash|sh) -lc /, '')
    .replace(/^(['"])([\s\S]*)\1$/, '$2');
}

export function sanitizeBenchmarkText(value, replacements = []) {
  let text = stripVTControlCharacters(String(value ?? ''));
  for (const [absolute, portable] of replacements.toSorted((a, b) => b[0].length - a[0].length)) {
    text = text.replaceAll(absolute, portable);
  }
  const webUrls = [];
  text = text.replace(webUrlPattern, (url) => {
    const token = `\u0000stim-web-url-${webUrls.length}\u0000`;
    webUrls.push([token, url]);
    return token;
  });
  text = text.replace(shellPathPattern, 'PATH=<toolchain-path>');
  text = text.replace(homebrewExecutablePattern, '$1');
  text = text.replace(agentDeviceBundlePattern, '<agent-device-helper>');
  text = text.replace(adbPublicKeyMessagePattern, '$1<adb-public-key>$2');
  text = text.replace(adbPublicKeyBootArgumentPattern, '$1<adb-public-key>');
  text = text.replace(fileUrlAbsolutePathPattern, (_match, path) => `file:///${replacementLabel(path)}`);
  text = text.replace(compilerFlagAbsolutePathPattern, (_match, flag, path) => `${flag}${replacementLabel(path)}`);
  text = text.replace(
    nestedPrivateAbsolutePathPattern,
    (_match, prefix, path) => `${prefix}/${replacementLabel(path)}`,
  );
  text = text.replace(absolutePathPattern, (path) => replacementLabel(path));
  text = text.replace(systemAbsolutePathPattern, (path) => replacementLabel(path));
  for (const [token, url] of webUrls) text = text.replaceAll(token, url);
  text = text.replace(remoteBranchUserPattern, '$1@<user>');
  text = text.replaceAll(userInfo().username, '<local-user>');
  return text
    .replace(simulatorIdPattern, '<simulator-udid>')
    .replace(simulatorIdPrefixPattern, '<simulator-udid-prefix>')
    .replace(simulatorShortIdPattern, '<simulator-udid-prefix>')
    .replace(localHostnamePattern, '<local-host>')
    .replace(ipAddressPattern, '<local-ip>')
    .replace(ipv6LoopbackPattern, '<local-ip>');
}

export function sanitizeCommandOutput(command, value, replacements = []) {
  const unwrapped = unwrapShellCommand(command);
  if (interactiveShellPattern.test(unwrapped)) {
    return '<interactive shell transcript omitted from public artifact>';
  }
  if (deviceInventoryPattern.test(unwrapped)) {
    return '<device inventory omitted from public artifact>';
  }
  if (machineStoragePattern.test(unwrapped)) {
    return '<machine storage inventory omitted from public artifact>';
  }
  if (branchInventoryPattern.test(unwrapped)) {
    return '<branch inventory omitted from public artifact>';
  }
  if (processInspectionPattern.test(unwrapped)) {
    return '<process output omitted from public artifact>';
  }
  return sanitizeBenchmarkText(clipped(value), replacements);
}

export function estimateTokenCost(usage, model) {
  const pricing = modelPricing[model];
  if (!usage || !pricing) return null;
  const input = usage.input_tokens ?? 0;
  const cached = usage.cached_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const uncached = Math.max(0, input - cached);
  return (
    (uncached * pricing.inputPerMillion + cached * pricing.cachedInputPerMillion + output * pricing.outputPerMillion) /
    1_000_000
  );
}

function relativeSeconds(iso, start) {
  return Math.max(0, (Date.parse(iso) - Date.parse(start)) / 1000);
}

function claudeToolOutput(event, content) {
  const direct = typeof content.content === 'string' ? content.content : '';
  const stdout = event.tool_use_result?.stdout ?? '';
  const stderr = event.tool_use_result?.stderr ?? '';
  return direct || [stdout, stderr].filter(Boolean).join('\n');
}

function collectPublicStrings(value, key = '') {
  if (typeof value === 'string') return key === 'id' ? [] : [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectPublicStrings(item));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([childKey, child]) => collectPublicStrings(child, childKey));
  }
  return [];
}

export function eventsFor(runDir, start, replacements) {
  const path = join(runDir, 'events.jsonl');
  if (!existsSync(path)) return { messages: [], commands: [] };
  const started = new Map();
  const messages = [];
  const commands = [];
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    const stamped = JSON.parse(line);
    let event;
    try {
      event = JSON.parse(stamped.line);
    } catch {
      continue;
    }
    const item = event.item;
    if (event.type === 'item.started' && item?.type === 'command_execution') {
      started.set(item.id, { at: stamped.arrivedAt, command: item.command });
    }
    if (event.type === 'item.completed' && item?.type === 'command_execution') {
      const begin = started.get(item.id);
      commands.push({
        id: item.id,
        startSeconds: relativeSeconds(begin?.at ?? stamped.arrivedAt, start),
        endSeconds: relativeSeconds(stamped.arrivedAt, start),
        command: sanitizeBenchmarkText(unwrapShellCommand(item.command ?? begin?.command ?? ''), replacements),
        output: sanitizeCommandOutput(item.command ?? begin?.command ?? '', item.aggregated_output, replacements),
        exitCode: item.exit_code,
      });
    }
    if (event.type === 'item.completed' && item?.type === 'agent_message') {
      messages.push({
        id: item.id,
        atSeconds: relativeSeconds(stamped.arrivedAt, start),
        text: sanitizeBenchmarkText(clipped(item.text, 4_000), replacements),
      });
    }

    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const [index, content] of event.message.content.entries()) {
        if (content.type === 'tool_use' && content.name === 'Bash') {
          started.set(content.id, { at: stamped.arrivedAt, command: content.input?.command ?? '' });
        }
        if (content.type === 'text' && content.text) {
          messages.push({
            id: `${event.uuid ?? event.message.id ?? 'claude-message'}-${index}`,
            atSeconds: relativeSeconds(stamped.arrivedAt, start),
            text: sanitizeBenchmarkText(clipped(content.text, 4_000), replacements),
          });
        }
      }
    }

    if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const content of event.message.content) {
        if (content.type !== 'tool_result') continue;
        const begin = started.get(content.tool_use_id);
        if (!begin) continue;
        const output = claudeToolOutput(event, content);
        const result = event.tool_use_result;
        const exitCode = Number.isInteger(result?.exit_code)
          ? result.exit_code
          : content.is_error || result?.is_error || result?.interrupted
            ? 1
            : 0;
        commands.push({
          id: content.tool_use_id,
          startSeconds: relativeSeconds(begin.at, start),
          endSeconds: relativeSeconds(stamped.arrivedAt, start),
          command: sanitizeBenchmarkText(unwrapShellCommand(begin.command), replacements),
          output: sanitizeCommandOutput(begin.command, output, replacements),
          exitCode,
        });
        started.delete(content.tool_use_id);
      }
    }
  }
  return { messages, commands };
}

function detachedCommandLabel(command) {
  const line = command.split('\n').find((candidate) => /\bnohup\b/.test(candidate) && /&(?:\s|$)/.test(candidate));
  return line?.match(/\bnohup\s+(.+?)(?=\s+(?:\d?>>?)|\s+&(?:\s|$))/)?.[1]?.trim() ?? null;
}

function capturedPid(output) {
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(?:(?:PID|Metro PID)\s*[=:]\s*)?(\d{2,})(?:\s|$)/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function capturedPidFile(command) {
  return command.match(/echo\s+(?:"?\$!"?|"?\$[A-Za-z_][A-Za-z0-9_]*"?)\s*>\s*"?([^"\s;]+\.pid)"?/)?.[1] ?? null;
}

function inspectsProcess(command, pid, pidFile) {
  const processInspection = /\b(?:ps|wait)\b|\bkill\s+-0\b/;
  if (!processInspection.test(command)) return false;
  const mentionsPid = pid ? new RegExp(`(^|[^0-9])${pid}([^0-9]|$)`).test(command) : false;
  return mentionsPid || Boolean(pidFile && command.includes(pidFile));
}

export function backgroundProcessesFor(commands) {
  return commands.flatMap((launcher) => {
    if (launcher.exitCode !== 0) return [];
    const label = detachedCommandLabel(launcher.command);
    if (!label) return [];
    const pid = capturedPid(launcher.output);
    const pidFile = capturedPidFile(launcher.command);
    if (!pid && !pidFile) return [];
    const later = commands.filter((command) => {
      if (command.startSeconds < launcher.endSeconds || command.id === launcher.id) return false;
      if (detachedCommandLabel(command.command)) return false;
      return inspectsProcess(command.command, pid, pidFile);
    });
    if (later.length === 0) return [];
    const endSeconds = later.reduce((latest, command) => Math.max(latest, command.endSeconds), launcher.endSeconds);
    return [
      {
        id: `background-${launcher.id}`,
        label,
        startSeconds: launcher.endSeconds,
        endSeconds,
        launcherCommandId: launcher.id,
        monitorCount: later.length,
      },
    ];
  });
}

export function summarizeRun(record, commands, backgroundProcesses) {
  const successfulCommands = commands.filter((command) => command.exitCode === 0);
  const commandText = successfulCommands.map((command) => command.command).join('\n');
  const preparedWorktree = /\bgit\s+worktree\b|\bstim\s+worktree\s+create\b/.test(commandText);
  const copiedInputs = /\bcp\b[^\n]*(?:node_modules|ios\/Pods|ios\/build|android\/\.gradle|android\/app\/build)/.test(
    commandText,
  );
  const change =
    record.variant === 'native'
      ? `native ${record.platform === 'android' ? 'Android' : 'iOS'} change`
      : record.variant === 'launch-crash'
        ? 'JavaScript launch failure'
        : 'JavaScript change';
  const preparation = preparedWorktree
    ? `Created an isolated worktree${copiedInputs ? ' and carried over dependencies or native outputs' : ''}`
    : 'Prepared the benchmark workspace';
  let launch = 'completed the app task';
  const stimPlatform = commandText.match(/(?:^|\s)stim\s+(ios|android)(?:\s|$)/)?.[1];
  if (stimPlatform) {
    launch = `ran Stim's ${stimPlatform === 'ios' ? 'iOS' : 'Android'} workflow`;
  } else if (/\bexpo\s+run:ios\b|\bxcodebuild\b/.test(commandText)) {
    launch = 'started the local Expo/Xcode workflow';
  } else if (/\bexpo\s+run:android\b|\bgradlew\b/.test(commandText)) {
    launch = 'started the local Expo/Android workflow';
  } else if (/\bexpo\s+start\b/.test(commandText)) {
    launch = 'started the local Expo dev server';
  } else if (/\bxcrun\s+simctl\s+launch\b/.test(commandText)) {
    launch = 'launched the app with simctl';
  } else if (/\bagent-device\s+open\b/.test(commandText)) {
    launch = 'opened the app with agent-device';
  }
  const backgroundMonitors = backgroundProcesses.reduce((sum, process) => sum + process.monitorCount, 0);
  const background = backgroundProcesses.length
    ? ` It started ${backgroundProcesses.length === 1 ? 'one process' : `${backgroundProcesses.length} processes`} with nohup${backgroundMonitors ? ' and monitored the detached work through later commands' : ''}.`
    : '';
  const validation =
    record.screen?.valid && /\bagent-device\s+screenshot\b/.test(commandText)
      ? ' It reached Settings and captured valid agent-device proof.'
      : '';
  const failed = commands.filter((command) => command.exitCode !== 0).length;
  const recovery = failed
    ? ` The record includes ${failed} failed command ${failed === 1 ? 'attempt' : 'attempts'} before completion.`
    : '';
  const diagnosis =
    record.variant === 'launch-crash' && /(?:^|\s)stim\s+logs\s+--errors(?:\s|$)/.test(commandText)
      ? ' It used the captured Stim error log to identify the injected failure before repairing it.'
      : '';
  return `${preparation}, worked on the ${change}, and ${launch}.${diagnosis}${background}${validation}${recovery}`;
}

function assertPortable(payload) {
  const serialized = JSON.stringify(collectPublicStrings(payload));
  const leakedFileUrl = serialized.match(fileUrlAbsolutePathPattern)?.[0];
  if (leakedFileUrl) {
    throw new Error(`benchmark export contains an absolute machine file URL: ${leakedFileUrl}`);
  }
  const serializedWithoutWebUrls = serialized.replace(/https?:\/\/[^"\\\s]+/gi, '');
  const leakedNestedPrivatePath = serializedWithoutWebUrls.match(
    /[A-Za-z0-9._+-](\/(?:Users|Volumes)(?![A-Za-z0-9._+-]))/,
  )?.[1];
  if (leakedNestedPrivatePath) {
    const at = serializedWithoutWebUrls.indexOf(leakedNestedPrivatePath);
    const field = serializedWithoutWebUrls.slice(
      Math.max(0, at - 80),
      Math.min(serializedWithoutWebUrls.length, at + 240),
    );
    throw new Error(
      `benchmark export contains a nested absolute machine path root: ${leakedNestedPrivatePath}\n${field}`,
    );
  }
  const leakedRoot = [
    '/Applications',
    '/Library',
    '/System',
    '/Users',
    '/Volumes',
    '/private',
    '/var',
    '/tmp',
    '/opt',
    '/Pods.build',
    '/XPCServices',
  ].find((root) => {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return (
      new RegExp(`(?<![A-Za-z0-9._/])${escaped}(?![A-Za-z0-9._+-])`).test(serialized) ||
      new RegExp(`-[FLI]${escaped}(?![A-Za-z0-9._+-])`).test(serialized)
    );
  });
  if (leakedRoot) {
    const at = serialized.indexOf(leakedRoot);
    const field = serialized.slice(Math.max(0, at - 80), Math.min(serialized.length, at + 240));
    throw new Error(`benchmark export contains an absolute machine path root: ${leakedRoot}\n${field}`);
  }
  const leakedSystemPath = serialized.match(systemAbsolutePathPattern)?.[0];
  if (leakedSystemPath) {
    throw new Error(`benchmark export contains an absolute system path: ${leakedSystemPath}`);
  }
  const leakedPath = serialized.match(absolutePathPattern)?.[0];
  if (leakedPath) {
    const at = serialized.indexOf(leakedPath);
    const field = serialized.slice(Math.max(0, at - 80), Math.min(serialized.length, at + leakedPath.length + 80));
    throw new Error(`benchmark export contains an absolute machine path: ${leakedPath}\n${field}`);
  }
  const leakedIp = serialized.match(ipAddressPattern)?.[0];
  if (leakedIp) throw new Error(`benchmark export contains an IP address: ${leakedIp}`);
  const leakedIpv6 = serialized.match(ipv6LoopbackPattern)?.[0];
  if (leakedIpv6) throw new Error(`benchmark export contains an IPv6 address: ${leakedIpv6}`);
  const leakedHelper = serialized.match(agentDeviceBundlePattern)?.[0];
  if (leakedHelper) throw new Error(`benchmark export contains an agent-device helper identifier: ${leakedHelper}`);
  const leakedSimulatorId = serialized.match(simulatorIdPattern)?.[0];
  if (leakedSimulatorId) throw new Error(`benchmark export contains a simulator identifier: ${leakedSimulatorId}`);
  const leakedSimulatorPrefix = serialized.match(simulatorIdPrefixPattern)?.[0];
  if (leakedSimulatorPrefix) {
    throw new Error(`benchmark export contains a simulator identifier prefix: ${leakedSimulatorPrefix}`);
  }
  const leakedSimulatorShortId = serialized.match(simulatorShortIdPattern)?.[0];
  if (leakedSimulatorShortId) {
    throw new Error(`benchmark export contains a simulator identifier prefix: ${leakedSimulatorShortId}`);
  }
  const leakedHostname = serialized.match(localHostnamePattern)?.[0];
  if (leakedHostname) throw new Error(`benchmark export contains a local hostname: ${leakedHostname}`);
  const leakedRemoteBranchUser = serialized.match(remoteBranchUserPattern)?.[0];
  if (leakedRemoteBranchUser) throw new Error('benchmark export contains a user-scoped remote branch');
  if (
    /(?:Sending adb public key \[|androidboot\.qemu\.adb\.pubkey=)(?!<adb-public-key>)[A-Za-z0-9+/=]{80,}/.test(
      serialized,
    )
  ) {
    throw new Error('benchmark export contains an ADB public key');
  }
  if (serialized.includes('janicduplessis')) {
    throw new Error('benchmark export contains a local username');
  }
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function validPng(path, expectedDimensions) {
  if (!existsSync(path)) return false;
  const bytes = readFileSync(path);
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return false;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width >= 300 && height >= 600 && width === expectedDimensions?.width && height === expectedDimensions?.height;
}

function validMp4(path) {
  if (!existsSync(path)) return false;
  const bytes = readFileSync(path);
  return (
    bytes.length >= 1_000 && bytes.subarray(4, 8).toString('ascii') === 'ftyp' && mp4DurationSeconds(bytes) !== null
  );
}

function mp4DurationSeconds(bytes) {
  const marker = bytes.indexOf(Buffer.from('mvhd'));
  if (marker < 0 || marker + 24 > bytes.length) return null;
  const version = bytes[marker + 4];
  const timescaleOffset = version === 1 ? marker + 24 : marker + 16;
  const durationOffset = version === 1 ? marker + 28 : marker + 20;
  const durationBytes = version === 1 ? 8 : 4;
  if (timescaleOffset + 4 > bytes.length || durationOffset + durationBytes > bytes.length) return null;
  const timescale = bytes.readUInt32BE(timescaleOffset);
  if (timescale === 0) return null;
  const duration = version === 1 ? Number(bytes.readBigUInt64BE(durationOffset)) : bytes.readUInt32BE(durationOffset);
  return duration / timescale;
}

function recordMatchesMeta(record, meta) {
  return (
    record.runId === meta.runId &&
    record.arm === meta.arm &&
    record.variant === meta.variant &&
    record.model === meta.model
  );
}

function iosReadinessCommandFailure({ meta, record, proofPath, recordingPath, screenCommands }) {
  const stateDir = meta.agentDevice?.stateDir;
  const session = meta.agentDevice?.session;
  const deviceId = record.simulator?.udid;
  if (!stateDir || session !== meta.runId || !deviceId) return 'agent-device isolation metadata missing';
  const prefix = `env AGENT_DEVICE_STATE_DIR=${stateDir} AGENT_DEVICE_SESSION=${session} agent-device`;
  const screenshotScratch = join('/tmp', `${meta.runId}-settings.png`);
  const recordingScratch = join('/tmp', `${meta.runId}-session.mp4`);
  const expectedCommands = [
    `${prefix} open com.appandflow.trailhead --foreground --platform ios --udid ${deviceId}`,
    `${prefix} record start ${recordingScratch} --scope device --quality high --hide-touches`,
    `${prefix} wait text ${JSON.stringify(record.screen.expected)}`,
    `${prefix} screenshot ${screenshotScratch}`,
    `cp ${screenshotScratch} ${proofPath}`,
    `${prefix} record stop`,
    `cp ${recordingScratch} ${recordingPath}`,
    `${prefix} close`,
  ];
  const normalizedExpected = expectedCommands.map((command) => sanitizeBenchmarkText(unwrapShellCommand(command), []));
  if (
    record.screen.commands?.length !== expectedCommands.length ||
    record.screen.commands.some((command, index) => command !== expectedCommands[index]) ||
    screenCommands.some((command, index) => command.command !== normalizedExpected[index])
  ) {
    return 'agent-device command sequence mismatch';
  }
  const expectedSessionState = sanitizeBenchmarkText(`Session state: ${stateDir}/sessions/${session}`, []);
  if (
    !screenCommands[0].output.includes(expectedSessionState) ||
    !screenCommands.at(-1).output.includes(`Closed: ${session}`)
  ) {
    return 'agent-device session output mismatch';
  }
  return null;
}

function readinessApplicationProofFailure({ runDir, record, meta, eventsPath, commands, screenCommands, platform }) {
  const recordedProofTarget = record.proof?.target;
  if (!record.proof?.valid || typeof recordedProofTarget !== 'string') return 'application proof missing';
  const applicationProofPath = join(runDir, 'proof', basename(recordedProofTarget));
  if (record.variant === 'javascript') {
    if (
      !existsSync(applicationProofPath) ||
      record.evidenceSha256?.proof !== fileSha256(applicationProofPath) ||
      !applicationProofPath.endsWith('.bundle') ||
      !readFileSync(applicationProofPath).includes(record.proof.expected)
    ) {
      return 'JavaScript bundle proof mismatch';
    }
    return null;
  }
  if (platform === 'ios') {
    const expectedMarker = `Trailhead ${meta.runId}`;
    if (
      recordedProofTarget !== eventsPath ||
      record.proof.kind !== 'agent-device-native-window-marker' ||
      record.proof.expected !== expectedMarker ||
      record.evidenceSha256?.proof !== record.evidenceSha256?.events ||
      !commands.some(
        (command) =>
          command.startSeconds >= screenCommands[0].startSeconds &&
          command.output.includes(`[window] "${expectedMarker}"`),
      )
    ) {
      return 'iOS native window proof mismatch';
    }
    return null;
  }
  if (basename(applicationProofPath) !== 'native-application-label.txt') {
    return 'Android native label proof missing';
  }
  if (!existsSync(applicationProofPath) || record.evidenceSha256?.proof !== fileSha256(applicationProofPath)) {
    return 'application proof hash mismatch';
  }
  const labelProof = readFileSync(applicationProofPath, 'utf8');
  const serial = labelProof.match(/^serial=(.*)$/m)?.[1];
  const label = labelProof.match(/^application-label=(.*)$/m)?.[1];
  return serial === record.simulator?.udid && label === record.proof.expected && label === record.proof.observed
    ? null
    : 'Android native label proof mismatch';
}

function readinessCleanupFailure(runDir, record, meta, platform) {
  const devicesBeforePath = join(runDir, 'devices-before.json');
  const cleanupPath = join(runDir, 'cleanup.json');
  if (!existsSync(devicesBeforePath) || !existsSync(cleanupPath)) return 'cleanup evidence missing';
  const devicesBefore = readJson(devicesBeforePath);
  const cleanup = readJson(cleanupPath);
  const actions = Array.isArray(cleanup.actions) ? cleanup.actions : [];
  if (
    !cleanup.cleanedAt ||
    actions.some((action) => action.startsWith('failed:') || action.startsWith('skipped ')) ||
    !actions.includes('verified benchmark agent-device sessions empty')
  ) {
    return 'cleanup did not complete';
  }
  if (record.arm === 'stim') {
    if (!actions.includes('stim worktree remove --force')) return 'Stim cleanup missing';
    if (platform !== 'ios') return null;
    const udid = record.simulator?.udid;
    return meta.expectedParkedSimulator?.udid === udid &&
      devicesBefore.includes(udid) &&
      actions.includes(`verified parked simulator ${udid}`) &&
      actions.includes(`verified quiescent simulator ${udid}`)
      ? null
      : 'parked simulator cleanup not proven';
  }
  if (platform === 'android') {
    const avdsBeforePath = join(runDir, 'avds-before.json');
    if (!existsSync(avdsBeforePath)) return 'AVD baseline missing';
    const avdsBefore = readJson(avdsBeforePath);
    const expectedName = meta.expectedControlSimulator?.name;
    return expectedName && !avdsBefore.includes(expectedName) && actions.includes(`delete AVD ${expectedName}`)
      ? null
      : 'control AVD cleanup not proven';
  }
  const udid = record.simulator?.udid;
  return udid &&
    !devicesBefore.includes(udid) &&
    record.simulator?.name === meta.expectedControlSimulator?.name &&
    actions.includes(`delete ${udid}`) &&
    actions.some((action) => action.startsWith('remove worktree '))
    ? null
    : 'control simulator cleanup not proven';
}

function validateReadinessRecord(runDir, record, meta) {
  const reject = (reason) => {
    if (process.env.STIM_BENCH_EXPORT_DEBUG === '1') {
      process.stderr.write(`${basename(runDir)}: ${reason}\n`);
    }
    return null;
  };
  const eventsPath = join(runDir, 'events.jsonl');
  const proofPath = join(runDir, 'proof', 'settings.png');
  const recordingPath = join(runDir, 'proof', 'session.mp4');
  const transcriptPath = (record.runner ?? meta.runner) === 'claude' ? eventsPath : join(runDir, 'rollout.jsonl');
  if (
    !existsSync(eventsPath) ||
    !existsSync(transcriptPath) ||
    !validPng(proofPath, record.screen?.dimensions) ||
    !validMp4(recordingPath)
  ) {
    return reject('invalid evidence files');
  }
  if (record.evidenceSha256?.events !== fileSha256(eventsPath)) return reject('events hash mismatch');
  if (record.evidenceSha256?.settingsPng !== fileSha256(proofPath)) return reject('screenshot hash mismatch');
  if (record.evidenceSha256?.transcript !== fileSha256(transcriptPath)) return reject('transcript hash mismatch');
  if (record.evidenceSha256?.recording !== fileSha256(recordingPath)) return reject('recording hash mismatch');
  if (!recordMatchesMeta(record, meta)) return reject('record metadata mismatch');

  const commands = eventsFor(runDir, meta.dispatchAt, []).commands;
  const platform = meta.platform ?? 'ios';
  const recordingCopyCommandId = record.screen?.recordingCopyCommandId;
  if (platform === 'ios' && typeof recordingCopyCommandId !== 'string') {
    return reject('recording copy command id missing');
  }
  const screenIds = [
    record.screen?.openCommandId,
    record.screen?.recordStartCommandId,
    record.screen?.waitCommandId,
    record.screen?.screenshotCommandId,
    record.screen?.copyCommandId,
    record.screen?.recordStopCommandId,
    ...(typeof recordingCopyCommandId === 'string' ? [recordingCopyCommandId] : []),
    record.screen?.closeCommandId,
  ];
  if (screenIds.some((id) => typeof id !== 'string')) return reject('screen command ids missing');
  const screenCommands = screenIds.map((id) => commands.find((command) => command.id === id));
  if (
    screenCommands.some((command) => !command || command.exitCode !== 0) ||
    screenCommands.some((command, index) => index > 0 && command.startSeconds < screenCommands[index - 1].endSeconds)
  ) {
    return reject('screen command graph invalid');
  }
  if (platform === 'ios') {
    const failure = iosReadinessCommandFailure({ meta, record, proofPath, recordingPath, screenCommands });
    if (failure) return reject(failure);
  }
  const screenReadySeconds = screenCommands[3].endSeconds;
  const screenObservedAt = new Date(Date.parse(meta.dispatchAt) + screenReadySeconds * 1000).toISOString();
  if (
    record.screen.observedAt !== screenObservedAt ||
    record.screen.dispatchToScreenReadySeconds !== screenReadySeconds ||
    record.dispatchToScreenReadySeconds !== screenReadySeconds
  ) {
    return reject('screen metrics mismatch');
  }
  if (
    record.recording?.valid !== true ||
    record.recording?.target !== recordingPath ||
    record.recording?.bytes !== statSync(recordingPath).size ||
    record.recording?.startCommandId !== screenIds[1] ||
    record.recording?.stopCommandId !== screenIds[5] ||
    (platform === 'ios' && record.recording?.copyCommandId !== screenIds[6]) ||
    record.recording?.startedAt !==
      new Date(Date.parse(meta.dispatchAt) + screenCommands[1].endSeconds * 1000).toISOString() ||
    record.recording?.endedAt !==
      new Date(Date.parse(meta.dispatchAt) + screenCommands[5].endSeconds * 1000).toISOString()
  ) {
    return reject('recording evidence mismatch');
  }
  const recordingDurationSeconds = mp4DurationSeconds(readFileSync(recordingPath));
  const recordingSecondsToScreenProof = screenReadySeconds - screenCommands[1].endSeconds;
  if (recordingDurationSeconds === null || recordingDurationSeconds + 2 < recordingSecondsToScreenProof) {
    return reject('recording ends before Settings proof');
  }

  const appAlivePath = join(runDir, 'app-alive.json');
  if (!existsSync(appAlivePath)) return reject('app-alive evidence missing');
  const appAlive = readJson(appAlivePath);
  if (
    appAlive.error ||
    appAlive.dispatchToAppAliveSeconds !== record.dispatchToAppAliveSeconds ||
    appAlive.simulator?.udid !== record.simulator?.udid
  ) {
    return reject('app-alive evidence mismatch');
  }

  const proofFailure = readinessApplicationProofFailure({
    runDir,
    record,
    meta,
    eventsPath,
    commands,
    screenCommands,
    platform,
  });
  if (proofFailure) return reject(proofFailure);
  const cleanupFailure = readinessCleanupFailure(runDir, record, meta, platform);
  if (cleanupFailure) return reject(cleanupFailure);
  return { screenReadySeconds };
}

function nonShellActivitiesFor(runDir) {
  const eventsPath = join(runDir, 'events.jsonl');
  if (!existsSync(eventsPath)) return [];
  const activities = [];
  for (const record of readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)) {
    let event;
    try {
      event = JSON.parse(record.line);
    } catch {
      continue;
    }
    const item = event.item;
    if (event.type === 'item.started' && item?.type && item.type !== 'command_execution') {
      activities.push({
        id: item.id,
        command: `tool:${item.type} ${JSON.stringify(item.changes ?? item)}`,
        startedAt: record.arrivedAt,
        endedAt: record.arrivedAt,
      });
    }
    for (const block of event.message?.content ?? []) {
      if (event.type === 'assistant' && block.type === 'tool_use' && block.name !== 'Bash') {
        activities.push({
          id: block.id,
          command: `tool:${block.name} ${JSON.stringify(block.input ?? {})}`,
          startedAt: record.arrivedAt,
          endedAt: record.arrivedAt,
        });
      }
    }
  }
  return activities;
}

function usageAtOrBefore(path, observedAt) {
  if (!path || !existsSync(path)) return null;
  const cutoff = Date.parse(observedAt);
  if (!Number.isFinite(cutoff)) return null;
  let usage = null;
  for (const line of readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)) {
    const event = JSON.parse(line);
    const timestamp = Date.parse(event.timestamp);
    const candidate = event.payload?.info?.total_token_usage;
    if (
      event.type === 'event_msg' &&
      event.payload?.type === 'token_count' &&
      candidate &&
      Number.isFinite(timestamp) &&
      timestamp <= cutoff
    ) {
      usage = candidate;
    }
  }
  return usage;
}

function sameUsage(left, right) {
  if (left === null || right === null) return left === right;
  return ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'].every(
    (field) => (left?.[field] ?? 0) === (right?.[field] ?? 0),
  );
}

function validateLaunchCrashRecord(runDir, record, meta) {
  const reject = (reason) => {
    if (process.env.STIM_BENCH_EXPORT_DEBUG === '1') {
      process.stderr.write(`${basename(runDir)}: ${reason}\n`);
    }
    return null;
  };
  const eventsPath = join(runDir, 'events.jsonl');
  const proofPath = join(runDir, 'proof', 'settings.png');
  if (!existsSync(eventsPath) || !validPng(proofPath, record.screen?.dimensions))
    return reject('invalid evidence files');
  if (record.evidenceSha256?.events !== fileSha256(eventsPath)) return reject('events hash mismatch');
  if (record.evidenceSha256?.settingsPng !== fileSha256(proofPath)) return reject('screenshot hash mismatch');
  const eventData = eventsFor(runDir, meta.dispatchAt, []);
  const commands = eventData.commands.map((command) =>
    Object.assign({}, command, {
      startedAt: new Date(Date.parse(meta.dispatchAt) + command.startSeconds * 1000).toISOString(),
      endedAt: new Date(Date.parse(meta.dispatchAt) + command.endSeconds * 1000).toISOString(),
    }),
  );
  const token = [record.proof?.expected, ...commands.map((command) => command.output)]
    .join('\n')
    .match(/STIM_BENCH_LAUNCH_CRASH_[0-9A-F]{12}/)?.[0];
  if (!token) return reject('crash token missing');
  const diagnosis = launchCrashDiagnosis(commands, {
    dispatchAt: meta.dispatchAt,
    token,
    arm: record.arm,
    platform: meta.platform ?? 'ios',
    activities: nonShellActivitiesFor(runDir),
  });
  const recovery = launchCrashRecovery(commands, {
    diagnosis,
    arm: record.arm,
    platform: meta.platform ?? 'ios',
    screen: record.screen,
  });
  if (!diagnosis.valid || !recovery.valid) {
    return reject(`event graph invalid: ${JSON.stringify({ diagnosis, recovery })}`);
  }
  const screenReadySeconds = relativeSeconds(record.screen.observedAt, meta.dispatchAt);
  const runner = record.runner ?? meta.runner;
  const transcriptPath = runner === 'claude' ? eventsPath : join(runDir, 'rollout.jsonl');
  const diagnosisUsage = runner === 'claude' ? null : usageAtOrBefore(transcriptPath, diagnosis.observedAt);
  if (!existsSync(transcriptPath)) return reject('transcript missing');
  if (record.evidenceSha256?.transcript !== fileSha256(transcriptPath)) return reject('transcript hash mismatch');
  if (
    record.diagnosis?.observedAt !== diagnosis.observedAt ||
    record.dispatchToDiagnosisSeconds !== diagnosis.dispatchToDiagnosisSeconds ||
    record.diagnosisCommandCount !== diagnosis.commandCount ||
    record.screen?.observedAt !== new Date(Date.parse(meta.dispatchAt) + screenReadySeconds * 1000).toISOString() ||
    record.dispatchToScreenReadySeconds !== screenReadySeconds ||
    record.screen?.dispatchToScreenReadySeconds !== screenReadySeconds ||
    !sameUsage(record.diagnosisUsage ?? null, diagnosisUsage)
  ) {
    return reject('derived metrics mismatch');
  }
  if (
    record.diagnosis?.initialLaunchCommandId !== diagnosis.initialLaunchCommandId ||
    record.diagnosis?.errorCaptureCommandId !== diagnosis.errorCaptureCommandId ||
    record.diagnosis?.commandId !== diagnosis.commandId ||
    record.recovery?.screenshotCommandId !== recovery.screenshotCommandId
  ) {
    return reject('evidence command ids mismatch');
  }
  return { diagnosis, recovery, diagnosisUsage, screenReadySeconds };
}

export function exportBenchmark(stageDir, outputPath, proofDir, machine = {}) {
  const absoluteStageDir = resolve(stageDir);
  const stage = basename(absoluteStageDir);
  const resultsRoot = dirname(absoluteStageDir);
  const coordinatorRoot = dirname(resultsRoot);
  const artifactCopies = [];
  const runDirs = readdirSync(absoluteStageDir)
    .toSorted()
    .map((name) => join(absoluteStageDir, name))
    .filter((runDir) => existsSync(join(runDir, 'run.json')) && existsSync(join(runDir, 'meta.json')));
  const records = runDirs
    .map((runDir) => {
      const record = readJson(join(runDir, 'run.json'));
      const meta = readJson(join(runDir, 'meta.json'));
      return {
        runDir,
        record,
        meta,
        readinessValidation:
          record.variant === 'javascript' || record.variant === 'native'
            ? validateReadinessRecord(runDir, record, meta)
            : true,
        launchCrashValidation:
          record.variant === 'launch-crash' ? validateLaunchCrashRecord(runDir, record, meta) : null,
      };
    })
    .filter(({ runDir, record, readinessValidation, launchCrashValidation }) => {
      if (!record.valid || !record.screen?.valid || !existsSync(join(runDir, 'proof', 'settings.png'))) return false;
      if (record.variant !== 'launch-crash') return readinessValidation !== null;
      return (
        record.diagnosis?.valid === true &&
        Number.isFinite(record.dispatchToDiagnosisSeconds) &&
        record.dispatchToDiagnosisSeconds >= 0 &&
        Number.isInteger(record.diagnosisCommandCount) &&
        record.diagnosisCommandCount > 0 &&
        record.proof?.valid === true &&
        record.recovery?.valid === true &&
        typeof record.recovery.screenshotCommandId === 'string' &&
        launchCrashValidation !== null
      );
    });
  if (records.length === 0) throw new Error(`no valid benchmark runs found in ${absoluteStageDir}`);
  const validCounts = new Map();
  for (const { record } of records) {
    if (!record.valid) continue;
    const base = publicRunId(record);
    validCounts.set(base, (validCounts.get(base) ?? 0) + 1);
  }
  const attemptCounts = new Map();
  const environment = benchmarkEnvironment(readJson(join(records[0].runDir, 'meta.json')), machine);
  const runs = records
    .map(({ runDir, record, meta, launchCrashValidation }) => {
      const appAlive = existsSync(join(runDir, 'app-alive.json')) ? readJson(join(runDir, 'app-alive.json')) : null;
      const baseId = publicRunId(record);
      const attemptKind = record.valid ? 'valid' : 'invalid';
      const countKey = `${baseId}-${attemptKind}`;
      const attempt = (attemptCounts.get(countKey) ?? 0) + 1;
      attemptCounts.set(countKey, attempt);
      const id = record.valid && validCounts.get(baseId) === 1 ? baseId : `${baseId}-${attemptKind}-${attempt}`;
      const runNonce = record.runId.match(/-(\d{13})$/)?.[1];
      const replacements = [
        [runDir, `results/${stage}/${id}`],
        [absoluteStageDir, `results/${stage}`],
        [resultsRoot, 'results'],
        [coordinatorRoot, '.'],
        [record.runId, id],
        ...(record.simulator?.udid
          ? [
              [record.simulator.udid, '<simulator-udid>'],
              ...(simulatorIdExactPattern.test(record.simulator.udid)
                ? [[record.simulator.udid.slice(0, 8), '<simulator-udid-prefix>']]
                : []),
            ]
          : []),
        ...(runNonce ? [[runNonce, id]] : []),
      ];
      const proofSource = join(runDir, 'proof', 'settings.png');
      const proofName = `${id}.png`;
      if (record.screen?.valid && existsSync(proofSource)) {
        artifactCopies.push([proofSource, join(proofDir, proofName)]);
      }
      const recordingSource = join(runDir, 'proof', 'session.mp4');
      const recordingName = `${id}.mp4`;
      if (record.recording?.valid && existsSync(recordingSource)) {
        artifactCopies.push([recordingSource, join(proofDir, recordingName)]);
      }
      const totalSeconds = Math.max(
        record.dispatchToScreenReadySeconds ?? 0,
        relativeSeconds(meta.finishedAt, meta.dispatchAt),
      );
      const events = eventsFor(runDir, meta.dispatchAt, replacements);
      const backgroundProcesses = backgroundProcessesFor(events.commands);
      const usage = record.usage ?? {
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
      };
      return {
        id,
        model: record.model,
        platform: meta.platform ?? 'ios',
        variant: record.variant,
        arm: record.arm,
        valid: record.valid,
        invalidReasons: (record.invalidReasons ?? []).map((reason) => sanitizeBenchmarkText(reason, replacements)),
        settingsReadySeconds: launchCrashValidation?.screenReadySeconds ?? record.dispatchToScreenReadySeconds,
        appAliveSeconds: record.dispatchToAppAliveSeconds,
        diagnosisSeconds: launchCrashValidation?.diagnosis.dispatchToDiagnosisSeconds ?? null,
        diagnosisCommandCount: launchCrashValidation?.diagnosis.commandCount ?? null,
        launchCrashAudit:
          record.variant === 'launch-crash'
            ? {
                initialLaunchCommandId: record.diagnosis.initialLaunchCommandId,
                errorCaptureCommandId: record.diagnosis.errorCaptureCommandId,
                diagnosisCommandId: record.diagnosis.commandId,
                screenshotCommandId: record.recovery.screenshotCommandId,
              }
            : null,
        diagnosisUsage: launchCrashValidation?.diagnosisUsage ?? null,
        estimatedDiagnosisCostUsd: estimateTokenCost(launchCrashValidation?.diagnosisUsage, record.model),
        totalSeconds,
        commandCount: record.commandCount,
        usage,
        estimatedTokenCostUsd: record.reportedCostUsd ?? estimateTokenCost(usage, record.model),
        summary: summarizeRun({ ...record, platform: meta.platform ?? 'ios' }, events.commands, backgroundProcesses),
        messages: events.messages,
        commands: events.commands,
        backgroundProcesses,
        markers: [
          appAlive?.observedAt && {
            id: 'app-alive',
            kind: 'appAlive',
            label: 'App process alive',
            atSeconds: relativeSeconds(appAlive.observedAt, meta.dispatchAt),
          },
          launchCrashValidation?.diagnosis.observedAt && {
            id: 'diagnosis',
            kind: 'diagnosis',
            label: 'Actionable diagnosis',
            atSeconds: launchCrashValidation.diagnosis.dispatchToDiagnosisSeconds,
          },
          record.screen?.observedAt && {
            id: 'settings-ready',
            kind: 'settingsReady',
            label: 'Settings proof ready',
            atSeconds: relativeSeconds(record.screen.observedAt, meta.dispatchAt),
          },
        ].filter(Boolean),
        proof: record.screen?.valid
          ? {
              src: `benchmarks/${stage}/${proofName}`,
              expected: record.screen.expected,
              width: record.screen.dimensions?.width,
              height: record.screen.dimensions?.height,
            }
          : null,
        recording: record.recording?.valid
          ? {
              src: `benchmarks/${stage}/${recordingName}`,
              bytes: record.recording.bytes,
            }
          : null,
      };
    })
    .toSorted(
      (a, b) =>
        ['javascript', 'native', 'launch-crash'].indexOf(a.variant) -
          ['javascript', 'native', 'launch-crash'].indexOf(b.variant) ||
        ['stim', 'control'].indexOf(a.arm) - ['stim', 'control'].indexOf(b.arm),
    );

  const model = runs[0].model;
  const recordedOn = records
    .map(({ runDir }) => readJson(join(runDir, 'meta.json')).dispatchAt)
    .filter(Boolean)
    .toSorted()[0]
    ?.slice(0, 10);
  const payload = {
    schemaVersion: 1,
    stage,
    title: formatStage(stage),
    suite: runs.every((run) => run.variant === 'launch-crash') ? 'launch-crash' : 'readiness',
    platform: runs[0].platform,
    protocolVersion: 4,
    recordedOn,
    primaryMetric:
      runs[0].variant === 'launch-crash'
        ? 'Dispatch to first actionable diagnosis; repaired Settings screenshot reported separately'
        : 'Dispatch to validated Settings screenshot',
    pricing: modelPricing[model]
      ? {
          model,
          ...modelPricing[model],
          estimateNote:
            'API-equivalent token estimate from aggregate counters. It excludes long-context multipliers, cache-write premiums, tool fees, and subscription pricing.',
        }
      : null,
    environment,
    runs,
  };
  assertPortable(payload);
  mkdirSync(proofDir, { recursive: true });
  const expectedArtifacts = new Set(artifactCopies.map(([, target]) => resolve(target)));
  for (const entry of readdirSync(proofDir)) {
    const path = join(proofDir, entry);
    if (/\.(?:png|mp4)$/.test(entry) && !expectedArtifacts.has(resolve(path))) unlinkSync(path);
  }
  for (const [source, target] of artifactCopies) copyFileSync(source, target);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const [, , stageDir, outputPath, proofDir, machinePath] = process.argv;
  if (!stageDir || !outputPath || !proofDir) {
    throw new Error(
      'usage: node scripts/export-benchmark-viewer.mjs <stage-dir> <output-json> <proof-dir> [machine-json]',
    );
  }
  const payload = exportBenchmark(stageDir, outputPath, proofDir, machinePath ? readJson(resolve(machinePath)) : {});
  process.stdout.write(`${relative(process.cwd(), outputPath)} (${payload.runs.length} sanitized runs)\n`);
}
