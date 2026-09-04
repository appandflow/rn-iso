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

export function completedCleanupRecord(record) {
  const actions = Array.isArray(record?.actions) ? record.actions : [];
  const removedWorktree = actions.some((action) =>
    /^(?:stim worktree remove|remove worktree|remove launch-crash fixture)\b/.test(action),
  );
  const failedWorktreeRemoval = actions.some(
    (action) => action.startsWith('failed:') && /(?:worktree|launch-crash fixture)/.test(action),
  );
  return Boolean(record?.cleanedAt && removedWorktree && !failedWorktreeRemoval);
}

export function durableRunRecord(previous, next, cleanupCompleted = false) {
  if (
    cleanupCompleted &&
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
