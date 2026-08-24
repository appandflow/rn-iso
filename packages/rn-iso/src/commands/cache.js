import chalk from 'chalk';
import { register, unregister } from '../cache-manifest.js';
import { declaredCachePaths, discoverCaches, sizeCaches } from '../caches.js';
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
    .option('--entries-depth <n>', 'how many levels below the directory the entries sit (default 1). Pass 2 for a root holding a layer of grouping directories, such as a Metro FileStore (256 shards) or a build cache keyed <platform>/<key>.', v => parseInt(v, 10))
    .option('--note <note>', 'why it exists, shown in reports')
    .action((dir, opts) => {
      const record = register({
        dir,
        name: opts.name,
        prune: opts.atomic ? 'atomic' : 'entries',
        entriesDepth: opts.entriesDepth,
        note: opts.note,
      });
      console.log(chalk.green(`Registered ${record.name} -> ${record.dir}`));
      if (record.prune === 'atomic') {
        console.log(chalk.dim('  Will be emptied whole; --older-than will leave it alone.'));
        return;
      }
      console.log(chalk.dim('  Entries can be trimmed individually with `gc --caches --delete --older-than <days>`.'));
      console.log(chalk.dim(record.entriesDepth === 1
        ? `  An entry is a direct child of ${record.dir}. Pass --entries-depth if they sit deeper.`
        : `  An entry is ${record.entriesDepth} levels below ${record.dir}.`));
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
    .description('Show every shared cache gc knows about, registered or detected, and its size')
    // The same set `gc --caches` acts on. Listing only the registered ones said
    // "No caches registered" on a machine carrying gigabytes of Xcode CAS and
    // Metro file maps, which reads as "there is nothing here".
    .action(() => {
      const caches = sizeCaches(discoverCaches({ declared: declaredCachePaths() }));
      if (!caches.length) {
        console.log(chalk.dim('No caches registered or detected.'));
        console.log(chalk.dim('A project registers its own with `rn-iso cache register <dir>`.'));
        return;
      }
      for (const c of caches) {
        const tag = c.source === 'registered' ? 'registered' : 'detected';
        console.log(`${formatBytes(c.bytes).padStart(10)}  ${c.name} ${chalk.dim(`(${tag})`)}`);
        console.log(chalk.dim(`            ${c.dir}`));
      }
      console.log(chalk.dim(`  total: ${formatBytes(caches.reduce((n, c) => n + c.bytes, 0))}`));
      console.log(chalk.dim('  registered: a project described it. detected: rn-iso recognised its shape.'));
    });
}
