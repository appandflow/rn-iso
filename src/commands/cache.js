import chalk from 'chalk';
import { register, registeredCaches, unregister } from '../cache-manifest.js';
import { sizeCaches } from '../caches.js';
import { formatBytes } from '../artifacts.js';

export default function cacheCommand(program) {
  const cache = program
    .command('cache')
    .description('Register the shared build caches a project creates, so `gc --caches` and `doctor` can see them');

  cache
    .command('register <dir>')
    .description('Record a shared cache directory. Idempotent: registering the same directory again updates it.')
    .option('--name <name>', 'what to call it in reports')
    .option('--atomic', 'the cache indexes its own data, so it can only be emptied whole, never trimmed entry by entry')
    .option('--note <note>', 'why it exists, shown in reports')
    .action((dir, opts) => {
      const record = register({
        dir,
        name: opts.name,
        prune: opts.atomic ? 'atomic' : 'entries',
        note: opts.note,
      });
      console.log(chalk.green(`Registered ${record.name} -> ${record.dir}`));
      console.log(chalk.dim(record.prune === 'atomic'
        ? '  Will be emptied whole; --older-than will leave it alone.'
        : '  Entries can be trimmed individually with `gc --caches --delete --older-than <days>`.'));
    });

  cache
    .command('forget <dir>')
    .description('Remove a directory from the registry. Does not delete anything on disk.')
    .action((dir) => {
      if (unregister(dir)) console.log(chalk.green(`Forgot ${dir}`));
      else {
        console.error(chalk.yellow(`${dir} was not registered.`));
        process.exitCode = 1;
      }
    });

  cache
    .command('list')
    .description('Show the registered caches and their sizes')
    .action(() => {
      const caches = sizeCaches(registeredCaches());
      if (!caches.length) {
        console.log(chalk.dim('No caches registered.'));
        console.log(chalk.dim('A project registers its own with `rn-iso cache register <dir>`.'));
        return;
      }
      for (const c of caches) {
        console.log(`${formatBytes(c.bytes).padStart(10)}  ${c.name}`);
        console.log(chalk.dim(`            ${c.dir}`));
      }
      console.log(chalk.dim(`  total: ${formatBytes(caches.reduce((n, c) => n + c.bytes, 0))}`));
    });
}
