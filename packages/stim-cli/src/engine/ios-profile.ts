import { X509Certificate } from 'node:crypto';

export type PlistValue = string | number | boolean | Date | Buffer | PlistValue[] | { [key: string]: PlistValue };

interface Cursor {
  xml: string;
  pos: number;
}

interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  end: number;
}

const TAG = /<(\/?)\s*([A-Za-z0-9_]+)(?:\s[^>]*?)?(\/?)>/g;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(raw: string): string {
  return raw.replace(/&(#x?[0-9A-Fa-f]+|[a-z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? match;
  });
}

function peekTag(cursor: Cursor): Tag | null {
  TAG.lastIndex = cursor.pos;
  const match = TAG.exec(cursor.xml);
  if (!match) return null;
  return {
    name: (match[2] ?? '').toLowerCase(),
    closing: match[1] === '/',
    selfClosing: match[3] === '/',
    end: TAG.lastIndex,
  };
}

function takeTag(cursor: Cursor): Tag | null {
  const tag = peekTag(cursor);
  if (tag) cursor.pos = tag.end;
  return tag;
}

function takeText(cursor: Cursor, name: string): string {
  const close = cursor.xml.indexOf(`</${name}>`, cursor.pos);
  if (close < 0) {
    cursor.pos = cursor.xml.length;
    return '';
  }
  const raw = cursor.xml.slice(cursor.pos, close);
  cursor.pos = close + name.length + 3;
  return raw;
}

function parseValue(cursor: Cursor): PlistValue | undefined {
  const tag = takeTag(cursor);
  if (!tag || tag.closing) return undefined;
  if (tag.selfClosing) {
    if (tag.name === 'true') return true;
    if (tag.name === 'false') return false;
    if (tag.name === 'array') return [];
    if (tag.name === 'dict') return {};
    return '';
  }
  switch (tag.name) {
    case 'plist': {
      const inner = parseValue(cursor);
      return inner;
    }
    case 'dict': {
      const out: { [key: string]: PlistValue } = {};
      for (;;) {
        const next = peekTag(cursor);
        if (!next) break;
        if (next.closing) {
          cursor.pos = next.end;
          break;
        }
        cursor.pos = next.end;
        if (next.name !== 'key') continue;
        const key = decodeEntities(next.selfClosing ? '' : takeText(cursor, 'key'));
        const value = parseValue(cursor);
        if (value !== undefined) out[key] = value;
      }
      return out;
    }
    case 'array': {
      const out: PlistValue[] = [];
      for (;;) {
        const next = peekTag(cursor);
        if (!next) break;
        if (next.closing) {
          cursor.pos = next.end;
          break;
        }
        const value = parseValue(cursor);
        if (value === undefined) break;
        out.push(value);
      }
      return out;
    }
    case 'string':
    case 'key':
      return decodeEntities(takeText(cursor, tag.name));
    case 'integer':
      return Number.parseInt(takeText(cursor, 'integer').trim(), 10);
    case 'real':
      return Number.parseFloat(takeText(cursor, 'real').trim());
    case 'date':
      return new Date(takeText(cursor, 'date').trim());
    case 'data':
      return Buffer.from(takeText(cursor, 'data').replace(/\s+/g, ''), 'base64');
    case 'true':
      takeText(cursor, 'true');
      return true;
    case 'false':
      takeText(cursor, 'false');
      return false;
    default:
      takeText(cursor, tag.name);
      return '';
  }
}

export function parsePlist(xml: unknown): PlistValue | null {
  if (typeof xml !== 'string' || xml.trim() === '') return null;
  const start = xml.indexOf('<plist');
  const cursor: Cursor = { xml, pos: start < 0 ? 0 : start };
  const value = parseValue(cursor);
  return value === undefined ? null : value;
}

export interface ProvisioningProfile {
  name: string | null;
  uuid: string | null;
  teamIdentifier: string | null;
  expirationDate: Date | null;
  provisionedDevices: string[] | null;
  provisionsAllDevices: boolean;
  getTaskAllow: boolean;
  certificates: Buffer[];
}

function isDict(value: PlistValue | null): value is { [key: string]: PlistValue } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !Buffer.isBuffer(value) &&
    !(value instanceof Date)
  );
}

function stringsOf(value: PlistValue | undefined): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === 'string');
}

export function parseProvisioningProfilePlist(xml: unknown): ProvisioningProfile | null {
  const root = parsePlist(xml);
  if (!isDict(root)) return null;
  const entitlements = isDict(root.Entitlements ?? null) ? (root.Entitlements as { [key: string]: PlistValue }) : {};
  const teamIdentifier = stringsOf(root.TeamIdentifier);
  const expiration = root.ExpirationDate;
  const certificates = Array.isArray(root.DeveloperCertificates)
    ? root.DeveloperCertificates.filter((v): v is Buffer => Buffer.isBuffer(v))
    : [];
  return {
    name: typeof root.Name === 'string' ? root.Name : null,
    uuid: typeof root.UUID === 'string' ? root.UUID : null,
    teamIdentifier: teamIdentifier?.[0] ?? null,
    expirationDate: expiration instanceof Date && !Number.isNaN(expiration.getTime()) ? expiration : null,
    provisionedDevices: stringsOf(root.ProvisionedDevices),
    provisionsAllDevices: root.ProvisionsAllDevices === true,
    getTaskAllow: entitlements['get-task-allow'] === true,
    certificates,
  };
}

export type ProfileKind = 'development' | 'ad hoc' | 'enterprise' | 'App Store';

export function provisioningProfileKind(profile: ProvisioningProfile): ProfileKind {
  if (profile.provisionedDevices) return profile.getTaskAllow ? 'development' : 'ad hoc';
  return profile.provisionsAllDevices ? 'enterprise' : 'App Store';
}

export function certificateCommonName(der: unknown): string | null {
  if (!Buffer.isBuffer(der) || der.length === 0) return null;
  let subject: string;
  try {
    subject = new X509Certificate(der).subject;
  } catch {
    return null;
  }
  for (const part of String(subject).split(/\r?\n/)) {
    const trimmed = part.trim();
    if (trimmed.startsWith('CN=')) return trimmed.slice(3).trim() || null;
  }
  const inline = /(?:^|,)\s*CN=([^,]+)/.exec(String(subject));
  return inline?.[1]?.trim() || null;
}

export interface SigningIdentity {
  sha1: string;
  name: string;
}

// `security find-identity -v -p codesigning` prints one numbered line per valid
// identity: `  1) <40 hex SHA-1> "Apple Development: Name (TEAMID)"`.
const IDENTITY_LINE = /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"(.+)"\s*$/;

export function parseSigningIdentities(text: unknown): SigningIdentity[] {
  if (typeof text !== 'string') return [];
  const out: SigningIdentity[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = IDENTITY_LINE.exec(line);
    if (!match) continue;
    out.push({ sha1: (match[1] as string).toUpperCase(), name: match[2] as string });
  }
  return out;
}

export const SIGNING_CODES = {
  noProfile: 'STIM_NO_PROFILE',
  profileMismatch: 'STIM_PROFILE_MISMATCH',
  noIdentity: 'STIM_NO_SIGNING_IDENTITY',
  codesignFailed: 'STIM_CODESIGN_FAILED',
} as const;

export type SigningRefusalCode = (typeof SIGNING_CODES)[keyof typeof SIGNING_CODES];

export interface SigningGateInput {
  profilePresent: boolean;
  profile: ProvisioningProfile | null;
  identities: SigningIdentity[];
  udid: string | null;
  configuration?: string | null;
  now?: number;
  pinnedName?: string | null;
  pinnedSha1?: string | null;
}

export interface SigningRefusal {
  ok: false;
  code: SigningRefusalCode;
  reason: string;
  remedy: string;
}

export type SigningGateResult = { ok: true; identity: SigningIdentity } | SigningRefusal;

const XCODE_STEP =
  'build once from Xcode to install it -- Stim will not, because registering a device or minting a profile changes your Apple Developer account.';

const KEYCHAIN_REMEDY =
  'Open Xcode > Settings > Accounts and download your certificates, or unlock the login keychain with `security unlock-keychain`. `security find-identity -v -p codesigning` should list `Apple Development: ...`.';

function signingConfiguration(input: SigningGateInput): string {
  return input.configuration ?? 'Debug';
}

export function signingGate(input: SigningGateInput): SigningGateResult {
  const now = input.now ?? Date.now();
  if (!input.profilePresent) {
    return {
      ok: false,
      code: SIGNING_CODES.noProfile,
      reason: 'The app bundle has no embedded.mobileprovision, so it was built unsigned or for the simulator.',
      remedy: `Set a team and profile for the target's ${signingConfiguration(input)} configuration in Xcode > Signing & Capabilities, then ${XCODE_STEP}`,
    };
  }
  if (!input.profile) {
    return {
      ok: false,
      code: SIGNING_CODES.noProfile,
      reason: "`security cms -D` could not decode the app bundle's embedded.mobileprovision.",
      remedy: `The profile inside the app is corrupt. Delete the build cache entry with \`stim gc --delete\`, then ${XCODE_STEP}`,
    };
  }
  const profile = input.profile;
  const named = profile.name ? `"${profile.name}"` : 'the embedded profile';
  if (!profile.expirationDate || profile.expirationDate.getTime() <= now) {
    return {
      ok: false,
      code: SIGNING_CODES.profileMismatch,
      reason: profile.expirationDate
        ? `The ${provisioningProfileKind(profile)} profile ${named} expired on ${profile.expirationDate.toISOString()}.`
        : `The ${provisioningProfileKind(profile)} profile ${named} carries no ExpirationDate, so Stim cannot prove it is still valid.`,
      remedy: `Renew the profile under Signing & Capabilities, then ${XCODE_STEP}`,
    };
  }
  if (!profile.provisionedDevices) {
    const kind = provisioningProfileKind(profile);
    return {
      ok: false,
      code: SIGNING_CODES.profileMismatch,
      reason: `${named} is an ${kind} profile, which carries no ProvisionedDevices list, so Stim cannot prove ${input.udid ?? 'the target device'} is admitted.`,
      remedy: `Local device runs need a development profile. Select one under Signing & Capabilities, then ${XCODE_STEP}`,
    };
  }
  const udid = input.udid;
  if (!udid || !profile.provisionedDevices.some((d) => d.toLowerCase() === udid.toLowerCase())) {
    return {
      ok: false,
      code: SIGNING_CODES.profileMismatch,
      reason: `The ${provisioningProfileKind(profile)} profile ${named} lists ${profile.provisionedDevices.length} device(s) and ${udid ?? 'the target device'} is not one of them.`,
      remedy: `Register ${udid ?? 'the device'} at developer.apple.com, regenerate the profile, then ${XCODE_STEP}`,
    };
  }

  const identities = Array.isArray(input.identities) ? input.identities : [];
  if (identities.length === 0) {
    return {
      ok: false,
      code: SIGNING_CODES.noIdentity,
      reason: '`security find-identity -v -p codesigning` lists no codesigning identity on this machine.',
      remedy: KEYCHAIN_REMEDY,
    };
  }
  if (input.pinnedSha1) {
    const wanted = input.pinnedSha1.trim().toUpperCase();
    const match = identities.find((i) => i.sha1 === wanted);
    if (match) return { ok: true, identity: match };
    return {
      ok: false,
      code: SIGNING_CODES.noIdentity,
      reason: `ios.signingIdentitySha1 is ${wanted}, which is not in the keychain. Available: ${identities.map((i) => `${i.sha1} "${i.name}"`).join(', ')}.`,
      remedy: KEYCHAIN_REMEDY,
    };
  }
  const wantedName = input.pinnedName?.trim() || certificateCommonName(profile.certificates[0] ?? null);
  if (!wantedName) {
    return {
      ok: false,
      code: SIGNING_CODES.noIdentity,
      reason: `Stim could not read a signing-identity name out of ${named}: its DeveloperCertificates entry has no readable subject CN.`,
      remedy:
        'Set ios.signingIdentity in .stim.json to the identity name to re-sign with, or ios.signingIdentitySha1 to its SHA-1 hash.',
    };
  }
  const matches = identities.filter((i) => i.name === wantedName);
  if (matches.length === 1) return { ok: true, identity: matches[0] as SigningIdentity };
  if (matches.length === 0) {
    return {
      ok: false,
      code: SIGNING_CODES.noIdentity,
      reason: `The app was signed by "${wantedName}", which is not in this machine's keychain. Available: ${identities.map((i) => `"${i.name}"`).join(', ')}.`,
      remedy: `${KEYCHAIN_REMEDY} Or set ios.signingIdentity in .stim.json to one of the identities listed above.`,
    };
  }
  return {
    ok: false,
    code: SIGNING_CODES.noIdentity,
    reason: `${matches.length} keychain identities share the name "${wantedName}", so Stim cannot pick one: ${matches.map((i) => i.sha1).join(', ')}.`,
    remedy: 'Set ios.signingIdentitySha1 in .stim.json to the SHA-1 hash of the certificate to sign with.',
  };
}
