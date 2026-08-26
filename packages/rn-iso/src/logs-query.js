// src/logs-query.js -- reading the merged timeline back out.
//
// The log directory holds one file per source (metro.ndjson, client.ndjson,
// device.ndjson, build-ios.ndjson, ...), each appended in ts order by its own
// producer. A query is a k-way merge across whatever files happen to exist:
// the set is discovered, never enumerated, because steps 3 and 4 add sources
// and a hardcoded list would silently omit them.
//
// The query that has to be exactly right is `--errors`, because it is what an
// agent loop polls after a build and its EMPTY result is the pass condition.
// It has to be right in BOTH directions, and a field test caught it wrong in
// both at once: it returned 3,004 iOS syslog lines on a healthy app while
// hiding a real `[Error: Exception in HostFunction]`. Two rules come from
// that, and they are the two things to not undo:
//
//   SCOPE  --errors reports metro, client and build by default (ERROR_SOURCES).
//          Device errors are the OS talking, not the app; the app's own
//          crashes reach the client and metro streams. `--source device` (or
//          `--source all`) opts back in, and a plain `logs` still shows
//          everything.
//   WINDOW A marker records which window it closes, by its source. See
//          markerWindow below: a finished bundle is not evidence that the
//          app which loaded it is fine.
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'fs';
import { join } from 'path';
import { StringDecoder } from 'string_decoder';
import { levelRank, parseNdjsonLine, parseNdjsonText } from './ndjson.ts';

const SINCE_UNITS = { s: 1000, m: 60000, h: 3600000 };
const SINCE_FORMS = '30s, 5m, 2h';

// Pure. Returns { ms } or { error }, never NaN: the failure this exists to
// prevent is `parseInt('soon')` producing NaN, every comparison against it
// coming out false, and the query returning an empty result that an agent
// loop reads as "nothing is wrong".
export function parseSince(text) {
  if (typeof text !== 'string') {
    return { error: `Invalid --since value ${JSON.stringify(text)}. Use a count and a unit, e.g. ${SINCE_FORMS}.` };
  }
  const m = /^(\d+)\s*([smh])$/i.exec(text.trim());
  if (!m) {
    return { error: `Invalid --since value "${text}". Use a count and a unit, e.g. ${SINCE_FORMS}.` };
  }
  return { ms: parseInt(m[1], 10) * SINCE_UNITS[m[2].toLowerCase()] };
}

// Pure. Same contract as parseSince: a bad pattern is data, not an exception,
// so the command can print it and exit 1 instead of dumping a stack.
export function compileGrep(pattern) {
  if (pattern instanceof RegExp) return { re: pattern };
  try {
    return { re: new RegExp(String(pattern)) };
  } catch (err) {
    return { error: `Invalid --grep pattern "${pattern}": ${err.message}` };
  }
}

// The sources `--errors` reports when the caller named none. Device is out on
// purpose: `simctl log stream` is predicated on the app's PROCESS, and inside
// that process Apple's own frameworks log thousands of Error-typed lines that
// have nothing to do with the app (collector/ios.js demotes the proven ones;
// this is the second half of the same fix, for the ones nobody has curated
// yet). A native crash that never reached JS is still findable -- `logs
// --errors --source device`, `--source all`, or a plain `logs`.
export const ERROR_SOURCES = ['metro', 'client', 'build'];

// THE MARKER WINDOW, and why it is two numbers rather than one.
//
// FIELD CASE. A real startup crash was reported at 16:03:54 on client, and
// Metro wrote its bundle_build_done marker at 16:03:55 -- one second LATER,
// because the bundler finishes accounting for a build after the app has
// already evaluated it. Under a single "last marker across all sources"
// cutoff that marker retroactively swallowed the crash, and `--errors` said
// the app was fine while it was sitting on a redbox.
//
// The rule now: a marker closes the window for the sources it can actually
// speak for.
//   * A BUNDLE marker (src metro: the reporter's bundle_build_done, or the
//     "Bundled 812ms" line in expo-child mode) means the BUNDLER is happy. It
//     resets metro-source errors -- a resolve failure you fixed and rebuilt is
//     history -- and says nothing about the app, so client, device and build
//     errors survive it.
//   * A LAUNCH marker (src build: `ios`/`android` after a successful launch)
//     means a new run of the app starts here. It resets everything, which is
//     what stops the previous run's redbox from being reported forever.
//
// Chosen over the alternative (a settle delay plus a [marker-5s, marker]
// startup-crash window for client records) because that one is two tunable
// constants deciding whether a crash is reported, and because a 5s window
// applied to a LAUNCH marker would resurrect the previous run's errors --
// exactly the bug the marker exists to prevent. The cost of this rule is the
// opposite, safe direction: a client redbox that Fast Refresh already fixed
// keeps being reported until the next launch marker.
//
// Classification is by `src`, not by event name, because the two bundle
// markers have different event names (bundle_build_done / expo_stdout) and
// the same source. An unrecognised marker source resets everything, which is
// the conservative reading -- it shows more, never less.
export function markerWindow(records) {
  let launchTs = null;
  let bundleTs = null;
  for (const r of records) {
    if (r?.marker !== true) continue;
    const ts = tsOf(r);
    if (ts === null) continue;
    if (r.src === 'metro') {
      if (bundleTs === null || ts > bundleTs) bundleTs = ts;
    } else if (launchTs === null || ts > launchTs) {
      launchTs = ts;
    }
  }
  return { launchTs, bundleTs };
}

// Pure predicate shared by queryLogs and followLogs, so a follow stream and a
// one-shot query can never disagree about what matches.
export function recordMatches(record, criteria = {}) {
  if (!record) return false;
  const { sources, minLevel, grep, sinceTs, errorsOnly, markerTs, bundleMarkerTs } = criteria;

  if (sources && sources.length > 0 && !sources.includes(record.src)) return false;
  if (minLevel && levelRank(record.level) < levelRank(minLevel)) return false;

  if (errorsOnly) {
    if (record.level !== 'error' && record.level !== 'fatal') return false;
    // markerTs is the LAUNCH cutoff and applies to every source;
    // bundleMarkerTs is the bundle cutoff and applies to metro only. A metro
    // error has to clear both, which makes its cutoff the later of the two.
    if (typeof markerTs === 'number') {
      const ts = tsOf(record);
      // Strictly after: a record stamped at the same millisecond as the marker
      // describes the state the marker closes off, not the one it opens.
      if (ts === null || ts <= markerTs) return false;
    }
    if (typeof bundleMarkerTs === 'number' && record.src === 'metro') {
      const ts = tsOf(record);
      if (ts === null || ts <= bundleMarkerTs) return false;
    }
  }

  if (typeof sinceTs === 'number') {
    const ts = tsOf(record);
    if (ts === null || ts < sinceTs) return false;
  }

  if (grep) {
    const re = grep instanceof RegExp ? grep : compileGrep(grep).re;
    // .search rather than .test: it ignores lastIndex, so a caller-supplied
    // /g regex cannot make alternate records match.
    if (!re || String(record.msg ?? '').search(re) === -1) return false;
  }

  return true;
}

// Turns CLI-shaped options into the criteria recordMatches wants, resolving
// `since` against `now` and compiling `grep` once. Throws on bad input --
// callers that want to report it politely call parseSince/compileGrep first.
export function buildCriteria({ sources, minLevel, since, grep, errorsOnly, markerTs, bundleMarkerTs, now } = {}) {
  const criteria = { errorsOnly: Boolean(errorsOnly) };
  // The default scope lives here rather than in queryLogs so the one-shot
  // query and the --follow stream cannot disagree about what --errors means.
  if (sources && sources.length > 0) criteria.sources = sources;
  else if (criteria.errorsOnly) criteria.sources = ERROR_SOURCES;
  if (minLevel) criteria.minLevel = minLevel;
  if (typeof markerTs === 'number') criteria.markerTs = markerTs;
  if (typeof bundleMarkerTs === 'number') criteria.bundleMarkerTs = bundleMarkerTs;
  if (since !== undefined && since !== null && since !== '') {
    const parsed = parseSince(since);
    if (parsed.error) throw new Error(parsed.error);
    criteria.sinceTs = (typeof now === 'number' ? now : Date.now()) - parsed.ms;
  }
  if (grep !== undefined && grep !== null && grep !== '') {
    const compiled = compileGrep(grep);
    if (compiled.error) throw new Error(compiled.error);
    criteria.grep = compiled.re;
  }
  return criteria;
}

// Discovered, not enumerated. supervisor.log is deliberately excluded: it is
// the supervisor's raw stdio, not NDJSON.
export function logFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.ndjson'))
    .map((e) => e.name)
    .sort();
}

export function fileSizes(dir) {
  const sizes = {};
  for (const name of logFiles(dir)) {
    try {
      sizes[name] = statSync(join(dir, name)).size;
    } catch {
      // Raced against a rotation or a removed workspace: not this call's problem.
    }
  }
  return sizes;
}

// Every record in the directory, merged ascending. Records with no usable ts
// sort last in file order rather than poisoning the comparator: a producer
// that forgot to stamp is a bug to see in the output, not a crash.
export function readLogRecords(dir) {
  const all = [];
  for (const name of logFiles(dir)) {
    let text;
    try {
      text = readFileSync(join(dir, name), 'utf-8');
    } catch {
      continue;
    }
    for (const record of parseNdjsonText(text)) all.push(record);
  }
  return sortByTs(all);
}

export function queryLogs({ dir, sources, minLevel, since, grep, tail, errorsOnly, now } = {}) {
  const all = readLogRecords(dir);
  if (all.length === 0) return [];

  // The marker scan runs over the UNFILTERED merge on purpose: --source client
  // must still see the build marker that closes the previous window.
  const { launchTs, bundleTs } = errorsOnly ? markerWindow(all) : { launchTs: null, bundleTs: null };
  const criteria = buildCriteria({
    sources,
    minLevel,
    since,
    grep,
    errorsOnly,
    now,
    markerTs: launchTs === null ? undefined : launchTs,
    bundleMarkerTs: bundleTs === null ? undefined : bundleTs,
  });

  const matched = all.filter((r) => recordMatches(r, criteria));
  // Tail last, so `--level error --tail 5` means the last five ERRORS and not
  // the errors among the last five records.
  if (typeof tail === 'number' && tail >= 0 && matched.length > tail) {
    return matched.slice(matched.length - tail);
  }
  return matched;
}

// --- incremental tailing -------------------------------------------------
//
// Split into two pure functions plus a thin poller, so the part that is easy
// to get wrong (offsets, a record split across two polls, a truncated file)
// is unit-testable without sleeping.

// Decides where the next read starts. A file smaller than our offset was
// truncated or replaced; resuming past its end would stall the follower
// silently, so it restarts from the beginning.
export function tailRead(prev, size) {
  const state = prev && typeof prev.offset === 'number' ? prev : { offset: 0, partial: '' };
  if (size < state.offset) return { start: 0, prev: { offset: 0, partial: '' } };
  return { start: state.offset, prev: state };
}

// Absorbs a chunk read from `prev.offset` up to `size`. Whatever follows the
// last newline is not a finished record, so it is carried to the next poll.
export function advanceTail(prev, chunk, size) {
  const partialIn = prev && typeof prev.partial === 'string' ? prev.partial : '';
  const text = partialIn + (chunk || '');
  const lines = text.split('\n');
  const partial = lines.pop();
  const records = [];
  for (const line of lines) {
    const record = parseNdjsonLine(line);
    if (record) records.push(record);
  }
  return { state: { offset: size, partial }, records };
}

// Polling tail. Poll rather than fs.watch because the producers are separate
// processes writing over several files (and, on step 3/4, over a network of
// simctl/adb pipes); watch semantics differ per platform and drop events under
// exactly the churn a bundler produces.
//
// `offsets` lets a caller snapshot sizes BEFORE running its one-shot query, so
// a record written between the two is duplicated rather than lost. That is the
// right direction to err for an error stream.
export function followLogs({ dir, onRecord, criteria = {}, intervalMs = 500, offsets = null } = {}) {
  const state = new Map();
  const decoders = new Map();
  for (const [name, size] of Object.entries(offsets || fileSizes(dir))) {
    state.set(name, { offset: size, partial: '' });
    decoders.set(name, new StringDecoder('utf8'));
  }

  function pollFile(name) {
    const path = join(dir, name);
    const size = statSync(path).size;
    const entry = state.get(name);
    const { start, prev } = tailRead(entry, size);
    if (prev !== entry) decoders.set(name, new StringDecoder('utf8'));
    if (!decoders.has(name)) decoders.set(name, new StringDecoder('utf8'));

    let chunk = '';
    if (size > start) {
      const fd = openSync(path, 'r');
      try {
        const buf = Buffer.allocUnsafe(size - start);
        const read = readSync(fd, buf, 0, size - start, start);
        // Decode through a per-file StringDecoder: a poll boundary can fall in
        // the middle of a multi-byte character, and a naive toString would turn
        // it into replacement characters that then fail to parse.
        chunk = decoders.get(name).write(buf.subarray(0, read));
      } finally {
        closeSync(fd);
      }
    }

    const next = advanceTail(prev, chunk, size);
    state.set(name, next.state);
    for (const record of next.records) {
      if (recordMatches(record, criteria)) onRecord(record);
    }
  }

  function poll() {
    for (const name of logFiles(dir)) {
      try {
        pollFile(name);
      } catch {
        // A file removed or replaced under us: pick it up on the next poll.
      }
    }
  }

  const timer = setInterval(poll, intervalMs);
  return function stop() {
    clearInterval(timer);
  };
}

function tsOf(record) {
  return typeof record?.ts === 'number' && Number.isFinite(record.ts) ? record.ts : null;
}

function sortByTs(records) {
  return records.sort((a, b) => {
    const ta = tsOf(a);
    const tb = tsOf(b);
    if (ta === null && tb === null) return 0;
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta - tb;
  });
}
