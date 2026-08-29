import assert from 'node:assert/strict';

export function launchEvidenceMessage(launched, label) {
  if (launched === true) return `${label} launched and verified.`;
  if (launched === 'bundling') {
    return `${label} reached this workspace's Metro while the bundle was still building.`;
  }
  if (launched === 'unverified') {
    return `${label} launched but UNVERIFIED (no bundle request seen) -- tolerated per protocol.`;
  }
  throw new Error(`${label} did not launch (launched=${JSON.stringify(launched)})`);
}

export function noCompileEvidenceMessage({ cwd, logPath, text, compileSigns }) {
  assert(logPath, `no build-*.ndjson exists for the cached build in ${cwd}; no-compile proof is missing`);
  for (const sign of compileSigns) {
    assert(
      !sign.test(text),
      `the cached build's log contains a compile signature ${sign} -- it should have installed, not compiled:\n${logPath}`,
    );
  }
  return 'no-compile proof: the second worktree build log holds no compiler invocation.';
}
