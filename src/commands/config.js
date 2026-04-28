// src/commands/config.js
import chalk from 'chalk';
import {
  findProjectRoot,
  resolveRegisteredProject,
  detectIsExpo,
  detectBundleId,
  detectAndroidPackage,
} from '../project.js';
import {
  getProject,
  upsertProject,
  getProjectSettings,
  getProjectSetting,
  setProjectSetting,
  unsetProjectSetting,
} from '../config.js';

const ALLOWED_KEYS = ['packageManager', 'ios.script', 'android.script'];
const PM_VALUES = ['npm', 'yarn', 'pnpm', 'bun'];

export default function configCommand(program) {
  program
    .command('config [key] [value]')
    .description(
      'Get or set a per-project setting. Allowed keys: ' + ALLOWED_KEYS.join(', ') +
      '. With no args, lists current settings.'
    )
    .option('--unset', 'Remove the value for <key>')
    .option('--project <target>', 'Run against another project (label / unique basename / absolute path) instead of cwd')
    .action((key, value, opts) => {
      const found = resolveTarget(opts.project);

      if (!key) {
        const settings = getProjectSettings(found);
        if (Object.keys(settings).length === 0) {
          console.log(chalk.dim(`No settings for ${found}.`));
          return;
        }
        console.log(found);
        for (const k of ALLOWED_KEYS) {
          const v = getProjectSetting(found, k);
          if (v !== undefined) console.log(`  ${k} = ${chalk.cyan(v)}`);
        }
        return;
      }

      if (!ALLOWED_KEYS.includes(key)) {
        console.error(chalk.red(`Unknown key "${key}". Allowed: ${ALLOWED_KEYS.join(', ')}.`));
        process.exit(1);
      }

      if (opts.unset) {
        const removed = unsetProjectSetting(found, key);
        if (removed) console.log(chalk.green(`Unset ${key} for ${found}.`));
        else console.log(chalk.dim(`${key} was already unset.`));
        return;
      }

      if (value === undefined) {
        const cur = getProjectSetting(found, key);
        if (cur === undefined) console.log(chalk.dim('(unset)'));
        else console.log(cur);
        return;
      }

      if (key === 'packageManager' && !PM_VALUES.includes(value)) {
        console.error(chalk.red(`Invalid packageManager "${value}". Must be one of: ${PM_VALUES.join(', ')}.`));
        process.exit(1);
      }

      setProjectSetting(found, key, value);
      console.log(chalk.green(`Set ${key} = ${value} for ${found}.`));
    });
}

// `--project` targets an existing registered project; without it we fall
// back to the cwd and auto-register if needed (so users can configure a
// project before running `ios` / `android` for the first time).
function resolveTarget(projectArg) {
  if (projectArg) {
    const { found, error } = resolveRegisteredProject(projectArg);
    if (!found) {
      console.error(chalk.red(error));
      process.exit(1);
    }
    return found;
  }
  const root = findProjectRoot(process.cwd());
  if (!root) {
    console.error(chalk.red('Not in a React Native project (no package.json found).'));
    process.exit(1);
  }
  if (!getProject(root)) {
    upsertProject(root, {
      bundleId: detectBundleId(root),
      androidPackage: detectAndroidPackage(root),
      isExpo: detectIsExpo(root),
    });
  }
  return root;
}
