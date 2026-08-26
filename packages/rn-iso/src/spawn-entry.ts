// src/spawn-entry.ts -- resolve the absolute path of a spawnable child entry,
// correctly in BOTH the dev (source) and the built (dist) layout.
//
// rn-iso spawns two kinds of long-lived child by path: the per-workspace
// SUPERVISOR (supervisor/run.ts) and the per-platform device-log COLLECTOR
// (collector/run.ts). In dev the CLI runs straight from source as
// `node bin/cli.ts`, so the child is the sibling `.ts` next to the caller
// (src/supervisor/run.ts, src/collector/run.ts) and is run with node's own
// type-stripping. In the published package tsdown emits each of those as its
// own flat output beside dist/cli.js (dist/supervisor-run.js,
// dist/collector-run.js), so the child is a sibling `.js` of THIS bundled
// module.
//
// The discriminator is where THIS module is running from. In dev its own
// file:// URL contains `/src/`; once bundled into dist/cli.js it does not.
// import.meta.url is always a file:// URL that uses `/`, so the substring test
// is portable.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SpawnEntryName = 'supervisor-run' | 'collector-run';

// The dev source location of each spawnable entry, relative to THIS module
// (src/spawn-entry.ts). Named identically to the dist output basenames so the
// built branch can derive the sibling from the same key.
const DEV_ENTRIES: Record<SpawnEntryName, string> = {
  'supervisor-run': './supervisor/run.ts',
  'collector-run': './collector/run.ts',
};

export function spawnEntry(name: SpawnEntryName): string {
  if (import.meta.url.includes('/src/')) {
    return fileURLToPath(new URL(DEV_ENTRIES[name], import.meta.url));
  }
  return join(dirname(fileURLToPath(import.meta.url)), `${name}.js`);
}
