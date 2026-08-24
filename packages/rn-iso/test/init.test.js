import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPackageManager, projectFacts, renderDevScript, renderWorkflow, renderWorktreeExclude, runScript } from '../src/init.js';

const expoApp = { pkg: { name: 'demo', dependencies: { expo: '~57.0.0', 'react-native': '0.86.2' } } };
const bareApp = { pkg: { name: 'bare', dependencies: { 'react-native': '0.86.2' } } };

test('an Expo project and a bare one get different run commands', () => {
  assert.equal(projectFacts(expoApp).runCommand, 'npx expo run:ios');
  assert.equal(projectFacts(bareApp).runCommand, 'npx react-native run-ios');
});

test('the SDK major is read from the expo range, and absent for a bare project', () => {
  assert.equal(projectFacts(expoApp).sdkMajor, 57);
  assert.equal(projectFacts(bareApp).sdkMajor, null);
  assert.equal(projectFacts(bareApp).isExpo, false);
});

// The build cache key moved when the setting left experiments, and naming the
// wrong one produces a silent no-op -- so the generated document has to name the
// one this SDK actually reads.
test('the workflow names the build cache key this SDK reads', () => {
  const sdk53 = renderWorkflow(projectFacts({ pkg: { dependencies: { expo: '~53.0.0' } } }));
  assert.match(sdk53, /expo\.experiments\.buildCacheProvider/);

  const sdk57 = renderWorkflow(projectFacts(expoApp));
  assert.match(sdk57, /expo\.buildCacheProvider/);
  assert.doesNotMatch(sdk57, /expo\.experiments\.buildCacheProvider.*Point/s);
});

// A bare project has no provider hook at all, so telling it where to put a key
// would be nonsense; it gets the CLI route instead.
test('a bare project is given the CLI build cache route, not an Expo provider', () => {
  const doc = renderWorkflow(projectFacts(bareApp));
  assert.match(doc, /rn-iso build-cache resolve/);
  assert.doesNotMatch(doc, /buildCacheProvider/);
  assert.match(doc, /@expo\/fingerprint/, 'it still needs the fingerprinter, which works on a bare project');
});

// The dev client is the difference between a reserved port working and a red
// screen, so an Expo project without it must be told first, not reassured.
test('an Expo project without the dev client is told to install it before anything else', () => {
  const doc = renderWorkflow(projectFacts(expoApp));
  assert.match(doc, /Install `expo-dev-client` before anything else/);
});

test('an Expo project that already has the dev client is told why it matters instead', () => {
  const doc = renderWorkflow(projectFacts({
    pkg: { dependencies: { expo: '~57.0.0', 'expo-dev-client': '~57.0.0' } },
  }));
  assert.doesNotMatch(doc, /Install `expo-dev-client` before/);
  assert.match(doc, /only reaches the app because/);
});

// A bare project cannot use the dev client route, and compiling the port in
// would poison a fingerprint-keyed cache -- so it is steered to the runtime one.
test('a bare project is steered to the runtime port override, with the reason', () => {
  const doc = renderWorkflow(projectFacts(bareApp));
  assert.match(doc, /RCT_jsLocation/);
  assert.match(doc, /does not include the port/, 'the reason has to survive, or someone will compile it in');
});

test('every generated workflow warns about --no-bundler, which is the easy mistake', () => {
  for (const facts of [projectFacts(expoApp), projectFacts(bareApp)]) {
    assert.match(renderWorkflow(facts), /--no-bundler/);
  }
});

test('the worktree exclude file is patterns and comments only', () => {
  const lines = renderWorktreeExclude().split('\n').filter(l => l.trim() && !l.startsWith('#'));
  assert.ok(lines.length > 0);
  assert.ok(lines.every(l => !l.includes(' ')), 'a pattern with a space in it would not match anything');
});

// The middle of the loop is a sequence, and getting the order wrong fails in
// ways that do not name themselves -- build before Metro answers and the app
// opens on a red screen.
test('the dev script waits for Metro to answer before running the build', () => {
  const script = renderDevScript(projectFacts(expoApp));
  const bundlerAt = script.indexOf('expo start');
  const readyAt = script.indexOf('packager-status:running', bundlerAt);
  const runAt = script.indexOf('expo run:ios');
  assert.ok(bundlerAt !== -1 && readyAt !== -1 && runAt !== -1);
  assert.ok(readyAt < runAt, 'readiness must be established before the build starts');
});

test('the dev script polls rather than sleeping a fixed amount', () => {
  const script = renderDevScript(projectFacts(expoApp));
  assert.match(script, /for _ in \$\(seq/);
});

// --no-bundler is the mistake this script exists partly to prevent, so it must
// not appear in an actual command -- only in the comment warning about it.
test('no generated command uses --no-bundler', () => {
  for (const facts of [projectFacts(expoApp), projectFacts(bareApp)]) {
    const commands = renderDevScript(facts)
      .split('\n')
      .filter(l => l.trim() && !l.trim().startsWith('#'));
    assert.equal(commands.filter(l => l.includes('--no-bundler')).length, 0);
  }
});

// A bare app has no dev client to receive the deep link, and compiling the port
// in would poison a fingerprint-keyed build cache.
test('only the bare script points the app at the bundler at runtime', () => {
  assert.match(renderDevScript(projectFacts(bareApp)), /RCT_jsLocation/);
  assert.doesNotMatch(renderDevScript(projectFacts(expoApp)), /RCT_jsLocation/);
});

// The port is what `up --json` and `status` both report, so a log named after it
// can be found again without anything having to remember where it went.
test('the Metro log is named after the port', () => {
  assert.match(renderDevScript(projectFacts(expoApp)), /rn-iso-metro-\$\{PORT\}\.log/);
});

// The packageManager field is the declared answer and corepack enforces it, so
// it outranks a lockfile that may just be stale.
test('the packageManager field beats a lockfile, and a lockfile beats the default', () => {
  assert.equal(detectPackageManager({ files: ['yarn.lock'], packageManagerField: 'pnpm@9.0.0' }), 'pnpm');
  assert.equal(detectPackageManager({ files: ['pnpm-lock.yaml'] }), 'pnpm');
  assert.equal(detectPackageManager({ files: ['yarn.lock'] }), 'yarn');
  assert.equal(detectPackageManager({ files: ['bun.lockb'] }), 'bun');
  assert.equal(detectPackageManager({ files: [] }), 'npm', 'npm is the fallback npx implies');
});

// npm and pnpm need `--` before flags meant for the script; yarn and bun would
// pass a literal `--` through to it. Established by running all four.
test('flags are forwarded the way each package manager actually wants them', () => {
  assert.equal(runScript('npm', 'ios', ['--device', 'X']), 'npm run ios -- --device X');
  assert.equal(runScript('pnpm', 'ios', ['--device', 'X']), 'pnpm run ios -- --device X');
  assert.equal(runScript('yarn', 'ios', ['--device', 'X']), 'yarn run ios --device X');
  assert.equal(runScript('bun', 'ios', ['--device', 'X']), 'bun run ios --device X');
});

test('a script with no extra flags gets no separator at all', () => {
  assert.equal(runScript('npm', 'start'), 'npm run start');
});

// A project's own start script often carries flags that matter -- --client-logs,
// a variant, a flavor -- and spawning the bundler directly drops them silently.
test('the project script is preferred over a command we would invent', () => {
  const facts = projectFacts({
    pkg: { dependencies: { expo: '~57.0.0' }, scripts: { ios: 'expo run:ios', start: 'expo start --client-logs' } },
    files: ['yarn.lock'],
  });
  const script = renderDevScript(facts);
  assert.match(script, /yarn run start --port/);
  assert.match(script, /yarn run ios --device/);
  assert.doesNotMatch(script, /npx expo start/);
});

test('a project with no scripts falls back to a direct command rather than inventing a script', () => {
  const script = renderDevScript(projectFacts({ pkg: { dependencies: { expo: '~57.0.0' } }, files: [] }));
  assert.match(script, /npx expo start --port/);
  assert.doesNotMatch(script, /run start/);
});

// The port must be passed exactly once: twice is not harmless, since the second
// occurrence is what some CLIs actually read.
test('the port is passed exactly once to the bundler', () => {
  for (const files of [[], ['pnpm-lock.yaml']]) {
    const facts = projectFacts({ pkg: { dependencies: { expo: '~57.0.0' }, scripts: { start: 'expo start' } }, files });
    const line = renderDevScript(facts).split('\n').find(l => l.includes('$LOG') && l.includes('&'));
    assert.equal((line.match(/--port/g) || []).length, 1, line);
  }
});

// A monorepo keeps its lockfile at the workspace root, not in the app package.
// Looking only in the project directory reports npm for a pnpm repo, and
// `npm run ios -- --flag` is the wrong invocation there.
test('a lockfile above the project directory is found', () => {
  assert.equal(detectPackageManager({ files: ['package.json'], ancestorFiles: ['pnpm-lock.yaml'] }), 'pnpm');
});

test('a lockfile in the project directory still wins nothing over the declared field', () => {
  assert.equal(
    detectPackageManager({ files: ['yarn.lock'], ancestorFiles: ['pnpm-lock.yaml'], packageManagerField: 'bun@1.0.0' }),
    'bun'
  );
});
