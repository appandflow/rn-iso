'use strict';
(self.webpackChunkwebsite = self.webpackChunkwebsite || []).push([
  ['337'],
  {
    183(e, t, n) {
      (n.r(t),
        n.d(t, {
          metadata: () => s,
          default: () => c,
          frontMatter: () => r,
          contentTitle: () => i,
          toc: () => h,
          assets: () => d,
        }));
      var s = JSON.parse(
          '{"id":"why","title":"Why rn-iso exists","description":"What breaks when coding agents share one machine, and what rn-iso does about it","source":"@site/docs/why.md","sourceDirName":".","slug":"/why","permalink":"/rn-iso/docs/why","draft":false,"unlisted":false,"editUrl":"https://github.com/appandflow/rn-iso/tree/main/website/docs/why.md","tags":[],"version":"current","sidebarPosition":1,"frontMatter":{"title":"Why rn-iso exists","sidebar_position":1,"description":"What breaks when coding agents share one machine, and what rn-iso does about it"},"sidebar":"docs","next":{"title":"Getting started","permalink":"/rn-iso/docs/getting-started"}}',
        ),
        o = n(4848),
        a = n(8453);
      let r = {
          title: 'Why rn-iso exists',
          sidebar_position: 1,
          description: 'What breaks when coding agents share one machine, and what rn-iso does about it',
        },
        i,
        d = {},
        h = [
          { value: 'The problem', id: 'the-problem', level: 2 },
          { value: 'Where local honestly loses', id: 'where-local-honestly-loses', level: 3 },
        ];
      function l(e) {
        let t = {
          a: 'a',
          blockquote: 'blockquote',
          code: 'code',
          em: 'em',
          h2: 'h2',
          h3: 'h3',
          li: 'li',
          p: 'p',
          strong: 'strong',
          ul: 'ul',
          ...(0, a.R)(),
          ...e.components,
        };
        return (0, o.jsxs)(o.Fragment, {
          children: [
            (0, o.jsxs)(t.p, {
              children: [
                'The React Native / Expo CLI for AI agents. One isolated dev environment per project or worktree: ',
                (0, o.jsx)(t.code, { children: 'rn-iso start' }),
                ' runs the dev server on a reserved, collision-free Metro port under a detached supervisor; ',
                (0, o.jsx)(t.code, { children: 'rn-iso ios' }),
                ' / ',
                (0, o.jsx)(t.code, { children: 'rn-iso android' }),
                ' boot a dedicated, ',
                (0, o.jsx)(t.strong, { children: 'owned' }),
                ' simulator/emulator, install a build from a shared fingerprint cache when nothing native changed, and launch the app wired to that port; ',
                (0, o.jsx)(t.code, { children: 'rn-iso logs --errors' }),
                ' answers "did that work" from a captured timeline instead of a scraped terminal. Multiple worktrees or coding agents can each get their own environment and build the same app in parallel without port or device collisions.',
              ],
            }),
            '\n',
            (0, o.jsxs)(t.p, {
              children: [
                'It never prompts, prints on the order of ten lines, takes ',
                (0, o.jsx)(t.code, { children: '--json' }),
                ' everywhere, and reports a failing build as the ',
                (0, o.jsx)(t.em, { children: 'extracted' }),
                ' compiler diagnostic plus a log path rather than four thousand lines of transcript.',
              ],
            }),
            '\n',
            (0, o.jsxs)(t.blockquote, {
              children: [
                '\n',
                (0, o.jsxs)(t.p, {
                  children: [
                    (0, o.jsx)(t.strong, { children: 'Experimental.' }),
                    ' APIs, flags, and on-disk state may change. ',
                    (0, o.jsx)(t.a, { href: 'https://github.com/appandflow/rn-iso/issues', children: 'File issues' }),
                    ' if anything breaks.',
                  ],
                }),
                '\n',
              ],
            }),
            '\n',
            (0, o.jsx)(t.h2, { id: 'the-problem', children: 'The problem' }),
            '\n',
            (0, o.jsx)(t.p, {
              children:
                'Coding agents are moving to the cloud, and React Native is one of the places\nthat goes badly. A cloud agent needs macOS, a matching Xcode, a booted\nsimulator, a signing identity, and every MCP server re-authenticated -- on\nrunners that cost several times a Linux box and lag Xcode releases by months.\nPhysical devices are simply out of reach.',
            }),
            '\n',
            (0, o.jsx)(t.p, {
              children:
                'Locally, none of that is a problem. The environment is already set up, the\nMac is already paid for, simulators work, you are already logged into\neverything, and the agent harness already provides the isolation that a cloud\nsandbox is there to provide.',
            }),
            '\n',
            (0, o.jsxs)(t.p, {
              children: [
                "What breaks locally is that agents share one machine. Two of them reach for\nport 8081, or the same booted simulator, and both end up talking to the wrong\nbundler -- silently, because nothing tells you a build attached to somebody\nelse's Metro. When an agent is killed mid-run it leaves a simulator booted, a\nMetro squatting on a port, and an ",
                (0, o.jsx)(t.code, { children: 'xcodebuild' }),
                ' test runner pinning a device\nnothing can now delete.',
              ],
            }),
            '\n',
            (0, o.jsxs)(t.p, {
              children: [
                'That is the first job of this tool: arbitrate the contended resources, and\nreclaim them when the agent that owned them dies badly. The second is the dev\nserver, which every agent otherwise backgrounds by hand and then scrapes a log\nfile for: ',
                (0, o.jsx)(t.code, { children: 'start' }),
                ' runs it on the reserved port and captures its output as\nstructured records, so ',
                (0, o.jsx)(t.code, { children: 'logs --errors' }),
                ' replaces the scraping. What stays out is\nthe build -- which command, which flags, when to install -- because that is\njudgment a coding agent already has from reading the repo, and rn-iso\ndeliberately does not take it back.',
              ],
            }),
            '\n',
            (0, o.jsx)(t.h3, { id: 'where-local-honestly-loses', children: 'Where local honestly loses' }),
            '\n',
            (0, o.jsxs)(t.ul, {
              children: [
                '\n',
                (0, o.jsxs)(t.li, {
                  children: [
                    (0, o.jsx)(t.strong, { children: 'CPU and memory are finite.' }),
                    ' Two or three live environments on a 16 GB\nmachine, not ten. Cloud wins this outright.',
                  ],
                }),
                '\n',
                (0, o.jsxs)(t.li, {
                  children: [
                    (0, o.jsx)(t.strong, { children: 'Paths are not stable.' }),
                    " CI checks out to the same path every run, so\npath-keyed caches (ccache, Xcode's compilation cache, a CocoaPods sandbox)\njust work. Locally every worktree sits somewhere different, and those caches\nquietly miss everything -- measured on one project as 0 ccache hits out of\n1094 across two workspaces. It is fixable, but it is a tax cloud does not pay.",
                  ],
                }),
                '\n',
                (0, o.jsxs)(t.li, {
                  children: [
                    (0, o.jsx)(t.strong, { children: 'Disk grows without bound.' }),
                    ' Simulators and the shared caches that make any\nof this fast all accumulate. ',
                    (0, o.jsx)(t.code, { children: 'gc' }),
                    ' exists for that reason.',
                  ],
                }),
                '\n',
              ],
            }),
            '\n',
            (0, o.jsxs)(t.p, {
              children: [
                'State lives in ',
                (0, o.jsx)(t.code, { children: '~/.rn-iso/config.json' }),
                ', keyed by absolute project path. Worktrees count as separate projects. There is no shared mutex -- each project gets its own port and its own device.',
              ],
            }),
          ],
        });
      }
      function c(e = {}) {
        let { wrapper: t } = { ...(0, a.R)(), ...e.components };
        return t ? (0, o.jsx)(t, { ...e, children: (0, o.jsx)(l, { ...e }) }) : l(e);
      }
    },
    8453(e, t, n) {
      n.d(t, { R: () => r, x: () => i });
      var s = n(6540);
      let o = {},
        a = s.createContext(o);
      function r(e) {
        let t = s.useContext(a);
        return s.useMemo(
          function () {
            return 'function' == typeof e ? e(t) : { ...t, ...e };
          },
          [t, e],
        );
      }
      function i(e) {
        let t;
        return (
          (t = e.disableParentContext
            ? 'function' == typeof e.components
              ? e.components(o)
              : e.components || o
            : r(e.components)),
          s.createElement(a.Provider, { value: t }, e.children)
        );
      }
    },
  },
]);
