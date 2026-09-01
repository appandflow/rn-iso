import { resetExecutor, setExecutor } from '../exec.ts';
import { readProcessArgs } from '../process-args.ts';

describe('readProcessArgs', () => {
  test('reads a bounded NUL-delimited command from Linux procfs', () => {
    const reads: Array<{ path: string; maxBytes: number }> = [];
    const result = readProcessArgs(4242, {
      platform: 'linux',
      readProcCommand: (path, maxBytes) => {
        reads.push({ path, maxBytes });
        return Buffer.from(['/usr/bin/ngrok', 'http', '8081', ''].join('\0'));
      },
    });
    expect(result).toEqual(['/usr/bin/ngrok', 'http', '8081']);
    expect(reads).toEqual([{ path: '/proc/4242/cmdline', maxBytes: expect.any(Number) }]);
    expect(reads[0]?.maxBytes).toBeLessThanOrEqual(64 * 1024);
  });

  test('a process that renamed itself leaves NUL padding in procfs', () => {
    const title = 'stim-collector-ios --root /w/project';
    const padded = Buffer.concat([Buffer.from(title), Buffer.alloc(64)]);
    expect(readProcessArgs(111, { platform: 'linux', readProcCommand: () => padded })).toEqual([title]);
  });

  test('an argument list with an empty member is malformed, not padding', () => {
    const data = Buffer.from(['/usr/bin/ngrok', '', 'http', ''].join('\0'));
    expect(readProcessArgs(111, { platform: 'linux', readProcCommand: () => data })).toBeNull();
  });

  test('an unreadable Linux procfs command fails closed', () => {
    expect(
      readProcessArgs(4242, {
        platform: 'linux',
        readProcCommand: () => {
          throw new Error('EACCES');
        },
      }),
    ).toBeNull();
  });

  test('runs ps with a timeout on macOS and parses quoted arguments', () => {
    const calls: Array<{ pid: number; timeoutMs: number }> = [];
    const result = readProcessArgs(4242, {
      platform: 'darwin',
      runPsCommand: (pid, timeoutMs) => {
        calls.push({ pid, timeoutMs });
        return "'/opt/local/bin/ngrok' http 8081 --url 'https://stable.ngrok.app'";
      },
    });
    expect(result).toEqual(['/opt/local/bin/ngrok', 'http', '8081', '--url', 'https://stable.ngrok.app']);
    expect(calls).toEqual([{ pid: 4242, timeoutMs: expect.any(Number) }]);
    expect(calls[0]?.timeoutMs).toBeLessThanOrEqual(5_000);
  });

  test('uses full-width BSD ps argv and preserves a long stable ngrok URL', () => {
    const stableUrl = `https://${'a'.repeat(4_000)}.ngrok.app`;
    const calls: Array<{ file: string; args: string[]; timeoutMs: number | undefined }> = [];
    setExecutor({
      runFile(file, args, options) {
        calls.push({ file, args, timeoutMs: options?.timeoutMs });
        return `ngrok http 8081 --log=stdout --log-format=json --url ${stableUrl}`;
      },
    });
    try {
      expect(readProcessArgs(4242, { platform: 'darwin' })).toEqual([
        'ngrok',
        'http',
        '8081',
        '--log=stdout',
        '--log-format=json',
        '--url',
        stableUrl,
      ]);
    } finally {
      resetExecutor();
    }
    expect(calls).toEqual([
      { file: 'ps', args: ['-ww', '-o', 'command=', '-p', '4242'], timeoutMs: expect.any(Number) },
    ]);
  });

  test.each([
    [
      'ps failure',
      () => {
        throw new Error('ps failed');
      },
    ],
    [
      'ps timeout',
      () => {
        throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
      },
    ],
    ['empty output', () => ''],
    ['malformed output', () => "'/usr/bin/ngrok http 8081"],
  ])('%s fails closed', (_name, runPsCommand) => {
    expect(readProcessArgs(4242, { platform: 'darwin', runPsCommand })).toBeNull();
  });
});
