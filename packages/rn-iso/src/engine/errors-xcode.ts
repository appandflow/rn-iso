// src/engine/errors-xcode.js -- an xcodebuild transcript in, structured
// diagnostics out. Pure: no fs, no exec, no clock. The invocation half lives
// in xcode.js.
//
// This module is the whole reason `rn-iso ios` can print six lines where
// `expo run:ios` prints four thousand. A failing RN build emits a transcript
// measured in megabytes, of which between one and three lines say what is
// actually wrong; everything else is compiler invocations, response-file
// paths and the linker's argv. The agent pays tokens for whatever we print,
// so the transcript goes to the log file and only the extraction reaches
// stdout.
//
// Two rules keep the extraction honest, and they pull in opposite directions:
//
// 1. NEVER promote noise. A line reported as an error that is not one sends
//    an agent loop to edit a file that compiles fine. So a diagnostic has to
//    be anchored at the start of a line: xcodebuild indents every command it
//    echoes by four spaces, and those command lines routinely contain the
//    substring "error" (`-Wno-error=`, a path with "error" in it, the
//    linker's `--serialize-diagnostics ... .dia`). Anchoring is what
//    separates the compiler's own output from the compiler's argv.
// 2. NEVER swallow the only clue. An unrecognized transcript returns [] --
//    explicitly, so the caller can fall back to the tail of the log rather
//    than print "build failed" with nothing attached. Returning a guess
//    would be worse: it looks like an extraction and is not one.
//
// Every pattern here was recorded from a real Xcode 26 transcript produced
// by a scratch project built for this module (see test/errors-xcode.test.js
// for the captures). Where Xcode has changed a format across versions -- the
// linker's undefined-symbol header is the live example -- both forms are
// matched, because a machine mid-upgrade sees both.

// A single extracted diagnostic. `column` and `remedy` are only ever present
// alongside `line`/a matched remedy pattern respectively -- see makeDiagnostic.
export interface Diagnostic {
  file?: string | null;
  line?: number | null;
  column?: number | null;
  message: string;
  remedy?: string;
}

// The cap the CLI prints under. Ten is well past the point where an agent
// stops reading and starts fixing the first one, and the full set is always
// in the log.
export const MAX_DIAGNOSTICS = 10;

// xcodebuild prints this once, after the last diagnostic and before the
// "The following build commands failed:" recap. Everything past it is a
// restatement of failures already reported -- whole CompileC/Ld command
// lines, one per architecture slice -- so scanning stops here. Xcode 26 tab
// indents that recap, which rule 1 would exclude anyway; the terminator is
// what keeps this correct if a future release stops doing that, which is not
// a format anyone has promised.
const BUILD_FAILED = '** BUILD FAILED **';

// <file>:<line>:<col>: error: <message>, and the column-less form Swift and
// some clang diagnostics use. `fatal error:` is the same thing with a
// different word in front of it.
const POSITIONED = /^(\S[^\t]*?):(\d+):(?:(\d+):)?\s*(?:fatal\s+)?error:\s+(.+)$/;

// Everything else that says `error:` at the start of a line. The prefix is
// whatever came before it -- and the prefix must itself start at column 0, or
// an indented command line carrying the substring `error:` would be promoted
// to a diagnostic. It is one of:
//   ""                             a bare `error:` from a run-script phase
//   "xcodebuild"                   an invocation error (bad scheme, bad -sdk)
//   "clang" / "ld" / "swiftc"      a tool speaking for itself
//   "/path/to/App.xcodeproj"       a project-level error (signing, above all)
//   "/path/App.xcodeproj: Target"  the same, with a target named after it
// The path form is the only one worth keeping as `file`; the tool names are
// noise once the message is in hand.
const UNPOSITIONED = /^(\S[^\t]*?)?\berror:\s+(.+)$/;

// The linker, which reports without a file at all. `ld: warning:` is common
// and deliberately excluded -- a warning is not a diagnostic here.
const LD_ERROR = /^ld:\s+(?!warning:)(.+)$/;

// Two spellings of the same failure. The classic linker prints
// "Undefined symbols for architecture arm64:", the Xcode 15+ linker prints
// "ld: Undefined symbols:". Both are followed by indented
// `"_symbol", referenced from:` lines.
const UNDEFINED_HEADER = /^(?:ld:\s+)?Undefined symbols?(?:\s+for architecture\s+\S+)?:\s*$/;
const UNDEFINED_SYMBOL = /^\s+"?([^",]+)"?,\s+referenced from:\s*$/;

// The architecture is deliberately NOT part of the message: a fat simulator
// build reports the same missing symbol once per slice, and an agent needs to
// be told about one missing symbol, not two.
function undefinedSymbolMessage(symbol: string): string {
  return `Undefined symbol: ${symbol}`;
}

// --- remedies ---------------------------------------------------------
//
// A remedy is attached only where the fix is mechanical and rn-iso knows it.
// A compile error gets none on purpose: "fix the code" is not advice, and an
// invented remedy is worse than an absent one because an agent will follow it.

const PODS_OUT_OF_SYNC = /The sandbox is not in sync with the Podfile\.lock/;

const SIGNING = [
  /No profiles for '.*' were found/,
  /requires a development team/i,
  /[Cc]ode ?[Ss]igning [Ee]rror/,
  /No signing certificate/i,
  /code signing is required/i,
  /errSecInternalComponent/,
  /Provisioning profile .* doesn't (?:include|match)/i,
];

const NO_SUCH_SCHEME = /does not contain a scheme named/;

function remedyFor(message: string): string | null {
  if (PODS_OUT_OF_SYNC.test(message)) {
    // The plan's flow syncs pods before building precisely so this never
    // fires; when it does, the lockfiles moved under the build.
    return 'Run `pod install` in ios/ (rn-iso ios does this when Podfile.lock and Pods/Manifest.lock disagree), then build again.';
  }
  if (NO_SUCH_SCHEME.test(message)) {
    return 'Run `xcodebuild -list` in ios/ to see the schemes this project defines, and share the app scheme so it is visible to the build.';
  }
  for (const pattern of SIGNING) {
    if (pattern.test(message)) {
      // rn-iso builds Debug for the simulator and nothing else, so a signing
      // requirement here is always a setting that should not apply.
      return "rn-iso builds Debug for the simulator, which needs no signing. Check CODE_SIGNING_REQUIRED / DEVELOPMENT_TEAM in the target's Debug configuration.";
    }
  }
  return null;
}

// A prefix is a file only when it looks like a path. "xcodebuild", "clang"
// and "ld" are tool names; carrying them in `file` would make a caller print
// "clang:12" -- a location that does not exist.
function fileFromPrefix(prefix: string): string | null {
  const trimmed = String(prefix).trim().replace(/:$/, '');
  if (!trimmed) return null;
  // "/path/App.xcodeproj: Scratch: clang" -- take the first segment, which is
  // where the path is, and only when it is one.
  const head = (trimmed.split(': ')[0] ?? '').trim();
  if (!head.includes('/')) return null;
  return head;
}

function makeDiagnostic({
  file = null,
  line = null,
  column = null,
  message,
}: {
  file?: string | null;
  line?: number | null;
  column?: number | null;
  message: string;
}): Diagnostic {
  const text = String(message).trim();
  const out: Diagnostic = { message: text };
  if (file) out.file = file;
  if (line !== null && line !== undefined) out.line = line;
  if (column !== null && column !== undefined) out.column = column;
  out.message = text;
  const remedy = remedyFor(text);
  if (remedy) out.remedy = remedy;
  return out;
}

// Dedupe is on the whole location, not the message alone: clang emits an
// identical diagnostic once per architecture slice (arm64 and x86_64 of a
// simulator build), which shares file, line AND column, while the same
// message at two different call sites is two things to fix and must survive.
function dedupeKey(d: Diagnostic): string {
  return `${d.file || ''}|${d.line || ''}|${d.column || ''}|${d.message}`;
}

export function extractXcodeDiagnostics(transcript: string): Diagnostic[] {
  if (typeof transcript !== 'string' || transcript === '') return [];

  const lines = transcript.split('\n');
  const out: Diagnostic[] = [];
  const seen = new Set<string>();

  const push = (d: Diagnostic) => {
    const key = dedupeKey(d);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(d);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    if (rawLine === undefined) continue;
    const raw = rawLine.replace(/\r$/, '');
    if (raw.includes(BUILD_FAILED)) break;

    if (UNDEFINED_HEADER.test(raw)) {
      // Consume the indented symbol list that follows. Anything else ends the
      // block, including the blank line the linker leaves after it.
      for (let j = i + 1; j < lines.length; j += 1) {
        const symLine = lines[j];
        if (symLine === undefined) continue;
        const sym = UNDEFINED_SYMBOL.exec(symLine.replace(/\r$/, ''));
        if (sym) {
          // Group 1 is a required capture; guard defensively.
          const symbol = sym[1];
          if (symbol !== undefined) push(makeDiagnostic({ message: undefinedSymbolMessage(symbol) }));
          continue;
        }
        // The `_main in main.o` continuation lines are indented further and
        // carry no new fact; skip them and keep looking for the next symbol.
        if (/^\s+\S/.test(symLine) && !/^\S/.test(symLine)) continue;
        i = j - 1;
        break;
      }
      continue;
    }

    const ld = LD_ERROR.exec(raw);
    if (ld) {
      push(makeDiagnostic({ message: `ld: ${ld[1]}` }));
      continue;
    }

    const positioned = POSITIONED.exec(raw);
    if (positioned) {
      const posMsg = positioned[4];
      if (posMsg === undefined) continue;
      push(
        makeDiagnostic({
          file: positioned[1],
          line: Number(positioned[2]),
          column: positioned[3] === undefined ? null : Number(positioned[3]),
          message: posMsg,
        }),
      );
      continue;
    }

    const plain = UNPOSITIONED.exec(raw);
    if (plain) {
      const plainMsg = plain[2];
      if (plainMsg === undefined) continue;
      push(makeDiagnostic({ file: fileFromPrefix(plain[1] || ''), message: plainMsg }));
    }
  }

  return out;
}

// The cap lives here rather than inside the extractor so that the extractor
// stays a total function of the transcript -- a caller that wants everything
// (a future `logs --errors` over a stored build log) is not fighting a
// presentation decision baked into the parser. `truncated` is the count the
// CLI prints as "+N more", and is 0, not absent, when nothing was dropped.
export function capDiagnostics(
  diagnostics: Diagnostic[],
  max = MAX_DIAGNOSTICS,
): { diagnostics: Diagnostic[]; truncated: number } {
  const list = Array.isArray(diagnostics) ? diagnostics : [];
  if (list.length <= max) return { diagnostics: list.slice(), truncated: 0 };
  return { diagnostics: list.slice(0, max), truncated: list.length - max };
}

// One line, in the shape a compiler prints it, because that is the shape an
// agent already knows how to parse and jump to. The remedy is NOT included:
// it is a separate line in the CLI's output, and gluing them together makes
// the diagnostic ungreppable.
export function describeDiagnostic(diagnostic?: Diagnostic | null): string {
  if (!diagnostic || typeof diagnostic !== 'object') return '';
  const { file, line, column, message } = diagnostic;
  if (!file) return String(message ?? '');
  const position = line ? (column ? `:${line}:${column}` : `:${line}`) : '';
  return `${file}${position}: ${message}`;
}
