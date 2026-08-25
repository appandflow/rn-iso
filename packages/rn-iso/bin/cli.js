#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import initCommand from '../src/commands/init.js';
import doctorCommand from '../src/commands/doctor.js';
import worktreeCommand from '../src/commands/worktree.js';
import startCommand from '../src/commands/start.js';
import stopCommand from '../src/commands/stop.js';
import iosCommand from '../src/commands/ios.js';
import androidCommand from '../src/commands/android.js';
import logsCommand from '../src/commands/logs.js';
import statusCommand from '../src/commands/status.js';
import gcCommand from '../src/commands/gc.js';
import guideCommand from '../src/commands/guide.js';
import skillCommand from '../src/commands/skill.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

const program = new Command();
program
  .name('rn-iso')
  .description('Isolated React Native dev environments per project/worktree')
  .version(pkg.version);

// Registration order is the order `--help` lists them, and that listing is the
// surface a new agent reads first: the lifecycle in the order it is run
// (init/doctor once per repo, then worktree -> start -> ios/android -> logs ->
// stop), then the whole-machine commands, then the two meta commands.
initCommand(program);
doctorCommand(program);
worktreeCommand(program);
startCommand(program, pkg.version);
stopCommand(program);
iosCommand(program);
androidCommand(program);
logsCommand(program);
statusCommand(program);
gcCommand(program);
guideCommand(program, pkg.version);
skillCommand(program, pkg.version);

// parseAsync (not parse): several command actions (ios, android, start, stop,
// worktree) are async, and commander only awaits/propagates their errors
// correctly through parseAsync. Top-level await is fine here -- this file
// is ESM ("type": "module" in package.json).
try {
  await program.parseAsync();
} catch (err) {
  // Errors that describe a state the user must repair carry their own
  // instructions, so the message is the whole output. Anything else is a bug,
  // and its stack trace is the useful part.
  if (err?.code === 'RN_ISO_CONFIG_CORRUPT') {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
