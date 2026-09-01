import { resetExecutor, setExecutor } from '../exec.ts';
import { parseLinuxStartTicks, parseLstartOutput, readProcessArgs, readProcessStartTime } from '../process-args.ts';

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

// state (field 3) is fields[0] after "(comm) "; starttime (field 22) is fields[19], so 18 filler
// fields sit between them (fields[1..18]).
function linuxStatFields(startTicks: string): string {
  return `S ${Array<string>(18).fill('0').join(' ')} ${startTicks}`;
}

function linuxStatWithStartTicks(ticks: string): Buffer {
  return Buffer.from(`4242 (node worker) ${linuxStatFields(ticks)}`);
}

describe('parseLinuxStartTicks', () => {
  test('reads the starttime field (22nd, 1-indexed) out of /proc/[pid]/stat', () => {
    expect(parseLinuxStartTicks(linuxStatWithStartTicks('123456'), 32 * 1024)).toBe(123456);
  });

  test('a comm containing spaces or parens does not throw off the field count', () => {
    const data = Buffer.from(`4242 (node (worker)) ${linuxStatFields('987')}`);
    expect(parseLinuxStartTicks(data, 32 * 1024)).toBe(987);
  });

  test.each([
    ['empty', Buffer.alloc(0)],
    ['no comm parens', Buffer.from('4242 node S 0 0')],
    ['starttime is not numeric', Buffer.from(`4242 (node) ${linuxStatFields('abc')}`)],
    ['too short', Buffer.from('4242 (node) S 0 0')],
  ])('%s fails closed', (_name, data) => {
    expect(parseLinuxStartTicks(data as Buffer, 32 * 1024)).toBeNull();
  });

  test('a buffer past maxBytes fails closed', () => {
    expect(parseLinuxStartTicks(linuxStatWithStartTicks('123456'), 4)).toBeNull();
  });
});

describe('parseLstartOutput', () => {
  test('trims and collapses internal whitespace', () => {
    expect(parseLstartOutput('  Wed Aug  27 14:32:10 2025  ')).toBe('Wed Aug 27 14:32:10 2025');
  });

  test.each([
    ['empty', ''],
    ['embedded NUL', 'Wed Aug 27\0 14:32:10 2025'],
    ['embedded newline', 'Wed Aug 27\n14:32:10 2025'],
    ['embedded carriage return', 'Wed Aug 27\r14:32:10 2025'],
  ])('%s fails closed', (_name, output) => {
    expect(parseLstartOutput(output)).toBeNull();
  });
});

describe('readProcessStartTime', () => {
  test('darwin: parses ps -o lstart= into a real Date', () => {
    const calls: Array<{ pid: number; timeoutMs: number }> = [];
    const result = readProcessStartTime(4242, {
      platform: 'darwin',
      runPsCommand: (pid, timeoutMs) => {
        calls.push({ pid, timeoutMs });
        return 'Wed Aug 27 14:32:10 2025';
      },
    });
    expect(result).toBeInstanceOf(Date);
    expect(result?.getFullYear()).toBe(2025);
    expect(result?.getMonth()).toBe(7);
    expect(result?.getDate()).toBe(27);
    expect(calls).toEqual([{ pid: 4242, timeoutMs: expect.any(Number) }]);
  });

  test.each([
    [
      'ps failure',
      () => {
        throw new Error('ps failed');
      },
    ],
    ['empty output', () => ''],
    ['unparseable date text', () => 'not a date'],
  ])('darwin: %s fails closed', (_name, runPsCommand) => {
    expect(readProcessStartTime(4242, { platform: 'darwin', runPsCommand })).toBeNull();
  });

  test('linux: converts starttime ticks + /proc/uptime into a wall-clock Date', () => {
    const now = () => 1_700_000_000_000;
    const result = readProcessStartTime(4242, {
      platform: 'linux',
      readProcStat: () => linuxStatWithStartTicks('123456'),
      readUptimeSeconds: () => 500,
      now,
    });
    // boot = now - 500s; start = boot + (123456 ticks / 100 ticks-per-second)
    expect(result?.getTime()).toBe(now() - 500 * 1000 + (123456 / 100) * 1000);
  });

  test('linux: an unparseable stat fails closed', () => {
    expect(
      readProcessStartTime(4242, {
        platform: 'linux',
        readProcStat: () => Buffer.alloc(0),
        readUptimeSeconds: () => 500,
      }),
    ).toBeNull();
  });

  test('linux: an unreadable /proc/uptime fails closed even with a valid stat', () => {
    expect(
      readProcessStartTime(4242, {
        platform: 'linux',
        readProcStat: () => linuxStatWithStartTicks('123456'),
        readUptimeSeconds: () => null,
      }),
    ).toBeNull();
  });

  test('win32: never supported, always null', () => {
    expect(readProcessStartTime(4242, { platform: 'win32' })).toBeNull();
  });
});
