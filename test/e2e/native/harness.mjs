import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export function createHarness({ env, cliPath, label }) {
  const log = (msg) => process.stderr.write(`[${label}] ${msg}\n`);
  const banner = (msg) => log('='.repeat(4) + ` ${msg} ` + '='.repeat(4));
  const die = (msg, code = 1) => {
    log(`ERROR: ${msg}`);
    process.exit(code);
  };

  const sh = (file, argv, opts = {}) => {
    const r = spawnSync(file, argv, {
      cwd: opts.cwd,
      env: opts.env || env,
      encoding: 'utf-8',
      timeout: opts.timeout || 5 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const stdout = r.stdout || '';
    const stderr = r.stderr || r.error?.message || '';
    if (stderr) process.stderr.write(stderr);
    if (r.error && !opts.allowFail) die(`${file} ${argv.join(' ')} could not run: ${r.error.message}`);
    const code = r.status ?? (r.signal || r.error ? 1 : 0);
    if (code !== 0 && !opts.allowFail)
      die(`${file} ${argv.slice(0, 3).join(' ')} exited ${code}:\n${lastLines(stderr, 40)}`);
    return { code, stdout, stderr };
  };

  const cli = (argv, opts = {}) => sh(process.execPath, [cliPath, ...argv], opts);

  const cliJson = (argv, opts = {}) => {
    const r = cli(argv, opts);
    if (r.code !== 0) throw new Error(`stim ${argv.join(' ')} failed (exit ${r.code}):\n${lastLines(r.stderr, 40)}`);
    const line = r.stdout.trim().split('\n').findLast(Boolean);
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`stim ${argv.join(' ')} did not emit a JSON line on stdout:\n${r.stdout}`);
    }
  };

  const requireTool = (file, argv) => {
    const r = sh(file, argv, { allowFail: true });
    if (r.code !== 0 && r.stderr && /not found|ENOENT/i.test(r.stderr)) {
      die(`required tool "${file}" is not available on this runner`, 2);
    }
  };

  return { env, cliPath, label, log, banner, die, sh, cli, cliJson, requireTool };
}

export function preflight(h, platform) {
  const v = h.cli(['--version'], { allowFail: true });
  assert(v.code === 0, `stim CLI does not run: ${v.stderr}`);
  h.log(`stim ${v.stdout.trim()}`);
  if (platform === 'ios') {
    if (process.platform !== 'darwin') h.die('ios variant requires macOS + Xcode; this is not a macOS host.', 2);
    h.requireTool('xcrun', ['--version']);
    h.requireTool('xcodebuild', ['-version']);
  } else {
    h.requireTool('adb', ['version']);
  }
  return v.stdout.trim();
}

export const FIXTURE_COMMANDS = {
  bare(appDir) {
    if (process.env.STIM_E2E_BARE_INIT) return withDir(process.env.STIM_E2E_BARE_INIT, appDir);
    return [
      'npx',
      '--yes',
      '@react-native-community/cli@latest',
      'init',
      'StimE2E',
      '--directory',
      appDir,
      '--skip-git-init',
      '--install-pods',
      'false',
      '--pm',
      'npm',
    ];
  },
  expo(appDir) {
    if (process.env.STIM_E2E_EXPO_INIT) return withDir(process.env.STIM_E2E_EXPO_INIT, appDir);
    return ['npx', '--yes', 'create-expo-app@latest', appDir, '--template', 'blank', '--no-install'];
  },
};

function withDir(tmplStr, appDir) {
  return tmplStr
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (t === '{dir}' ? appDir : t));
}

export function createFixture({ framework, platform, workDir, h }) {
  const appDir = join(workDir, 'app');
  const cmd = FIXTURE_COMMANDS[framework](appDir);
  h.log(`creating ${framework} fixture: ${cmd.map(quote).join(' ')}`);
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: workDir, env: h.env, stdio: 'inherit', timeout: 20 * 60 * 1000 });
  if (r.status !== 0) h.die(`fixture creation failed (exit ${r.status ?? r.signal})`);
  assert(existsSync(join(appDir, 'package.json')), `fixture has no package.json at ${appDir}`);

  if (framework === 'expo') {
    const r2 = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: appDir,
      env: h.env,
      stdio: 'inherit',
      timeout: 15 * 60 * 1000,
    });
    if (r2.status !== 0) h.die('installing the expo fixture dependencies failed');
  }

  if (framework === 'bare' && platform === 'ios') {
    // The Gemfile pins cocoapods/activesupport, and installing the fixture's
    // pods outside bundler both dodges those pins and trips RubyGems'
    // Gemfile-aware activation under rvm (#133).
    h.log('installing the bare iOS fixture pods (bundler, per the template) before its initial commit');
    const rb = spawnSync('bundle', ['install'], {
      cwd: appDir,
      env: h.env,
      stdio: 'inherit',
      timeout: 20 * 60 * 1000,
    });
    if (rb.status !== 0) {
      h.die(
        `bundle install failed for the bare iOS fixture (exit ${rb.status ?? rb.signal}${rb.error ? `: ${rb.error.message}` : ''}); ` +
          'its Gemfile pins the pods toolchain, so the fixture cannot be prepared without it',
      );
    }
    const r2 = spawnSync('bundle', ['exec', 'pod', 'install'], {
      cwd: join(appDir, 'ios'),
      env: h.env,
      stdio: 'inherit',
      timeout: 20 * 60 * 1000,
    });
    if (r2.status !== 0) {
      h.die(
        `installing the bare iOS fixture pods failed (exit ${r2.status ?? r2.signal}${r2.error ? `: ${r2.error.message}` : ''})`,
      );
    }
  }

  if (framework === 'expo' && platform === 'ios') {
    h.log('preparing the disposable Expo iOS fixture and Pods before its initial commit');
    h.sh('npx', ['--no-install', 'expo', 'prebuild', '--platform', 'ios'], { cwd: appDir, timeout: 20 * 60 * 1000 });
    assertMatchingPods(appDir);
  }

  gitInitWithRemote({ appDir, workDir, framework, h });
  return appDir;
}

export function createWarmWorktree({ h, sourceDir, workDir, name, created }) {
  const path = join(workDir, name);
  const added = h.sh('git', ['-C', sourceDir, 'worktree', 'add', '--detach', path, 'HEAD'], { allowFail: true });
  assert(added.code === 0, `git worktree add failed: ${added.stderr}`);
  created.push(path);
  assert(existsSync(path), `git worktree add did not create ${path}`);
  const warmed = h.cli(['worktree', 'warm'], { cwd: path, allowFail: true });
  assert(warmed.code === 0, `warming ${path} failed: ${warmed.stderr}`);
  h.log(`worktree ${name} (from ${sourceDir}) -> ${path}`);
  return path;
}

export function assertMatchingPods(appDir) {
  const lock = join(appDir, 'ios', 'Podfile.lock');
  const manifest = join(appDir, 'ios', 'Pods', 'Manifest.lock');
  assert(
    existsSync(lock) && existsSync(manifest),
    `Pods reuse requires Podfile.lock and Pods/Manifest.lock at ${appDir}`,
  );
  assert(
    readFileSync(lock, 'utf-8') === readFileSync(manifest, 'utf-8'),
    `Pods/Manifest.lock differs from Podfile.lock at ${appDir}`,
  );
}

export function gitInitWithRemote({ appDir, workDir, framework, h }) {
  const remote = join(workDir, 'remote.git');
  h.sh('git', ['init', '-b', 'main', appDir]);
  const g = (a) => h.sh('git', ['-C', appDir, ...a]);
  g(['config', 'user.email', 'e2e@example.com']);
  g(['config', 'user.name', 'stim-cli native e2e']);
  g(['config', 'commit.gpgsign', 'false']);
  ensureGitignore({ appDir, framework });
  g(['add', '-A']);
  g(['commit', '-m', `${framework} native e2e fixture`]);
  h.sh('git', ['init', '--bare', '-b', 'main', remote]);
  g(['remote', 'add', 'origin', remote]);
  g(['push', '-u', 'origin', 'main']);
  g(['remote', 'set-head', 'origin', 'main']);
}

export function ensureGitignore({ appDir, framework }) {
  const gi = join(appDir, '.gitignore');
  const needed = ['node_modules/', 'ios/Pods/', 'ios/build/', 'android/.gradle/', 'android/app/build/'];
  if (framework === 'expo') needed.push('ios/', 'android/');
  let text = existsSync(gi) ? readFileSync(gi, 'utf-8') : '';
  const missing = needed.filter(
    (n) =>
      !text
        .split('\n')
        .map((l) => l.trim())
        .includes(n.replace(/\/$/, '')) && !text.includes(n),
  );
  if (missing.length) {
    const add = `\n# stim-cli native e2e\n${missing.join('\n')}\n`;
    spawnSync('sh', ['-c', `printf '%s' ${quote(add)} >> ${quote(gi)}`], { stdio: 'inherit' });
  }
}

export function createCleanupTracker({ h, platform, processExitTimeoutMs = 5000 }) {
  const devices = new Set();
  const processes = new Map();

  function recordBuild(facts) {
    const id = platform === 'ios' ? facts.udid : facts.avdName;
    assert(typeof id === 'string' && id.length > 0, `the ${platform} build did not identify its device`);
    devices.add(id);
  }

  function recordWorkspace(cwd) {
    let device;
    try {
      const config = JSON.parse(readFileSync(join(h.env.STIM_HOME, 'config.json'), 'utf-8'));
      device = config.projects?.[resolve(cwd)]?.platforms?.[platform];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (device?.owned === true) recordBuild({ udid: device.deviceUdid, avdName: device.avdName });

    let state;
    try {
      state = JSON.parse(readFileSync(join(workspaceLogsDir(cwd), '..', 'state.json'), 'utf-8'));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const records = [
      state.supervisor,
      { pid: state.supervisor?.serverPid, startedAt: state.supervisor?.startedAt },
      ...Object.values(state.collectors ?? {}),
    ].filter(Boolean);
    const live = processSnapshot(h);
    for (const record of records) {
      if (!Number.isInteger(record.pid) || record.pid <= 0) continue;
      const key = JSON.stringify([cwd, record.pid, record.startedAt]);
      if (!processes.has(key)) processes.set(key, live.get(record.pid));
    }
  }

  function remainingDevices() {
    const ids =
      platform === 'ios'
        ? Object.values(JSON.parse(inspect(h, 'xcrun', ['simctl', 'list', 'devices', '--json'])).devices)
            .flat()
            .map((device) => device.udid)
        : inspect(h, 'emulator', ['-list-avds'])
            .split('\n')
            .map((name) => name.trim());
    return ids.filter((id) => devices.has(id));
  }

  async function verifyProcesses() {
    const deadline = Date.now() + processExitTimeoutMs;
    while (true) {
      const live = new Set(processSnapshot(h).values());
      const leaked = [...processes.values()].filter((identity) => live.has(identity));
      if (leaked.length === 0) return;
      assert(Date.now() < deadline, `a workspace process is still running:\n${leaked.join('\n')}`);
      await sleep(Math.min(100, deadline - Date.now()));
    }
  }

  return { recordBuild, recordWorkspace, remainingDevices, verifyProcesses };
}

function inspect(h, file, argv) {
  const result = h.sh(file, argv, { allowFail: true, timeout: 5000 });
  assert(result.code === 0, `could not inspect ${file}: ${result.stderr}`);
  return result.stdout;
}

function processSnapshot(h) {
  const out = inspect(h, 'ps', ['-ax', '-o', 'pid=,lstart=,command=']);
  return new Map(
    out
      .split('\n')
      .map((line) => /^\s*(\d+)\s+(.+)$/.exec(line))
      .filter(Boolean)
      .map((match) => [Number(match[1]), match[0].trim()]),
  );
}

export async function verifyCleanup({ h, cleanup, appDir, created }) {
  h.banner('cleanup checks');

  const devices = cleanup.remainingDevices();
  assert(devices.length === 0, `a device from this run was left behind: ${devices.join(', ')}`);
  h.log('(1) no devices from this run remain');

  await cleanup.verifyProcesses();
  h.log('(2) no workspace supervisor/Metro/collector processes remain');

  const status = h.cli(['status'], { allowFail: true }).stdout;
  assert(!created.some((p) => status.includes(p)), 'status still lists a removed workspace');
  h.log('(3) status is clean of our workspaces');

  const porcelain = h.sh('git', ['-C', appDir, 'status', '--porcelain']).stdout.trim();
  assert(porcelain === '', `main checkout is dirty after the run:\n${porcelain}`);
  const wl = h.sh('git', ['-C', appDir, 'worktree', 'list', '--porcelain']).stdout;
  const registered = new Set(
    wl
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length)),
  );
  assert(!created.some((path) => registered.has(resolve(path))), `a worktree registration survived:\n${wl}`);
  h.log('(4) main checkout byte-clean, no worktrees linger');

  const gc = h.cli(['gc'], { allowFail: true });
  assert(!created.some((p) => gc.stdout.includes(p)), 'gc reports one of our workspaces as orphaned');
  h.log('(5) gc reports nothing of ours orphaned');
}

export function buildLog(cwd) {
  const dir = workspaceLogsDir(cwd);
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((f) => /^build-.*\.ndjson$/.test(f))
    .map((f) => join(dir, f));
  return candidates.toSorted((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] || null;
}

export function workspaceLogsDir(cwd) {
  const canonical = resolve(cwd);
  const slug =
    basename(canonical)
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 48) || 'workspace';
  const id = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  const home = process.env.STIM_HOME || join(process.env.HOME || '', '.stim');
  return join(home, 'workspaces', `${slug}--${id}`, 'logs');
}

export function dumpDiagnostics(h, created) {
  h.banner('DIAGNOSTICS (build log tails)');
  for (const wt of created) {
    const logPath = buildLog(wt);
    if (!logPath) {
      h.log(`no build log under ${wt}`);
      continue;
    }
    h.log(`--- ${logPath} (tail) ---`);
    process.stderr.write(lastLines(readFileSync(logPath, 'utf-8'), 60) + '\n');
  }
}

export function cleanupTmp(dirs) {
  for (const dir of dirs.filter(Boolean)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

export function dirStats(dir) {
  const out = { dir, exists: existsSync(dir), files: 0, bytes: 0 };
  if (!out.exists) return out;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const path = join(current, e.name);
      if (e.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!e.isFile()) continue;
      out.files += 1;
      try {
        out.bytes += statSync(path).size;
      } catch {}
    }
  }
  return out;
}

export function topFileNames(dir, { matching } = {}) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && (!matching || matching.test(e.name)))
    .map((e) => e.name);
}

export function growth(label, before, after) {
  return {
    label,
    before: before.files,
    after: after.files,
    added: after.files - before.files,
    bytesBefore: before.bytes,
    bytesAfter: after.bytes,
    bytesAdded: after.bytes - before.bytes,
    dir: after.dir,
  };
}

export function describeGrowth(g) {
  return `${g.label}: ${g.before} files -> ${g.after} files (${g.added >= 0 ? '+' : ''}${g.added}, ${formatBytes(
    g.bytesAdded,
  )}) at ${g.dir}`;
}

export function formatBytes(n) {
  const bytes = Number(n) || 0;
  const sign = bytes < 0 ? '-' : '';
  let value = Math.abs(bytes);
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${sign}${i === 0 ? value : value.toFixed(1)}${units[i]}`;
}

export function readNdjson(file) {
  if (!file || !existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

export function lastLines(s, n) {
  return String(s || '')
    .split('\n')
    .slice(-n)
    .join('\n');
}

export function quote(s) {
  return /[^\w./@:{}-]/.test(s) ? `'${String(s).replace(/'/g, "'\\''")}'` : String(s);
}

export function resolvePath(p) {
  return resolve(p);
}
