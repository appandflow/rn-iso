#!/usr/bin/env node
import { Command } from 'commander';
import deviceCommand from '../src/commands/device.js';
import iosCommand from '../src/commands/ios.js';
import androidCommand from '../src/commands/android.js';
import startCommand from '../src/commands/start.js';
import stopCommand from '../src/commands/stop.js';
import logsCommand from '../src/commands/logs.js';
import statusCommand from '../src/commands/status.js';
import releaseCommand from '../src/commands/release.js';
import shutdownCommand from '../src/commands/shutdown.js';

const program = new Command();
program
  .name('rn-iso')
  .description('Isolated React Native dev environments per project/worktree')
  .version('0.1.0');

deviceCommand(program);
iosCommand(program);
androidCommand(program);
startCommand(program);
stopCommand(program);
logsCommand(program);
statusCommand(program);
releaseCommand(program);
shutdownCommand(program);

program.parse();
