// src/commands/logs.js -- query the merged NDJSON timeline.
//
// Non-blocking by default (spec principle 7): the command prints what matches
// and returns. `--follow` is the only way to make it wait.
//
// The exit code is the part to not get wrong: NOTHING MATCHING IS EXIT 0.
// `rn-iso logs --errors` returning empty is the pass condition of an agent
// loop, so a "no results" non-zero would report every healthy build as broken.
// The only exit-1 paths here are a malformed query or no project.
import chalk from 'chalk';
import type { ChalkInstance } from 'chalk';
import type { Command } from 'commander';
import { findProjectRoot } from '../project.ts';
import { workspaceLogsDir } from '../paths.ts';
import { LEVELS, SOURCES } from '../ndjson.ts';
import type { NdjsonRecord } from '../ndjson.ts';
import { buildCriteria, compileGrep, fileSizes, followLogs, parseSince, queryLogs } from '../logs-query.ts';

const LEVEL_WIDTH = 5; // 'debug' / 'fatal'
const SRC_WIDTH = 6; // 'client' / 'device'
const INDENT = '    ';

// Stack frames arrive as {file,line,column,fn} straight off the wire, and any
// field may be absent.
interface StackFrame {
  file?: string;
  line?: number;
  column?: number;
  fn?: string;
}

export function formatTime(ts: unknown) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '--:--:--.---';
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// Stacks arrive as {file,line,column,fn} and any field may be absent -- this
// step passes frames through unsymbolicated, so a frame can be little more
// than a file. Returns null when there is nothing worth printing.
export function formatStackFrame(frame: StackFrame | null | undefined) {
  if (!frame || typeof frame !== 'object') return null;
  const where = [frame.file, frame.line, frame.column]
    .filter((p) => p !== undefined && p !== null && p !== '')
    .join(':');
  if (frame.fn && where) return `at ${frame.fn} (${where})`;
  if (frame.fn) return `at ${frame.fn}`;
  if (where) return `at ${where}`;
  return null;
}

// Pure: `paint` defaults to identity so the formatter never depends on whether
// chalk decided stdout is a TTY. The command passes the colouring in.
export function formatRecord(
  record: Partial<NdjsonRecord> | null | undefined,
  { paint }: { paint?: (t: string) => string } = {},
) {
  const colour = paint || ((t: string) => t);
  const level = String(record?.level ?? '').padEnd(LEVEL_WIDTH);
  const src = String(record?.src ?? '').padEnd(SRC_WIDTH);
  const msg = record?.msg === undefined || record?.msg === null ? '' : String(record.msg);
  const [first, ...rest] = msg.split('\n');
  const lines = [`${formatTime(record?.ts)} ${colour(level)} ${src} ${first}`];
  for (const line of rest) lines.push(`${INDENT}${line}`);
  // record.stack comes through NdjsonRecord's index signature as unknown;
  // formatStackFrame is defensive about what it actually finds inside.
  for (const frame of (Array.isArray(record?.stack) ? record.stack : []) as StackFrame[]) {
    const rendered = formatStackFrame(frame);
    if (rendered) lines.push(`${INDENT}${rendered}`);
  }
  return lines.join('\n');
}

export function parseTail(value: unknown) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return { n: value };
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    return { error: `Invalid --tail value ${JSON.stringify(value)}. Use a non-negative whole number, e.g. --tail 50.` };
  }
  return { n: parseInt(value.trim(), 10) };
}

// An unknown source would just match nothing, and "nothing" is the answer
// this CLI must never get wrong: `logs --errors --source metrro` exiting 0
// with no output is indistinguishable from a clean build. So it fails.
//
// `all` is spelled out rather than left implicit because --errors now has a
// DEFAULT scope (metro, client, build -- see ERROR_SOURCES): without a word
// for "everything", asking for the device stream back would mean typing the
// whole list.
interface SourcesResult {
  sources?: string[];
  error?: string;
}

export function validateSources(sources: string | string[] | undefined | null): SourcesResult {
  if (sources === undefined || sources === null) return { sources: undefined };
  const list = Array.isArray(sources) ? sources : [sources];
  if (list.includes('all')) return { sources: [...SOURCES] };
  const unknown = list.filter((s) => !SOURCES.includes(s));
  if (unknown.length > 0) {
    return {
      error: `Unknown --source value(s): ${unknown.join(', ')}. Use one or more of: ${SOURCES.join(', ')}, or all.`,
    };
  }
  return { sources: list };
}

interface LevelResult {
  level?: string;
  error?: string;
}

export function validateLevel(level: string): LevelResult {
  if (LEVELS.includes(level)) return { level };
  return { error: `Invalid --level value ${JSON.stringify(level)}. Use one of: ${LEVELS.join(', ')}.` };
}

// How many records `--errors` prints before it stops and says how many are
// left. The field case was 3,004 records of iOS syslog: a report that long is
// not a report, and the agent reading it pays for every line. The cap is on
// the PRINTED output only -- the query itself, and `status`, still count them
// all, and --json is never capped because a machine reader asked for the set.
//
// The head is what survives, not the tail: the first error in a window is
// usually the cause and the rest is cascade. That also makes the trailer's
// count exact -- what was hidden IS the tail, so `--tail N` prints precisely
// the records that were left out.
export const ERRORS_PRINT_CAP = 20;

const LEVEL_COLOURS: Record<string, ChalkInstance> = {
  debug: chalk.dim,
  info: chalk.reset,
  warn: chalk.yellow,
  error: chalk.red,
  fatal: chalk.bgRed,
};

interface LogsOptions {
  source?: string | string[];
  level?: string;
  since?: string;
  grep?: string;
  tail?: string | number;
  errors?: boolean;
  follow?: boolean;
  json?: boolean;
}

export default function logsCommand(program: Command) {
  program
    .command('logs')
    .description(
      "Query this workspace's merged NDJSON log timeline (bundler, client, device, build). Prints and exits; nothing matching is a successful, empty result. Use --follow to stream.",
    )
    .option('--source <s...>', 'Only these sources: metro, client, device, build, or all')
    .option('--level <l>', `Minimum level: ${LEVELS.join(', ')}`)
    .option('--since <d>', 'Only records newer than this, e.g. 30s, 5m, 2h')
    .option('--grep <re>', 'Only records whose message matches this regular expression')
    .option('--tail <n>', 'Only the last n matching records')
    .option(
      '--errors',
      "Only errors and fatals since the last marker, from metro, client and build (the agent-loop query). Device errors are the OS talking, not the app -- the app's own crashes reach the client and metro streams -- so add --source device or --source all to include them.",
    )
    .option('--follow', 'Keep streaming new records until interrupted')
    .option('--json', 'Emit the raw records, one per line (valid NDJSON; zero matches is zero bytes, exit 0)')
    .action((opts: LogsOptions) => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project (no package.json found).'));
        process.exit(1);
      }
      const dir = workspaceLogsDir(root);

      let sources: string[] | undefined;
      if (opts.source !== undefined) {
        const checked = validateSources(opts.source);
        if (checked.error) fail(checked.error);
        sources = checked.sources;
      }

      let minLevel: string | undefined;
      if (opts.level !== undefined) {
        const checked = validateLevel(opts.level);
        if (checked.error) fail(checked.error);
        minLevel = checked.level;
      }

      if (opts.since !== undefined) {
        const parsed = parseSince(opts.since);
        if (parsed.error) fail(parsed.error);
      }

      let tail: number | undefined;
      if (opts.tail !== undefined) {
        const parsed = parseTail(opts.tail);
        if (parsed.error) fail(parsed.error);
        tail = parsed.n;
      }

      if (opts.grep !== undefined) {
        const compiled = compileGrep(opts.grep);
        if (compiled.error) fail(compiled.error);
      }

      const query = {
        dir,
        sources,
        minLevel,
        since: opts.since,
        grep: opts.grep,
        tail,
        errorsOnly: Boolean(opts.errors),
      };

      const emit = (record: NdjsonRecord) => {
        if (opts.json) {
          // One raw record per line: this stdout is itself valid NDJSON.
          console.log(JSON.stringify(record));
          return;
        }
        console.log(formatRecord(record, { paint: record?.level ? LEVEL_COLOURS[record.level] : undefined }));
      };

      // Snapshot the file sizes BEFORE the query so a record written between
      // the two shows up twice rather than being missed. For an error stream
      // a duplicate is noise; a gap is a wrong answer.
      const offsets = opts.follow ? fileSizes(dir) : null;

      const records = queryLogs(query);
      // An explicit --tail is the caller choosing a length, so it wins.
      const capped =
        opts.errors && !opts.json && tail === undefined && records.length > ERRORS_PRINT_CAP
          ? records.slice(0, ERRORS_PRINT_CAP)
          : records;
      for (const record of capped) emit(record);
      const hidden = records.length - capped.length;
      if (hidden > 0) {
        console.log(chalk.dim(`... and ${hidden} more (rerun with --tail ${hidden} or --json)`));
      }

      if (!opts.follow) {
        if (records.length === 0 && !opts.json) {
          console.error(chalk.dim(`No matching log records in ${dir}`));
        }
        return;
      }

      // In follow mode --errors drops the marker window: every error arriving
      // from here is, by definition, after the last marker seen so far. Keeping
      // the window would mean a later marker retroactively hiding lines already
      // printed, which it cannot.
      const criteria = buildCriteria({
        sources,
        minLevel,
        since: opts.since,
        grep: opts.grep,
        errorsOnly: Boolean(opts.errors),
      });
      const stop = followLogs({ dir, offsets, criteria, onRecord: emit });
      // Ctrl+C is how a follow ends. It is a normal end, so it exits 0.
      const finish = () => {
        stop();
        process.exit(0);
      };
      process.on('SIGINT', finish);
      process.on('SIGTERM', finish);
    });
}

function fail(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}
