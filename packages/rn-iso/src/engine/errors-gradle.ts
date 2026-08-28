export interface Diagnostic {
  file?: string;
  line?: number;
  column?: number;
  message: string;
  remedy?: string;
}

export const MAX_DIAGNOSTICS = 10;

const MAX_MESSAGE_LENGTH = 300;

const KOTLIN_URI = /^e:\s+file:\/\/(\/\S+?):(\d+):(\d+)\s+(.*)$/;
const KOTLIN_PAREN = /^e:\s+(\S+?):\s*\((\d+),\s*(\d+)\):\s*(.*)$/;
const KOTLIN_BARE = /^e:\s+(.*)$/;
const FILE_LINE_ERROR = /^([^\s:]+):(\d+):(?:(\d+):)?\s*(?:AAPT:\s*)?error:\s*(.*)$/i;
const AAPT_PREFIXED = /^ERROR:\s*([^\s:]+):(\d+):(?:(\d+):)?\s*(.*)$/;
const BARE_ERROR = /^error:\s*(.*)$/i;
const FATAL_ERROR = /FATAL_ERROR/;
const TASK_FAILED = /^>\s*Task\s+(:[A-Za-z0-9_.:-]+)\s+FAILED\b/;
const FAILURE_HEADER = /^FAILURE:\s*Build (?:failed|completed with)/;
const WHAT_WENT_WRONG = /^\*\s*What went wrong:/;
const SECTION = /^\*\s*[A-Za-z]/;
const COULD_NOT_RESOLVE = /^>?\s*(Could not (?:resolve|find|download|GET) .+)$/;

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

    if (FAILURE_HEADER.test(line)) {
      const block = readWhatWentWrong(lines, i);
      if (block) {
        add({ message: block.message });
        for (const fatal of block.fatal) add({ message: fatal });
        i = block.endIndex;
      }
      continue;
    }
    if (WHAT_WENT_WRONG.test(line)) {
      const block = readWhatWentWrong(lines, i - 1);
      if (block) {
        add({ message: block.message });
        for (const fatal of block.fatal) add({ message: fatal });
        i = block.endIndex;
      }
      continue;
    }

    if (FATAL_ERROR.test(line)) {
      add({ message: line });
      continue;
    }

    const kotlinUri = KOTLIN_URI.exec(line);
    if (kotlinUri) {
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

export function capDiagnostics(
  diagnostics: Diagnostic[],
  limit: number = MAX_DIAGNOSTICS,
): { shown: Diagnostic[]; truncated: number } {
  const all = Array.isArray(diagnostics) ? diagnostics : [];
  if (all.length <= limit) return { shown: all.slice(), truncated: 0 };
  return { shown: all.slice(0, limit), truncated: all.length - limit };
}

export function formatDiagnostic(diag?: Diagnostic | null): string {
  if (!diag) return '';
  const where = diag.file
    ? `${diag.file}${diag.line != null ? `:${diag.line}` : ''}${diag.line != null && diag.column != null ? `:${diag.column}` : ''}: `
    : '';
  return `${where}${diag.message}`;
}

function readWhatWentWrong(
  lines: string[],
  start: number,
): { message: string; fatal: string[]; endIndex: number } | null {
  let i = start + 1;
  while (i < lines.length && !WHAT_WENT_WRONG.test(stripCarriage(lines[i]).trim())) {
    const probe = stripCarriage(lines[i]).trim();
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
      if (parts.length) break;
      continue;
    }
    parts.push(line.replace(/^>\s*/, ''));
  }
  if (parts.length === 0) return null;
  return { message: parts.join(' '), fatal: parts.filter((part) => FATAL_ERROR.test(part)), endIndex: j - 1 };
}

function stripAaptPrefix(message: string): string {
  return String(message)
    .replace(/^AAPT:\s*/, '')
    .replace(/^error:\s*/i, '');
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

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
