import { setExecutor, getExecutor, resetExecutor } from '../exec.ts';

test('default executor runs commands and returns stdout trimmed', () => {
  resetExecutor();
  const out = getExecutor().run('echo hello');
  expect(out).toBe('hello');
});

test('runQuiet returns null on failure', () => {
  resetExecutor();
  const out = getExecutor().runQuiet('false');
  expect(out).toBe(null);
});

test('setExecutor replaces the active executor', () => {
  setExecutor({
    run: () => 'mocked',
    runQuiet: () => 'mocked-quiet',
    spawn: () => ({ pid: 999 }),
  });
  expect(getExecutor().run('anything')).toBe('mocked');
  expect(getExecutor().runQuiet('anything')).toBe('mocked-quiet');
  resetExecutor();
});

test('runFileQuiet returns trimmed stdout and null on failure', () => {
  resetExecutor();
  expect(getExecutor().runFileQuiet('echo', ['hello'])).toBe('hello');
  expect(getExecutor().runFileQuiet('false')).toBe(null);
});

test('runFileQuiet passes arguments without a shell, so metacharacters stay literal', () => {
  resetExecutor();
  expect(getExecutor().runFileQuiet('echo', ['$HOME `id` "x"'])).toBe('$HOME `id` "x"');
});
