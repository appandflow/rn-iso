import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import {
  EMBEDDED_PROFILE,
  findSigningIdentities,
  gateAppForDevice,
  readEmbeddedProfile,
  resealBundle,
  sealAppForDevice,
  type ResealFailure,
  type ResealMode,
  type ResealSuccess,
  type SigningGateOptions,
} from '../engine/ios-signing.ts';
import {
  certificateCommonName,
  parsePlist,
  parseProvisioningProfilePlist,
  parseSigningIdentities,
  provisioningProfileKind,
  signingGate,
  type ProvisioningProfile,
  type SigningIdentity,
  type SigningRefusalCode,
} from '../engine/ios-profile.ts';

const PHONE = '00008030-001A2B3C4D5E802E';
const STRANGER = '00008101-999999999999999E';
const JANE = 'Apple Development: Jane Fixture (TEAMID5678)';
const JANE_SHA1 = '3FE19E227EC5BC2EDE3AC52AB02FF46920445C6A';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/ios-signing/${name}`, import.meta.url), 'utf-8');
}

function profile(name = 'development-profile.plist'): ProvisioningProfile {
  const parsed = parseProvisioningProfilePlist(fixture(name));
  if (!parsed) throw new Error(`fixture ${name} did not parse`);
  return parsed;
}

const BEFORE_EXPIRY = Date.parse('2026-09-01T00:00:00Z');
const IDENTITIES: SigningIdentity[] = parseSigningIdentities(fixture('find-identity.txt'));

test('parsePlist reads the container types security cms -D emits', () => {
  const value = parsePlist(
    '<plist version="1.0"><dict><key>a</key><string>x &amp; y</string>' +
      '<key>n</key><integer>7</integer><key>r</key><real>1.5</real>' +
      '<key>t</key><true/><key>f</key><false/>' +
      '<key>list</key><array><string>one</string><string>two</string></array>' +
      '<key>nested</key><dict><key>deep</key><string>value</string></dict>' +
      '<key>empty</key><array/></dict></plist>',
  );
  expect(value).toEqual({
    a: 'x & y',
    n: 7,
    r: 1.5,
    t: true,
    f: false,
    list: ['one', 'two'],
    nested: { deep: 'value' },
    empty: [],
  });
});

test('parsePlist refuses what is not a plist rather than guessing', () => {
  expect(parsePlist('')).toBe(null);
  expect(parsePlist(null)).toBe(null);
  expect(parsePlist('<html><body>nope</body></html>')).toBe('');
});

test('parseProvisioningProfilePlist reads the keys the gate decides on', () => {
  const parsed = profile();
  expect(parsed.name).toBe('iOS Team Provisioning Profile: com.example.stim');
  expect(parsed.uuid).toBe('9d1f8f6a-0e0c-4c33-9a1f-2b6a5c7d8e90');
  expect(parsed.teamIdentifier).toBe('TEAMID5678');
  expect(parsed.expirationDate?.toISOString()).toBe('2027-06-01T12:00:00.000Z');
  expect(parsed.provisionedDevices).toEqual([PHONE, '00008120-000A11223C44201E']);
  expect(parsed.provisionsAllDevices).toBe(false);
  expect(parsed.getTaskAllow).toBe(true);
  expect(parsed.certificates).toHaveLength(1);
  expect(parsed.certificates[0]!.length).toBeGreaterThan(500);
});

test('parseProvisioningProfilePlist returns null for input that is not a profile', () => {
  expect(parseProvisioningProfilePlist('not a plist')).toBe(null);
  expect(parseProvisioningProfilePlist('<plist version="1.0"><array/></plist>')).toBe(null);
});

test('provisioningProfileKind names the four shapes the remedy has to distinguish', () => {
  expect(provisioningProfileKind(profile())).toBe('development');
  expect(provisioningProfileKind(profile('app-store-profile.plist'))).toBe('App Store');
  expect(provisioningProfileKind(profile('enterprise-profile.plist'))).toBe('enterprise');
  expect(provisioningProfileKind({ ...profile(), getTaskAllow: false })).toBe('ad hoc');
});

test('certificateCommonName pulls the identity name out of a real X509 subject', () => {
  expect(certificateCommonName(profile().certificates[0])).toBe(JANE);
  expect(certificateCommonName(Buffer.from('not a certificate'))).toBe(null);
  expect(certificateCommonName(null)).toBe(null);
});

test('parseSigningIdentities scrapes what security find-identity prints', () => {
  expect(IDENTITIES).toEqual([
    { sha1: JANE_SHA1, name: JANE },
    { sha1: 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678', name: 'Apple Distribution: Fixture Inc (TEAMID5678)' },
  ]);
  expect(parseSigningIdentities(fixture('find-identity-empty.txt'))).toEqual([]);
  expect(parseSigningIdentities(null)).toEqual([]);
});

function gate(overrides: Partial<Parameters<typeof signingGate>[0]> = {}) {
  return signingGate({
    profilePresent: true,
    profile: profile(),
    identities: IDENTITIES,
    udid: PHONE,
    now: BEFORE_EXPIRY,
    ...overrides,
  });
}

test('the gate admits a development profile that names the phone and an identity in the keychain', () => {
  expect(gate()).toEqual({ ok: true, identity: { sha1: JANE_SHA1, name: JANE } });
});

test('a bundle with no embedded.mobileprovision is STIM_NO_PROFILE, not a codesign attempt', () => {
  const refused = gate({ profilePresent: false, profile: null });
  expect(refused).toMatchObject({ ok: false, code: 'STIM_NO_PROFILE' });
  expect('remedy' in refused && refused.remedy).toMatch(/Signing & Capabilities/);
  expect('remedy' in refused && refused.remedy).toMatch(/changes your Apple Developer account/);
});

test('a profile that will not decode is STIM_NO_PROFILE too', () => {
  expect(gate({ profile: null })).toMatchObject({ ok: false, code: 'STIM_NO_PROFILE' });
});

test('an expired profile is STIM_PROFILE_MISMATCH and the message names the date', () => {
  const refused = gate({ profile: profile('expired-profile.plist') });
  expect(refused).toMatchObject({ ok: false, code: 'STIM_PROFILE_MISMATCH' });
  expect('reason' in refused && refused.reason).toContain('2024-02-03');
});

test('a profile that is still in date but expires before now is refused on the boundary', () => {
  const expiry = Date.parse('2027-06-01T12:00:00Z');
  expect(gate({ now: expiry - 1 })).toMatchObject({ ok: true });
  expect(gate({ now: expiry })).toMatchObject({ ok: false, code: 'STIM_PROFILE_MISMATCH' });
});

test('an App Store or enterprise profile is refused by name, because it cannot prove the device', () => {
  const store = gate({ profile: profile('app-store-profile.plist') });
  expect(store).toMatchObject({ ok: false, code: 'STIM_PROFILE_MISMATCH' });
  expect('reason' in store && store.reason).toContain('App Store');
  expect('reason' in store && store.reason).toContain('ProvisionedDevices');
  expect('remedy' in store && store.remedy).toMatch(/development profile/);

  const enterprise = gate({ profile: profile('enterprise-profile.plist') });
  expect('reason' in enterprise && enterprise.reason).toContain('enterprise');
});

test('a development profile that does not list this phone is refused with the udid named', () => {
  const refused = gate({ udid: STRANGER });
  expect(refused).toMatchObject({ ok: false, code: 'STIM_PROFILE_MISMATCH' });
  expect('reason' in refused && refused.reason).toContain(STRANGER);
  expect('remedy' in refused && refused.remedy).toContain(STRANGER);
});

test('the device list is matched case-insensitively', () => {
  expect(gate({ udid: PHONE.toLowerCase() })).toMatchObject({ ok: true });
});

test('an empty keychain is STIM_NO_SIGNING_IDENTITY', () => {
  const refused = gate({ identities: [] });
  expect(refused).toMatchObject({ ok: false, code: 'STIM_NO_SIGNING_IDENTITY' });
  expect('remedy' in refused && refused.remedy).toMatch(/Xcode > Settings > Accounts/);
});

test('an artifact signed by someone else is detected before any codesign runs', () => {
  const refused = gate({
    identities: [{ sha1: 'C'.repeat(40), name: 'Apple Development: Someone Else (OTHERTEAM)' }],
  });
  expect(refused).toMatchObject({ ok: false, code: 'STIM_NO_SIGNING_IDENTITY' });
  expect('reason' in refused && refused.reason).toContain(JANE);
  expect('reason' in refused && refused.reason).toContain('Someone Else');
});

test('two certificates sharing a common name are refused rather than picked between', () => {
  const refused = gate({ identities: parseSigningIdentities(fixture('find-identity-duplicate.txt')) });
  expect(refused).toMatchObject({ ok: false, code: 'STIM_NO_SIGNING_IDENTITY' });
  expect('remedy' in refused && refused.remedy).toContain('ios.signingIdentitySha1');
});

test('ios.signingIdentitySha1 disambiguates and wins over the name', () => {
  expect(
    gate({
      identities: parseSigningIdentities(fixture('find-identity-duplicate.txt')),
      pinnedSha1: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }),
  ).toEqual({ ok: true, identity: { sha1: 'B'.repeat(40), name: JANE } });
});

test('a pinned sha1 that is not in the keychain refuses and lists what is', () => {
  const refused = gate({ pinnedSha1: 'D'.repeat(40) });
  expect(refused).toMatchObject({ ok: false, code: 'STIM_NO_SIGNING_IDENTITY' });
  expect('reason' in refused && refused.reason).toContain(JANE_SHA1);
});

test('ios.signingIdentity overrides the identity derived from the profile', () => {
  expect(gate({ pinnedName: 'Apple Distribution: Fixture Inc (TEAMID5678)' })).toEqual({
    ok: true,
    identity: {
      sha1: 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678',
      name: 'Apple Distribution: Fixture Inc (TEAMID5678)',
    },
  });
});

test('a profile whose certificate has no readable subject refuses with the settings escape hatch', () => {
  const refused = gate({ profile: { ...profile(), certificates: [] } });
  expect(refused).toMatchObject({ ok: false, code: 'STIM_NO_SIGNING_IDENTITY' });
  expect('remedy' in refused && refused.remedy).toContain('ios.signingIdentity');
});

test('the gate checks the profile before the keychain, so a bad profile is not masked', () => {
  const refused = gate({ profile: profile('expired-profile.plist'), identities: [] });
  expect(refused).toMatchObject({ ok: false, code: 'STIM_PROFILE_MISMATCH' });
});

test('the refusal remedies name the manual Xcode step rather than a flag Stim could pass', () => {
  for (const refused of [
    gate({ profilePresent: false, profile: null }),
    gate({ profile: profile('expired-profile.plist') }),
    gate({ profile: profile('app-store-profile.plist') }),
    gate({ udid: STRANGER }),
  ]) {
    expect('remedy' in refused && refused.remedy).toMatch(/build once from Xcode/);
  }
});

const SCRATCH_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.stimcli.scratch</string>
<key>CFBundleExecutable</key><string>Scratch</string>
<key>CFBundleName</key><string>Scratch</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`;

const SCRATCH_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>get-task-allow</key><true/>
<key>keychain-access-groups</key><array><string>TEAMID5678.*</string></array>
</dict></plist>
`;

const AD_HOC: SigningIdentity = { sha1: '', name: '-' };

function toolsAvailable(): boolean {
  if (process.platform !== 'darwin') return false;
  const exec = getExecutor();
  return ['codesign', 'security', 'clang', 'openssl'].every((tool) => exec.runQuiet(`command -v ${tool}`) !== null);
}

const LIVE = toolsAvailable() ? false : 'codesign, security, clang and openssl are not all available here';

describe('the re-seal primitive against the real codesign and security', { skip: LIVE as unknown as boolean }, () => {
  let dir: string;
  let appPath: string;

  function writeScratchApp(): void {
    appPath = join(dir, 'Scratch.app');
    mkdirSync(appPath, { recursive: true });
    writeFileSync(join(dir, 'main.c'), 'int main(void) { return 0; }\n');
    writeFileSync(join(appPath, 'Info.plist'), SCRATCH_INFO_PLIST);
    writeFileSync(join(dir, 'entitlements.plist'), SCRATCH_ENTITLEMENTS);
    writeFileSync(join(appPath, 'ip.txt'), '10.0.0.132:8081');
    const exec = getExecutor();
    exec.runFile('clang', ['-o', join(appPath, 'Scratch'), join(dir, 'main.c')]);
    exec.runFile('codesign', [
      '--force',
      '--sign',
      '-',
      '--entitlements',
      join(dir, 'entitlements.plist'),
      '--timestamp=none',
      appPath,
    ]);
  }

  function sealIsValid(): boolean {
    return getExecutor().runQuiet(`codesign --verify --strict ${JSON.stringify(appPath)}`) !== null;
  }

  function entitlementsOf(): string {
    return getExecutor().runFile('codesign', ['-d', '--entitlements', '-', '--xml', appPath]);
  }

  beforeEach(() => {
    resetExecutor();
    dir = mkdtempSync(join(tmpdir(), 'stim-reseal-'));
    writeScratchApp();
  });

  afterEach(() => {
    resetExecutor();
    rmSync(dir, { recursive: true, force: true });
  });

  test('rewriting a sealed resource really does break the seal, which is why the re-seal exists', () => {
    expect(sealIsValid()).toBe(true);
    writeFileSync(join(appPath, 'ip.txt'), '192.168.1.42:8085');
    expect(sealIsValid()).toBe(false);
  });

  test('the preferred form re-seals a mutated bundle and carries its entitlements over verbatim', () => {
    const before = entitlementsOf();
    writeFileSync(join(appPath, 'ip.txt'), '192.168.1.42:8085');
    expect(sealIsValid()).toBe(false);

    const result = resealBundle({ appPath, identity: AD_HOC });
    expect(result).toEqual({ ok: true, identity: AD_HOC, mode: 'preserve-metadata' });
    expect(sealIsValid()).toBe(true);
    expect(entitlementsOf()).toBe(before);
    expect(readFileSync(join(appPath, 'ip.txt'), 'utf-8')).toBe('192.168.1.42:8085');
    expect(entitlementsOf()).toContain('keychain-access-groups');
  });

  test('the entitlements fallback re-seals for real when --preserve-metadata is rejected', () => {
    const real = getExecutor();
    const before = entitlementsOf();
    writeFileSync(join(appPath, 'ip.txt'), '192.168.1.42:8085');
    setExecutor({
      runFile(file: string, args: string[], opts?: unknown) {
        if (file === 'codesign' && args.some((a) => a.startsWith('--preserve-metadata='))) {
          throw Object.assign(new Error('codesign: unknown option --preserve-metadata'), {
            stderr: 'codesign: unknown option --preserve-metadata',
          });
        }
        return real.runFile(file, args, opts as never);
      },
    });

    const result = resealBundle({ appPath, identity: AD_HOC });
    resetExecutor();
    expect(result).toEqual({ ok: true, identity: AD_HOC, mode: 'entitlements' });
    expect(sealIsValid()).toBe(true);
    expect(entitlementsOf()).toBe(before);
  });

  test('a bundle codesign will not sign reports STIM_CODESIGN_FAILED with the real stderr', () => {
    const result = resealBundle({ appPath: join(dir, 'Missing.app'), identity: AD_HOC });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: 'STIM_CODESIGN_FAILED' });
    expect('lastLines' in result && result.lastLines.join(' ')).toMatch(/Missing\.app/);
  });

  test('readEmbeddedProfile decodes a real CMS-wrapped profile through security cms -D', () => {
    const exec = getExecutor();
    const key = join(dir, 'signer.key');
    const pem = join(dir, 'signer.pem');
    exec.runFile('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      key,
      '-out',
      pem,
      '-days',
      '30',
      '-nodes',
      '-subj',
      `/CN=${JANE}/OU=TEAMID5678/O=Fixture Inc/C=US`,
    ]);
    const plist = join(dir, 'profile.plist');
    writeFileSync(plist, fixture('development-profile.plist'));
    exec.runFile('openssl', [
      'smime',
      '-sign',
      '-nodetach',
      '-binary',
      '-in',
      plist,
      '-signer',
      pem,
      '-inkey',
      key,
      '-outform',
      'DER',
      '-out',
      join(appPath, EMBEDDED_PROFILE),
    ]);

    const read = readEmbeddedProfile(appPath);
    expect(read.present).toBe(true);
    expect(read.profile?.provisionedDevices).toContain(PHONE);
    expect(read.profile?.expirationDate?.toISOString()).toBe('2027-06-01T12:00:00.000Z');
    expect(certificateCommonName(read.profile?.certificates[0])).toBe(JANE);
  }, 60_000);

  test('an app with no embedded.mobileprovision reads as absent rather than throwing', () => {
    expect(readEmbeddedProfile(appPath)).toEqual({ present: false, profile: null });
  });

  test('a profile that is not CMS at all reads as present but undecodable', () => {
    writeFileSync(join(appPath, EMBEDDED_PROFILE), 'not a CMS blob');
    expect(readEmbeddedProfile(appPath)).toEqual({ present: true, profile: null });
  });

  test('gateAppForDevice refuses a bundle with no profile, without reaching codesign', () => {
    const options: SigningGateOptions = { appPath, udid: PHONE, configuration: 'Release' };
    const gated = gateAppForDevice(options);
    expect(gated).toMatchObject({ ok: false, code: 'STIM_NO_PROFILE' });
    expect(sealIsValid()).toBe(true);
  });

  test('sealAppForDevice returns the gate refusal with no lines, so a caller can print one shape', () => {
    const failure = sealAppForDevice({ appPath, udid: PHONE }) as ResealFailure;
    expect(failure.ok).toBe(false);
    const codes: SigningRefusalCode[] = [
      'STIM_NO_PROFILE',
      'STIM_PROFILE_MISMATCH',
      'STIM_NO_SIGNING_IDENTITY',
      'STIM_CODESIGN_FAILED',
    ];
    expect(codes).toContain(failure.code);
    expect(failure.lastLines).toEqual([]);
  });

  test('sealAppForDevice refuses a real profile that does not name the target phone', () => {
    const exec = getExecutor();
    const key = join(dir, 'signer.key');
    const pem = join(dir, 'signer.pem');
    exec.runFile('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      key,
      '-out',
      pem,
      '-days',
      '30',
      '-nodes',
      '-subj',
      `/CN=${JANE}/OU=TEAMID5678/O=Fixture Inc/C=US`,
    ]);
    const plist = join(dir, 'profile.plist');
    writeFileSync(plist, fixture('development-profile.plist'));
    exec.runFile('openssl', [
      'smime',
      '-sign',
      '-nodetach',
      '-binary',
      '-in',
      plist,
      '-signer',
      pem,
      '-inkey',
      key,
      '-outform',
      'DER',
      '-out',
      join(appPath, EMBEDDED_PROFILE),
    ]);

    const refused = sealAppForDevice({ appPath, udid: STRANGER, now: BEFORE_EXPIRY });
    expect(refused).toMatchObject({ ok: false, code: 'STIM_PROFILE_MISMATCH' });
    expect('reason' in refused && refused.reason).toContain(STRANGER);
  }, 60_000);

  test('a successful re-seal reports which of the two forms sealed it', () => {
    writeFileSync(join(appPath, 'ip.txt'), '192.168.1.42:8085');
    const sealed = resealBundle({ appPath, identity: AD_HOC }) as ResealSuccess;
    const modes: ResealMode[] = ['preserve-metadata', 'entitlements', 'no-entitlements'];
    expect(modes).toContain(sealed.mode);
    expect(sealed.identity).toEqual(AD_HOC);
  });

  test('findSigningIdentities parses whatever this machine really has in its keychain', () => {
    for (const identity of findSigningIdentities()) {
      expect(identity.sha1).toMatch(/^[0-9A-F]{40}$/);
      expect(identity.name.length).toBeGreaterThan(0);
    }
  });
});
