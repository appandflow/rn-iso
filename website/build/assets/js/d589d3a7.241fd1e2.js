'use strict';
(self.webpackChunkwebsite = self.webpackChunkwebsite || []).push([
  ['557'],
  {
    526(e, n, t) {
      (t.r(n),
        t.d(n, {
          metadata: () => s,
          default: () => c,
          frontMatter: () => o,
          contentTitle: () => a,
          toc: () => d,
          assets: () => l,
        }));
      var s = JSON.parse(
          '{"id":"getting-started","title":"Getting started","description":"Install the skill, have the agent run /rn-iso-init, then describe what you want built","source":"@site/docs/getting-started.md","sourceDirName":".","slug":"/getting-started","permalink":"/rn-iso/docs/getting-started","draft":false,"unlisted":false,"editUrl":"https://github.com/appandflow/rn-iso/tree/main/website/docs/getting-started.md","tags":[],"version":"current","sidebarPosition":2,"frontMatter":{"title":"Getting started","sidebar_position":2,"description":"Install the skill, have the agent run /rn-iso-init, then describe what you want built"},"sidebar":"docs","previous":{"title":"Why rn-iso exists","permalink":"/rn-iso/docs/why"},"next":{"title":"Commands","permalink":"/rn-iso/docs/commands"}}',
        ),
        i = t(4848),
        r = t(8453);
      let o = {
          title: 'Getting started',
          sidebar_position: 2,
          description: 'Install the skill, have the agent run /rn-iso-init, then describe what you want built',
        },
        a,
        l = {},
        d = [
          { value: '1. Install the agent skill', id: '1-install-the-agent-skill', level: 2 },
          { value: '2. Have the agent set the project up', id: '2-have-the-agent-set-the-project-up', level: 2 },
          { value: '3. Describe what you want', id: '3-describe-what-you-want', level: 2 },
          { value: 'Parallel agents', id: 'parallel-agents', level: 2 },
          { value: 'Where next', id: 'where-next', level: 2 },
        ];
      function h(e) {
        let n = {
          a: 'a',
          code: 'code',
          h2: 'h2',
          p: 'p',
          pre: 'pre',
          strong: 'strong',
          ...(0, r.R)(),
          ...e.components,
        };
        return (0, i.jsxs)(i.Fragment, {
          children: [
            (0, i.jsxs)(n.p, {
              children: [
                'rn-iso is a CLI ',
                (0, i.jsx)(n.strong, { children: 'humans never run' }),
                ' \u2014 your coding agent does. Setup is one\ncommand, and it is the only one you type yourself.',
              ],
            }),
            '\n',
            (0, i.jsx)(n.h2, { id: '1-install-the-agent-skill', children: '1. Install the agent skill' }),
            '\n',
            (0, i.jsx)(n.pre, {
              children: (0, i.jsx)(n.code, {
                className: 'language-bash',
                children: 'npx skills add appandflow/rn-iso\n',
              }),
            }),
            '\n',
            (0, i.jsxs)(n.p, {
              children: [
                "That installs two skills into your agent's skill directory (",
                (0, i.jsx)(n.code, { children: '~/.claude/skills' }),
                ',\n',
                (0, i.jsx)(n.code, { children: '~/.agents/skills' }),
                '): ',
                (0, i.jsx)(n.strong, { children: 'rn-iso' }),
                ' \u2014 how to drive the CLI (the lifecycle, the\nownership model, the destructive-command rules) \u2014 and ',
                (0, i.jsx)(n.strong, { children: 'rn-iso-init' }),
                ' \u2014 the\nplaybook for setting a repo up. Re-run the same command after upgrading rn-iso\nto refresh them.',
              ],
            }),
            '\n',
            (0, i.jsx)(n.h2, {
              id: '2-have-the-agent-set-the-project-up',
              children: '2. Have the agent set the project up',
            }),
            '\n',
            (0, i.jsx)(n.p, { children: "In your app's repo, invoke the init skill:" }),
            '\n',
            (0, i.jsx)(n.pre, { children: (0, i.jsx)(n.code, { children: '/rn-iso-init\n' }) }),
            '\n',
            (0, i.jsxs)(n.p, {
              children: [
                'The agent runs ',
                (0, i.jsx)(n.code, { children: 'rn-iso doctor' }),
                ' (read-only), then applies each finding by hand\nin the files your project already owns: the shared Metro transform cache, the\nlocal Expo build cache provider, the settings that silently prevent either\nfrom working. There is deliberately no ',
                (0, i.jsx)(n.code, { children: 'rn-iso init' }),
                ' generator \u2014 every edit\nlands in a file with existing project logic in it, which is judgement, not\ntemplating.',
              ],
            }),
            '\n',
            (0, i.jsx)(n.h2, { id: '3-describe-what-you-want', children: '3. Describe what you want' }),
            '\n',
            (0, i.jsx)(n.pre, {
              children: (0, i.jsx)(n.code, {
                children: 'Build and run the app on the iOS simulator and fix anything that breaks.\n',
              }),
            }),
            '\n',
            (0, i.jsx)(n.p, { children: "That's the whole interface. Under the hood the agent drives:" }),
            '\n',
            (0, i.jsx)(n.pre, {
              children: (0, i.jsx)(n.code, {
                className: 'language-bash',
                children:
                  'npx rn-iso start             # dev server on a reserved port, under a supervisor\nnpx rn-iso ios               # owned simulator, cached native build, launch\nnpx rn-iso logs --errors     # no output + exit 0 = nothing is broken\nnpx rn-iso stop              # supervisor down, sim shut down, port freed\n',
              }),
            }),
            '\n',
            (0, i.jsxs)(n.p, {
              children: [
                '\u2014 its own dev server on a reserved port, its own ',
                (0, i.jsx)(n.strong, { children: 'owned' }),
                ' simulator,\na native build that installs from the shared cache when nothing native\nchanged, and a queryable log timeline to check its work. About ten lines of\noutput for the whole cycle, ',
                (0, i.jsx)(n.code, { children: '--json' }),
                ' everywhere.',
              ],
            }),
            '\n',
            (0, i.jsx)(n.h2, { id: 'parallel-agents', children: 'Parallel agents' }),
            '\n',
            (0, i.jsxs)(n.p, {
              children: [
                'Each git worktree is its own environment \u2014 own port, own device \u2014 so two\nagents build the same app side by side without fighting. Agents create and\ntear these down themselves (',
                (0, i.jsx)(n.code, { children: 'rn-iso worktree create' }),
                ' / ',
                (0, i.jsx)(n.code, { children: 'remove' }),
                '); teardown\nreclaims the device, the port and the build artifacts with the tree.',
              ],
            }),
            '\n',
            (0, i.jsx)(n.h2, { id: 'where-next', children: 'Where next' }),
            '\n',
            (0, i.jsxs)(n.p, {
              children: [
                'The ',
                (0, i.jsx)(n.a, { href: '/docs/commands', children: 'command reference' }),
                ' documents everything the agent runs,\nand the Concepts section covers the ownership model, the dev server, the\ncaches and worktrees \u2014 useful for understanding what is happening on your\nmachine, not because you need to type any of it.',
              ],
            }),
          ],
        });
      }
      function c(e = {}) {
        let { wrapper: n } = { ...(0, r.R)(), ...e.components };
        return n ? (0, i.jsx)(n, { ...e, children: (0, i.jsx)(h, { ...e }) }) : h(e);
      }
    },
    8453(e, n, t) {
      t.d(n, { R: () => o, x: () => a });
      var s = t(6540);
      let i = {},
        r = s.createContext(i);
      function o(e) {
        let n = s.useContext(r);
        return s.useMemo(
          function () {
            return 'function' == typeof e ? e(n) : { ...n, ...e };
          },
          [n, e],
        );
      }
      function a(e) {
        let n;
        return (
          (n = e.disableParentContext
            ? 'function' == typeof e.components
              ? e.components(i)
              : e.components || i
            : o(e.components)),
          s.createElement(r.Provider, { value: n }, e.children)
        );
      }
    },
  },
]);
