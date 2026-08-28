import { readWorkspaceState, withWorkspaceStateLock, writeWorkspaceState } from '../supervisor/state.ts';

export function registerCollector(
  root: string,
  platform: string,
  record: Record<string, unknown>,
): Record<string, unknown> {
  return withWorkspaceStateLock(root, () => {
    const collectors = { ...readWorkspaceState(root)?.collectors, [platform]: record };
    writeWorkspaceState(root, { collectors });
    return collectors;
  });
}

export function unregisterCollector(root: string, platform: string): Record<string, unknown> {
  return withWorkspaceStateLock(root, () => {
    const state = readWorkspaceState(root);
    const collectors: Record<string, unknown> = { ...state?.collectors };
    if (!(platform in collectors)) return collectors;
    delete collectors[platform];
    writeWorkspaceState(root, { collectors: Object.keys(collectors).length ? collectors : undefined });
    return collectors;
  });
}

export function readCollectors(root: string): Record<string, unknown> {
  return readWorkspaceState(root)?.collectors || {};
}
