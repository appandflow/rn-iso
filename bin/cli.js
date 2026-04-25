#!/usr/bin/env node
import { Command } from 'commander';
import deviceCommand from '../src/commands/device.js';

const program = new Command();
program
  .name('rn-iso')
  .description('Isolated React Native dev environments per project/worktree')
  .version('0.1.0');

deviceCommand(program);

program.parse();
