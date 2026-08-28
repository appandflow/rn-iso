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
// There is no `init`, and no setup skill either. Setting a repo up stopped
// being a step: rn-iso supplies the Metro store, the Xcode compilation cache
// and the Gradle build cache on the command lines it composes, and the one
// edit that was always safe -- the `.rn-iso/` gitignore entry -- is
// self-ensured by the commands that create the directory (engine/workspace.ts).
// What is left is what rn-iso CANNOT do for a project, and `doctor` reports
// exactly that, read-only, at the moment it matters; the edits it names land in
// files the project already owns (a metro.config.js with its own transformer, a
// Podfile with existing post_install logic), which is judgement, not
// templating, so an agent applies each one in the repo's own style.
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
