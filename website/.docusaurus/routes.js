import React from 'react';
import ComponentCreator from '@docusaurus/ComponentCreator';

export default [
  {
    path: '/rn-iso/docs',
    component: ComponentCreator('/rn-iso/docs', '0de'),
    routes: [
      {
        path: '/rn-iso/docs',
        component: ComponentCreator('/rn-iso/docs', '4e2'),
        routes: [
          {
            path: '/rn-iso/docs',
            component: ComponentCreator('/rn-iso/docs', '793'),
            routes: [
              {
                path: '/rn-iso/docs/agent-skills',
                component: ComponentCreator('/rn-iso/docs/agent-skills', 'ebe'),
                exact: true,
                sidebar: 'docs',
              },
              {
                path: '/rn-iso/docs/build-caches',
                component: ComponentCreator('/rn-iso/docs/build-caches', '13e'),
                exact: true,
                sidebar: 'docs',
              },
              {
                path: '/rn-iso/docs/cache-packages',
                component: ComponentCreator('/rn-iso/docs/cache-packages', '278'),
                exact: true,
                sidebar: 'docs',
              },
              {
                path: '/rn-iso/docs/changelog',
                component: ComponentCreator('/rn-iso/docs/changelog', 'c3b'),
                exact: true,
                sidebar: 'docs',
              },
              {
                path: '/rn-iso/docs/commands',
                component: ComponentCreator('/rn-iso/docs/commands', 'aea'),
                exact: true,
                sidebar: 'docs',
              },
              {
                path: '/rn-iso/docs/dev-server-and-logs',
                component: ComponentCreator('/rn-iso/docs/dev-server-and-logs', '5a5'),
                exact: true,
                sidebar: 'docs',
              },
              {
                path: '/rn-iso/docs/getting-started',
                component: ComponentCreator('/rn-iso/docs/getting-started', 'aea'),
                exact: true,
                sidebar: 'docs',
              },
              {
                path: '/rn-iso/docs/owned-devices',
                component: ComponentCreator('/rn-iso/docs/owned-devices', '44e'),
                exact: true,
                sidebar: 'docs',
              },
              {
                path: '/rn-iso/docs/requirements',
                component: ComponentCreator('/rn-iso/docs/requirements', 'e19'),
                exact: true,
                sidebar: 'docs',
              },
              {
                path: '/rn-iso/docs/settings',
                component: ComponentCreator('/rn-iso/docs/settings', 'aa2'),
                exact: true,
                sidebar: 'docs',
              },
              {
                path: '/rn-iso/docs/why',
                component: ComponentCreator('/rn-iso/docs/why', '967'),
                exact: true,
                sidebar: 'docs',
              },
              {
                path: '/rn-iso/docs/worktrees',
                component: ComponentCreator('/rn-iso/docs/worktrees', 'a39'),
                exact: true,
                sidebar: 'docs',
              },
            ],
          },
        ],
      },
    ],
  },
  {
    path: '/rn-iso/',
    component: ComponentCreator('/rn-iso/', 'e8d'),
    exact: true,
  },
  {
    path: '*',
    component: ComponentCreator('*'),
  },
];
