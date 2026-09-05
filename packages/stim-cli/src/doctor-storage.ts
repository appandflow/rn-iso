import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorPlatform, Finding } from './doctor.ts';
import { apkOutputsDir } from './engine/gradle.ts';
import { sharedBuildCache, workspaceDerivedData } from './paths.ts';
import { filesystemDevice, temporaryRoot } from './temporary.ts';
import { listWorktrees, repoRoot } from './worktree.ts';

export function checkStorageLayout(
  projectRoot: string,
  {
    platform,
    device = filesystemDevice,
    stagingRoot = temporaryRoot,
  }: {
    platform?: DoctorPlatform;
    device?: typeof filesystemDevice;
    stagingRoot?: typeof temporaryRoot;
  } = {},
): Finding[] {
  const findings: Finding[] = [];
  const temporaryFix =
    'Unset STIM_TMPDIR / machine tempDir to select same-volume staging automatically, ' +
    'or point the override at a writable directory on the relevant volume outside Git working trees.';
  const check = (operation: string, paths: string[], fix: string) => {
    if (new Set(paths.map(device)).size < 2) return;
    findings.push({
      level: 'cost',
      title: `${operation} crosses filesystems`,
      detail:
        `${paths.join(' -> ')}. These copies cannot share file blocks across volumes and can consume the full ` +
        'artifact size in space and I/O. cp -c can silently perform a full copy without an error.',
      fix,
    });
  };
  try {
    const target = repoRoot(projectRoot) ?? projectRoot;
    const source = listWorktrees(target)[0]?.path ?? target;
    check('Worktree staging', [source, stagingRoot(target), target], temporaryFix);
    const cache = sharedBuildCache();
    check('Cached app/APK staging', [cache, stagingRoot(join(cache, 'artifact.app'))], temporaryFix);
    const cacheFix =
      'Place STIM_BUILD_CACHE / machine caches.buildCache on the build-output volume, ' +
      'or accept the full-copy cost of keeping the cache on a separate volume.';
    if (platform === 'ios' || (platform !== 'android' && existsSync(join(projectRoot, 'ios')))) {
      const output = join(workspaceDerivedData(projectRoot), 'Build', 'Products');
      check('iOS build-cache storage', [output, cache], cacheFix);
      check('iOS device app staging', [output, stagingRoot(join(output, 'artifact.app'))], temporaryFix);
    }
    if (platform === 'android' || (platform !== 'ios' && existsSync(join(projectRoot, 'android')))) {
      check('Android build-cache storage', [apkOutputsDir(projectRoot), cache], cacheFix);
    }
  } catch (error) {
    findings.push({
      level: 'cost',
      title: 'Could not resolve temporary storage',
      detail: String((error as Error).message),
      fix: temporaryFix,
    });
  }
  return findings;
}
