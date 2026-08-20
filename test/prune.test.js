import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { saveConfig, loadConfig } from '../src/config.js';
import pruneCommand from '../src/commands/prune.js';

// `prune` is documented as the narrow, always-safe command: it only ever
// touches entries whose project directory is confirmed gone. Before this
// fix it had NO unmounted-volume guard at all, so unplugging the external
// SSD this machine's repos live on made a bare `rn-iso prune` unregister
// (and, via reclaimProject, SIGTERM) every project on it. This mirrors
// gc.test.js's equivalent test for the project sweep gc.js already had.

let tmpHome;

async function runPrune() {
  const program = new Command();
  pruneCommand(program);
  await program.parseAsync(['node', 'rn-iso', 'prune']);
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
  setExecutor({
    run(cmd) {
      throw new Error(`unexpected run: ${cmd}`);
    },
    // reclaimProject looks up a listening pid via lsof; none is running here.
    runQuiet() {
      return null;
    },
    spawn(cmd) {
      throw new Error(`unexpected spawn: ${cmd}`);
    },
  });
});

afterEach(() => {
  resetExecutor();
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

test('a dead project on an unmounted volume is not unregistered', async () => {
  const unmountedPath = '/Volumes/RnIsoTestVolumeThatDoesNotExist/proj/gone';
  const localDeadBase = mkdtempSync(join(tmpdir(), 'rn-iso-test-localbase-'));
  const localDeadPath = join(localDeadBase, 'no-longer-here');
  // localDeadPath deliberately not created: existsSync(localDeadPath) is false,
  // but its ancestor (localDeadBase, under the real tmp dir on the boot
  // volume) exists and resolves to the always-mounted "/" root.

  try {
    saveConfig({
      version: 2,
      projects: {
        [unmountedPath]: { metroPort: 8100 },
        [localDeadPath]: { metroPort: 8101 },
      },
      repos: {},
    });

    await runPrune();

    const cfg = loadConfig();
    // The unmounted-volume entry survives: its volume could not be
    // confirmed mounted, so it must not be treated as dead.
    assert.ok(cfg.projects[unmountedPath], 'entry on unmounted volume must not be pruned');
    assert.equal(cfg.projects[unmountedPath].metroPort, 8100);
    // The genuinely local dead entry (boot volume, directory just missing)
    // is still pruned as before.
    assert.equal(cfg.projects[localDeadPath], undefined);
  } finally {
    rmSync(localDeadBase, { recursive: true, force: true });
  }
});

test('prunes nothing and reports every path still existing when nothing is dead', async () => {
  const liveDir = mkdtempSync(join(tmpdir(), 'rn-iso-test-live-'));
  try {
    saveConfig({
      version: 2,
      projects: { [liveDir]: { metroPort: 8090 } },
      repos: {},
    });

    await runPrune();

    const cfg = loadConfig();
    assert.ok(cfg.projects[liveDir]);
  } finally {
    rmSync(liveDir, { recursive: true, force: true });
  }
});

test('a genuinely dead project on the boot volume is pruned and reported', async () => {
  const deadBase = mkdtempSync(join(tmpdir(), 'rn-iso-test-deadbase-'));
  const deadPath = join(deadBase, 'gone');
  try {
    saveConfig({
      version: 2,
      projects: { [deadPath]: { metroPort: 8095 } },
      repos: {},
    });

    await runPrune();

    const cfg = loadConfig();
    assert.equal(cfg.projects[deadPath], undefined);
  } finally {
    rmSync(deadBase, { recursive: true, force: true });
  }
});
