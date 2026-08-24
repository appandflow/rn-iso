import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectFacts, renderWorkflow, renderWorktreeExclude } from '../src/init.js';

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
