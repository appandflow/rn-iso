// src/engine/errors-gradle.js -- a gradle transcript reduced to the few lines
// that say what actually broke.
//
// PURE, and the whole module is: it takes text and returns data. The build
// itself lives in engine/gradle.js, so the parsing that decides what an agent
// reads can be tested against recorded transcripts without a gradle daemon,
// an Android SDK, or a network.
//
// Why this exists at all: `./gradlew assembleDebug` on a React Native app
// emits several thousand lines, and the compiler diagnostic is four of them.
// The design's output discipline is that the agent pays for those four --
// on failure the EXTRACTED diagnostic plus the log path, never the
// transcript. The full transcript is on disk in build-android.ndjson when it
// is wanted, which is rarely, and never as tokens.
//
// The forms recognized below are gradle's and the Android toolchain's, in the
// order a failing build prints them:
//
//   > Task :app:compileDebugKotlin FAILED       which task gave up
//   e: file:///p/Main.kt:10:5 Unresolved ...    kotlinc, K2 URI form
//   e: /p/Main.kt: (10, 5): Unresolved ...      kotlinc, pre-K2 form
//   /p/Main.java:10: error: cannot find symbol  javac
//   ERROR:/p/res/values/x.xml:5:5: AAPT: ...    aapt2 resource linking
//   FAILURE: Build failed with an exception.    the summary block, whose
//   * What went wrong:                          section is the one gradle
//   Execution failed for task ':app:...'.       writes for humans
//   > Could not resolve com.foo:bar:1.0.        dependency resolution
//
// Anything unrecognized yields [] rather than a guess: a wrong diagnostic
// costs an agent more than no diagnostic, because it sends it editing a file
// that is not broken.

// A single extracted diagnostic. `line`/`column` and `remedy` are only ever
// present when the pattern that matched carried a location / a known fix --
// see the `add` closure in extractGradleDiagnostics and remedyFor.
export interface Diagnostic {
  file?: string;
  line?: number;
  column?: number;
  message: string;
  remedy?: string;
}

export const MAX_DIAGNOSTICS = 10;

// A single diagnostic's message is a line of an agent's output, not a page.
const MAX_MESSAGE_LENGTH = 300;

// --- the recognized forms -------------------------------------------------

// kotlinc K2: `e: file:///abs/Main.kt:10:5 Unresolved reference 'foo'.`
const KOTLIN_URI = /^e:\s+file:\/\/(\/\S+?):(\d+):(\d+)\s+(.*)$/;
// kotlinc pre-K2: `e: /abs/Main.kt: (10, 5): Unresolved reference: foo`
const KOTLIN_PAREN = /^e:\s+(\S+?):\s*\((\d+),\s*(\d+)\):\s*(.*)$/;
// Anything else kotlinc marks as an error, e.g. `e: Compilation error.`
const KOTLIN_BARE = /^e:\s+(.*)$/;
// javac: `/abs/Main.java:10: error: cannot find symbol`, and the
// file:line:col:error: form clang-style tools use.
const FILE_LINE_ERROR = /^([^\s:]+):(\d+):(?:(\d+):)?\s*(?:AAPT:\s*)?error:\s*(.*)$/i;
// aapt2 through gradle: `ERROR:/abs/res/values/strings.xml:5:5: AAPT: error: ...`
const AAPT_PREFIXED = /^ERROR:\s*([^\s:]+):(\d+):(?:(\d+):)?\s*(.*)$/;
// A bare `error: resource string/foo not found.` with no file to blame.
const BARE_ERROR = /^error:\s*(.*)$/i;
const TASK_FAILED = /^>\s*Task\s+(:[A-Za-z0-9_.:-]+)\s+FAILED\b/;
const FAILURE_HEADER = /^FAILURE:\s*Build (?:failed|completed with)/;
const WHAT_WENT_WRONG = /^\*\s*What went wrong:/;
const SECTION = /^\*\s*[A-Za-z]/;
const COULD_NOT_RESOLVE = /^>?\s*(Could not (?:resolve|find|download|GET) .+)$/;

// --- remedies -------------------------------------------------------------
//
// Only for failures whose fix is environmental rather than in the code. A
// remedy on "cannot find symbol" would be noise; a remedy on "SDK location
// not found" is the entire answer, and without it an agent retries the build
// instead of setting the variable.
const REMEDIES: Array<[RegExp, string]> = [
  [
    /JAVA_HOME is (?:set to an invalid directory|not set)/i,
    'Point JAVA_HOME at a JDK 17 install (`export JAVA_HOME=$(/usr/libexec/java_home -v 17)`) and run again.',
  ],
  [
    /SDK location not found|ANDROID_HOME|ANDROID_SDK_ROOT|sdk\.dir/i,
    'Set ANDROID_HOME to the Android SDK (usually ~/Library/Android/sdk), or write sdk.dir into android/local.properties.',
  ],
  [
    /licen[cs]es? (?:have not been|has not been) accepted|You have not accepted the license/i,
    'Accept the SDK licences: `$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses`.',
  ],
  [
    /Failed to install the following (?:Android )?SDK packages|package is not installed/i,
    'Install the missing SDK package with `$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "<package>"`.',
  ],
  [
    /Unsupported class file major version|invalid source release|compiled by a more recent version of the Java|Could not determine java version/i,
    'The JDK does not match what this project builds with; select JDK 17 (`export JAVA_HOME=$(/usr/libexec/java_home -v 17)`).',
  ],
  [
    /Could not (?:resolve|find|download|GET)/i,
    'Check network access and the repositories block. After a bad cache entry, `./gradlew --refresh-dependencies assembleDebug` in android/ re-resolves.',
  ],
  [
    /Android resource linking failed|AAPT/i,
    'Fix the resource file and line named above (under android/app/src/main/res); aapt2 reports the exact element it could not link.',
  ],
];

export function remedyFor(message: string): string | null {
  const text = String(message || '');
  for (const [pattern, remedy] of REMEDIES) {
    if (pattern.test(text)) return remedy;
  }
  return null;
}

// --- the extractor --------------------------------------------------------

// Returns every diagnostic found, deduped, in transcript order. Unrecognized
// text returns []. The cap lives in capDiagnostics so the extractor stays a
// plain "what is in this text" question -- a caller wanting all of them (a
// test, a future `logs --build`) is not forced through a limit meant for
// terminal output.
export function extractGradleDiagnostics(text: string): Diagnostic[] {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const lines = text.split('\n');
  const found: Diagnostic[] = [];
  const seen = new Set<string>();

  const add = (diag: { file?: string; line?: number; column?: number; message: string }) => {
    const message = clip(diag.message);
    if (!message) return;
    const key = `${diag.file || ''}|${diag.line ?? ''}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    const record: Diagnostic = { message };
    if (diag.file) record.file = diag.file;
    if (diag.line != null) record.line = diag.line;
    if (diag.column != null) record.column = diag.column;
    const remedy = remedyFor(`${diag.file || ''} ${message}`);
    if (remedy) record.remedy = remedy;
    found.push(record);
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = stripCarriage(lines[i]);
    const line = raw.trim();
    if (!line) continue;

    // The FAILURE block is multi-line and is handled first: its inner lines
    // ("Execution failed for task ...", "> Compilation failed; see ...")
    // would otherwise be picked up individually and read as separate faults.
    if (FAILURE_HEADER.test(line)) {
      const block = readWhatWentWrong(lines, i);
      if (block) {
        add({ message: block.message });
        i = block.endIndex;
      }
      continue;
    }
    if (WHAT_WENT_WRONG.test(line)) {
      // A transcript captured from the middle (a tail, a log excerpt) can
      // start inside the block, with no FAILURE header above it.
      const block = readWhatWentWrong(lines, i - 1);
      if (block) {
        add({ message: block.message });
        i = block.endIndex;
      }
      continue;
    }

    const kotlinUri = KOTLIN_URI.exec(line);
    if (kotlinUri) {
      // file and message are required capture groups; skip if a match somehow
      // lacks them rather than fabricate a diagnostic.
      const uriFile = kotlinUri[1];
      const uriMsg = kotlinUri[4];
      if (uriFile === undefined || uriMsg === undefined) continue;
      add({
        file: decodePath(uriFile),
        line: Number(kotlinUri[2]),
        column: Number(kotlinUri[3]),
        message: uriMsg,
      });
      continue;
    }
    const kotlinParen = KOTLIN_PAREN.exec(line);
    if (kotlinParen) {
      const parenMsg = kotlinParen[4];
      if (parenMsg === undefined) continue;
      add({
        file: kotlinParen[1],
        line: Number(kotlinParen[2]),
        column: Number(kotlinParen[3]),
        message: parenMsg,
      });
      continue;
    }

    const aapt = AAPT_PREFIXED.exec(line);
    if (aapt) {
      const aaptMsg = aapt[4];
      if (aaptMsg === undefined) continue;
      add({
        file: aapt[1],
        line: Number(aapt[2]),
        column: aapt[3] ? Number(aapt[3]) : undefined,
        message: stripAaptPrefix(aaptMsg),
      });
      continue;
    }

    const fileError = FILE_LINE_ERROR.exec(line);
    if (fileError) {
      const errMsg = fileError[4];
      if (errMsg === undefined) continue;
      add({
        file: fileError[1],
        line: Number(fileError[2]),
        column: fileError[3] ? Number(fileError[3]) : undefined,
        message: errMsg,
      });
      continue;
    }

    const kotlinBare = KOTLIN_BARE.exec(line);
    if (kotlinBare) {
      const bareMsg = kotlinBare[1];
      if (bareMsg === undefined) continue;
      add({ message: bareMsg });
      continue;
    }

    const bare = BARE_ERROR.exec(line);
    if (bare) {
      const bareErrMsg = bare[1];
      if (bareErrMsg === undefined) continue;
      add({ message: bareErrMsg });
      continue;
    }

    const resolve = COULD_NOT_RESOLVE.exec(line);
    if (resolve) {
      const resolveMsg = resolve[1];
      if (resolveMsg === undefined) continue;
      add({ message: resolveMsg });
      continue;
    }

    const task = TASK_FAILED.exec(line);
    if (task) {
      add({ message: `Task ${task[1]} FAILED` });
      continue;
    }
  }

  return found;
}

// PURE. What goes on the terminal, and what was left in the log.
export function capDiagnostics(
  diagnostics: Diagnostic[],
  limit: number = MAX_DIAGNOSTICS,
): { shown: Diagnostic[]; truncated: number } {
  const all = Array.isArray(diagnostics) ? diagnostics : [];
  if (all.length <= limit) return { shown: all.slice(), truncated: 0 };
  return { shown: all.slice(0, limit), truncated: all.length - limit };
}

// PURE. One diagnostic as one line, in the compiler's own file:line:col
// shape so an editor, a grep, and a human all read it the same way.
export function formatDiagnostic(diag?: Diagnostic | null): string {
  if (!diag) return '';
  const where = diag.file
    ? `${diag.file}${diag.line != null ? `:${diag.line}` : ''}${diag.line != null && diag.column != null ? `:${diag.column}` : ''}: `
    : '';
  return `${where}${diag.message}`;
}

// --- helpers --------------------------------------------------------------

// The "* What went wrong:" section, from a FAILURE header at `start`. Gradle
// writes the cause on the first line and each nested cause on a `> ` line
// under it, then moves on to "* Try:". The nested causes carry the useful
// half ("Compilation failed", "Could not resolve X"), so they are joined
// into the message rather than dropped.
function readWhatWentWrong(lines: string[], start: number): { message: string; endIndex: number } | null {
  let i = start + 1;
  while (i < lines.length && !WHAT_WENT_WRONG.test(stripCarriage(lines[i]).trim())) {
    const probe = stripCarriage(lines[i]).trim();
    // Only whitespace separates the header from the section. Anything else
    // means this FAILURE header is not followed by one at all.
    if (probe !== '' && !FAILURE_HEADER.test(probe)) return null;
    i++;
  }
  if (i >= lines.length) return null;

  const parts: string[] = [];
  let j = i + 1;
  for (; j < lines.length; j++) {
    const line = stripCarriage(lines[j]).trim();
    if (SECTION.test(line)) break;
    if (line === '') {
      // A blank line ends the section only once something has been read;
      // gradle puts none inside it.
      if (parts.length) break;
      continue;
    }
    parts.push(line.replace(/^>\s*/, ''));
  }
  if (parts.length === 0) return null;
  return { message: parts.join(' '), endIndex: j - 1 };
}

function stripAaptPrefix(message: string): string {
  return String(message)
    .replace(/^AAPT:\s*/, '')
    .replace(/^error:\s*/i, '');
}

// kotlinc prints a file URI, and a path with a space in it comes back
// percent-encoded. decodeURIComponent throws on a malformed sequence, which
// is not a reason to lose the diagnostic.
function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

// Gradle's rich console redraws with carriage returns; a captured transcript
// keeps them, and they would otherwise glue two lines together.
function stripCarriage(line: string | undefined): string {
  const text = String(line ?? '');
  const idx = text.lastIndexOf('\r');
  return idx === -1 ? text : text.slice(idx + 1);
}

function clip(message: string): string {
  const text = String(message ?? '').trim();
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  return `${text.slice(0, MAX_MESSAGE_LENGTH - 3)}...`;
}
