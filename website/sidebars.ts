import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    'why',
    'getting-started',
    {
      type: 'category',
      label: 'Understand Stim',
      collapsed: false,
      items: ['build-caches', 'worktrees', 'owned-devices', 'dev-server-and-logs'],
    },
    {
      type: 'category',
      label: 'Reference',
      collapsed: false,
      items: ['commands', 'settings', 'requirements', 'agent-skills', 'cache-packages'],
    },
    'changelog',
  ],
};

export default sidebars;
