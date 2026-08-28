export interface SupervisorError extends Error {
  code?: string;
  remedy?: string;
}

export function supervisorError(code: string, message: string, remedy?: string): SupervisorError {
  const err = new Error(message) as SupervisorError;
  err.code = code;
  if (remedy) err.remedy = remedy;
  return err;
}

export function describeError(err: unknown): string {
  if (!err) return 'unknown error';
  const e = err as SupervisorError;
  const message = e.message || String(err);
  const code = e.code ? `${e.code}: ` : '';
  const remedy = e.remedy ? ` Remedy: ${e.remedy}` : '';
  return `${code}${message}${remedy}`;
}
