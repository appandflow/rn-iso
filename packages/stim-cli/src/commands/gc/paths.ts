import { realpathSync } from 'fs';
import { resolve } from 'path';

export function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
