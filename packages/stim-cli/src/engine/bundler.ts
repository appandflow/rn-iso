import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Bundler's lockfile indents a resolved spec name with exactly four spaces; six marks
// that spec's own dependencies and two marks the DEPENDENCIES section. Matching the
// four-space form finds cocoapods whether the Gemfile names it directly or pulls it in
// through another gem, which is exactly when `bundle exec pod` can work; DEPENDENCIES
// would miss the transitive case.
const COCOAPODS_SPEC = /^ {4}cocoapods \(/m;

export function bundlerPin(root: string): { gemfile: string; lockfile: string } | null {
  const gemfile = join(root, 'Gemfile');
  const lockfile = join(root, 'Gemfile.lock');
  if (!existsSync(gemfile)) return null;
  let lock: string;
  try {
    lock = readFileSync(lockfile, 'utf-8');
  } catch {
    return null;
  }
  if (!COCOAPODS_SPEC.test(lock)) return null;
  return { gemfile, lockfile };
}

export function podInstallCommand(root: string, ...args: string[]): string {
  const pod = ['pod', 'install', ...args].join(' ');
  return bundlerPin(root) ? `bundle exec ${pod}` : pod;
}
