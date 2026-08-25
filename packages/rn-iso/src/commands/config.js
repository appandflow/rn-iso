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
  getRepoSettings,
  setRepoSetting,
  unsetRepoSetting,
} from '../config.js';
import { gitCommonDir } from '../worktree.js';

// `.script` keys died with the `ios`/`android` build wrappers; `up` creates
// owned devices instead, so device-shape settings replace them.
const ALLOWED_KEYS = ['ios.deviceType', 'ios.runtime', 'android.systemImage'];

// Repo-layer settings additionally accept `worktreeDir`, `caches`, and any
// `worktree.*` key (baseRef, include, exclude) -- the set that `worktree
// create` and `gc`'s cache report resolve via resolveSettings. The prefix match is
// deliberately wider than that list: settings.js owns which keys are actually
// honoured, and warns by name about any that are not.
export function isAllowedRepoKey(key) {
  return ALLOWED_KEYS.includes(key) || key === 'worktreeDir' || key === 'caches' || key.startsWith('worktree.');
}

// Array-valued settings (`caches`, `worktree.include`) arrive on the command
// line as JSON text. Store them as real arrays/objects so resolveSettings
// hands consumers the shape they expect; scalar values (a device name, a
// runtime like "26.2") stay strings.
export function parseSettingValue(key, value) {
  const trimmed = String(value).trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`Value for ${key} looks like JSON but does not parse. Quote it as valid JSON, e.g. '["~/.myapp-metro-cache"]'.`);
  }
}

function readNestedValue(obj, dottedKey) {
  let cur = obj;
  for (const k of dottedKey.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

export default function configCommand(program) {
  program
    .command('config [key] [value]')
    .description(
      'Get or set a per-project setting. Allowed keys: ' + ALLOWED_KEYS.join(', ') +
      '. With no args, lists current settings. Pass --repo to operate on the repo-shared layer instead.'
    )
    .option('--unset', 'Remove the value for <key>')
    .option('--project <target>', 'Run against another project (label / unique basename / absolute path) instead of cwd')
    .option('--repo', 'Operate on the repo-shared settings layer (keyed by git common dir of cwd) instead of the project layer')
    .action((key, value, opts) => {
      if (opts.repo) {
        runRepo(key, value, opts);
        return;
      }

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

      setProjectSetting(found, key, value);
      console.log(chalk.green(`Set ${key} = ${value} for ${found}.`));
    });
}

function runRepo(key, value, opts) {
  const dir = gitCommonDir(process.cwd());
  if (!dir) {
    console.error(chalk.red('Not inside a git repository.'));
    process.exit(1);
    return;
  }

  if (!key) {
    const settings = getRepoSettings(dir);
    if (Object.keys(settings).length === 0) {
      console.log(chalk.dim(`No repo settings for ${dir}.`));
      return;
    }
    console.log(dir);
    console.log(JSON.stringify(settings, null, 2));
    return;
  }

  if (!isAllowedRepoKey(key)) {
    console.error(chalk.red(`Unknown key "${key}". Allowed: ${ALLOWED_KEYS.join(', ')}, worktreeDir, caches, worktree.*.`));
    process.exit(1);
    return;
  }

  if (opts.unset) {
    const removed = unsetRepoSetting(dir, key);
    if (removed) console.log(chalk.green(`Unset ${key} for repo ${dir}.`));
    else console.log(chalk.dim(`${key} was already unset.`));
    return;
  }

  if (value === undefined) {
    const cur = readNestedValue(getRepoSettings(dir), key);
    if (cur === undefined) console.log(chalk.dim('(unset)'));
    else console.log(typeof cur === 'object' ? JSON.stringify(cur) : cur);
    return;
  }

  let parsed;
  try {
    parsed = parseSettingValue(key, value);
  } catch (e) {
    console.error(chalk.red(String(e?.message || e)));
    process.exit(1);
    return;
  }
  setRepoSetting(dir, key, parsed);
  console.log(chalk.green(`Set ${key} = ${value} for repo ${dir}.`));
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
