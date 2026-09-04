const cleanupOnlyReasons = new Set([
  'launch-crash-worktree-missing',
  'launch-crash-source-missing',
  'source-edit-missing',
  'worktree-evidence-missing',
]);

function sameEvidence(left, right) {
  const keys = ['events', 'settingsPng', 'transcript'];
  return keys.every((key) => left?.evidenceSha256?.[key] && left.evidenceSha256[key] === right?.evidenceSha256?.[key]);
}

export function durableRunRecord(previous, next) {
  if (
    previous?.valid === true &&
    next.valid === false &&
    next.invalidReasons.length > 0 &&
    next.invalidReasons.every((reason) => cleanupOnlyReasons.has(reason)) &&
    sameEvidence(previous, next)
  ) {
    return previous;
  }
  return next;
}
