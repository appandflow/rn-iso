import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    'why',
    'getting-started',
    'commands',
    {
      type: 'category',
      label: 'Concepts',
      collapsed: false,
      items: ['owned-devices', 'dev-server-and-logs', 'build-caches', 'worktrees'],
    },
    {
      type: 'category',
      label: 'Reference',
      collapsed: false,
      items: ['settings', 'cache-packages', 'agent-skills', 'requirements'],
    },
    'changelog',
  ],
};

export default sidebars;
