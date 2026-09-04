import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
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
      return index === 0 ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part;
    })
    .join(' ');
}

function displaySimulator(meta) {
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
      [actual.XCODE_VERSION && `Xcode ${actual.XCODE_VERSION}`, actual.XCODE_BUILD && `(${actual.XCODE_BUILD})`]
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
  text = text.replace(shellPathPattern, 'PATH=<toolchain-path>');
  text = text.replace(homebrewExecutablePattern, '$1');
  text = text.replace(agentDeviceBundlePattern, '<agent-device-helper>');
  text = text.replace(fileUrlAbsolutePathPattern, (_match, path) => `file:///${replacementLabel(path)}`);
  text = text.replace(compilerFlagAbsolutePathPattern, (_match, flag, path) => `${flag}${replacementLabel(path)}`);
  text = text.replace(absolutePathPattern, (path) => replacementLabel(path));
  text = text.replace(systemAbsolutePathPattern, (path) => replacementLabel(path));
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
  const copiedInputs = /\bcp\b[^\n]*(?:node_modules|ios\/Pods|ios\/build)/.test(commandText);
  const change =
    record.variant === 'native'
      ? 'native iOS change'
      : record.variant === 'launch-crash'
        ? 'JavaScript launch failure'
        : 'JavaScript change';
  const preparation = preparedWorktree
    ? `Created an isolated worktree${copiedInputs ? ' and carried over dependencies or native outputs' : ''}`
    : 'Prepared the benchmark workspace';
  let launch = 'completed the app task';
  if (/(?:^|\s)stim\s+ios(?:\s|$)/.test(commandText)) {
    launch = "ran Stim's iOS workflow";
  } else if (/\bexpo\s+run:ios\b|\bxcodebuild\b/.test(commandText)) {
    launch = 'started the local Expo/Xcode workflow';
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
    record.recovery?.repairedLaunchCommandId !== recovery.repairedLaunchCommandId ||
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
  const proofCopies = [];
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
        launchCrashValidation:
          record.variant === 'launch-crash' ? validateLaunchCrashRecord(runDir, record, meta) : null,
      };
    })
    .filter(({ runDir, record, launchCrashValidation }) => {
      if (!record.valid || !record.screen?.valid || !existsSync(join(runDir, 'proof', 'settings.png'))) return false;
      if (record.variant !== 'launch-crash') return true;
      return (
        record.diagnosis?.valid === true &&
        Number.isFinite(record.dispatchToDiagnosisSeconds) &&
        record.dispatchToDiagnosisSeconds >= 0 &&
        Number.isInteger(record.diagnosisCommandCount) &&
        record.diagnosisCommandCount > 0 &&
        record.proof?.valid === true &&
        record.recovery?.valid === true &&
        typeof record.recovery.repairedLaunchCommandId === 'string' &&
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
              [record.simulator.udid.slice(0, 8), '<simulator-udid-prefix>'],
            ]
          : []),
        ...(runNonce ? [[runNonce, id]] : []),
      ];
      const proofSource = join(runDir, 'proof', 'settings.png');
      const proofName = `${id}.png`;
      if (record.screen?.valid && existsSync(proofSource)) {
        proofCopies.push([proofSource, join(proofDir, proofName)]);
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
                repairedLaunchCommandId: record.recovery.repairedLaunchCommandId,
                screenshotCommandId: record.recovery.screenshotCommandId,
              }
            : null,
        diagnosisUsage: launchCrashValidation?.diagnosisUsage ?? null,
        estimatedDiagnosisCostUsd: estimateTokenCost(launchCrashValidation?.diagnosisUsage, record.model),
        totalSeconds,
        commandCount: record.commandCount,
        usage,
        estimatedTokenCostUsd: record.reportedCostUsd ?? estimateTokenCost(usage, record.model),
        summary: summarizeRun(record, events.commands, backgroundProcesses),
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
  const expectedProofs = new Set(proofCopies.map(([, target]) => resolve(target)));
  for (const entry of readdirSync(proofDir)) {
    const path = join(proofDir, entry);
    if (entry.endsWith('.png') && !expectedProofs.has(resolve(path))) unlinkSync(path);
  }
  for (const [source, target] of proofCopies) copyFileSync(source, target);
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
