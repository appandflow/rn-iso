import chalk from 'chalk';
import { existsSync } from 'fs';
import { findProjectRoot } from '../project.js';
import { cacheRoot, fingerprintProject, loadFingerprinter, resolveBuild, storeBuild } from '../build-cache.js';
import { formatBytes } from '../artifacts.js';
import { directorySize } from '../artifacts.js';

const PLATFORMS = new Set(['ios', 'android']);

function project() {
  const root = findProjectRoot(process.cwd());
  if (!root) {
    console.error(chalk.red('Not in a React Native project (no package.json found).'));
    process.exitCode = 1;
    return null;
  }
  return root;
}

function requirePlatform(platform) {
  if (PLATFORMS.has(platform)) return true;
  console.error(chalk.red(`--platform must be ios or android, got "${platform}".`));
  process.exitCode = 1;
  return false;
}

// Missing @expo/fingerprint is the one failure worth explaining: it is what
// computes the key, it is not an rn-iso dependency, and an Expo project already
// has it.
function fingerprinterMissing(root) {
  console.error(chalk.red('@expo/fingerprint is not installed.'));
  console.error(chalk.dim(`  It computes the cache key from ${root}/ios and android.`));
  console.error(chalk.dim('  npm i -D @expo/fingerprint'));
  process.exitCode = 1;
}

export default function buildCacheCommand(program) {
  const cache = program
    .command('build-cache')
    .description('A build cache for projects with no provider hook: ask whether a build already exists for what is on disk, and store one when you have made it. Never builds anything.');

  cache
    .command('resolve')
    .description('Print the path of a cached build matching the current native fingerprint. Prints nothing and exits 1 on a miss, so `APP=$(... ) || build` works.')
    .requiredOption('--platform <platform>', 'ios or android')
    .action(async opts => {
      if (!requirePlatform(opts.platform)) return;
      const root = project();
      if (!root) return;
      if (!loadFingerprinter(root)) return fingerprinterMissing(root);

      const hash = await fingerprintProject(root);
      if (!hash) {
        console.error(chalk.red('Could not fingerprint this project.'));
        process.exitCode = 1;
        return;
      }

      const hit = resolveBuild(opts.platform, hash);
      if (!hit) {
        // stdout stays empty on a miss so `$(...)` is falsy; the explanation
        // goes to stderr like every other status line in this CLI.
        console.error(chalk.dim(`No cached ${opts.platform} build for ${hash.slice(0, 12)}.`));
        process.exitCode = 1;
        return;
      }
      console.error(chalk.green(`Cached ${opts.platform} build for ${hash.slice(0, 12)}`));
      // stdout carries ONLY the path: this is meant to be captured.
      console.log(hit);
    });

  cache
    .command('store')
    .description('Store a build you just made under the current native fingerprint.')
    .requiredOption('--platform <platform>', 'ios or android')
    .requiredOption('--path <path>', 'the .app or .apk to store')
    .action(async opts => {
      if (!requirePlatform(opts.platform)) return;
      const root = project();
      if (!root) return;
      if (!existsSync(opts.path)) {
        console.error(chalk.red(`Nothing at ${opts.path}.`));
        process.exitCode = 1;
        return;
      }
      if (!loadFingerprinter(root)) return fingerprinterMissing(root);

      const hash = await fingerprintProject(root);
      if (!hash) {
        console.error(chalk.red('Could not fingerprint this project.'));
        process.exitCode = 1;
        return;
      }

      try {
        const stored = storeBuild(opts.platform, hash, opts.path);
        console.error(chalk.green(`Stored ${opts.platform} build for ${hash.slice(0, 12)}`));
        console.log(stored);
      } catch (e) {
        console.error(chalk.red(String(e?.message || e)));
        process.exitCode = 1;
      }
    });

  cache
    .command('path')
    .description('Print the cache root, so a script can inspect or clear it directly.')
    .action(() => {
      const root = cacheRoot();
      console.error(chalk.dim(existsSync(root) ? `${formatBytes(directorySize(root))} in` : 'not created yet:'));
      console.log(root);
    });
}
