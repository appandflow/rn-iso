import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SpawnEntryName = 'supervisor-run' | 'collector-run';

const DEV_ENTRIES: Record<SpawnEntryName, string> = {
  'supervisor-run': './supervisor/run.ts',
  'collector-run': './collector/run.ts',
};

export function spawnEntry(name: SpawnEntryName): string {
  const here = fileURLToPath(import.meta.url);
  if (basename(dirname(here)) === 'src') {
    return fileURLToPath(new URL(DEV_ENTRIES[name], import.meta.url));
  }
  return join(dirname(here), `${name}.mjs`);
}
