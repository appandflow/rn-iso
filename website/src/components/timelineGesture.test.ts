import { describe, expect, it, vi } from 'vitest';
import {
  installTimelineWheelZoom,
  timelineAnchoredScrollLeft,
  timelinePlaybackScrollLeft,
  timelinePinchGeometry,
  type TimelineWheelZoom,
} from './timelineGesture';

function wheel(ctrlKey: boolean, deltaY = -25, clientX = 240): Event {
  const event = new Event('wheel', { cancelable: true });
  Object.assign(event, { ctrlKey, deltaY, clientX });
  return event;
}

describe('installTimelineWheelZoom', () => {
  it('cancels Ctrl-wheel page zoom and reports the focal point and scale', () => {
    const target = new EventTarget();
    const onZoom = vi.fn<(gesture: TimelineWheelZoom) => void>();
    const remove = installTimelineWheelZoom(target as HTMLElement, onZoom);
    const event = wheel(true);

    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onZoom).toHaveBeenCalledWith({ clientX: 240, scale: Math.exp(0.25) });
    remove();
  });

  it('leaves an ordinary wheel event untouched and removes its listener', () => {
    const target = new EventTarget();
    const onZoom = vi.fn<(gesture: TimelineWheelZoom) => void>();
    const remove = installTimelineWheelZoom(target as HTMLElement, onZoom);
    const ordinary = wheel(false);

    target.dispatchEvent(ordinary);
    expect(ordinary.defaultPrevented).toBe(false);
    expect(onZoom).not.toHaveBeenCalled();

    remove();
    target.dispatchEvent(wheel(true));
    expect(onZoom).not.toHaveBeenCalled();
  });
});

describe('timelineAnchoredScrollLeft', () => {
  it('keeps the content ratio under the gesture midpoint after zoom', () => {
    expect(timelineAnchoredScrollLeft(0.5, 1600, 200)).toBe(600);
  });
});

describe('timelinePlaybackScrollLeft', () => {
  it('keeps the early playhead in view without scrolling', () => {
    expect(timelinePlaybackScrollLeft(0.2, 2112, 1000, 112)).toBe(0);
  });

  it('follows the playhead after it crosses 70% of the visible track', () => {
    expect(timelinePlaybackScrollLeft(0.5, 2112, 1000, 112)).toBeCloseTo(378.4);
  });

  it('stops at the end of the scrollable timeline', () => {
    expect(timelinePlaybackScrollLeft(1, 2112, 1000, 112)).toBe(1112);
  });
});

describe('timelinePinchGeometry', () => {
  it('reports a two-touch distance and midpoint', () => {
    expect(
      timelinePinchGeometry([
        { clientX: 100, clientY: 20 },
        { clientX: 200, clientY: 20 },
      ]),
    ).toEqual({ distance: 100, midpointX: 150 });
  });

  it('leaves one-finger timeline scrolling alone', () => {
    expect(timelinePinchGeometry([{ clientX: 100, clientY: 20 }])).toBeNull();
  });
});
