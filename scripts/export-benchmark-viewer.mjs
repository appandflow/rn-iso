import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';

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

const absolutePathPattern = /(?<![A-Za-z0-9._-])\/(?:Users|Volumes|private|tmp|var\/folders)\/[^\s'"`,;)]+/g;
const ipAddressPattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const simulatorIdPattern = /\b[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\b/gi;

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
  let text = String(value ?? '');
  for (const [absolute, portable] of replacements.toSorted((a, b) => b[0].length - a[0].length)) {
    text = text.replaceAll(absolute, portable);
  }
  text = text.replaceAll(userInfo().username, '<local-user>');
  return text
    .replace(simulatorIdPattern, '<simulator-udid>')
    .replace(ipAddressPattern, '<local-ip>')
    .replace(absolutePathPattern, (path) => replacementLabel(path));
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

function eventsFor(runDir, start, replacements) {
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
        output: sanitizeBenchmarkText(clipped(item.aggregated_output), replacements),
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
  }
  return { messages, commands };
}

function assertPortable(payload) {
  const serialized = JSON.stringify(payload);
  const leakedPath = serialized.match(absolutePathPattern)?.[0];
  if (leakedPath) throw new Error(`benchmark export contains an absolute machine path: ${leakedPath}`);
  const leakedIp = serialized.match(ipAddressPattern)?.[0];
  if (leakedIp) throw new Error(`benchmark export contains an IP address: ${leakedIp}`);
  if (serialized.includes('janicduplessis')) {
    throw new Error('benchmark export contains a local username');
  }
}

export function exportBenchmark(stageDir, outputPath, proofDir) {
  const absoluteStageDir = resolve(stageDir);
  const stage = basename(absoluteStageDir);
  const resultsRoot = dirname(absoluteStageDir);
  const coordinatorRoot = dirname(resultsRoot);
  const proofCopies = [];
  const runs = readdirSync(absoluteStageDir)
    .map((name) => join(absoluteStageDir, name))
    .filter((runDir) => existsSync(join(runDir, 'run.json')) && existsSync(join(runDir, 'meta.json')))
    .map((runDir) => {
      const record = readJson(join(runDir, 'run.json'));
      const meta = readJson(join(runDir, 'meta.json'));
      const appAlive = existsSync(join(runDir, 'app-alive.json')) ? readJson(join(runDir, 'app-alive.json')) : null;
      const id = publicRunId(record);
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
      return {
        id,
        model: record.model,
        variant: record.variant,
        arm: record.arm,
        valid: record.valid,
        invalidReasons: record.invalidReasons,
        settingsReadySeconds: record.dispatchToScreenReadySeconds,
        appAliveSeconds: record.dispatchToAppAliveSeconds,
        totalSeconds,
        commandCount: record.commandCount,
        usage: record.usage,
        estimatedTokenCostUsd: estimateTokenCost(record.usage, record.model),
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

  if (runs.length === 0) throw new Error(`no benchmark runs found in ${absoluteStageDir}`);
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
  const [, , stageDir, outputPath, proofDir] = process.argv;
  if (!stageDir || !outputPath || !proofDir) {
    throw new Error('usage: node scripts/export-benchmark-viewer.mjs <stage-dir> <output-json> <proof-dir>');
  }
  const payload = exportBenchmark(stageDir, outputPath, proofDir);
  process.stdout.write(`${relative(process.cwd(), outputPath)} (${payload.runs.length} sanitized runs)\n`);
}
