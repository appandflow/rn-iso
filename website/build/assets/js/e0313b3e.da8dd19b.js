'use strict';
(self.webpackChunkwebsite = self.webpackChunkwebsite || []).push([
  ['776'],
  {
    5496(e, r, t) {
      (t.r(r),
        t.d(r, {
          metadata: () => o,
          default: () => h,
          frontMatter: () => i,
          contentTitle: () => d,
          toc: () => a,
          assets: () => c,
        }));
      var o = JSON.parse(
          '{"id":"worktrees","title":"Worktrees","description":"Isolated git worktrees with carried gitignored files, and teardown that reclaims everything","source":"@site/docs/worktrees.md","sourceDirName":".","slug":"/worktrees","permalink":"/rn-iso/docs/worktrees","draft":false,"unlisted":false,"editUrl":"https://github.com/appandflow/rn-iso/tree/main/website/docs/worktrees.md","tags":[],"version":"current","sidebarPosition":4,"frontMatter":{"title":"Worktrees","sidebar_position":4,"description":"Isolated git worktrees with carried gitignored files, and teardown that reclaims everything"},"sidebar":"docs","previous":{"title":"Build caches","permalink":"/rn-iso/docs/build-caches"},"next":{"title":"Settings","permalink":"/rn-iso/docs/settings"}}',
        ),
        n = t(4848),
        s = t(8453);
      let i = {
          title: 'Worktrees',
          sidebar_position: 4,
          description: 'Isolated git worktrees with carried gitignored files, and teardown that reclaims everything',
        },
        d,
        c = {},
        a = [
          { value: 'Carry-over', id: 'carry-over', level: 3 },
          { value: '<code>--carry-ignored</code>', id: '--carry-ignored', level: 4 },
          {
            value: 'Why worktrees live next to the repo, not inside it',
            id: 'why-worktrees-live-next-to-the-repo-not-inside-it',
            level: 3,
          },
          {
            value: 'Wiring into Claude Code (<code>WorktreeCreate</code> hook)',
            id: 'wiring-into-claude-code-worktreecreate-hook',
            level: 3,
          },
        ];
      function l(e) {
        let r = {
          code: 'code',
          em: 'em',
          h3: 'h3',
          h4: 'h4',
          li: 'li',
          p: 'p',
          pre: 'pre',
          strong: 'strong',
          ul: 'ul',
          ...(0, s.R)(),
          ...e.components,
        };
        return (0, n.jsxs)(n.Fragment, {
          children: [
            (0, n.jsx)(r.pre, {
              children: (0, n.jsx)(r.code, {
                className: 'language-bash',
                children:
                  'npx rn-iso worktree create feature-x        # creates ../<repo>-worktrees/feature-x\nnpx rn-iso worktree remove                  # removes it, deleting its owned device(s) and freeing its Metro port\n',
              }),
            }),
            '\n',
            (0, n.jsxs)(r.p, {
              children: [
                (0, n.jsx)(r.code, { children: 'worktree create <name>' }),
                ' does three things in one step: creates the git worktree itself (branched ',
                (0, n.jsx)(r.code, { children: 'worktree-<name>' }),
                ' off ',
                (0, n.jsx)(r.code, { children: 'origin/HEAD' }),
                ' by default -- pass ',
                (0, n.jsx)(r.code, { children: '--base head' }),
                ' to branch off the current ',
                (0, n.jsx)(r.code, { children: 'HEAD' }),
                ' instead), carries over gitignored files (see "Carry-over" below), and registers a label for the worktree root so ',
                (0, n.jsx)(r.code, { children: 'rn-iso' }),
                " shortcuts don't collide across a monorepo's worktrees (every worktree of a monorepo shares the same app-dir basename). Prefer it over a raw ",
                (0, n.jsx)(r.code, { children: 'git worktree add' }),
                ' for that reason. It prints only the resulting worktree path to stdout; everything else goes to stderr (see "Wiring into Claude Code" below).',
              ],
            }),
            '\n',
            (0, n.jsxs)(r.p, {
              children: [
                'It deliberately does ',
                (0, n.jsx)(r.strong, { children: 'not' }),
                ' install dependencies. Which commands a repo actually needs -- a plain install, a workspace filter, a codegen step after it -- is project-specific judgment. Install them yourself (or from your agent) before building, or use ',
                (0, n.jsx)(r.code, { children: '--carry-ignored' }),
                " to clone the source worktree's ",
                (0, n.jsx)(r.code, { children: 'node_modules' }),
                '.',
              ],
            }),
            '\n',
            (0, n.jsxs)(r.p, {
              children: [
                (0, n.jsx)(r.code, { children: 'worktree remove [<path>]' }),
                " defaults to the current workspace. It reclaims the worktree's build artifacts, Metro port, and every owned device registered under it (deleting them, not just clearing the claim -- the environment dies whole) before removing the git worktree itself. It refuses if the worktree has uncommitted changes, untracked files, or commits that exist on no remote -- pass ",
                (0, n.jsx)(r.code, { children: '--force' }),
                ' to override, but note ',
                (0, n.jsx)(r.code, { children: '--force' }),
                ' only discards uncommitted/untracked state; committed work stays safe on the branch either way.',
              ],
            }),
            '\n',
            (0, n.jsxs)(r.p, {
              children: [
                'There is no ',
                (0, n.jsx)(r.code, { children: 'worktree list' }),
                ': ',
                (0, n.jsx)(r.code, { children: 'rn-iso status' }),
                ' shows the same worktrees ',
                (0, n.jsx)(r.em, { children: 'with' }),
                ' their devices, ports and supervisors, including ones that have no environment yet.',
              ],
            }),
            '\n',
            (0, n.jsx)(r.h3, { id: 'carry-over', children: 'Carry-over' }),
            '\n',
            (0, n.jsxs)(r.p, {
              children: [
                'Gitignored files (like ',
                (0, n.jsx)(r.code, { children: '.env' }),
                ", local certs, or IDE state) don't exist in a fresh worktree by default. ",
                (0, n.jsx)(r.code, { children: 'worktree create' }),
                ' copies any gitignored file matching a pattern from either:',
              ],
            }),
            '\n',
            (0, n.jsxs)(r.ul, {
              children: [
                '\n',
                (0, n.jsxs)(r.li, {
                  children: [
                    (0, n.jsx)(r.code, { children: '.worktreeinclude' }),
                    ' at the repo root -- one gitignore-style pattern per line (',
                    (0, n.jsx)(r.code, { children: '#' }),
                    ' comments allowed), e.g.:',
                    '\n',
                    (0, n.jsx)(r.pre, {
                      children: (0, n.jsx)(r.code, { children: '.env\n.env.*\n**/*.local.json\n' }),
                    }),
                    '\n',
                  ],
                }),
                '\n',
                (0, n.jsxs)(r.li, {
                  children: [
                    'or the ',
                    (0, n.jsx)(r.code, { children: 'worktree.include' }),
                    ' setting (see "Settings" below), if no ',
                    (0, n.jsx)(r.code, { children: '.worktreeinclude' }),
                    ' file exists.',
                  ],
                }),
                '\n',
              ],
            }),
            '\n',
            (0, n.jsx)(r.p, {
              children:
                'Only files that are both gitignored and pattern-matched are copied -- tracked files are never duplicated into the worktree.',
            }),
            '\n',
            (0, n.jsx)(r.h4, { id: '--carry-ignored', children: (0, n.jsx)(r.code, { children: '--carry-ignored' }) }),
            '\n',
            (0, n.jsxs)(r.p, {
              children: [
                'That carry-over is file-by-file, which suits a handful of small config files but not the multi-gigabyte trees a worktree needs in order to build without reinstalling. ',
                (0, n.jsx)(r.code, { children: 'worktree create --carry-ignored' }),
                ' instead clones ',
                (0, n.jsx)(r.strong, { children: 'every' }),
                ' gitignored path -- ',
                (0, n.jsx)(r.code, { children: 'node_modules' }),
                ', ',
                (0, n.jsx)(r.code, { children: 'ios/Pods' }),
                ', ',
                (0, n.jsx)(r.code, { children: 'ios/build' }),
                ' (React Native codegen output, without which ',
                (0, n.jsx)(r.code, { children: 'xcodebuild' }),
                ' fails on a missing ',
                (0, n.jsx)(r.code, { children: 'States.cpp' }),
                ' until ',
                (0, n.jsx)(r.code, { children: 'pod install' }),
                ' regenerates it) -- minus:',
              ],
            }),
            '\n',
            (0, n.jsxs)(r.ul, {
              children: [
                '\n',
                (0, n.jsxs)(r.li, {
                  children: [
                    (0, n.jsx)(r.code, { children: '.rn-iso/' }),
                    ', at any depth, ',
                    (0, n.jsx)(r.strong, { children: 'always' }),
                    ". It holds the workspace's own derived data, logs and supervisor pidfile: build output keyed to a path the new worktree does not have, and a pidfile for a process that is not running. That exclusion is in code, and no pattern file can turn it off.",
                  ],
                }),
                '\n',
                (0, n.jsxs)(r.li, {
                  children: [
                    'anything matching ',
                    (0, n.jsx)(r.code, { children: '.worktreeexclude' }),
                    ' at the repo root, same gitignore-style syntax as ',
                    (0, n.jsx)(r.code, { children: '.worktreeinclude' }),
                    ', e.g.:',
                    '\n',
                    (0, n.jsx)(r.pre, { children: (0, n.jsx)(r.code, { children: 'bench/results/logs\n' }) }),
                    '\n',
                  ],
                }),
                '\n',
                (0, n.jsxs)(r.li, {
                  children: [
                    'or the ',
                    (0, n.jsx)(r.code, { children: 'worktree.exclude' }),
                    ' setting, if no ',
                    (0, n.jsx)(r.code, { children: '.worktreeexclude' }),
                    ' file exists.',
                  ],
                }),
                '\n',
              ],
            }),
            '\n',
            (0, n.jsx)(r.p, {
              children:
                'It is a skip list rather than a copy list on purpose: forgetting to name something you needed shows up months later as a confusing build error, while forgetting to skip something only costs a needless copy.',
            }),
            '\n',
            (0, n.jsxs)(r.p, {
              children: [
                'Each path is cloned with ',
                (0, n.jsx)(r.code, { children: 'cp -Rc' }),
                ', so on APFS the copy is copy-on-write -- a 3.6 GB tree costs roughly 12s and tens of MB of real disk. Off by default because that only holds on APFS, within one volume: elsewhere the clone is refused and the fallback is a real copy of every byte, which ',
                (0, n.jsx)(r.code, { children: 'worktree create' }),
                ' warns about.',
              ],
            }),
            '\n',
            (0, n.jsx)(r.p, {
              children:
                "Cloned dependencies match the source worktree, not necessarily the new branch's manifests -- the same contract as restoring a CI cache. Reinstall if the branch changes them.",
            }),
            '\n',
            (0, n.jsx)(r.h3, {
              id: 'why-worktrees-live-next-to-the-repo-not-inside-it',
              children: 'Why worktrees live next to the repo, not inside it',
            }),
            '\n',
            (0, n.jsxs)(r.p, {
              children: [
                (0, n.jsx)(r.code, { children: 'worktree create' }),
                ' places new worktrees in a sibling directory (',
                (0, n.jsx)(r.code, { children: '../<repo>-worktrees/<name>' }),
                '), never under the repo root. A worktree nested inside the repo puts a second copy of every ',
                (0, n.jsx)(r.code, { children: 'package.json' }),
                " inside Metro's watch root, which causes jest-haste-map naming collisions (two files claiming the same module name). Its multi-gigabyte ",
                (0, n.jsx)(r.code, { children: 'node_modules' }),
                ' also gets walked by Metro, TypeScript, and ESLint on every run. Gitignoring the nested worktree directory does not fix either problem: those tools walk the filesystem directly, not ',
                (0, n.jsx)(r.code, { children: 'git' }),
                ', so a ',
                (0, n.jsx)(r.code, { children: '.gitignore' }),
                ' entry is invisible to them.',
              ],
            }),
            '\n',
            (0, n.jsxs)(r.h3, {
              id: 'wiring-into-claude-code-worktreecreate-hook',
              children: ['Wiring into Claude Code (', (0, n.jsx)(r.code, { children: 'WorktreeCreate' }), ' hook)'],
            }),
            '\n',
            (0, n.jsxs)(r.p, {
              children: [
                "Claude Code's ",
                (0, n.jsx)(r.code, { children: 'WorktreeCreate' }),
                " hook fires when a session for a new worktree starts, and uses the hook command's stdout as the directory for that session. ",
                (0, n.jsx)(r.code, { children: 'rn-iso worktree create' }),
                ' is built for exactly this contract -- it prints only the resulting path to stdout, and everything else goes to stderr. Wire it in ',
                (0, n.jsx)(r.code, { children: '.claude/settings.json' }),
                ':',
              ],
            }),
            '\n',
            (0, n.jsx)(r.pre, {
              children: (0, n.jsx)(r.code, {
                className: 'language-json',
                children:
                  '{\n  "hooks": {\n    "WorktreeCreate": [{ "hooks": [{ "type": "command", "command": "rn-iso worktree create \\"$(jq -r .name)\\"" }] }]\n  }\n}\n',
              }),
            }),
          ],
        });
      }
      function h(e = {}) {
        let { wrapper: r } = { ...(0, s.R)(), ...e.components };
        return r ? (0, n.jsx)(r, { ...e, children: (0, n.jsx)(l, { ...e }) }) : l(e);
      }
    },
    8453(e, r, t) {
      t.d(r, { R: () => i, x: () => d });
      var o = t(6540);
      let n = {},
        s = o.createContext(n);
      function i(e) {
        let r = o.useContext(s);
        return o.useMemo(
          function () {
            return 'function' == typeof e ? e(r) : { ...r, ...e };
          },
          [r, e],
        );
      }
      function d(e) {
        let r;
        return (
          (r = e.disableParentContext
            ? 'function' == typeof e.components
              ? e.components(n)
              : e.components || n
            : i(e.components)),
          o.createElement(s.Provider, { value: r }, e.children)
        );
      }
    },
  },
]);
