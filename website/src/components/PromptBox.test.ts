/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import PromptBox from './PromptBox';

describe('PromptBox simulation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  });

  test('runs and reruns the example before revealing its response', async () => {
    await act(async () => {
      root.render(
        createElement(PromptBox, {
          title: 'Build and run',
          response: 'Trailhead ready\nerrors clean',
          children: 'Run the app on iOS.',
        }),
      );
    });

    const button = container.querySelector('button');
    expect(button?.textContent).toBe('Run example');
    expect(container.textContent).not.toContain('Trailhead ready');

    act(() => button?.click());
    expect(button?.textContent).toBe('Running...');
    expect(button?.disabled).toBe(true);
    expect(container.textContent).toContain('Agent is running the prompt...');

    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(button?.textContent).toBe('Run again');
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Example agent response');
    expect(container.textContent).toContain('Trailhead ready\nerrors clean');

    act(() => button?.click());
    expect(button?.textContent).toBe('Running...');
    expect(container.textContent).not.toContain('Trailhead ready');
  });

  test('stays copy-only without a response', async () => {
    await act(async () => {
      root.render(createElement(PromptBox, { title: 'Build and run', children: 'Run the app on iOS.' }));
    });

    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain('Run the app on iOS.');
  });
});
