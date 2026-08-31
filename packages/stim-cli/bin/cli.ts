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
program.name('stim').description('Isolated React Native dev environments per project/worktree').version(pkg.version);

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

try {
  await program.parseAsync();
} catch (err) {
  if ((err as { code?: string })?.code === 'STIM_CONFIG_CORRUPT') {
    console.error((err as Error).message);
    process.exit(1);
  }
  throw err;
}
