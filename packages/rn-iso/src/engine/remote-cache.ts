// src/engine/remote-cache.js -- the SECOND level of the build cache: the
// project's OWN Expo build-cache provider.
//
// Level one is rn-iso's local cache (src/build-cache.js): a directory under
// $HOME shared by every worktree on this machine. It answers instantly and
// costs nothing, so it is always consulted first. Level two is whatever the
// project already told Expo to use -- `"buildCacheProvider": "eas"`, or a
// module of its own -- which is how a workspace that has never built this
// commit locally can still avoid compiling it. A remote hit is copied INTO
// the local cache on the way past, so the next worktree hits level one.
//
// rn-iso invokes the provider the same way the Expo CLI does, and every shape
// here is grounded in that code rather than in the docs:
//
//   packages/@expo/cli/src/utils/build-cache-providers/index.ts
//     resolveBuildCacheProvider()  'eas' -> the bundled `eas-build-cache-provider`
//                                  package; { plugin: <ref> } -> resolveFrom(projectRoot, ref)
//     resolveBuildCache()          plugin.resolveBuildCache({ fingerprintHash, platform,
//                                  runOptions, projectRoot }, options) -> string | null
//     uploadBuildCache()           plugin.uploadBuildCache({ projectRoot, platform,
//                                  fingerprintHash, buildPath, runOptions }, options)
//     calculateFingerprintHashAsync()  prefers plugin.calculateFingerprintHash when the
//                                  plugin defines one, else @expo/fingerprint
//     resolvePluginFunction()      require()s the module, unwraps `.default`, and asserts
//                                  the resolve/upload pair exists
//   packages/@expo/cli/src/run/ios/options/resolveOptions.ts:51-53 and
//   packages/@expo/cli/src/run/android/resolveOptions.ts:46-48
//     exp.buildCacheProvider ?? exp.experiments.buildCacheProvider -- the SDK 53
//     key is still read as a fallback, so both are honoured here too.
//   packages/@expo/config/src/buildCacheProvider.ts
//     BuildCacheProviderPlugin, including the deprecated resolveRemoteBuildCache /
//     uploadRemoteBuildCache pair the CLI still calls when it is the one present.
//
// THREE THINGS THIS DELIBERATELY DOES NOT DO.
//
// 1. It never installs anything and never edits the project's config. The
//    Expo CLI's 'eas' branch calls ensureDependenciesAsync with
//    isProjectMutable: true and installs `eas-build-cache-provider` on the
//    fly; rn-iso is a broker running inside someone's agent loop, so a
//    missing package is a REASON reported once, not a mutation.
// 2. It never consults a provider on a bare React Native project. The
//    community CLI has no provider concept, so there is nothing configured to
//    honour and a network call would be pure invention.
// 3. It never lets a provider fail a run. Every call is bounded and every
//    throw becomes a note: the local cache and the build below it still work,
//    and an agent loop that stalls for four minutes on someone's expired EAS
//    session is a worse outcome than a rebuild.
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { format } from 'node:util';
import { getExecutor } from '../exec.ts';
import { createNdjsonWriter, type NdjsonWriter } from '../ndjson.ts';
import { workspaceLogsDir } from '../paths.ts';
import { resolvePackageJson } from '../project.ts';
// The SAME two helpers engine/prebuild.js uses to find a project's own expo
// binary. Imported rather than re-derived: a fourth copy of "where is this
// package's executable" is how the config path below came to look only at
// <root>/node_modules/.bin, which no hoisted monorepo has.
import { expoBinFromPackage, expoBinPath, findBinUpward } from '../supervisor/server-expo.ts';

// The package the Expo CLI maps 'eas' to (build-cache-providers/index.ts:29-44).
// Resolved FROM THE PROJECT, so the version that answers is the one the
// project's own `expo run:ios` would have used.
export const EAS_PROVIDER_PACKAGE = 'eas-build-cache-provider';

// rn-iso's own provider package addresses the SAME directory with the SAME key
// rules as src/build-cache.js (that equivalence is what test/cache-packages.test.js
// pins). A project that configured it has already been asked, and asking again
// after a local miss can only miss again -- and then "upload" a copy into the
// entry that was just written. So it is treated as no remote provider at all.
export const LOCAL_PROVIDER_PACKAGE = '@rn-iso/expo-build-cache';

// How long the provider gets. These are constants, not settings: a knob here
// would be a knob for "how long may my dev loop hang", which is not a question
// a project should have to answer. The numbers come from what the EAS provider
// actually does -- `npx eas-cli build:download` (a metadata query plus a
// download) and `npx eas-cli upload` (an upload of a whole .app) -- and both
// are generous enough that only a wedged or unauthenticated call hits them.
export const RESOLVE_TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 60_000;
// Evaluating a dynamic app.config.ts means TypeScript compilation plus the
// whole config-plugin pipeline on a cold cache. It is only paid on a local
// cache MISS, and only on a project whose config is code.
export const CONFIG_TIMEOUT_MS = 30_000;

// The config files that are PROGRAMS. Expo evaluates these on top of app.json,
// so when one exists the static read below is not the answer -- the provider
// may be added, changed or removed by the code in it.
const DYNAMIC_CONFIG_FILES = ['app.config.ts', 'app.config.js', 'app.config.mjs', 'app.config.cjs'];

const TIMED_OUT = Symbol('timed-out');

// The project's config (app.json, or `expo config --json`'s output): genuinely
// dynamic third-party JSON, read field-by-field rather than trusted wholesale.
type ProjectConfig = Record<string, unknown>;

// A `getExecutor().runFile`-shaped call, injectable independently of
// getExecutor() for tests.
type ExecFileFn = (file: string, args: string[], opts?: { timeoutMs?: number }) => string;

// FLAT rather than a discriminated union -- see readProjectConfig's doc comment.
interface ReadProjectConfigResult {
  config?: ProjectConfig | null;
  source?: string | null;
  unavailable?: string;
}

// FLAT: the configured provider value, decoded, or why it could not be.
interface NormalizedProvider {
  name?: string;
  reference?: string;
  options?: Record<string, unknown>;
  invalid?: string;
}

// A provider plugin's shape (build-cache-providers): loaded via require()/
// import() from a project dependency, so its own internals are genuinely
// dynamic -- only the entry points this module calls are named.
export interface ProviderPlugin {
  resolveBuildCache?: (props: unknown, options: unknown) => unknown;
  resolveRemoteBuildCache?: (props: unknown, options: unknown) => unknown;
  uploadBuildCache?: (props: unknown, options: unknown) => unknown;
  uploadRemoteBuildCache?: (props: unknown, options: unknown) => unknown;
  calculateFingerprintHash?: (props: unknown, options: unknown) => unknown;
}

interface LoadedProvider {
  plugin: ProviderPlugin;
  options: Record<string, unknown>;
}

// FLAT -- see loadProjectProvider's doc comment for the three outcomes.
export interface LoadProjectProviderResult {
  provider?: LoadedProvider;
  name?: string;
  owner?: string | null;
  none?: true;
  unavailable?: string;
}

// FLAT -- see parseWhoami's doc comment for the three outcomes.
interface WhoamiResult {
  loggedOut?: true;
  unknown?: string;
  loggedIn?: true;
  account?: string;
  accounts?: string[] | null;
  viaToken?: boolean;
}

interface EasAuthNoteStatus {
  code?: string;
  account?: string | null;
  owner?: string;
  reason?: string;
  phase?: 'resolve' | 'upload';
}

// FLAT -- see checkEasAuth's doc comment for the three outcomes.
export interface EasAuthResult {
  ok?: true;
  account?: string | null;
  accounts?: string[] | null;
  viaToken?: boolean;
  source?: string;
  failed?: true;
  code?: 'no-cli' | 'logged-out' | 'wrong-account';
  reason?: string;
  remedy?: string;
  owner?: string;
  unknown?: string;
}

// FLAT -- see resolveRemote's doc comment for the four outcomes.
export interface RemoteCacheResolveResult {
  appPath?: string;
  failed?: string;
  timedOut?: true;
}

// FLAT -- see uploadRemote's doc comment for the four outcomes.
export interface RemoteCacheUploadResult {
  uploaded?: true;
  destination?: string;
  failed?: string;
  timedOut?: true;
  skipped?: true;
}

// A capture frame's stdout-writer: either the caller's own NdjsonWriter, or
// one this module opens lazily on the first line.
interface CaptureFrame {
  lines: string[];
  pending: string;
  onLine?: ((line: string) => void) | null;
  writer: () => NdjsonWriter | null;
  close: () => void;
}

interface BudgetOutcome {
  value?: unknown;
  error?: unknown;
  timedOut?: true;
  lines: string[];
}

// --- pure ------------------------------------------------------------------

// PURE(one existsSync per candidate). Which dynamic config a project has, or null.
export function dynamicConfigFile(root: string): string | null {
  for (const name of DYNAMIC_CONFIG_FILES) {
    if (existsSync(join(root, name))) return name;
  }
  return null;
}

// PURE. The provider value out of a config object, whichever shape it arrived
// in: `app.json` nests it under `expo`, while `expo config --json` prints the
// already-unwrapped `exp`. The key moved out of `experiments` when it was
// promoted, and the Expo CLI still reads the old one as a fallback, so both
// resolve here in the same order the CLI uses.
export function providerFromConfig(config?: ProjectConfig | null): unknown {
  if (!config || typeof config !== 'object') return null;
  const expoField = (config as { expo?: unknown }).expo;
  const exp = (expoField && typeof expoField === 'object' ? expoField : config) as {
    buildCacheProvider?: unknown;
    experiments?: { buildCacheProvider?: unknown };
  };
  return exp.buildCacheProvider ?? exp.experiments?.buildCacheProvider ?? null;
}

// PURE. The Expo account that owns this project, out of either config shape.
//
// `expo.owner` is the only place a project states it (@expo/config-types:
// "The name of the Expo account that owns the project ... If not provided, the
// owner defaults to the username of the current user"). eas.json does NOT
// carry one -- @expo/eas-json's schema has no owner field at all, which was
// checked rather than assumed -- so there is no second place to look. The
// authoritative owner for a project that has an EAS projectId lives on the
// server and costs a network round trip; this is the local, free half, and it
// is only ever used to WARN.
export function ownerFromConfig(config?: ProjectConfig | null): string | null {
  if (!config || typeof config !== 'object') return null;
  const expoField = (config as { expo?: unknown }).expo;
  const exp = (expoField && typeof expoField === 'object' ? expoField : config) as { owner?: unknown };
  const owner = exp.owner;
  return typeof owner === 'string' && owner.trim() !== '' ? owner.trim() : null;
}

// PURE. The configured value -> what to load and what to call it.
// null when nothing is configured, { invalid } when it is a shape the Expo CLI
// itself would throw on ("Invalid build cache provider").
// `raw` is whatever a project's config put under buildCacheProvider: genuinely
// dynamic third-party JSON, asserted into shape below rather than trusted.
export function normalizeProvider(raw: unknown): NormalizedProvider | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw === 'eas') return { name: 'eas', reference: EAS_PROVIDER_PACKAGE, options: {} };
  if (typeof raw === 'object') {
    const obj = raw as { plugin?: unknown; options?: unknown };
    if (typeof obj.plugin === 'string' && obj.plugin.trim() !== '') {
      const reference = obj.plugin.trim();
      return {
        name: reference,
        reference,
        options: obj.options && typeof obj.options === 'object' ? (obj.options as Record<string, unknown>) : {},
      };
    }
  }
  return { invalid: typeof raw === 'string' ? `"${raw}"` : JSON.stringify(raw) };
}

// PURE. The run options handed to the provider. rn-iso builds exactly one
// thing -- a Debug build for a simulator/emulator -- so these are facts, not
// inference. They are not decoration: eas-build-cache-provider reads
// `configuration` / `variant` to decide whether to ask EAS for a dev-client
// build (build/helpers.js, isDevClientBuild), and getting that wrong fetches a
// binary that cannot talk to this workspace's dev server.
export function runOptionsFor(platform?: string | null): { variant: string } | { configuration: string } {
  return platform === 'android' ? { variant: 'debug' } : { configuration: 'Debug' };
}

// PURE. The Expo CLI's own plugin assertion (resolvePluginFunction), including
// its acceptance of the deprecated method pair.
export function isProviderPlugin(plugin: unknown): plugin is ProviderPlugin {
  if (!plugin || typeof plugin !== 'object') return false;
  const p = plugin as ProviderPlugin;
  const resolves = typeof p.resolveBuildCache === 'function' || typeof p.resolveRemoteBuildCache === 'function';
  const uploads = typeof p.uploadBuildCache === 'function' || typeof p.uploadRemoteBuildCache === 'function';
  return resolves && uploads;
}

// PURE. Which level of the cache answered, as a value rather than a boolean.
//
// There are three outcomes and a boolean can only carry two: 'local' (this
// machine's shared cache), 'remote' (the project's own provider, whose artifact
// is copied into the local cache on the way past) and false (nothing answered,
// so it was compiled). An agent reading `true` cannot tell a free install from
// one that cost a download, and the two are not the same thing to plan around.
export function cacheLevel(value: unknown): 'local' | 'remote' | false {
  return value === 'local' || value === 'remote' ? value : false;
}

// Exit once stdout has actually drained.
//
// A provider call that was abandoned at its bound may still hold the child
// process the provider spawned, and node does not exit while that handle is
// open -- an agent's `rn-iso ios` would sit there long after the app launched.
// The command calls this when it is otherwise DONE. `console.log` on a pipe is
// asynchronous, so a bare process.exit() would truncate the ONE line these
// commands put on stdout (the --json payload a caller captured with `$(...)`),
// which is why the exit rides on the write's callback. `exit` is read at call
// time, so a test that stubbed process.exit gets its own stub back.
export function exitAfterFlush(
  code = 0,
  {
    exit = (c: number) => process.exit(c),
    stream = process.stdout,
  }: { exit?: (code: number) => void; stream?: NodeJS.WriteStream } = {},
): void {
  try {
    stream.write('', () => exit(code));
  } catch {
    exit(code);
  }
}

// --- config ----------------------------------------------------------------

// The project's config, read the cheapest honest way.
//
// A static app.json is parsed directly. A config that is CODE is evaluated by
// the PROJECT'S OWN expo binary -- `<root>/node_modules/.bin/expo config --json
// <root>` -- for the same reason engine/prebuild.js refuses `npx expo`: npx on
// a project whose expo is not installed downloads whatever is newest and
// answers from a different SDK's rules. Failure to evaluate is `unavailable`,
// never a guess: this codebase does not execute the config in-process either,
// because that would run arbitrary project code inside rn-iso.
export function readProjectConfig(
  root: string,
  { run = null, timeoutMs = CONFIG_TIMEOUT_MS }: { run?: ExecFileFn | null; timeoutMs?: number } = {},
): ReadProjectConfigResult {
  const dynamic = dynamicConfigFile(root);
  if (!dynamic) {
    const file = join(root, 'app.json');
    if (!existsSync(file)) return { config: null, source: null };
    try {
      return { config: JSON.parse(readFileSync(file, 'utf-8')), source: 'app.json' };
    } catch (err) {
      return { unavailable: `app.json could not be parsed: ${firstLine(err)}` };
    }
  }

  // THE PROJECT'S OWN expo, found by NODE RESOLUTION rather than by joining
  // <root>/node_modules/.bin/expo -- which is the path a hoisted monorepo does
  // not have. Observed on a real pnpm workspace: every app.config.ts project
  // reported "node_modules/.bin/expo does not exist" and the whole remote tier
  // was dead there, silently, behind a note that read like a missing install.
  // expoBinPath tries `expo/package.json`'s own bin field first and only then
  // walks node_modules/.bin UPWARD, so the hoisted copy is found either way.
  const bin = expoBinPath(root);
  if (!bin) {
    return {
      unavailable:
        `${dynamic} is code, so it has to be evaluated to read its buildCacheProvider, ` +
        'and the `expo` package is not resolvable from this project ' +
        '(no expo/package.json to read a bin from, and no node_modules/.bin/expo here or in any parent)',
    };
  }
  const exec: ExecFileFn = run || ((file, args, opts) => getExecutor().runFile(file, args, opts));
  let stdout;
  try {
    // The project root is passed as the positional argument rather than relied
    // on through cwd (`getProjectRoot` in @expo/cli/src/utils/args.ts), so the
    // answer is about THIS workspace whatever directory the command was run
    // from.
    stdout = exec(bin, ['config', '--json', root], { timeoutMs });
  } catch (err) {
    return { unavailable: `\`expo config --json\` failed: ${firstLine(err)}` };
  }
  try {
    return { config: JSON.parse(String(stdout)), source: dynamic };
  } catch (err) {
    return { unavailable: `\`expo config --json\` did not print JSON: ${firstLine(err)}` };
  }
}

// --- the plugin ------------------------------------------------------------

// Resolved FROM THE PROJECT, exactly like the Expo CLI's resolveFrom(projectRoot,
// ref): a provider is a project dependency, and rn-iso resolving it from its own
// node_modules would load a different copy -- or, worse, resolve one the project
// never installed.
//
// require() first (every published provider is CommonJS, and the EAS one is), with
// a dynamic import() fallback for an ESM module, whose require() throws
// ERR_REQUIRE_ESM on the Node versions this CLI supports.
export async function loadPlugin(
  projectRoot: string,
  reference: string,
  { requireFrom = null }: { requireFrom?: ((root: string) => NodeRequire) | null } = {},
): Promise<ProviderPlugin> {
  const require_ = requireFrom ? requireFrom(projectRoot) : createRequire(join(projectRoot, 'package.json'));
  const file = require_.resolve(reference);
  let mod;
  try {
    mod = require_(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ERR_REQUIRE_ESM') throw err;
    mod = await import(pathToFileURL(file).href);
  }
  const plugin = mod?.default ?? mod;
  if (!isProviderPlugin(plugin)) {
    throw new Error(`"${reference}" does not export resolveBuildCache and uploadBuildCache functions`);
  }
  return plugin;
}

/**
 * The project's configured provider, ready to call.
 *
 *   { provider: { plugin, options }, name }  a provider to consult
 *   { none: true }                           nothing configured (the ordinary case)
 *   { unavailable: reason }                  configured but not usable right now
 *
 * `none` and `unavailable` are different on purpose. Nothing configured is not
 * a problem and says nothing; a provider that is configured and could not be
 * loaded is worth ONE line, because the alternative is a project that believes
 * it has a remote cache and silently rebuilds forever.
 */
export async function loadProjectProvider(
  projectRoot: string,
  {
    isExpo = true,
    run = null,
    requireFrom = null,
    timeoutMs = CONFIG_TIMEOUT_MS,
  }: {
    isExpo?: boolean;
    run?: ExecFileFn | null;
    requireFrom?: ((root: string) => NodeRequire) | null;
    timeoutMs?: number;
  } = {},
): Promise<LoadProjectProviderResult> {
  // Bare React Native: the community CLI has no provider concept, so there is
  // no config to read and nothing to call. No config evaluation, no network.
  if (!isExpo) return { none: true };

  const read = readProjectConfig(projectRoot, { run, timeoutMs });
  if (read.unavailable) return { unavailable: read.unavailable };

  const normalized = normalizeProvider(providerFromConfig(read.config));
  if (!normalized) return { none: true };
  if (normalized.invalid) {
    return { unavailable: `buildCacheProvider is ${normalized.invalid}, which is not "eas" or { plugin: <module> }` };
  }
  // See LOCAL_PROVIDER_PACKAGE: it IS level one.
  if (normalized.reference === LOCAL_PROVIDER_PACKAGE) return { none: true };

  let plugin: ProviderPlugin;
  try {
    plugin = await loadPlugin(projectRoot, normalized.reference!, { requireFrom });
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException)?.code === 'MODULE_NOT_FOUND';
    return {
      unavailable:
        normalized.name === 'eas' && missing
          ? // The Expo CLI installs this package on the fly. rn-iso reports it
            // instead (see the header): installing into someone's project mid-loop
            // is not a broker's call.
            `the EAS build cache needs the \`${EAS_PROVIDER_PACKAGE}\` package, which is not installed in this project`
          : `${normalized.name} could not be loaded: ${firstLine(err)}`,
    };
  }
  // The owner rides along because the caller has no other cheap way to get it:
  // reading it means reading the config, and on a dynamic config that is a
  // whole `expo config --json` this function has already paid for.
  return {
    provider: { plugin, options: normalized.options ?? {} },
    name: normalized.name,
    owner: ownerFromConfig(read.config),
  };
}

// --- EAS authentication ------------------------------------------------------
//
// WHY THIS EXISTS AT ALL: eas-build-cache-provider SWALLOWS every failure.
// Both entry points are `try { spawn('npx', ['eas-cli', ...]) } catch { return
// null }` (eas-build-cache-provider@21.0.0, build/index.js), so a project whose
// EAS session has expired gets a CLEAN MISS on every lookup and a null from
// every upload -- from rn-iso's side, indistinguishable from a cache that
// happened to hold nothing. There is no error text to classify and nothing to
// report, which is how a team's shared cache can be off for weeks with nobody
// seeing a line about it. `eas whoami` is the only cheap way to know.
// (That same file also returns null before doing anything when the project has
// no eas.json, which is worth knowing when a cache "never hits".)
//
// WHAT `eas whoami` DOES. Verified two ways: read in the eas-cli installed on
// this machine (18.0.3, build/commands/account/view.js -- `whoami` is an ALIAS
// of `account:view`), and observed live, both states, on 2026-08-25.
//   logged in    exit 0. stdout is the actor's DISPLAY NAME, then -- only when
//                the actor belongs to an account that is not its own personal
//                one -- a blank line, "Accounts:", and one
//                "<bullet> <name> (Role: <role>)" line per account.
//   EXPO_TOKEN   the same, with " (authenticated using EXPO_TOKEN)" appended to
//                the display name. SessionManager.getAccessToken() reads
//                process.env.EXPO_TOKEN and nothing else.
//   logged out   exit 1, stdout "Not logged in" (Log.warn -> console.log, so it
//                is on stdout, not stderr). Nothing is fetched on this path:
//                getUserAsync() only queries when a session secret or a token
//                exists, so it answers instantly.
//   --json       DOES NOT EXIST. `eas whoami --json` is accepted and ignored,
//                printing the same human text, so parsing that text is the only
//                option there is.
// The session lives in ~/.expo/state.json under `auth` (getStateJsonPath()),
// shared with the Expo CLI; EXPO_TOKEN overrides it.
//
// COST: 0.30s user, 0.8s wall on this machine while logged in -- one GraphQL
// query for the actor. It IS a network call whenever a session exists, and that
// is exactly why anything other than the literal "Not logged in" is UNKNOWN
// rather than an auth failure: a plane, a VPN or a DNS hiccup must never read
// as "you are logged out", and must never produce advice to log in again.
//
// WHAT THIS IS NOT ALLOWED TO DO: fail a build. A broken EAS session costs the
// team tier; the local cache underneath it still answers, and the build below
// that still runs. Every outcome here is a NOTE (or a doctor finding), never an
// error code.
export const WHOAMI_TIMEOUT_MS = 15_000;

// The package that carries the `eas` executable, and the name of that
// executable in its bin map.
const EAS_CLI_PACKAGE = 'eas-cli';
const EAS_CLI_BIN = 'eas';

// PURE. `eas whoami`'s output -> what is actually known.
//
//   { loggedIn, account, accounts, viaToken }  a session
//   { loggedOut: true }                        definitively no session
//   { unknown: reason }                        anything else, including offline
//
// `accounts` is null when the output did not enumerate them and the display
// name cannot stand in for one. That happens for a ROBOT actor
// (getActorDisplayName returns "robot" / "<first> (robot)" and getActorUsername
// returns null for it), and it is the reason wrong-account is a warning
// everywhere rather than a rule: an account list that could not be read must
// never contradict a configured owner.
export function parseWhoami({
  stdout = '',
  stderr = '',
  exitCode = 0,
}: { stdout?: string; stderr?: string; exitCode?: number } = {}): WhoamiResult {
  const out = stripAnsi(stdout);
  const combined = `${out}\n${stripAnsi(stderr)}`;
  if (/^\s*Not logged in\s*$/m.test(combined)) return { loggedOut: true };
  if (exitCode !== 0) {
    return { unknown: firstLine(combined.trim() || `eas whoami exited ${exitCode}`) };
  }
  const lines = out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return { unknown: 'eas whoami printed nothing' };

  const raw = lines[0];
  if (raw === undefined) return { unknown: 'eas whoami printed nothing' };
  const viaToken = /\(authenticated using EXPO_TOKEN\)\s*$/.test(raw);
  const display = raw.replace(/\s*\(authenticated using EXPO_TOKEN\)\s*$/, '').trim();

  // "<bullet> <name> (Role: <role>)". The bullet is written as an escape
  // because this file is ASCII (CLAUDE.md), and the role is not read: a Viewer
  // on an account is still ON the account, and what the cache needs is access,
  // which the server decides.
  const accounts: string[] = [];
  for (const line of lines) {
    const m = /^\u2022\s*(\S+)\s*\(Role:/.exec(line);
    const name = m?.[1];
    if (name !== undefined) accounts.push(name);
  }
  if (accounts.length === 0 && !display.endsWith('(robot)') && display !== 'robot') {
    // No Accounts block is printed when the personal account is the only one,
    // so the display name IS the account list (account/view.js filters the
    // list by `account.name !== actor.username` and prints nothing when that
    // leaves nothing).
    accounts.push(display);
  }
  return {
    loggedIn: true,
    account: display,
    accounts: accounts.length ? accounts : null,
    viaToken,
  };
}

// PURE. Does this text -- a provider's error, a transcript line -- say the
// failure was authentication? Deliberately narrow: the point of the check is to
// replace a generic note with a specific one, and a false positive would send
// somebody to `eas login` over a network blip.
export function isEasAuthFailureText(text?: string | null): boolean {
  const t = stripAnsi(text || '');
  if (t.trim() === '') return false;
  return (
    /not logged in/i.test(t) ||
    /\beas login\b/i.test(t) ||
    /EXPO_TOKEN/.test(t) ||
    /unauthorized/i.test(t) ||
    /not authorized/i.test(t) ||
    /authentication (failed|required)/i.test(t)
  );
}

// PURE. The ONE line a build prints about this, or null.
//
// Both call sites share it so the wording cannot drift: the pre-flight below,
// and the provider-failed branches in ios/android, which classify their reason
// text with isEasAuthFailureText. A logged-out run says what it is going to do
// instead (the local cache); a wrong-account run says it is proceeding anyway,
// because the account list may be incomplete and access is the server's to
// decide.
export function easAuthNote(status?: EasAuthNoteStatus | null): string | null {
  const { code, account, owner, reason, phase = 'resolve' } = status || {};
  const because = reason ? ` (${reason})` : '';
  if (code === 'logged-out') {
    return (
      `eas is not authenticated${because} -- run \`eas login\` (or set EXPO_TOKEN); ` +
      (phase === 'upload' ? 'this build stayed in the local cache' : 'building with the local cache only')
    );
  }
  if (code === 'wrong-account') {
    return (
      `eas is authenticated as ${account}, and this project's owner is ${owner} -- ` +
      `run \`eas login\` as a member of ${owner} (or set EXPO_TOKEN); consulting the EAS cache anyway`
    );
  }
  return null;
}

// The project's own eas-cli, then the machine's. PROJECT-FIRST like everything
// else here, and by node resolution rather than by path joining, so a hoisted
// monorepo (where <root>/node_modules/.bin is empty) resolves the copy the
// project actually installed. Never `npx eas-cli`: npx would DOWNLOAD a CLI
// nobody chose, which is a network install inside a diagnostic.
//
// The PATH fallback is deliberate and is not a fourth guess -- `eas` installed
// globally (npm i -g eas-cli, or Homebrew, which is what this machine has) is
// the ordinary way to hold a session, and the session it reads is the same
// ~/.expo/state.json either way.
export function resolveEasCliBin(
  projectRoot: string,
  { lookupPath = null, timeoutMs = 5000 }: { lookupPath?: (() => string | null) | null; timeoutMs?: number } = {},
): { file: string; source: 'project' | 'path' } | null {
  const fromPackage = expoBinFromPackage(resolvePackageJson(projectRoot, EAS_CLI_PACKAGE), EAS_CLI_BIN);
  if (fromPackage) return { file: fromPackage, source: 'project' };
  const shim = findBinUpward(projectRoot, EAS_CLI_BIN);
  if (shim) return { file: shim, source: 'project' };
  const onPath = lookupPath ? lookupPath() : getExecutor().runQuiet(`command -v ${EAS_CLI_BIN}`, { timeoutMs });
  const file = (String(onPath || '').split('\n')[0] ?? '').trim();
  return file ? { file, source: 'path' } : null;
}

// One answer per command run. `ios` asks before the resolve and again before
// the upload, and `doctor` asks once; three whoami calls to learn the same
// fact would be three network round trips.
const easAuthCache = new Map<string, EasAuthResult>();

export function resetEasAuthCache(): void {
  easAuthCache.clear();
}

/**
 * Is this machine's eas-cli usable for THIS project's cache?
 *
 *   { ok: true, account, accounts, viaToken, source }
 *   { failed: true, code: 'no-cli' | 'logged-out' | 'wrong-account', reason, remedy, ... }
 *   { unknown: reason }   could not be established -- offline, timed out, or an
 *                         output shape this does not recognise
 *
 * Never throws, and `unknown` is never treated as a failure by any caller: an
 * offline machine still builds.
 */
interface CheckEasAuthOptions {
  projectRoot: string;
  owner?: string | null;
  run?: ExecFileFn | null;
  resolveBin?: ((root: string) => { file: string; source: 'project' | 'path' } | null) | null;
  timeoutMs?: number;
  cache?: Map<string, EasAuthResult> | null;
}

// execFileSync throws this shape on a non-zero exit AND on a timeout.
type ExecFileSyncError = NodeJS.ErrnoException & {
  signal?: string | null;
  killed?: boolean;
  stdout?: unknown;
  stderr?: unknown;
  status?: number | null;
};

export function checkEasAuth({
  projectRoot,
  owner = null,
  run = null,
  resolveBin = null,
  timeoutMs = WHOAMI_TIMEOUT_MS,
  cache = easAuthCache,
}: CheckEasAuthOptions): EasAuthResult {
  const key = `${projectRoot}::${owner || ''}`;
  if (cache?.has(key)) return cache.get(key)!;
  const answer = probeEasAuth({ projectRoot, owner, run, resolveBin, timeoutMs });
  cache?.set(key, answer);
  return answer;
}

function probeEasAuth({
  projectRoot,
  owner,
  run,
  resolveBin,
  timeoutMs,
}: {
  projectRoot: string;
  owner?: string | null;
  run?: ExecFileFn | null;
  resolveBin?: ((root: string) => { file: string; source: 'project' | 'path' } | null) | null;
  timeoutMs?: number;
}): EasAuthResult {
  const bin = (resolveBin || resolveEasCliBin)(projectRoot);
  if (!bin) {
    return {
      failed: true,
      code: 'no-cli',
      reason: 'no `eas` executable is resolvable from this project or on PATH',
      remedy: 'Install eas-cli (`npm i -g eas-cli`, or as a project devDependency), then run `eas login`.',
    };
  }

  const exec: ExecFileFn = run || ((file, args, opts) => getExecutor().runFile(file, args, opts));
  let result: { stdout: string; stderr?: string; exitCode: number };
  try {
    result = { stdout: String(exec(bin.file, ['whoami'], { timeoutMs }) ?? ''), exitCode: 0 };
  } catch (e) {
    const err = e as ExecFileSyncError;
    // execFileSync throws on a non-zero exit AND on a timeout, and the two mean
    // opposite things here, so the timeout is separated before the output is
    // read: a SIGTERMed child has no verdict in its stdout.
    if (err?.code === 'ETIMEDOUT' || err?.signal === 'SIGTERM' || err?.killed) {
      return { unknown: `eas whoami timed out after ${timeoutMs}ms` };
    }
    result = {
      stdout: String(err?.stdout ?? ''),
      stderr: String(err?.stderr ?? err?.message ?? ''),
      exitCode: typeof err?.status === 'number' ? err.status : 1,
    };
  }

  const parsed = parseWhoami(result);
  if (parsed.loggedOut) {
    return {
      failed: true,
      code: 'logged-out',
      reason: 'eas whoami says "Not logged in"',
      remedy: 'Run `eas login` (or set EXPO_TOKEN).',
    };
  }
  if (parsed.unknown) return { unknown: parsed.unknown };

  // Wrong-account is only ever claimed when the accounts were actually
  // enumerated. See parseWhoami: a robot actor prints a display name that is
  // not an account name at all, and an unknown list must not contradict a
  // configured owner.
  if (owner && Array.isArray(parsed.accounts) && !parsed.accounts.includes(owner)) {
    return {
      failed: true,
      code: 'wrong-account',
      account: parsed.account,
      accounts: parsed.accounts,
      owner,
      reason:
        `eas is authenticated as ${parsed.account} (accounts: ${parsed.accounts.join(', ')}), ` +
        `which does not include this project's owner ${owner}`,
      remedy: `Run \`eas login\` as a member of ${owner}, or set EXPO_TOKEN to a token for it.`,
    };
  }
  return {
    ok: true,
    account: parsed.account,
    accounts: parsed.accounts,
    viaToken: parsed.viaToken,
    source: bin.source,
  };
}

// --- the provider's stdout ---------------------------------------------------
//
// A provider plugin is a FUNCTION CALL, not a subprocess: resolveBuildCache and
// uploadBuildCache run in this process, and whatever they print goes to the
// same fd 1 that carries `ios --json`'s single payload line.
// eas-build-cache-provider prints on every call -- "Searching builds with
// matching fingerprint on EAS servers" on a lookup, "Uploading build to EAS" on
// a store -- so a cache MISS produced a stdout that was progress text
// interleaved with JSON, on both platforms. That is the one thing item 7 of
// CLAUDE.md says stdout may never be.
//
// So while a provider function runs, rn-iso takes fd 1 away from IT -- not from
// the process. Every write made inside the provider's own async context is
// rerouted to stderr (where progress belongs, and where the user still sees it,
// colour and all) and recorded in the build log as a Contract-1 record, so
// `rn-iso logs` holds what the provider said. Nothing is suppressed; it is
// moved. A write from anywhere else -- the command's own payload, a supervisor,
// a test runner sharing this process -- is not the provider's to lose, and goes
// where it was going.
//
// Three properties this has to have, all of them learned from what the code
// around it does:
//   - EXCEPTION-SAFE. A provider that throws is the ordinary case here
//     (an expired EAS session), and a throw that left fd 1 patched would take
//     the payload with it.
//   - NESTED-SAFE. resolve and upload can be in flight at once (the upload is
//     started before the install and collected after the launch), so the frames
//     form a stack rather than a single global, and the store picks out the one
//     a given write belongs to.
//   - ABANDONMENT-SAFE. withBudget stops WAITING for a call; it cannot stop it
//     RUNNING. An abandoned provider that prints two minutes later would print
//     onto a stdout nobody is guarding any more -- which is the original bug,
//     just later. So the frame outlives the timeout: it is removed from the
//     stack (the command's own writes go straight through again) but stays
//     reachable through an AsyncLocalStorage the provider's own continuations
//     carry, and is only torn down when the abandoned promise finally settles.
//
// The one thing no JS interception can catch is a provider that spawns a child
// with stdio 'inherit': that child writes to fd 1 without passing through
// process.stdout at all. Nothing here pretends otherwise.

// Frames whose call the caller is still waiting for, innermost last. Held so a
// frame reached through the async store can be confirmed as live, and so the
// patch knows when there is nothing left to guard.
const capturing: CaptureFrame[] = [];
// Frames abandoned at their budget: no longer on the stack, still routed when a
// write arrives inside their async context.
const abandoned = new Set<CaptureFrame>();
// The originals, while the patch is installed. Null when it is not.
let patched: {
  stdout: NodeJS.WriteStream;
  write: NodeJS.WriteStream['write'];
  log: typeof console.log;
  patchedWrite: NodeJS.WriteStream['write'];
  patchedLog: typeof console.log;
} | null = null;

const PROVIDER_CONTEXT = new AsyncLocalStorage<CaptureFrame>();

// PURE. ANSI colour codes stripped, so a record and a parse both see the text.
export function stripAnsi(text?: string | null): string {
  // oxlint-disable-next-line no-control-regex -- intentional ANSI escape match
  return String(text ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

// PURE. The destination a provider named in its own output, or null.
//
// Best-effort by construction: no provider promises this format, and the EAS
// one says only "Uploading build to EAS" in the common case -- which names no
// org, and so is worth no extra line. A URL is the answer when there is one; an
// `owner/slug` (or `@owner/slug`) is the other shape that identifies an
// account. Anything else is left alone rather than guessed at.
export function uploadDestination(lines?: string[] | null): string | null {
  const text = (lines || []).map(stripAnsi);
  for (const line of text) {
    const url = /(https?:\/\/[^\s'"]+)/.exec(line)?.[1];
    if (url !== undefined) return url.replace(/[.,)\]]+$/, '');
  }
  for (const line of text) {
    const slug = /\bto\s+(@?[\w.-]+\/[\w.-]+)/i.exec(line)?.[1];
    if (slug !== undefined) return slug.replace(/[.,)\]]+$/, '');
  }
  return null;
}

// The label the note below is printed under, in the same shape the commands'
// own phase lines use. Not imported from either command: engine modules do not
// depend on commands, and the two commands pad the same width anyway.
function providerNote(text: string): string {
  return `${'cache'.padEnd(11)} ${text}`;
}

// Whose write this is. A frame is reached through the async context the
// provider call runs in, NEVER through "a call is in flight, so fd 1 is ours":
// this process is also a test runner, a supervisor and a command that has one
// line of its own to print, and taking every write for the duration of a
// 60-second upload would swallow whichever of those happened to overlap it.
// The store is set by PROVIDER_CONTEXT.run around the plugin call and is
// carried by everything that call goes on to do -- its own await chain, and the
// event handlers of any child process it spawns from inside it.
function currentFrame(): CaptureFrame | null {
  const store = PROVIDER_CONTEXT.getStore();
  return store && (capturing.includes(store) || abandoned.has(store)) ? store : null;
}

// Installed once and left in place while any frame is outstanding, including an
// abandoned one -- a write that belongs to nobody passes straight through, so
// the patch costs a comparison and never a line.
//
// Re-patches when what is on process.stdout is no longer ours. Something else
// replacing stdout.write mid-run is not hypothetical: a test tap does exactly
// that, and the old "already patched, do nothing" check then left this module
// believing it was guarding a stream it had been evicted from -- and, worse,
// restoring that evicted function over whatever had replaced it.
function install(): void {
  if (patched && process.stdout.write === patched.patchedWrite) return;
  const stdout = process.stdout;
  const write = stdout.write.bind(stdout);
  const log = console.log;
  // Intercepting a stream's own overloaded write() means matching its call
  // shape rather than its declared signature: node calls this with either
  // (chunk, cb) or (chunk, encoding, cb), so the arguments are read
  // dynamically and the result is cast back to NodeJS.WriteStream['write'].
  const passthrough = write as unknown as (chunk: unknown, encoding?: unknown, callback?: unknown) => boolean;
  const patchedWrite = ((chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    const frame = currentFrame();
    if (!frame) return passthrough(chunk, encoding, callback);
    const cb = typeof encoding === 'function' ? encoding : callback;
    absorb(frame, typeof chunk === 'string' ? chunk : String(chunk));
    if (typeof cb === 'function') (cb as () => void)();
    return true;
  }) as NodeJS.WriteStream['write'];
  // console.log already goes through process.stdout.write, so this is belt and
  // braces -- and it is the call the header names, so it is caught explicitly
  // rather than by implication.
  const patchedLog = (...args: unknown[]): void => {
    const frame = currentFrame();
    if (!frame) return log(...args);
    absorb(frame, `${format(...args)}\n`);
    return undefined;
  };
  stdout.write = patchedWrite;
  console.log = patchedLog;
  patched = { stdout, write, log, patchedWrite, patchedLog };
}

// Only ever restores what it actually replaced, and only when nothing is
// outstanding.
function uninstall(): void {
  if (!patched || capturing.length || abandoned.size) return;
  if (patched.stdout.write === patched.patchedWrite) patched.stdout.write = patched.write;
  if (console.log === patched.patchedLog) console.log = patched.log;
  patched = null;
}

// One chunk of a provider's stdout: to stderr as it was written (the user is
// watching a four-minute build and this is progress), and into the build log a
// LINE at a time, because a Contract-1 record is a line.
function absorb(frame: CaptureFrame, chunk: string): void {
  try {
    process.stderr.write(chunk);
  } catch {
    // A closed stderr is not a reason to fail a build.
  }
  frame.pending += chunk;
  let index = frame.pending.indexOf('\n');
  while (index !== -1) {
    emitLine(frame, frame.pending.slice(0, index));
    frame.pending = frame.pending.slice(index + 1);
    index = frame.pending.indexOf('\n');
  }
}

function emitLine(frame: CaptureFrame, raw: string): void {
  const line = stripAnsi(raw).trim();
  if (line === '') return;
  frame.lines.push(line);
  const writer = frame.writer();
  try {
    writer?.write({ src: 'build', level: 'debug', event: 'provider', msg: line });
  } catch {
    // The log is a record of the run, never a dependency of it.
  }
  frame.onLine?.(line);
}

interface BeginCaptureOptions {
  logWriter?: NdjsonWriter | null;
  projectRoot?: string | null;
  platform?: string | null;
  onLine?: ((line: string) => void) | null;
}

function beginCapture({
  logWriter = null,
  projectRoot = null,
  platform = null,
  onLine = null,
}: BeginCaptureOptions = {}): CaptureFrame {
  let own: NdjsonWriter | null = null;
  const frame: CaptureFrame = {
    lines: [],
    pending: '',
    onLine,
    writer: () => {
      if (logWriter) return logWriter;
      if (own) return own;
      if (!projectRoot || !platform) return null;
      // Opened on the first line, so a provider that prints nothing leaves no
      // file behind -- the same rule the commands' own build log follows.
      own = createNdjsonWriter(join(workspaceLogsDir(projectRoot), `build-${platform}.ndjson`));
      return own;
    },
    close: () => {
      own?.close?.();
      own = null;
    },
  };
  capturing.push(frame);
  install();
  return frame;
}

function endCapture(frame?: CaptureFrame | null): void {
  if (!frame) return;
  const at = capturing.lastIndexOf(frame);
  if (at !== -1) capturing.splice(at, 1);
  abandoned.delete(frame);
  if (frame.pending !== '') {
    const rest = frame.pending;
    frame.pending = '';
    emitLine(frame, rest);
  }
  frame.close();
  uninstall();
}

// Abandoned, not finished: off the stack so the command's own stdout is its own
// again, still routed for anything the provider itself writes, and torn down
// when the call it belongs to finally settles.
function abandonCapture(frame: CaptureFrame | null, work: Promise<unknown>): void {
  if (!frame) return;
  const at = capturing.lastIndexOf(frame);
  if (at !== -1) capturing.splice(at, 1);
  abandoned.add(frame);
  Promise.resolve(work).then(
    () => endCapture(frame),
    () => endCapture(frame),
  );
}

// --- calling it ------------------------------------------------------------

/**
 * Ask the provider for a build.
 *
 *   { appPath }             a hit -- a path the provider produced locally
 *   null                    a clean miss
 *   { failed: reason }      the provider threw
 *   { timedOut: true }      the provider did not answer inside the budget
 *
 * Never throws. The last two are NOTES for the caller: the build below this is
 * still perfectly able to run.
 */
interface ResolveRemoteOptions {
  provider?: LoadedProvider | null;
  platform?: string | null;
  projectRoot?: string | null;
  fingerprintHash?: string | null;
  runOptions?: Record<string, unknown> | null;
  timeoutMs?: number;
  logWriter?: NdjsonWriter | null;
}

export async function resolveRemote({
  provider,
  platform,
  projectRoot,
  fingerprintHash,
  runOptions = null,
  timeoutMs = RESOLVE_TIMEOUT_MS,
  logWriter = null,
}: ResolveRemoteOptions = {}): Promise<RemoteCacheResolveResult | null> {
  if (!provider?.plugin || !fingerprintHash) return null;
  const opts = runOptions || runOptionsFor(platform);

  const outcome = await withBudget(
    async () => {
      const hash =
        (await providerFingerprint({ provider, platform, projectRoot, runOptions: opts })) ?? fingerprintHash;
      const props = { fingerprintHash: hash, platform, runOptions: opts, projectRoot };
      // The deprecated name is still what an older provider exports, and the
      // Expo CLI still calls it (build-cache-providers/index.ts:84-90).
      return typeof provider.plugin.resolveBuildCache === 'function'
        ? provider.plugin.resolveBuildCache(props, provider.options)
        : // isProviderPlugin already guaranteed one of the pair exists.
          provider.plugin.resolveRemoteBuildCache!(props, provider.options);
    },
    timeoutMs,
    { logWriter, projectRoot, platform },
  );

  if (outcome.timedOut) return { timedOut: true };
  if (outcome.error) return { failed: firstLine(outcome.error) };
  const appPath = typeof outcome.value === 'string' ? outcome.value.trim() : '';
  if (!appPath) return null;
  // A provider that answers with a path to nothing is a miss, not a hit: the
  // alternative is an install step failing on a file that was never there.
  if (!existsSync(appPath)) {
    return { failed: `returned ${appPath}, which does not exist` };
  }
  return { appPath };
}

/**
 * Hand the provider a build that was just compiled.
 *
 *   { uploaded: true }  the provider returned
 *   { failed: reason }  it threw
 *   { timedOut: true }  it is still going, and nothing is waiting any more
 *
 * Never throws, and never rejects. The caller starts this BEFORE installing and
 * collects it at the end, so the upload overlaps the install and the launch
 * instead of being added to them.
 */
interface UploadRemoteOptions {
  provider?: LoadedProvider | null;
  platform?: string | null;
  projectRoot?: string | null;
  fingerprintHash?: string | null;
  buildPath?: string | null;
  runOptions?: Record<string, unknown> | null;
  timeoutMs?: number;
  logWriter?: NdjsonWriter | null;
  note?: (line: string) => void;
}

export async function uploadRemote({
  provider,
  platform,
  projectRoot,
  fingerprintHash,
  buildPath,
  runOptions = null,
  timeoutMs = UPLOAD_TIMEOUT_MS,
  logWriter = null,
  note = (line: string) => console.error(line),
}: UploadRemoteOptions = {}): Promise<RemoteCacheUploadResult> {
  if (!provider?.plugin || !fingerprintHash || !buildPath) return { skipped: true };
  const opts = runOptions || runOptionsFor(platform);

  // An upload is started before the install and collected after the launch, so
  // the `cache  uploaded (eas)` line lands a minute after the upload began and
  // says nothing about WHERE it went. The provider names the destination in the
  // output rn-iso is now holding, so the moment it does, say so once -- an
  // agent that has just pushed a build to somebody's org should be able to read
  // which org from the run rather than from the provider's config.
  let announced = false;
  const onLine = (line: string) => {
    if (announced) return;
    const dest = uploadDestination([line]);
    if (!dest) return;
    announced = true;
    note(providerNote(`uploading to ${dest}`));
  };

  const outcome = await withBudget(
    async () => {
      const hash =
        (await providerFingerprint({ provider, platform, projectRoot, runOptions: opts })) ?? fingerprintHash;
      const props = { projectRoot, platform, fingerprintHash: hash, buildPath, runOptions: opts };
      return typeof provider.plugin.uploadBuildCache === 'function'
        ? provider.plugin.uploadBuildCache(props, provider.options)
        : // isProviderPlugin already guaranteed one of the pair exists.
          provider.plugin.uploadRemoteBuildCache!(props, provider.options);
    },
    timeoutMs,
    { logWriter, projectRoot, platform, onLine },
  );

  if (outcome.timedOut) return { timedOut: true };
  if (outcome.error) return { failed: firstLine(outcome.error) };
  // The key is only present when there IS one: "uploaded, destination unknown"
  // and "uploaded to null" are not the same statement, and a caller comparing
  // the result should not have to know the difference.
  const destination = uploadDestination(outcome.lines);
  return destination ? { uploaded: true, destination } : { uploaded: true };
}

// The Expo CLI lets a plugin compute the hash itself and only falls back to
// @expo/fingerprint when it does not (calculateFingerprintHashAsync). It
// matters for EAS, whose plugin runs `eas-cli fingerprint:generate` so the
// sources are uploaded with it -- a hash rn-iso cannot compute. A plugin that
// returns nothing, or throws, leaves the caller's own fingerprint in place:
// it is the same hash `expo run:ios` would have sent by default.
async function providerFingerprint({
  provider,
  platform,
  projectRoot,
  runOptions,
}: {
  provider: LoadedProvider;
  platform?: string | null;
  projectRoot?: string | null;
  runOptions: Record<string, unknown>;
}): Promise<string | null> {
  if (typeof provider.plugin.calculateFingerprintHash !== 'function') return null;
  try {
    const hash = await provider.plugin.calculateFingerprintHash(
      { projectRoot, platform, runOptions },
      provider.options,
    );
    return typeof hash === 'string' && hash.trim() !== '' ? hash.trim() : null;
  } catch {
    return null;
  }
}

// Run `factory()` with a wall-clock bound, and with stdout taken away from it
// for the duration (see "the provider's stdout" above). A promise cannot be
// cancelled, so a timeout here means "stop waiting", not "stop running" --
// which is why the commands treat a timed-out call as a reason to stop holding
// the process open (the provider's own child process is what would otherwise
// keep it alive), and why the capture is ABANDONED rather than ended: the call
// can still print, and it still must not print onto the payload.
// The timer is unref'd so THIS module never becomes the thing that does.
async function withBudget(
  factory: () => Promise<unknown>,
  ms: number,
  capture?: BeginCaptureOptions | null,
): Promise<BudgetOutcome> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer?.unref?.();
  });
  const frame = beginCapture(capture || {});
  // Settled BEFORE the race, so the abandonment path below has the underlying
  // promise to hang the teardown on -- and so a rejection after the bound is
  // always handled rather than surfacing as an unhandled rejection.
  const work = Promise.resolve()
    .then(() => PROVIDER_CONTEXT.run(frame, factory))
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  try {
    const settled = await Promise.race([work, timeout]);
    if (settled === TIMED_OUT) {
      abandonCapture(frame, work);
      return { timedOut: true, lines: frame.lines };
    }
    endCapture(frame);
    return { ...settled, lines: frame.lines };
  } catch (err) {
    endCapture(frame);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// One line, so a note stays a note. A provider that fails prints its own
// diagnosis to its own output; what reaches rn-iso's phase lines is the
// summary.
function firstLine(err: unknown): string {
  const text = String((err as Error)?.message || err || 'unknown error').trim();
  const line = (text.split('\n')[0] ?? '').trim();
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}
