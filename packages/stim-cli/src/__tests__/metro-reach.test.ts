import assert from 'node:assert';
import { detectProviders, planMetroReach, TUNNEL_MODES } from '../engine/metro-reach.ts';

const BARE = { metroPort: 8085, isExpo: false } as const;
const EXPO = { metroPort: 8085, isExpo: true } as const;

describe('off is an assertion, not a guess', () => {
  test('off uses localhost and skips the gate', () => {
    expect(planMetroReach({ ...BARE, mode: 'off' })).toEqual({ origin: 'http://localhost:8085', gate: false });
  });

  test('off wins even on an Expo project, which could have tunnelled itself', () => {
    expect(planMetroReach({ ...EXPO, mode: 'off' })).toEqual({ origin: 'http://localhost:8085', gate: false });
  });
});

describe('an address the operator supplied', () => {
  test('is used rather than starting a second tunnel', () => {
    const plan = planMetroReach({
      ...BARE,
      mode: 'auto',
      publicUrl: 'https://abc.trycloudflare.com',
      available: ['ngrok'],
    });
    expect(plan).toEqual({ origin: 'https://abc.trycloudflare.com', gate: true });
  });

  test('is GATED, because Stim did not create it', () => {
    const plan = planMetroReach({ ...BARE, mode: 'auto', publicUrl: 'https://abc.example' });
    expect('gate' in plan && plan.gate).toBe(true);
  });

  test('has its trailing slash dropped, so the deep link is not doubled', () => {
    const plan = planMetroReach({ ...BARE, mode: 'auto', publicUrl: 'https://abc.example/' });
    expect(plan).toEqual({ origin: 'https://abc.example', gate: true });
  });

  test('beats a managed provider even when one is available', () => {
    const plan = planMetroReach({
      ...BARE,
      mode: 'cloudflared',
      publicUrl: 'https://abc.example',
      available: ['cloudflared'],
    });
    expect('origin' in plan).toBe(true);
  });
});

describe('expo tunnels its own dev server only when selected', () => {
  test('auto on an Expo project uses the preferred managed provider', () => {
    expect(planMetroReach({ ...EXPO, mode: 'auto', available: ['ngrok', 'cloudflared'] })).toEqual({ start: 'ngrok' });
  });

  test('explicit expo mode lets the Expo dev server own its tunnel', () => {
    expect(planMetroReach({ ...EXPO, mode: 'expo', available: ['ngrok', 'cloudflared'] })).toEqual({
      expoTunnel: true,
    });
  });

  test('asking for expo on a bare RN workspace is refused, not silently ignored', () => {
    const plan = planMetroReach({ ...BARE, mode: 'expo' });
    expect('failed' in plan).toBe(true);
    assert('failed' in plan);
    expect(plan.remedy).toMatch(/auto|off/);
  });
});

describe('a managed provider', () => {
  test('auto on bare RN starts the caller-preferred one', () => {
    expect(planMetroReach({ ...BARE, mode: 'auto', available: ['ngrok', 'cloudflared'] })).toEqual({ start: 'ngrok' });
    expect(planMetroReach({ ...BARE, mode: 'auto', available: ['cloudflared'] })).toEqual({ start: 'cloudflared' });
  });

  test('naming one that is not installed refuses with how to install it', () => {
    const plan = planMetroReach({ ...BARE, mode: 'ngrok', available: ['cloudflared'] });
    expect('failed' in plan).toBe(true);
    assert('failed' in plan);
    expect(plan.failed).toContain('ngrok');
    expect(plan.remedy).toContain('brew install ngrok');
  });

  test('auto with nothing installed refuses, and names every way out', () => {
    const plan = planMetroReach({ ...BARE, mode: 'auto', available: [] });
    expect('failed' in plan).toBe(true);
    assert('failed' in plan);
    expect(plan.remedy).toContain('brew install');
    expect(plan.remedy).toContain('metro.publicUrl');
    expect(plan.remedy).toContain('"off"');
  });

  test('auto NEVER falls back to localhost', () => {
    for (const available of [[], ['ngrok'] as const, ['cloudflared'] as const]) {
      const plan = planMetroReach({ ...BARE, mode: 'auto', available });
      expect('origin' in plan).toBe(false);
    }
  });
});

describe('the mode list', () => {
  test('contains only the supported values', () => {
    expect(TUNNEL_MODES).toEqual(['auto', 'off', 'expo', 'cloudflared', 'ngrok']);
  });

  test('every mode is handled, so a new one cannot be added without a decision', () => {
    for (const mode of TUNNEL_MODES) {
      const plan = planMetroReach({ ...EXPO, mode, available: ['cloudflared'] });
      expect(plan).toBeTruthy();
    }
  });
});

describe('provider detection', () => {
  test('reports only what is on PATH', () => {
    expect(detectProviders((b) => b === 'cloudflared')).toEqual(['cloudflared']);
    expect(detectProviders(() => false)).toEqual([]);
  });

  test('prefers ngrok when both are installed', () => {
    expect(detectProviders(() => true)).toEqual(['ngrok', 'cloudflared']);
  });

  test('the detected order is what auto picks', () => {
    const available = detectProviders(() => true);
    expect(planMetroReach({ ...BARE, mode: 'auto', available })).toEqual({ start: 'ngrok' });
  });
});
