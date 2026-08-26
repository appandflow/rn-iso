#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import doctorCommand from '../src/commands/doctor.ts';
import worktreeCommand from '../src/commands/worktree.ts';
import startCommand from '../src/commands/start.ts';
import stopCommand from '../src/commands/stop.ts';
import iosCommand from '../src/commands/ios.ts';
import androidCommand from '../src/commands/android.ts';
import logsCommand from '../src/commands/logs.ts';
import statusCommand from '../src/commands/status.ts';
import gcCommand from '../src/commands/gc.ts';
import guideCommand from '../src/commands/guide.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

const program = new Command();
program.name('rn-iso').description('Isolated React Native dev environments per project/worktree').version(pkg.version);

// Registration order is the order `--help` lists them, and that listing is the
// surface a new agent reads first: the lifecycle in the order it is run
// (doctor once per repo, then worktree -> start -> ios/android -> logs ->
// stop), then the whole-machine commands, then the two meta commands.
//
// There is no `init`. Setting a repo up is not a generator's job: every edit it
// would make lands in a file the project already owns (a metro.config.js with
// its own transformer, a Podfile with existing post_install logic), and the one
// thing it could write safely -- the `.rn-iso/` gitignore entry -- is now
// self-ensured by the commands that create the directory (engine/workspace.js).
// What is left is judgement, which is the rn-iso-init SKILL's job: doctor
// reports, an agent applies each fix in the repo's own style.
doctorCommand(program);
worktreeCommand(program);
startCommand(program);
stopCommand(program);
iosCommand(program);
androidCommand(program);
logsCommand(program);
statusCommand(program);
gcCommand(program);
guideCommand(program, pkg.version);

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
  if ((err as { code?: string })?.code === 'RN_ISO_CONFIG_CORRUPT') {
    console.error((err as Error).message);
    process.exit(1);
  }
  throw err;
}
