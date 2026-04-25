#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();
program
  .name('rn-iso')
  .description('Isolated React Native dev environments per project/worktree')
  .version('0.1.0');

program.parse();
