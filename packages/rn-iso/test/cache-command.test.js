// `rn-iso cache list` reported only the manifest, so it printed "No caches
// registered" on a machine plainly holding an Xcode CAS and a pile of Metro file
// maps -- which reads as "there is nothing here" and is the opposite of what the
// command is for.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { register, registeredCaches } from '../src/cache-manifest.js';
import cacheCommand from '../src/commands/cache.js';

// Stub of the commander `Command` API, keyed by subcommand name: `cache`
// registers three actions off the same object.
function captureActions(registerCommands) {
  const actions = {};
  let current = null;
  const stub = {
    command(name) { current = String(name).split(' ')[0]; return stub; },
    description() { return stub; },
    option() { return stub; },
    action(fn) { actions[current] = fn; return stub; },
  };
  registerCommands(stub);
  return actions;
}

let sandbox;
let tmpHome;
let realHome;
let realTmp;
let printed;
let realLog;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'rn-iso-cachecmd-'));
  tmpHome = join(sandbox, 'config');
  // Both discovery probes read the machine: the Xcode CAS sits under $HOME and
  // Metro's file maps sit in the system temp dir. Point both at an empty
  // sandbox so this test describes only what it put there.
  realHome = process.env.HOME;
  realTmp = process.env.TMPDIR;
  process.env.HOME = join(sandbox, 'home');
  process.env.TMPDIR = join(sandbox, 'tmp');
  mkdirSync(process.env.HOME, { recursive: true });
  mkdirSync(process.env.TMPDIR, { recursive: true });
  process.env.RN_ISO_HOME = tmpHome;
  setExecutor({ run: () => '', runQuiet: () => null, spawn: () => {} });

  printed = [];
  realLog = console.log;
  console.log = (...args) => printed.push(args.join(' '));
});

afterEach(() => {
  console.log = realLog;
  resetExecutor();
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = realTmp;
  delete process.env.RN_ISO_HOME;
  rmSync(sandbox, { recursive: true, force: true });
});

test('cache list shows detected caches next to registered ones, and says which is which', () => {
  const registeredDir = join(sandbox, 'registered-cache');
  mkdirSync(registeredDir, { recursive: true });
  register({ dir: registeredDir, name: 'Registered one' });
  // A Metro file map is a cache nothing registers: rn-iso recognises it by name.
  writeFileSync(join(process.env.TMPDIR, 'metro-file-map-demo'), 'x'.repeat(64));

  captureActions(cacheCommand).list();

  const output = printed.join('\n');
  assert.doesNotMatch(output, /No caches registered/);
  assert.match(output, /Registered one \(registered\)/);
  assert.match(output, /Metro file maps \(detected\)/);
});

test('cache list says nothing is there only when nothing is', () => {
  captureActions(cacheCommand).list();
  assert.match(printed.join('\n'), /No caches registered or detected/);
});

// A cache registered by hand needs the same depth the packages register, or a
// hand-registered Metro FileStore is trimmed a whole shard at a time.
test('cache register records the entry depth it was given', () => {
  const dir = join(sandbox, 'by-hand');
  mkdirSync(dir, { recursive: true });

  captureActions(cacheCommand).register(dir, { entriesDepth: 2, name: 'By hand' });

  const record = registeredCaches().find(c => c.dir === dir);
  assert.equal(record.entriesDepth, 2);
  assert.match(printed.join('\n'), /2 levels below/);
});

test('cache register defaults to entries directly inside the directory, and says so', () => {
  const dir = join(sandbox, 'flat');
  mkdirSync(dir, { recursive: true });

  captureActions(cacheCommand).register(dir, {});

  assert.equal(registeredCaches().find(c => c.dir === dir).entriesDepth, 1);
  assert.match(printed.join('\n'), /--entries-depth/);
});
