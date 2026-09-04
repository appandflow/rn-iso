export interface TimelineWheelZoom {
  clientX: number;
  scale: number;
}

export interface TimelineTouchPoint {
  clientX: number;
  clientY: number;
}

export function timelinePinchGeometry(touches: TimelineTouchPoint[]): { distance: number; midpointX: number } | null {
  const [first, second] = touches;
  if (touches.length !== 2 || !first || !second) return null;
  return {
    distance: Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY),
    midpointX: (first.clientX + second.clientX) / 2,
  };
}

export function installTimelineWheelZoom(
  element: HTMLElement,
  onZoom: (gesture: TimelineWheelZoom) => void,
): () => void {
  const listener = (event: WheelEvent) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    onZoom({ clientX: event.clientX, scale: Math.exp(-event.deltaY * 0.01) });
  };
  element.addEventListener('wheel', listener, { passive: false });
  return () => element.removeEventListener('wheel', listener);
}

export function timelineAnchoredScrollLeft(contentRatio: number, scrollWidth: number, viewportOffset: number): number {
  return contentRatio * scrollWidth - viewportOffset;
}
