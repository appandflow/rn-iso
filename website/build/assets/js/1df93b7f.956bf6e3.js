'use strict';
(self.webpackChunkwebsite = self.webpackChunkwebsite || []).push([
  ['452'],
  {
    5146(e, t, n) {
      (n.r(t), n.d(t, { default: () => h }));
      var s = n(4848),
        a = n(5310),
        i = n(898),
        r = n(1085),
        o = n(1113),
        l = n(2072);
      let d = `# the only command a human runs:
npx skills add appandflow/rn-iso

# then tell your agent:
#   /rn-iso-init
#   "Build and run the app on the iOS simulator and fix anything that breaks."`,
        c = [
          {
            title: 'Isolated environments',
            body: (0, s.jsxs)(s.Fragment, {
              children: [
                'Every project or git worktree gets its own reserved Metro port and its own ',
                (0, s.jsx)('em', { children: 'owned' }),
                ' simulator or emulator. Several coding agents build the same app on one machine at the same time without fighting over ports and devices.',
              ],
            }),
          },
          {
            title: 'Built for agent loops',
            body: (0, s.jsxs)(s.Fragment, {
              children: [
                'Never prompts, prints on the order of ten lines, takes ',
                (0, s.jsx)('code', { children: '--json' }),
                ' everywhere, and reports a failing build as the extracted compiler diagnostic plus a log path \u2014 not four thousand lines of transcript.',
                ' ',
                (0, s.jsx)('code', { children: 'logs --errors' }),
                ' returning nothing is the pass condition.',
              ],
            }),
          },
          {
            title: 'Builds that hit a cache',
            body: (0, s.jsx)(s.Fragment, {
              children:
                'Native inputs are fingerprinted; when nothing native changed, the app installs from a shared cache instead of compiling. When two workspaces miss at once, exactly one compiles and the other installs its artifact.',
            }),
          },
          {
            title: 'Cleans up after dying agents',
            body: (0, s.jsxs)(s.Fragment, {
              children: [
                'A killed agent leaves a booted simulator, a Metro squatting on a port, a stale lock. ',
                (0, s.jsx)('code', { children: 'stop' }),
                ',',
                ' ',
                (0, s.jsx)('code', { children: 'worktree remove' }),
                ' and ',
                (0, s.jsx)('code', { children: 'gc' }),
                ' reclaim all of it \u2014 and rn-iso never touches a device it did not create.',
              ],
            }),
          },
        ];
      function h() {
        let { siteConfig: e } = (0, i.A)();
        return (0, s.jsxs)(r.A, {
          description:
            'The React Native / Expo CLI for AI agents: isolated dev environments, owned simulators, shared build caches, structured logs.',
          children: [
            (0, s.jsx)('header', {
              className: 'hero hero--dark',
              style: { textAlign: 'center', padding: '4rem 1rem' },
              children: (0, s.jsxs)('div', {
                className: 'container',
                children: [
                  (0, s.jsx)(l.A, { as: 'h1', className: 'hero__title', children: e.title }),
                  (0, s.jsx)('p', { className: 'hero__subtitle', children: e.tagline }),
                  (0, s.jsx)('p', {
                    style: { maxWidth: 720, margin: '0 auto 2rem' },
                    children:
                      'Humans never run it \u2014 your agent does. Isolated dev environments, so several coding agents can build the same app on one machine at the same time, with a build loop optimised for an agent, not a terminal.',
                  }),
                  (0, s.jsx)('div', {
                    style: { maxWidth: 720, margin: '0 auto', textAlign: 'left' },
                    children: (0, s.jsx)(o.A, { language: 'bash', children: d }),
                  }),
                  (0, s.jsxs)('div', {
                    style: { marginTop: '1.5rem', display: 'flex', gap: '1rem', justifyContent: 'center' },
                    children: [
                      (0, s.jsx)(a.A, {
                        className: 'button button--primary button--lg',
                        to: '/docs/getting-started',
                        children: 'Get started',
                      }),
                      (0, s.jsx)(a.A, {
                        className: 'button button--secondary button--lg',
                        to: '/docs/why',
                        children: 'Why rn-iso',
                      }),
                    ],
                  }),
                ],
              }),
            }),
            (0, s.jsx)('main', {
              children: (0, s.jsx)('section', {
                className: 'container',
                style: { padding: '3rem 1rem' },
                children: (0, s.jsx)('div', {
                  className: 'row',
                  children: c.map((e) =>
                    (0, s.jsxs)(
                      'div',
                      {
                        className: 'col col--6',
                        style: { marginBottom: '2rem' },
                        children: [
                          (0, s.jsx)(l.A, { as: 'h3', children: e.title }),
                          (0, s.jsx)('p', { children: e.body }),
                        ],
                      },
                      e.title,
                    ),
                  ),
                }),
              }),
            }),
          ],
        });
      }
    },
  },
]);
