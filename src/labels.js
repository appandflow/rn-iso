import prompts from 'prompts';

// Decide what label to store on a project entry.
//
// Priority:
//   1. --label flag (explicit override)
//   2. existing label on the project (don't re-prompt)
//   3. interactive prompt with the basename as default
//   4. null (non-interactive and no prior label) -> projectShortcut falls
//      back to the basename automatically.
export async function resolveLabel({ root, existingProject, optsLabel }) {
  if (optsLabel) return optsLabel;
  if (existingProject?.label) return existingProject.label;
  if (!process.stdin.isTTY) return null;

  const basename = root.split('/').pop() || root;
  const answer = await prompts({
    type: 'text',
    name: 'label',
    message: 'Project label (shortcut for stop / release):',
    initial: basename,
  });
  if (!answer.label) return null;
  return answer.label;
}
