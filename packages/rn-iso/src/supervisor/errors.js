// src/supervisor/errors.js -- the supervisor's error shape, in a module of its
// own so that nothing in src/supervisor/ has to import run.js to throw.
//
// This file exists because of a deadlock found in live verification. run.js
// dynamically imports the server modules; when the server modules imported
// run.js back (for this helper), evaluating them re-entered a module that was
// still evaluating its own top-level await, and ESM makes the cyclic importer
// WAIT for that evaluation to finish. The supervisor therefore hung before
// starting the server, having already written its pid file -- with nothing on
// stdout but "Detected unsettled top-level await". Keep the dependency arrow
// pointing one way: run.js -> server-*.js -> errors.js.
//
// The shape is the spec's error contract: a stable code an agent can branch
// on, a message, and a remedy.

export function supervisorError(code, message, remedy) {
  const err = new Error(message);
  err.code = code;
  if (remedy) err.remedy = remedy;
  return err;
}

// A structured error prints as its own instructions; anything else prints as
// whatever it is. Never a bare stack: this string is the only thing `start`
// has to show when a supervisor fails to come up.
export function describeError(err) {
  if (!err) return 'unknown error';
  const message = err.message || String(err);
  const code = err.code ? `${err.code}: ` : '';
  const remedy = err.remedy ? ` Remedy: ${err.remedy}` : '';
  return `${code}${message}${remedy}`;
}
