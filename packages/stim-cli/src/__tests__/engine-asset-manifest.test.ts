import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSET_MANIFEST_FILE,
  ASSET_MANIFEST_VERSION,
  androidModuleDirs,
  assetDiffReason,
  captureAssetManifest,
  compareAssetManifests,
  findGeneratedResDir,
  parseAssetManifest,
  pickGeneratedResDir,
  readAssetManifest,
  type AssetManifest,
} from '../engine/asset-manifest.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-cli-assets-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(file: string, contents: string) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, contents);
}

describe('readAssetManifest', () => {
  test('every file, hashed by CONTENT, at its path relative to the asset root, sorted', () => {
    write(join(root, 'drawable-xxhdpi', 'logo.png'), 'big-png');
    write(join(root, 'drawable-mdpi', 'logo.png'), 'small-png');
    write(join(root, 'raw', 'sound.mp3'), 'mp3');
    expect(readAssetManifest(root)).toEqual({
      version: ASSET_MANIFEST_VERSION,
      assets: [
        { path: 'drawable-mdpi/logo.png', sha256: sha('small-png') },
        { path: 'drawable-xxhdpi/logo.png', sha256: sha('big-png') },
        { path: 'raw/sound.mp3', sha256: sha('mp3') },
      ],
    });
  });

  test('the same tree hashes the same twice, and one changed byte changes exactly one entry', () => {
    write(join(root, 'drawable-mdpi', 'logo.png'), 'v1');
    write(join(root, 'raw', 'sound.mp3'), 'mp3');
    const first = readAssetManifest(root);
    expect(readAssetManifest(root)).toEqual(first);
    write(join(root, 'drawable-mdpi', 'logo.png'), 'v2');
    const second = readAssetManifest(root);
    expect(second?.assets[1]).toEqual(first?.assets[1]);
    expect(second?.assets[0]?.sha256).not.toBe(first?.assets[0]?.sha256);
  });

  test('an EXISTING but empty tree is a manifest with no assets, not a missing manifest', () => {
    expect(readAssetManifest(root)).toEqual({ version: ASSET_MANIFEST_VERSION, assets: [] });
  });

  test('a directory that does not exist is null, so the caller stores nothing', () => {
    expect(readAssetManifest(join(root, 'nope'))).toBe(null);
  });

  test('a file that cannot be read makes the WHOLE manifest null -- a partial one would let a change through', () => {
    write(join(root, 'raw', 'sound.mp3'), 'mp3');
    symlinkSync(join(root, 'gone'), join(root, 'raw', 'dangling.png'));
    expect(readAssetManifest(root)).toBe(null);
  });
});

describe('parseAssetManifest', () => {
  test('round-trips what storeBuild writes', () => {
    write(join(root, 'raw', 'sound.mp3'), 'mp3');
    const written = readAssetManifest(root);
    expect(parseAssetManifest(JSON.stringify(written))).toEqual(written);
  });

  test('anything unrecognised is NO manifest, never an empty one', () => {
    expect(parseAssetManifest('not json')).toBe(null);
    expect(parseAssetManifest(null)).toBe(null);
    expect(parseAssetManifest('[]')).toBe(null);
    expect(parseAssetManifest(JSON.stringify({ version: 2, assets: [] }))).toBe(null);
    expect(parseAssetManifest(JSON.stringify({ version: 1 }))).toBe(null);
    expect(parseAssetManifest(JSON.stringify({ version: 1, assets: [{ path: 'a.png' }] }))).toBe(null);
    expect(parseAssetManifest(JSON.stringify({ version: 1, assets: [] }))).toEqual({ version: 1, assets: [] });
  });

  test('the file name is the one stored beside the artifact', () => {
    expect(ASSET_MANIFEST_FILE).toBe('assets-manifest.json');
  });
});

describe('pickGeneratedResDir', () => {
  const modern = ['createBundleDebugJsAndAssets', 'createBundleProductionReleaseJsAndAssets'];

  test('RN 0.71+: createBundle<Variant>JsAndAssets, matched on the variant', () => {
    expect(pickGeneratedResDir(modern, 'productionRelease')).toBe('createBundleProductionReleaseJsAndAssets');
    expect(pickGeneratedResDir(modern, 'debug')).toBe('createBundleDebugJsAndAssets');
  });

  test('a tree that has built BOTH does not hand a release run the debug leftovers', () => {
    expect(pickGeneratedResDir(modern, 'release')).toBe(null);
  });

  test('older layout: react/<variant>', () => {
    expect(pickGeneratedResDir(['react'], 'productionRelease', ['debug', 'productionRelease'])).toBe(
      'react/productionRelease',
    );
    expect(pickGeneratedResDir(['react'], 'release', ['debug'])).toBe(null);
  });

  test('with no variant to match, exactly one candidate is unambiguous and several are not', () => {
    expect(pickGeneratedResDir(['createBundleReleaseJsAndAssets'], null)).toBe('createBundleReleaseJsAndAssets');
    expect(pickGeneratedResDir(modern, null)).toBe(null);
    expect(pickGeneratedResDir(['react'], null, ['release'])).toBe('react/release');
    expect(pickGeneratedResDir(['react'], null, ['debug', 'release'])).toBe(null);
  });

  test('nothing generated at all is null, which is a manifest-less entry', () => {
    expect(pickGeneratedResDir([], 'release')).toBe(null);
    expect(pickGeneratedResDir(['rs', 'resValues'], 'release')).toBe(null);
  });
});

describe('findGeneratedResDir', () => {
  test('the app module first, in the RN 0.71+ layout', () => {
    const dir = join(root, 'android', 'app', 'build', 'generated', 'res', 'createBundleReleaseJsAndAssets');
    write(join(dir, 'drawable-mdpi', 'logo.png'), 'png');
    expect(findGeneratedResDir(root, 'release')).toBe(dir);
  });

  test('the older react/<variant> layout is found too', () => {
    const dir = join(root, 'android', 'app', 'build', 'generated', 'res', 'react', 'release');
    write(join(dir, 'raw', 'sound.mp3'), 'mp3');
    expect(findGeneratedResDir(root, 'release')).toBe(dir);
  });

  test('an app module that is not literally `app` is found by the directory it generated', () => {
    const dir = join(root, 'android', 'mobile', 'build', 'generated', 'res', 'createBundleReleaseJsAndAssets');
    write(join(dir, 'drawable-mdpi', 'logo.png'), 'png');
    expect(androidModuleDirs(root)).toEqual(['app', 'mobile']);
    expect(findGeneratedResDir(root, 'release')).toBe(dir);
  });

  test('no android/ and no generated res is null, not a throw', () => {
    expect(findGeneratedResDir(root, 'release')).toBe(null);
    mkdirSync(join(root, 'android', 'app', 'build', 'generated', 'res'), { recursive: true });
    expect(findGeneratedResDir(root, 'release')).toBe(null);
  });
});

describe('captureAssetManifest', () => {
  test("a release build's emitted tree becomes the manifest stored beside the artifact", () => {
    const dir = join(root, 'android', 'app', 'build', 'generated', 'res', 'createBundleProductionReleaseJsAndAssets');
    write(join(dir, 'drawable-mdpi', 'logo.png'), 'png');
    write(join(dir, 'raw', 'sound.mp3'), 'mp3');
    expect(captureAssetManifest(root, { variant: 'productionRelease' })).toEqual({
      version: ASSET_MANIFEST_VERSION,
      assets: [
        { path: 'drawable-mdpi/logo.png', sha256: sha('png') },
        { path: 'raw/sound.mp3', sha256: sha('mp3') },
      ],
    });
  });

  test('nothing generated means no manifest -- and an entry with no manifest never swaps', () => {
    expect(captureAssetManifest(root, { variant: 'release' })).toBe(null);
  });
});

describe('compareAssetManifests', () => {
  const stored: AssetManifest = {
    version: 1,
    assets: [
      { path: 'drawable-mdpi/logo.png', sha256: sha('logo') },
      { path: 'raw/sound.mp3', sha256: sha('sound') },
    ],
  };

  test('IDENTICAL: the same paths with the same bytes is the case that swaps', () => {
    expect(compareAssetManifests({ version: 1, assets: [...stored.assets] }, stored)).toEqual({
      same: true,
      added: [],
      removed: [],
      changed: [],
      example: null,
    });
  });

  test('ADDED: a fresh require() the cached APK cannot serve', () => {
    const fresh: AssetManifest = {
      version: 1,
      assets: [...stored.assets, { path: 'drawable-mdpi/new.png', sha256: sha('new') }],
    };
    const diff = compareAssetManifests(fresh, stored);
    expect(diff.same).toBe(false);
    expect(diff.added).toEqual(['drawable-mdpi/new.png']);
    expect(diff.example).toBe('drawable-mdpi/new.png');
    expect(assetDiffReason(diff)).toMatch(/1 added, 0 changed, 0 removed; e\.g\. added drawable-mdpi\/new\.png/);
  });

  test('REMOVED: an asset the cached build emitted and this one does not', () => {
    const diff = compareAssetManifests({ version: 1, assets: [stored.assets[0]!] }, stored);
    expect(diff.same).toBe(false);
    expect(diff.removed).toEqual(['raw/sound.mp3']);
    expect(diff.added).toEqual([]);
    expect(assetDiffReason(diff)).toMatch(/e\.g\. removed raw\/sound\.mp3/);
  });

  test('CHANGED: the same filename, different bytes -- issue #62, and what names-only could not see', () => {
    const fresh: AssetManifest = {
      version: 1,
      assets: [{ path: 'drawable-mdpi/logo.png', sha256: sha('a DIFFERENT logo') }, stored.assets[1]!],
    };
    const diff = compareAssetManifests(fresh, stored);
    expect(diff.same).toBe(false);
    expect(diff.changed).toEqual(['drawable-mdpi/logo.png']);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(assetDiffReason(diff)).toMatch(/e\.g\. changed drawable-mdpi\/logo\.png/);
  });

  test('two empty manifests are the same: an app with no assets swaps like any other', () => {
    expect(compareAssetManifests({ version: 1, assets: [] }, { version: 1, assets: [] }).same).toBe(true);
  });

  test('the lists are sorted and the example prefers added, then changed, then removed', () => {
    const fresh: AssetManifest = {
      version: 1,
      assets: [
        { path: 'drawable-mdpi/logo.png', sha256: sha('changed') },
        { path: 'drawable-mdpi/b.png', sha256: sha('b') },
        { path: 'drawable-mdpi/a.png', sha256: sha('a') },
      ],
    };
    const diff = compareAssetManifests(fresh, stored);
    expect(diff.added).toEqual(['drawable-mdpi/a.png', 'drawable-mdpi/b.png']);
    expect(diff.changed).toEqual(['drawable-mdpi/logo.png']);
    expect(diff.removed).toEqual(['raw/sound.mp3']);
    expect(diff.example).toBe('drawable-mdpi/a.png');
  });
});
