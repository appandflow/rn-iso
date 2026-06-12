#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import deviceCommand from '../src/commands/device.js';
import iosCommand from '../src/commands/ios.js';
import androidCommand from '../src/commands/android.js';
import startCommand from '../src/commands/start.js';
import stopCommand from '../src/commands/stop.js';
import logsCommand from '../src/commands/logs.js';
import statusCommand from '../src/commands/status.js';
import releaseCommand from '../src/commands/release.js';
import reserveCommand from '../src/commands/reserve.js';
import unreserveCommand from '../src/commands/unreserve.js';
import shutdownCommand from '../src/commands/shutdown.js';
import configCommand from '../src/commands/config.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

const program = new Command();
program
  .name('rn-iso')
  .description('Isolated React Native dev environments per project/worktree')
  .version(pkg.version);

deviceCommand(program);
iosCommand(program);
androidCommand(program);
startCommand(program);
stopCommand(program);
logsCommand(program);
statusCommand(program);
releaseCommand(program);
reserveCommand(program);
unreserveCommand(program);
shutdownCommand(program);
configCommand(program);

program.parse();
