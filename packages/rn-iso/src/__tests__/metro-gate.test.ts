// engine/metro-gate.js -- proving a public address reaches THIS Metro.
//
// The bug this exists for, observed live: a cloudflared tunnel was built for
// port 8085, `rn-iso stop` released 8085, another workspace took it, and the
// tunnel then published THAT project's dev server. Healthy, answering, and
// wrong -- which is why liveness is not the test and identity is.
import { describeMiss, gateMetroOrigin, probeBundleUrl, REMOTE_METRO_WRONG } from '../engine/metro-gate.ts';
import type { NdjsonRecord } from '../ndjson.ts';

const ORIGIN = 'https://abc.trycloudflare.com';

// A clock the test drives, so a 25s timeout costs nothing and cannot flake.
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function gate(over: Partial<Parameters<typeof gateMetroOrigin>[0]> = {}) {
  const c = clock();
  return gateMetroOrigin({
    origin: ORIGIN,
    metroPort: 8085,
    platform: 'ios',
    readRecords: () => [],
    isProof: () => false,
    probe: async () => 200,
    now: c.now,
    sleep: c.sleep,
    ...over,
  });
}

describe('the proof is a request arriving in THIS workspace log', () => {
  test('a bundle event after the probe started passes the gate', async () => {
    const records: NdjsonRecord[] = [{ ts: 5_000, src: 'metro', level: 'info', msg: 'bundle' }];
    const result = await gate({ readRecords: () => records, isProof: (r) => (r.ts ?? 0) === 5_000 });
    expect(result.ok).toBe(true);
  });

  test('a HEALTHY foreign server is refused -- liveness is not identity', async () => {
    // The live failure: the tunnel answered 200 the whole time, from another
    // project's Metro. Nothing ever reached ours.
    const result = await gate({ probe: async () => 200, isProof: () => false });
    expect(result.failed).toBe(true);
    expect(result.code).toBe(REMOTE_METRO_WRONG);
    expect(result.reason).toContain('different dev server');
  });

  test('the remedy names the port and why a stale tunnel looks fine', async () => {
    const result = await gate({ isProof: () => false });
    expect(result.remedy).toContain('8085');
    expect(result.remedy).toMatch(/no longer holds|different project/);
  });
});

describe('records from BEFORE the probe do not count', () => {
  test('an older bundle event is not proof', async () => {
    // Otherwise any previously-built bundle would vouch for any address.
    const stale: NdjsonRecord[] = [{ ts: 10, src: 'metro', level: 'info', msg: 'bundle' }];
    const result = await gate({
      readRecords: () => stale,
      // The real isBundleProof compares against `since`; this asserts the gate
      // actually passes a sane `since` rather than 0.
      isProof: (r, since) => (r.ts ?? 0) >= since,
    });
    expect(result.failed).toBe(true);
  });
});

describe('what the miss says', () => {
  test('no answer at all reads as unreachable', () => {
    expect(describeMiss(ORIGIN, 8085, null)).toContain('did not answer');
  });

  test('a 5xx points at the tunnel rather than the project', () => {
    // cloudflared returns 502/522 when the edge is up and the origin is not:
    // the tunnel exists, the port behind it does not.
    expect(describeMiss(ORIGIN, 8085, 502)).toContain('not a dev server');
    expect(describeMiss(ORIGIN, 8085, 522)).toContain('not a dev server');
  });

  test('a 2xx is the dangerous case and says so plainly', () => {
    expect(describeMiss(ORIGIN, 8085, 200)).toContain('different dev server');
  });
});

describe('the probe url', () => {
  test('asks for the same bundle the launch will, so it warms rather than wastes', () => {
    expect(probeBundleUrl(ORIGIN, 'ios')).toBe(`${ORIGIN}/index.bundle?platform=ios&dev=true`);
    expect(probeBundleUrl(ORIGIN, 'android')).toContain('platform=android');
  });

  test('a trailing slash on the origin does not double up', () => {
    expect(probeBundleUrl('https://abc.example/', 'ios')).toBe(
      'https://abc.example/index.bundle?platform=ios&dev=true',
    );
  });
});

describe('failing closed', () => {
  test('a probe that throws is still a refusal, never a pass', async () => {
    const result = await gate({
      probe: async () => {
        throw new Error('network down');
      },
    });
    expect(result.failed).toBe(true);
  });

  test('the request is abandoned once the proof lands', async () => {
    // The proof is the log entry, not the response body -- waiting for four
    // megabytes of bundle would make the gate cost as much as the thing it
    // guards.
    let aborted = false;
    const result = await gate({
      probe: (_url, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve(null);
          });
        }),
      readRecords: () => [{ ts: 9_999, src: 'metro', level: 'info', msg: 'bundle' }],
      isProof: () => true,
    });
    expect(result.ok).toBe(true);
    expect(aborted).toBe(true);
  });
});
