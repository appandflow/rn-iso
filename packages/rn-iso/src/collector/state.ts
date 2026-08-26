// src/collector/state.ts -- the Contract-5 collector state helpers, guard-free.
//
// Split out of collector/run.ts for the same reason supervisor/state.ts was
// split out of supervisor/run.ts: `android` reads `readCollectors` to reap a
// previous collector, and importing it must NOT drag the spawnable collector
// daemon (its `if (invokedDirectly()) main()` tail, plus the ios/android log
// stream parsers it pulls in) into the CLI bundle. In the built package that
// would put run.ts into a chunk SHARED with cli.js, whose import.meta.url is
// the chunk's -- not collector-run.js's -- so the direct-invocation guard would
// never match and `node dist/collector-run.js` would silently do nothing.
// run.ts re-exports this surface for callers -- and tests -- that reach for it
// there.
import { readWorkspaceState, withWorkspaceStateLock, writeWorkspaceState } from '../supervisor/state.ts';

// Merged into the SAME state.json the supervisor writes, under its own
// `collectors` key, so `stop` and `status` read one file. Both writers
// read-modify-write, which is why each only ever touches its own key: a
// collector exiting must never take `supervisor` or the other platform's
// entry with it.

// The collectors merge (read `collectors`, add or drop this platform, write)
// is itself a read-modify-write, so it runs inside the state lock -- two
// collectors (ios + android) registering at once would otherwise each read the
// other's absence and drop it. The nested writeWorkspaceState re-acquires the
// same lock, which is reentrant, so this does not deadlock.
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
    // JSON.stringify drops an undefined value, so passing undefined REMOVES the
    // key rather than leaving an empty object behind -- and it does so through
    // the same merging writer, instead of a second copy of the atomic write.
    writeWorkspaceState(root, { collectors: Object.keys(collectors).length ? collectors : undefined });
    return collectors;
  });
}

export function readCollectors(root: string): Record<string, unknown> {
  return readWorkspaceState(root)?.collectors || {};
}
