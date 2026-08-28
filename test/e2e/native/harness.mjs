// SHARED NATIVE-E2E HARNESS -- the pieces both native drivers stand on.
//
// Two executables live beside this file and neither owns these:
//   run-native-e2e.mjs   the LOOP suite (docs/field-test-protocol.md as code):
//                        create -> start -> build -> cache hit -> teardown.
//   run-cache-e2e.mjs    the CACHE suite: for every cache rn-iso supplies,
//                        prove it is ENGAGED, that it STORES, and that a second
//                        workspace REUSES it.
//
// Everything here was factored OUT of run-native-e2e.mjs unchanged: the fixture
// creation, the process wrappers, the cleanup checks, the diagnostics dump. It
// is shared rather than copied because the two suites must agree about what a
// fixture IS -- a cache suite that built a different app from the loop suite
// would be proving something about a different program.
//
// The one thing that is NOT shared is the assertions. Each suite owns its own,
// because that is the part a reader has to be able to read in one place.
//
// STYLE: no dependencies, Node ESM, ASCII only (CLAUDE.md). Every log line goes
// to STDERR so each suite's stdout stays free for one machine-readable line.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// ---- process helpers --------------------------------------------------------

// The four wrappers every step goes through, bound to one environment, one CLI
// path and one log label. A factory rather than module state because the two
// suites run with different labels and (in --home runs) different environments,
// and because a test double for any of them has somewhere to go.
export function createHarness({ env, cliPath, label }) {
  const log = (msg) => process.stderr.write(`[${label}] ${msg}\n`);
  const banner = (msg) => log('='.repeat(4) + ` ${msg} ` + '='.repeat(4));
  const die = (msg, code = 1) => {
    log(`ERROR: ${msg}`);
    process.exit(code);
  };

  // spawnSync with output both captured AND echoed to this process's stderr, so
  // a CI log shows progress while assertions still get the text.
  const sh = (file, argv, opts = {}) => {
    const r = spawnSync(file, argv, {
      cwd: opts.cwd,
      env: opts.env || env,
      encoding: 'utf-8',
      timeout: opts.timeout || 5 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const stdout = r.stdout || '';
    const stderr = r.stderr || '';
    if (stderr) process.stderr.write(stderr);
    if (r.error && !opts.allowFail) die(`${file} ${argv.join(' ')} could not run: ${r.error.message}`);
    const code = r.status ?? (r.signal ? 1 : 0);
    if (code !== 0 && !opts.allowFail)
      die(`${file} ${argv.slice(0, 3).join(' ')} exited ${code}:\n${lastLines(stderr, 40)}`);
    return { code, stdout, stderr };
  };

  const cli = (argv, opts = {}) => sh(process.execPath, [cliPath, ...argv], opts);

  const cliJson = (argv, opts = {}) => {
    const r = cli(argv, opts);
    if (r.code !== 0) throw new Error(`rn-iso ${argv.join(' ')} failed (exit ${r.code}):\n${lastLines(r.stderr, 40)}`);
    // The --json contract: exactly one parseable line on stdout.
    const line = r.stdout.trim().split('\n').findLast(Boolean);
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`rn-iso ${argv.join(' ')} did not emit a JSON line on stdout:\n${r.stdout}`);
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

// The CLI must run at all, and the platform's toolchain must be present.
// Toolchain absence is a SKIP exit code (2), not a failure -- a runner that
// scheduled the wrong variant should say so clearly rather than fail red.
export function preflight(h, platform) {
  const v = h.cli(['--version'], { allowFail: true });
  assert(v.code === 0, `rn-iso CLI does not run: ${v.stderr}`);
  h.log(`rn-iso ${v.stdout.trim()}`);
  if (platform === 'ios') {
    if (process.platform !== 'darwin') h.die('ios variant requires macOS + Xcode; this is not a macOS host.', 2);
    h.requireTool('xcrun', ['--version']);
    h.requireTool('xcodebuild', ['-version']);
  } else {
    // android: adb must be on PATH (the CI job sets this up via the
    // android-emulator-runner action + ANDROID_HOME). rn-iso creates and boots
    // its OWN owned AVD; it does not reuse the action's emulator.
    h.requireTool('adb', ['version']);
  }
  return v.stdout.trim();
}

// ---- fixture commands (version-sensitive, overridable) ----------------------

export const FIXTURE_COMMANDS = {
  // Bare RN via the community CLI. `--skip-git-init` because we init git
  // ourselves (with a remote); `--install-pods false` because rn-iso runs pod
  // install as part of `ios`. Override with RN_ISO_E2E_BARE_INIT if a newer CLI
  // changes the flags.
  bare(appDir) {
    if (process.env.RN_ISO_E2E_BARE_INIT) return withDir(process.env.RN_ISO_E2E_BARE_INIT, appDir);
    return [
      'npx',
      '--yes',
      '@react-native-community/cli@latest',
      'init',
      'RnIsoE2E',
      '--directory',
      appDir,
      '--skip-git-init',
      '--install-pods',
      'false',
      '--pm',
      'npm',
    ];
  },
  // Managed Expo via a MINIMAL template (blank), so rn-iso's `expo prebuild`
  // path is exercised on first build. Override with RN_ISO_E2E_EXPO_INIT.
  expo(appDir) {
    if (process.env.RN_ISO_E2E_EXPO_INIT) return withDir(process.env.RN_ISO_E2E_EXPO_INIT, appDir);
    return ['npx', '--yes', 'create-expo-app@latest', appDir, '--template', 'blank', '--no-install'];
  },
};

function withDir(tmplStr, appDir) {
  // Split a shell-ish override on whitespace and substitute {dir}. Kept simple:
  // the override is a trusted CI/reviewer value, not user input.
  return tmplStr
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (t === '{dir}' ? appDir : t));
}

// A freshly created app, committed, with a bare remote so `worktree remove`
// sees the branch tip as pushed (no --force needed).
//
// Both suites use an isolated RN_ISO_HOME so global runtime output never trips
// over fixture project files.
export function createFixture({ framework, workDir, h }) {
  const appDir = join(workDir, 'app');
  const cmd = FIXTURE_COMMANDS[framework](appDir);
  h.log(`creating ${framework} fixture: ${cmd.map(quote).join(' ')}`);
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: workDir, env: h.env, stdio: 'inherit', timeout: 20 * 60 * 1000 });
  if (r.status !== 0) h.die(`fixture creation failed (exit ${r.status ?? r.signal})`);
  assert(existsSync(join(appDir, 'package.json')), `fixture has no package.json at ${appDir}`);

  // rn-iso supplies @expo/fingerprint directly; fixtures do not install it into
  // the project dependency graph.
  if (framework === 'expo') {
    // create-expo-app ran with --no-install (its own install is flaky in CI),
    // so the fixture has no node_modules yet. Install now: `start`'s expo-child
    // needs `expo` resolvable (RN_ISO_EXPO_BIN otherwise), and worktree create
    // --carry-ignored only clones a node_modules that exists.
    const r2 = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: appDir,
      env: h.env,
      stdio: 'inherit',
      timeout: 15 * 60 * 1000,
    });
    if (r2.status !== 0) h.die('installing the expo fixture dependencies failed');
  }

  gitInitWithRemote({ appDir, workDir, framework, h });
  return appDir;
}

export function gitInitWithRemote({ appDir, workDir, framework, h }) {
  const remote = join(workDir, 'remote.git');
  h.sh('git', ['init', '-b', 'main', appDir]);
  const g = (a) => h.sh('git', ['-C', appDir, ...a]);
  g(['config', 'user.email', 'e2e@example.com']);
  g(['config', 'user.name', 'rn-iso native e2e']);
  g(['config', 'commit.gpgsign', 'false']);
  // Expo's blank template may have no .gitignore that ignores node_modules; make
  // sure the heavy dirs are ignored so the commit stays small and worktree
  // create can carry them as gitignored entries.
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
  // A MANAGED app's native dirs are `expo prebuild` output -- disposable and
  // conventionally gitignored. Left tracked, the prebuild inside the worktree
  // makes the tree dirty and `worktree remove` (correctly) refuses. Bare apps
  // keep ios/ and android/ tracked: they ARE the source.
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
    const add = `\n# rn-iso native e2e\n${missing.join('\n')}\n`;
    spawnSync('sh', ['-c', `printf '%s' ${quote(add)} >> ${quote(gi)}`], { stdio: 'inherit' });
  }
}

// ---- cleanup verification ---------------------------------------------------

// The protocol's five cleanup checks. `created` is every worktree path the
// driver made, which is what checks 3 and 5 are asserting the absence of.
export function verifyCleanup({ h, platform, appDir, created }) {
  h.banner('cleanup checks');

  // (1) no rn-iso-* devices remain.
  if (platform === 'ios') {
    const out = h.sh('xcrun', ['simctl', 'list', 'devices']).stdout;
    assert(!/rn-iso-/.test(out), 'an rn-iso-* simulator was left behind');
  } else {
    const out = h.sh('emulator', ['-list-avds'], { allowFail: true }).stdout;
    assert(!/rn-iso-/.test(out), 'an rn-iso-* AVD was left behind');
  }
  h.log('(1) no rn-iso-* devices remain');

  // (2) no supervisor/collector processes.
  const ps = h.sh('ps', ['ax'], { allowFail: true }).stdout;
  assert(!/rn-iso.*supervisor|supervisor\/run\.js/.test(ps), 'a supervisor process is still running');
  h.log('(2) no supervisor/collector processes');

  // (3) status no longer lists our workspaces.
  const status = h.cli(['status'], { allowFail: true }).stdout;
  assert(!created.some((p) => status.includes(p)), 'status still lists a removed workspace');
  h.log('(3) status is clean of our workspaces');

  // (4) main checkout unchanged.
  const porcelain = h.sh('git', ['-C', appDir, 'status', '--porcelain']).stdout.trim();
  assert(porcelain === '', `main checkout is dirty after the run:\n${porcelain}`);
  const wl = h.sh('git', ['-C', appDir, 'worktree', 'list']).stdout;
  assert(!/e2e-/.test(wl), `a worktree registration survived:\n${wl}`);
  h.log('(4) main checkout byte-clean, no worktrees linger');

  // (5) gc (report-only) finds nothing of ours orphaned.
  const gc = h.cli(['gc'], { allowFail: true });
  assert(!created.some((p) => gc.stdout.includes(p)), 'gc reports one of our workspaces as orphaned');
  h.log('(5) gc reports nothing of ours orphaned');
}

// ---- diagnostics ------------------------------------------------------------

// The most recent build-*.ndjson under a workspace, which is the on-disk
// transcript of what the build actually ran.
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
  const home = process.env.RN_ISO_HOME || join(process.env.HOME || '', '.rn-iso');
  return join(home, 'workspaces', `${slug}--${id}`, 'logs');
}

// Dump the tail of every worktree's build log on failure: the extracted
// diagnostic plus the raw transcript are what a triager needs, and CI throws the
// worktree away. e2e-native.yml also uploads these as artifacts.
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
    } catch {
      /* best effort */
    }
  }
}

// ---- measurement ------------------------------------------------------------
//
// THE REASON THIS FILE HAS A MEASUREMENT SECTION AT ALL. A cache that is
// configured but stores nothing looks exactly like a cache that works, from
// every angle except the directory it is supposed to be filling -- which is how
// the old Expo Metro store hook shipped through green CI (issue #73) and was caught only
// by measuring a directory. So "it seemed to work" is never evidence here: a
// file count before and a file count after is.

// Recursive count of REGULAR FILES under a directory, plus their total bytes.
// Missing directory is {files: 0, bytes: 0, exists: false} rather than an
// error: "the cache root was never created" is a measurement, and the most
// interesting one there is.
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
      continue; // a directory that vanished mid-walk is not an error here
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
      } catch {
        // Same reasoning as the readdir catch.
      }
    }
  }
  return out;
}

// before/after as one printable fact. `label` names the cache; the caller
// prints `describeGrowth(...)` verbatim as the evidence for a STORES claim.
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

// Every parseable record in an NDJSON log, in order. Unparseable lines are
// dropped rather than thrown on: the timeline is append-only from several
// writers and a torn last line is normal.
export function readNdjson(file) {
  if (!file || !existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // See above.
    }
  }
  return out;
}

// ---- small utils ------------------------------------------------------------

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
