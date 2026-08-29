export interface Diagnostic {
  file?: string | null;
  line?: number | null;
  column?: number | null;
  message: string;
  remedy?: string;
}

export const MAX_DIAGNOSTICS = 10;

const BUILD_FAILED = '** BUILD FAILED **';

const POSITIONED = /^(\S[^\t]*?):(\d+):(?:(\d+):)?\s*(?:fatal\s+)?error:\s+(.+)$/;

const UNPOSITIONED = /^(\S[^\t]*?)?\berror:\s+(.+)$/;

const LD_ERROR = /^ld:\s+(?!warning:)(.+)$/;

const UNDEFINED_HEADER = /^(?:ld:\s+)?Undefined symbols?(?:\s+for architecture\s+\S+)?:\s*$/;
const UNDEFINED_SYMBOL = /^\s+"?([^",]+)"?,\s+referenced from:\s*$/;

function undefinedSymbolMessage(symbol: string): string {
  return `Undefined symbol: ${symbol}`;
}

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
    return 'Run `pod install` in ios/ (stim ios does this when Podfile.lock and Pods/Manifest.lock disagree), then build again.';
  }
  if (NO_SUCH_SCHEME.test(message)) {
    return 'Run `xcodebuild -list` in ios/ to see the schemes this project defines, and share the app scheme so it is visible to the build.';
  }
  for (const pattern of SIGNING) {
    if (pattern.test(message)) {
      return "stim-cli builds Debug for the simulator, which needs no signing. Check CODE_SIGNING_REQUIRED / DEVELOPMENT_TEAM in the target's Debug configuration.";
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
      for (let j = i + 1; j < lines.length; j += 1) {
        const symLine = lines[j];
        if (symLine === undefined) continue;
        const sym = UNDEFINED_SYMBOL.exec(symLine.replace(/\r$/, ''));
        if (sym) {
          const symbol = sym[1];
          if (symbol !== undefined) push(makeDiagnostic({ message: undefinedSymbolMessage(symbol) }));
          continue;
        }
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

export function capDiagnostics(
  diagnostics: Diagnostic[],
  max: number = MAX_DIAGNOSTICS,
): { diagnostics: Diagnostic[]; truncated: number } {
  const list = Array.isArray(diagnostics) ? diagnostics : [];
  if (list.length <= max) return { diagnostics: list.slice(), truncated: 0 };
  return { diagnostics: list.slice(0, max), truncated: list.length - max };
}

export function describeDiagnostic(diagnostic?: Diagnostic | null): string {
  if (!diagnostic || typeof diagnostic !== 'object') return '';
  const { file, line, column, message } = diagnostic;
  if (!file) return String(message ?? '');
  const position = line ? (column ? `:${line}:${column}` : `:${line}`) : '';
  return `${file}${position}: ${message}`;
}
