#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import deviceCommand from '../src/commands/device.js';
import stopCommand from '../src/commands/stop.js';
import pruneCommand from '../src/commands/prune.js';
import gcCommand from '../src/commands/gc.js';
import statusCommand from '../src/commands/status.js';
import releaseCommand from '../src/commands/release.js';
import shutdownCommand from '../src/commands/shutdown.js';
import configCommand from '../src/commands/config.js';
import worktreeCommand from '../src/commands/worktree.js';
import upCommand from '../src/commands/up.js';
import guideCommand from '../src/commands/guide.js';
import skillCommand from '../src/commands/skill.js';
import doctorCommand from '../src/commands/doctor.js';
import cacheCommand from '../src/commands/cache.js';
import buildCacheCommand from '../src/commands/build-cache.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

const program = new Command();
program
  .name('rn-iso')
  .description('Isolated React Native dev environments per project/worktree')
  .version(pkg.version);

deviceCommand(program);
upCommand(program);
stopCommand(program);
pruneCommand(program);
gcCommand(program);
statusCommand(program);
releaseCommand(program);
shutdownCommand(program);
configCommand(program);
worktreeCommand(program);
guideCommand(program, pkg.version);
skillCommand(program, pkg.version);
doctorCommand(program);
cacheCommand(program);
buildCacheCommand(program);

// parseAsync (not parse): several command actions (up, release, shutdown,
// worktree) are async, and commander only awaits/propagates their errors
// correctly through parseAsync. Top-level await is fine here -- this file
// is ESM ("type": "module" in package.json).
await program.parseAsync();
