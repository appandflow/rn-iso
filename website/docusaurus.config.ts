import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'rn-iso',
  tagline: 'The React Native / Expo CLI for AI agents',
  favicon: 'img/favicon.svg',

  future: {
    v4: true,
  },

  url: 'https://appandflow.github.io',
  baseUrl: '/rn-iso/',

  organizationName: 'appandflow',
  projectName: 'rn-iso',
  trailingSlash: false,

  onBrokenLinks: 'throw',
  onBrokenMarkdownLinks: 'throw',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/appandflow/rn-iso/tree/main/website/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'rn-iso',
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docs',
          position: 'left',
          label: 'Docs',
        },
        { to: '/docs/changelog', label: 'Changelog', position: 'left' },
        {
          href: 'https://www.npmjs.com/package/rn-iso',
          label: 'npm',
          position: 'right',
        },
        {
          href: 'https://github.com/appandflow/rn-iso',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Getting started', to: '/docs/getting-started' },
            { label: 'Commands', to: '/docs/commands' },
            { label: 'Worktrees', to: '/docs/worktrees' },
          ],
        },
        {
          title: 'Packages',
          items: [
            { label: 'rn-iso', href: 'https://www.npmjs.com/package/rn-iso' },
            { label: '@rn-iso/metro', href: 'https://www.npmjs.com/package/@rn-iso/metro' },
            {
              label: '@rn-iso/expo-build-cache',
              href: 'https://www.npmjs.com/package/@rn-iso/expo-build-cache',
            },
          ],
        },
        {
          title: 'More',
          items: [
            { label: 'GitHub', href: 'https://github.com/appandflow/rn-iso' },
            { label: 'Issues', href: 'https://github.com/appandflow/rn-iso/issues' },
          ],
        },
      ],
      copyright: `MIT License. Built by AppAndFlow.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
