import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

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

const absolutePathPattern = /(?<![A-Za-z0-9._-])\/(?:Users|Volumes|private|tmp|var\/folders)\/[^\s'"`,;()<>[\]]+/g;
const ipAddressPattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const ipv6LoopbackPattern = /\[::1\]|(?<![A-Za-z0-9:])::1(?![A-Za-z0-9:])/g;
const simulatorIdPattern = /\b[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\b/gi;
const simulatorIdPrefixPattern = /\b(?=[0-9A-F]{8}\b)(?=[0-9A-F]*[A-F])[0-9A-F]{8}\b/g;
const localHostnamePattern = /\b(?:[A-Za-z0-9-]+\.)+local\b/gi;
const agentDeviceBundlePattern = /\b(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9.-]*agentdevice[A-Za-z0-9.-]*\b/gi;
const processInspectionPattern = /\b(?:ps|pgrep)(?:\s|$)/;
const deviceInventoryPattern = /\b(?:agent-device devices|xcrun simctl list devices)\b/;
const machineStoragePattern = /\b(?:df|diskutil)(?:\s|$)/;
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
  text = text.replace(agentDeviceBundlePattern, '<agent-device-helper>');
  text = text.replace(absolutePathPattern, (path) => replacementLabel(path));
  text = text.replaceAll(userInfo().username, '<local-user>');
  return text
    .replace(simulatorIdPattern, '<simulator-udid>')
    .replace(simulatorIdPrefixPattern, '<simulator-udid-prefix>')
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
        commands.push({
          id: content.tool_use_id,
          startSeconds: relativeSeconds(begin.at, start),
          endSeconds: relativeSeconds(stamped.arrivedAt, start),
          command: sanitizeBenchmarkText(unwrapShellCommand(begin.command), replacements),
          output: sanitizeCommandOutput(begin.command, output, replacements),
          exitCode: content.is_error || event.tool_use_result?.interrupted ? 1 : 0,
        });
        started.delete(content.tool_use_id);
      }
    }
  }
  return { messages, commands };
}

function assertPortable(payload) {
  const serialized = JSON.stringify(collectPublicStrings(payload));
  const leakedRoot = ['/Users', '/Volumes', '/private', '/var/folders', '/tmp/'].find((root) =>
    serialized.includes(root),
  );
  if (leakedRoot) throw new Error(`benchmark export contains an absolute machine path root: ${leakedRoot}`);
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
  const leakedHostname = serialized.match(localHostnamePattern)?.[0];
  if (leakedHostname) throw new Error(`benchmark export contains a local hostname: ${leakedHostname}`);
  if (serialized.includes('janicduplessis')) {
    throw new Error('benchmark export contains a local username');
  }
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
  const records = runDirs.map((runDir) => ({ runDir, record: readJson(join(runDir, 'run.json')) }));
  if (records.length === 0) throw new Error(`no benchmark runs found in ${absoluteStageDir}`);
  const validCounts = new Map();
  for (const { record } of records) {
    if (!record.valid) continue;
    const base = publicRunId(record);
    validCounts.set(base, (validCounts.get(base) ?? 0) + 1);
  }
  const attemptCounts = new Map();
  const environment = benchmarkEnvironment(readJson(join(runDirs[0], 'meta.json')), machine);
  const runs = records
    .map(({ runDir, record }) => {
      const meta = readJson(join(runDir, 'meta.json'));
      const appAlive = existsSync(join(runDir, 'app-alive.json')) ? readJson(join(runDir, 'app-alive.json')) : null;
      const baseId = publicRunId(record);
      const attemptKind = record.valid ? 'valid' : 'invalid';
      const countKey = `${baseId}-${attemptKind}`;
      const attempt = (attemptCounts.get(countKey) ?? 0) + 1;
      attemptCounts.set(countKey, attempt);
      const id = record.valid && validCounts.get(baseId) === 1 ? baseId : `${baseId}-${attemptKind}-${attempt}`;
      const replacements = [
        [runDir, `results/${stage}/${id}`],
        [absoluteStageDir, `results/${stage}`],
        [resultsRoot, 'results'],
        [coordinatorRoot, '.'],
        [record.runId, id],
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
      const usage = record.usage ?? {
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
      };
      return {
        id,
        model: record.model,
        variant: record.variant,
        arm: record.arm,
        valid: record.valid,
        invalidReasons: (record.invalidReasons ?? []).map((reason) => sanitizeBenchmarkText(reason, replacements)),
        settingsReadySeconds: record.dispatchToScreenReadySeconds,
        appAliveSeconds: record.dispatchToAppAliveSeconds,
        totalSeconds,
        commandCount: record.commandCount,
        usage,
        estimatedTokenCostUsd: record.reportedCostUsd ?? estimateTokenCost(usage, record.model),
        messages: events.messages,
        commands: events.commands,
        markers: [
          appAlive?.observedAt && {
            id: 'app-alive',
            kind: 'appAlive',
            label: 'App process alive',
            atSeconds: relativeSeconds(appAlive.observedAt, meta.dispatchAt),
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
        ['javascript', 'native'].indexOf(a.variant) - ['javascript', 'native'].indexOf(b.variant) ||
        ['stim', 'control'].indexOf(a.arm) - ['stim', 'control'].indexOf(b.arm),
    );

  const model = runs[0].model;
  const recordedOn = readdirSync(absoluteStageDir)
    .map((name) => join(absoluteStageDir, name, 'meta.json'))
    .filter(existsSync)
    .map((path) => readJson(path).dispatchAt)
    .filter(Boolean)
    .toSorted()[0]
    ?.slice(0, 10);
  const payload = {
    schemaVersion: 1,
    stage,
    title: formatStage(stage),
    protocolVersion: 4,
    recordedOn,
    primaryMetric: 'Dispatch to validated Settings screenshot',
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
