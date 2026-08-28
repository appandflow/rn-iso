// The two things rn-iso wires into Metro: a transform cache shared by every
// worktree on the machine, and a reporter that writes the dev server's events
// as NDJSON.
//
// Metro's default cache lives under the project, so a second worktree starts
// cold and re-transforms the whole module graph -- thousands of modules, every
// time. Pointing every checkout at one store means only the first one pays.
//
//   const { sharedCacheStores } = require('@rn-iso/metro');
//   config.cacheStores = sharedCacheStores('myapp');
//
// The thin part is the FileStore. The part worth packaging is telling rn-iso the
// cache exists, so `gc` can report and trim it -- Metro's FileStore has
// no eviction logic whatsoever, so without that it grows until the disk does.
//
// The reporter is the other half, and it only works when Metro is hosted
// programmatically: both the Expo CLI and the React Native CLI overwrite
// config.reporter after loading metro.config.js, so a reporter set there is
// discarded. rn-iso's supervisor hosts Metro itself and passes this one in.
//
//   const { ndjsonReporter } = require('@rn-iso/metro');
//   config.reporter = ndjsonReporter();
//
// This file is authored in TypeScript with ESM syntax and built to CommonJS by
// tsdown (format: 'cjs'), because a metro.config.js and a supervisor hosting
// Metro in-process both reach the published entry through require().

import fs from 'node:fs';
import path from 'node:path';
import { metroCacheRoot, registerCache, tagSharedStore, workspaceLogDir } from '@rn-iso/core';

// A Metro FileStore, kept structural so this package need not depend on
// metro-cache's types: the constructor is all the caller relies on.
type FileStoreCtor = new (options: { root: string }) => object;

// A Metro reporter event. Metro's event union is large and version-dependent, so
// only the fields this reporter reads are named; the rest ride along untyped.
interface MetroEvent {
  type?: string;
  level?: unknown;
  data?: unknown;
  error?: unknown;
  stack?: string;
  buildID?: string;
}

// rn-iso's log record contract (Contract 1).
interface LogRecord {
  ts: number;
  src: 'metro' | 'client';
  level: string;
  msg: string;
  event?: string;
  stack?: string;
  marker?: boolean;
}

export interface NdjsonReporter {
  dir: string;
  update(event: MetroEvent): void;
  readonly drops: number;
}

// THIS RESOLUTION EXISTS THREE TIMES: here, in
// packages/expo-build-cache/index.ts, and in rn-iso's own src/paths.ts
// (sharedMetroCache / sharedBuildCache). This package cannot import that module
// -- it has to work on a machine with no rn-iso installed at all -- so the
// duplication is deliberate, the same way buildCacheKey is duplicated between
// the build-cache implementations. Change one and you must change all three:
// when they drift, one entry point writes a cache the other will never read,
// and neither of them says so. rn-iso's src/__tests__/cache-packages.test.ts
// asserts all three agree.
//
// RN_ISO_METRO_CACHE comes first because it did before the layout existed, and
// quietly ignoring an override someone already set reads as an empty cache
// rather than as an error. It names one directory, so it wins for a named cache
// too -- otherwise half the stores on a machine would move and half would not.
export function cacheRoot(name?: string | null): string {
  return metroCacheRoot(name);
}

// Registering makes this cache visible to `rn-iso gc`'s report, which is the
// only thing that will ever trim it -- Metro's FileStore has no eviction of its
// own.
//
// The manifest is written directly rather than through rn-iso's own module, for
// two reasons that both made the import silently do nothing:
//   - the documented way to use the CLI is `npx rn-iso`, so it is usually not a
//     dependency of the project and the specifier does not resolve at all
//   - rn-iso is an ES module, so `require` of it throws ERR_REQUIRE_ESM on Node
//     before 20.19
// A dynamic import fixes the second and not the first.
function registerOnce(dir: string): void {
  registerCache({
    dir,
    name: 'Metro transform cache',
    // One file per cache key, so entries nothing has touched can go
    // individually rather than emptying the whole store. FileStore shards one
    // level above them, so the entries are two deep.
    prune: 'entries',
    entriesDepth: 2,
    note: 'shared Metro transforms; no eviction of its own',
  });
}

// `name` only distinguishes one app's cache from another's on the same machine:
// it is a subdirectory of the shared root, not a directory of its own. Metro
// keys entries by content, so sharing one store between unrelated projects would
// be correct but pointlessly large.
export function sharedCacheStores(name = 'app', { FileStore }: { FileStore?: FileStoreCtor } = {}): object[] {
  // metro-cache is a peer dependency, resolved at call time so this package
  // still loads on a machine that never installed it (the store can be
  // injected instead). require() is native at runtime in the built CJS.
  const Store: FileStoreCtor = FileStore || (require('metro-cache') as { FileStore: FileStoreCtor }).FileStore;
  const root = cacheRoot(name);
  registerOnce(root);
  // Tagged so rn-iso recognizes this store as ITS root and does not append a
  // second one beside it when `rn-iso start` hosts a project that already
  // called this function by hand. Metro's FileStore made `_root` private in
  // metro-cache 0.83.0, so the tag is the only thing left to recognize.
  return [tagSharedStore(new Store({ root }), root)];
}

// --- the NDJSON reporter ------------------------------------------------
//
// One JSON object per line, per rn-iso's log record contract:
//
//   { ts, src: 'metro'|'client', level: 'debug'|'info'|'warn'|'error'|'fatal',
//     msg, event?, stack?, marker? }
//
// Two files, because the two sources answer different questions: metro.ndjson
// is the bundler (did it build, what failed to transform) and client.ndjson is
// the app (what the running code logged and threw). Metro forwards the latter
// through the same reporter, so splitting here is what keeps `logs --source
// client` from being a grep over bundler chatter.
//
// The rules this file lives by: a logging failure must never become a dev
// server failure. Metro calls update() from inside its own build pipeline, so a
// throw here -- an event shape from a Metro version this package never saw, an
// unwritable log directory -- would take the server down with it. Every path
// swallows and counts instead.

const NDJSON_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'fatal']);

// Metro speaks the console's vocabulary on client logs (`log`, `trace`,
// `group`) and its own on server logs. Anything unrecognized falls back to the
// caller's default rather than inventing a level.
function ndjsonLevel(level: unknown, fallback: string): string {
  const value = String(level === undefined || level === null ? '' : level).toLowerCase();
  if (NDJSON_LEVELS.has(value)) return value;
  switch (value) {
    case 'log':
    case 'dir':
    case 'table':
    case 'group':
    case 'groupcollapsed':
    case 'groupend':
      return 'info';
    case 'trace':
      return 'debug';
    case 'warning':
      return 'warn';
    default:
      return fallback;
  }
}

// Client logs arrive as the console's argument list, so they are joined the way
// a console would print them. A value that cannot be stringified (a circular
// object, a proxy that throws) still has to produce something.
function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message || String(value);
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // Fall through to String(), which handles circular structures.
  }
  try {
    return String(value);
  } catch {
    return '[unprintable]';
  }
}

function formatData(data: unknown): string {
  if (data === undefined || data === null) return '';
  if (Array.isArray(data)) return data.map(formatValue).join(' ');
  return formatValue(data);
}

// Metro wraps its failures differently depending on where they came from: a
// resolution failure is an Error, a transformer failure can be a plain object
// carrying only a message.
function errorMessage(error: unknown): string {
  if (error === undefined || error === null) return 'unknown error';
  if (typeof error === 'string') return error;
  if (typeof (error as { message?: unknown }).message === 'string' && (error as { message: string }).message) {
    return (error as { message: string }).message;
  }
  return formatValue(error);
}

export function ndjsonReporter({ dir }: { dir?: string } = {}): NdjsonReporter {
  const logDir = dir || workspaceLogDir(process.cwd());
  let ensured = false;
  let drops = 0;

  // Lazily: constructing a reporter must not create directories for a server
  // that may never start, and the per-workspace log directory may not exist
  // yet at all.
  function write(file: string, record: LogRecord): void {
    try {
      if (!ensured) {
        fs.mkdirSync(logDir, { recursive: true });
        ensured = true;
      }
      fs.appendFileSync(path.join(logDir, file), JSON.stringify(record) + '\n');
    } catch {
      // An unwritable log directory is a housekeeping problem, not a build one.
      // The count is what makes it visible instead of silent.
      drops += 1;
      ensured = false;
    }
  }

  function update(event: MetroEvent): void {
    try {
      const type = event && typeof event.type === 'string' ? event.type : '';
      const record: LogRecord = { ts: Date.now(), src: 'metro', level: 'debug', msg: '' };
      if (type) record.event = type;

      if (type === 'client_log') {
        record.src = 'client';
        record.level = ndjsonLevel(event.level, 'info');
        record.msg = formatData(event.data);
        // Passed through as-is: symbolication happens on the reading side, and
        // a stack this reporter could not parse is still better than no stack.
        if (event.stack) record.stack = event.stack;
        write('client.ndjson', record);
        return;
      }

      if (type === 'bundling_error' || type === 'transformer_error') {
        record.level = 'error';
        record.msg = errorMessage(event.error);
      } else if (type === 'bundle_build_done' || type === 'bundle_build_failed') {
        const what = type === 'bundle_build_done' ? 'bundle build done' : 'bundle build failed';
        record.level = 'info';
        record.msg = event.buildID ? `${what} (${event.buildID})` : what;
        // The marker resets the window `rn-iso logs --errors` reports over,
        // and BOTH ends of a bundle attempt carry one: a successful build is
        // the point past which older metro errors are history, and a FAILED
        // build has to advance the window too, or back-to-back failures pile
        // up and the oldest -- least relevant -- one is listed first
        // (appandflow/rn-iso#13). Marking the failure boundary cannot hide
        // the failure's own errors: Metro reports bundle_build_failed BEFORE
        // the bundling_error that carries the message (the same synchronous
        // catch block in metro's Server), this reporter appends records in
        // call order, and logs-query's bundle cutoff is strict (<), so an
        // error stamped at the marker's own millisecond still lands inside
        // the window the marker opens.
        record.marker = true;
      } else if (type === 'unstable_server_log') {
        record.level = ndjsonLevel(event.level, 'info');
        record.msg = formatData(event.data);
      } else {
        // Everything else is kept at debug rather than dropped: the event name
        // is often the only evidence of what the server was doing before it
        // failed, and debug costs nothing to a default query.
        record.msg = formatData(event && event.data) || type || 'metro event';
      }

      write('metro.ndjson', record);
    } catch {
      // The event shape came from a package this one does not version.
      drops += 1;
    }
  }

  return {
    dir: logDir,
    update,
    get drops() {
      return drops;
    },
  };
}
