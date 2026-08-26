'use strict';
(self.webpackChunkwebsite = self.webpackChunkwebsite || []).push([
  ['672'],
  {
    5625(e, n, s) {
      (s.r(n),
        s.d(n, {
          metadata: () => r,
          default: () => h,
          frontMatter: () => o,
          contentTitle: () => d,
          toc: () => c,
          assets: () => l,
        }));
      var r = JSON.parse(
          '{"id":"changelog","title":"Changelog","description":"Release notes","source":"@site/docs/changelog.md","sourceDirName":".","slug":"/changelog","permalink":"/rn-iso/docs/changelog","draft":false,"unlisted":false,"editUrl":"https://github.com/appandflow/rn-iso/tree/main/website/docs/changelog.md","tags":[],"version":"current","sidebarPosition":99,"frontMatter":{"title":"Changelog","sidebar_position":99,"description":"Release notes"},"sidebar":"docs","previous":{"title":"Requirements","permalink":"/rn-iso/docs/requirements"}}',
        ),
        i = s(4848),
        t = s(8453);
      let o = { title: 'Changelog', sidebar_position: 99, description: 'Release notes' },
        d = '1.3.1',
        l = {},
        c = [
          { value: 'Fixes', id: 'fixes', level: 2 },
          { value: 'Docs', id: 'docs', level: 2 },
          { value: 'New', id: 'new', level: 2 },
          { value: 'Removed (breaking)', id: 'removed-breaking', level: 2 },
          { value: 'Fixes', id: 'fixes-1', level: 2 },
          { value: 'Docs', id: 'docs-1', level: 2 },
        ];
      function a(e) {
        let n = {
          a: 'a',
          code: 'code',
          h1: 'h1',
          h2: 'h2',
          header: 'header',
          li: 'li',
          p: 'p',
          strong: 'strong',
          ul: 'ul',
          ...(0, t.R)(),
          ...e.components,
        };
        return (0, i.jsxs)(i.Fragment, {
          children: [
            (0, i.jsxs)(n.p, {
              children: [
                'Full release history is on ',
                (0, i.jsx)(n.a, { href: 'https://github.com/appandflow/rn-iso/releases', children: 'GitHub Releases' }),
                '.',
              ],
            }),
            '\n',
            (0, i.jsx)(n.header, { children: (0, i.jsx)(n.h1, { id: '131', children: '1.3.1' }) }),
            '\n',
            (0, i.jsx)(n.p, {
              children:
                'A patch release: everything the 1.3.0 field test and the native e2e matrix\nshook out. Two groups of fixes -- the ones CI forced (rn-iso now has a\n2x2 native e2e, real apps built on real simulators and emulators on GitHub\nrunners, and getting it green found real product bugs) -- and the diagnostics\nissues the field test filed (#24, #25, #26).',
            }),
            '\n',
            (0, i.jsx)(n.h2, { id: 'fixes', children: 'Fixes' }),
            '\n',
            (0, i.jsx)(n.p, {
              children: 'Found by the native e2e (they bit CI first, but any Linux or Intel host hits\nthem):',
            }),
            '\n',
            (0, i.jsxs)(n.ul, {
              children: [
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsxs)(n.strong, {
                      children: [
                        'Metro identity on hosts where ',
                        (0, i.jsx)(n.code, { children: 'lsof -d cwd' }),
                        ' answers nothing.',
                      ],
                    }),
                    " GitHub's\nubuntu runners do exactly this, so a healthy dev server could never verify\nas the project's own and every ",
                    (0, i.jsx)(n.code, { children: 'start' }),
                    ' timed out. Linux now reads\n',
                    (0, i.jsx)(n.code, { children: '/proc/<pid>/cwd' }),
                    ' directly; lsof stays the macOS path and the fallback.',
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsx)(n.strong, { children: "Android system images are picked for the host's architecture." }),
                    ' The\narm64-only filter returned nothing on an x86_64 host; the pick now matches\nthe machine (arm64 -> arm64-v8a, otherwise x86_64).',
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsx)(n.strong, { children: 'The emulator boots headless on a displayless Linux host.' }),
                    ' Without\n',
                    (0, i.jsx)(n.code, { children: '-no-window' }),
                    ' it died in display init and never registered with adb; rn-iso\ndetects the absence of DISPLAY/WAYLAND_DISPLAY rather than asking for\nconfiguration. A desktop session keeps its window.',
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsx)(n.strong, { children: 'A cold first AVD boot gets 240s' }),
                    ' (was 120), which software rendering on a\nloaded machine genuinely needs.',
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsxs)(n.strong, {
                      children: [
                        (0, i.jsx)(n.code, { children: 'android' }),
                        ' launches cache-hit builds in projects with no ',
                        (0, i.jsx)(n.code, { children: 'android/' }),
                        '\ndirectory',
                      ],
                    }),
                    " by reading the package name from the APK's own manifest --\nmirroring what iOS already did with the cached app's Info.plist.",
                  ],
                }),
                '\n',
              ],
            }),
            '\n',
            (0, i.jsx)(n.p, { children: 'From the field-test issues:' }),
            '\n',
            (0, i.jsxs)(n.ul, {
              children: [
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsx)(n.strong, { children: '#24' }),
                    ' -- a failed ',
                    (0, i.jsx)(n.code, { children: 'start' }),
                    " now quotes this attempt's error records from the\nlog timeline, not just supervisor.log. In expo-child mode a dev server that\ndies on a config error (the field case: a ",
                    (0, i.jsx)(n.code, { children: 'PluginError' }),
                    ' from a stale\nworktree) leaves supervisor.log empty and its death cry in metro.ndjson;\nthe failure used to point at the empty file.',
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsx)(n.strong, { children: '#25' }),
                    ' -- the ',
                    (0, i.jsx)(n.code, { children: 'logs --json' }),
                    ' zero-match contract is pinned in ',
                    (0, i.jsx)(n.code, { children: 'guide logs' }),
                    '\nand the flag help: zero matches is zero bytes on stdout with exit 0 (an\nempty NDJSON stream -- parse line by line, never as one JSON document).',
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsx)(n.strong, { children: '#26' }),
                    ' -- the occupied-sim skip names only the foreign ',
                    (0, i.jsx)(n.code, { children: '.xctrunner' }),
                    '\nbundles the occupancy decider actually counted, instead of a ',
                    (0, i.jsx)(n.code, { children: 'ps' }),
                    ' scan that\ndragged in the sim\'s own runtime and the app rn-iso itself launched; the\n"current as of the last ',
                    (0, i.jsx)(n.code, { children: 'git fetch' }),
                    '" note no longer prints for\n',
                    (0, i.jsx)(n.code, { children: '--base head' }),
                    ' (it only applies to ',
                    (0, i.jsx)(n.code, { children: 'fresh' }),
                    '); and the 30s heartbeat now also\ncovers the pod-install phase (a 2m33s ',
                    (0, i.jsx)(n.code, { children: 'pod install' }),
                    ' used to be silent).',
                  ],
                }),
                '\n',
              ],
            }),
            '\n',
            (0, i.jsx)(n.h2, { id: 'docs', children: 'Docs' }),
            '\n',
            (0, i.jsxs)(n.ul, {
              children: [
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsx)(n.strong, {
                      children: (0, i.jsx)(n.a, { href: '/docs/getting-started', children: 'Getting started' }),
                    }),
                    ' -- the quickest integration in\nfour steps: zero-install first run, agent skills via ',
                    (0, i.jsx)(n.code, { children: 'npx skills add appandflow/rn-iso' }),
                    ', the ten-minute cache wiring, parallel worktrees. Linked\nfrom both READMEs.',
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    'The lingering ',
                    (0, i.jsx)(n.code, { children: 'npx rn-iso skill install' }),
                    ' instructions are gone from the\nREADME (the command was removed in 1.3.0).',
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    'Skill caveat: ',
                    (0, i.jsx)(n.code, { children: '--carry-ignored' }),
                    ' against a base whose ',
                    (0, i.jsx)(n.code, { children: '.gitignore' }),
                    ' differs\ncan leave carried paths as untracked churn that ',
                    (0, i.jsx)(n.code, { children: 'worktree remove' }),
                    ' later,\ncorrectly, refuses over -- with the per-class restore commands.',
                  ],
                }),
                '\n',
              ],
            }),
            '\n',
            (0, i.jsx)(n.h1, { id: '130', children: '1.3.0' }),
            '\n',
            (0, i.jsx)(n.p, {
              children:
                'Everything since v1.1.0 \u2014 the TypeScript migration (the unpublished 1.2.0 bump)\nplus a hardening pass, a four-round code review, and the full field-test issue\nbacklog. All three packages move together, as always.',
            }),
            '\n',
            (0, i.jsx)(n.h2, { id: 'new', children: 'New' }),
            '\n',
            (0, i.jsxs)(n.ul, {
              children: [
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsx)(n.strong, { children: 'TypeScript, end to end.' }),
                    ' The codebase is strict TS 7 (native), bundled\nwith tsdown \u2014 ',
                    (0, i.jsx)(n.code, { children: 'rn-iso' }),
                    ' ships ESM, the two cache packages stay deliberate\nCJS. Tests run on vitest and typecheck in the same strict pass as\nproduction; oxlint (',
                    (0, i.jsx)(n.code, { children: 'no-explicit-any' }),
                    ' as an error) and oxfmt gate style, and\nknip gates dead code in CI.',
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsx)(n.strong, { children: 'Build heartbeat.' }),
                    ' ',
                    (0, i.jsx)(n.code, { children: 'ios' }),
                    ' / ',
                    (0, i.jsx)(n.code, { children: 'android' }),
                    ' print a stderr line about every 30s\nwhile the compiler runs \u2014 elapsed time plus the current transcript line \u2014 so\na five-minute build is never indistinguishable from a wedged one. stdout\nstill carries exactly one ',
                    (0, i.jsx)(n.code, { children: '--json' }),
                    ' payload.',
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsx)(n.strong, { children: 'Per-run build transcript.' }),
                    ' ',
                    (0, i.jsx)(n.code, { children: 'build-<platform>.ndjson' }),
                    ' now truncates on\neach run\'s first write; "see the log for the transcript" always opens on\nthis run. Device/metro logs still append.',
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsxs)(n.strong, {
                      children: [
                        (0, i.jsx)(n.code, { children: 'status --json' }),
                        ': ',
                        (0, i.jsx)(n.code, { children: 'labelOnly' }),
                        '.',
                      ],
                    }),
                    ' A monorepo worktree-root entry that only\nholds the label reservation is now flagged, so JSON consumers can count\nworkspaces without double-counting.',
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsxs)(n.strong, {
                      children: [(0, i.jsx)(n.code, { children: 'worktree create' }), ' staleness note.'],
                    }),
                    ' ',
                    (0, i.jsx)(n.code, { children: 'fresh' }),
                    ' / ',
                    (0, i.jsx)(n.code, { children: 'head' }),
                    ' branch from a\nremote-tracking ref that is only as current as the last ',
                    (0, i.jsx)(n.code, { children: 'git fetch' }),
                    '; the\ncommand now says so instead of silently building on stale code.',
                  ],
                }),
                '\n',
              ],
            }),
            '\n',
            (0, i.jsx)(n.h2, { id: 'removed-breaking', children: 'Removed (breaking)' }),
            '\n',
            (0, i.jsxs)(n.ul, {
              children: [
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsxs)(n.strong, {
                      children: ['The ', (0, i.jsx)(n.code, { children: 'skill' }), ' command.'],
                    }),
                    ' Bundled skills are installed with ',
                    (0, i.jsx)(n.code, { children: 'npx skills' }),
                    ';\na built-in copy-into-',
                    (0, i.jsx)(n.code, { children: '~/.claude' }),
                    ' command (and its staleness warning on\n',
                    (0, i.jsx)(n.code, { children: 'start' }),
                    ') was redundant. The surface is now ten commands.',
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsx)(n.strong, { children: 'Node 20.' }),
                    ' The floor is Node >= 22 (Node 20 reaches end of life\n2026-04-30, and the toolchain runs TypeScript natively).',
                  ],
                }),
                '\n',
              ],
            }),
            '\n',
            (0, i.jsx)(n.h2, { id: 'fixes-1', children: 'Fixes' }),
            '\n',
            (0, i.jsx)(n.p, { children: 'Found by a four-round adversarial code review:' }),
            '\n',
            (0, i.jsxs)(n.ul, {
              children: [
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsx)(n.strong, { children: 'spawn-entry' }),
                    ' resolved its dev/dist layout by matching ',
                    (0, i.jsx)(n.code, { children: '/src/' }),
                    ' anywhere in\nthe module URL, so a package installed under a path containing ',
                    (0, i.jsx)(n.code, { children: '/src/' }),
                    "\nspawned a supervisor from files that do not exist. It now checks only the\nmodule's own parent directory.",
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsx)(n.strong, { children: 'Single-flight builds' }),
                    ' could double-acquire: the stale-lock takeover did an\nunconditional ',
                    (0, i.jsx)(n.code, { children: 'rmSync' }),
                    " on a stale read, so a late waiter could delete the new\nholder's fresh lock (build-lock) or over-subscribe ",
                    (0, i.jsx)(n.code, { children: 'maxBuilds' }),
                    ' (build-slots).\nTakeover is atomic now (',
                    (0, i.jsx)(n.code, { children: 'renameSync' }),
                    '), and ',
                    (0, i.jsx)(n.code, { children: 'gc --delete' }),
                    ' re-checks liveness\nright before removing a stale lock or slot.',
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsx)(n.strong, { children: (0, i.jsx)(n.code, { children: 'killMetroTree' }) }),
                    " signalled the process-group leader \u2014 the shell, not\nMetro \u2014 when a backgrounded Metro shared rn-iso's own group. It now signals\nthe listener pid in that case.",
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsx)(n.strong, { children: (0, i.jsx)(n.code, { children: 'reclaimProject' }) }),
                    ' (',
                    (0, i.jsx)(n.code, { children: 'worktree remove' }),
                    ' / ',
                    (0, i.jsx)(n.code, { children: 'gc' }),
                    ') never reaped device-log\ncollectors the way ',
                    (0, i.jsx)(n.code, { children: 'stop' }),
                    ' does; a collector outliving a failed device\nteardown could resurrect a zombie ',
                    (0, i.jsx)(n.code, { children: '.rn-iso/' }),
                    ' after the tree was deleted.',
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsx)(n.strong, { children: (0, i.jsx)(n.code, { children: 'removeWorktree' }) }),
                    ' ran a destructive ',
                    (0, i.jsx)(n.code, { children: 'git worktree remove' }),
                    ' through the\nshell with the path interpolated; it uses ',
                    (0, i.jsx)(n.code, { children: 'runFile' }),
                    ' with ',
                    (0, i.jsx)(n.code, { children: '--' }),
                    ' now.',
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    'The Expo build-cache provider guards its readdir/touch/rename against a\nconcurrent prune, matching the CLI-side twin; ',
                    (0, i.jsx)(n.code, { children: 'doctor' }),
                    ' also reads\n',
                    (0, i.jsx)(n.code, { children: 'metro.config.cjs' }),
                    '.',
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsx)(n.strong, { children: 'Metro identity on Linux' }),
                    ' reads ',
                    (0, i.jsx)(n.code, { children: '/proc/<pid>/cwd' }),
                    ' directly (lsof stays the\nmacOS path and the fallback): on hosts where ',
                    (0, i.jsx)(n.code, { children: 'lsof -d cwd' }),
                    " returns nothing --\nGitHub's ubuntu runners do exactly this -- a healthy dev server could never\nverify as the project's own, and every ",
                    (0, i.jsx)(n.code, { children: 'start' }),
                    ' timed out.',
                  ],
                }),
                '\n',
              ],
            }),
            '\n',
            (0, i.jsx)(n.p, { children: 'From the field-test issue backlog:' }),
            '\n',
            (0, i.jsxs)(n.ul, {
              children: [
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsx)(n.strong, { children: '#8' }),
                    ' \u2014 ',
                    (0, i.jsx)(n.code, { children: 'worktree remove' }),
                    ' no longer counts commits inherited from a\nlocal-only base ref as unpushed; only commits reachable from nowhere else\nrefuse removal, and the remedy is followable.',
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsx)(n.strong, { children: '#9' }),
                    ' \u2014 pod-install failures print the CocoaPods ',
                    (0, i.jsx)(n.code, { children: '[!]' }),
                    ' blocks / Ruby\nexception head instead of the log tail (which held deferred warnings).',
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsx)(n.strong, { children: '#13' }),
                    ' \u2014 ',
                    (0, i.jsx)(n.code, { children: 'logs --errors' }),
                    ' no longer accumulates across consecutive failed\nbundles: every bundle attempt writes a marker when it finishes, success or\nfailure, so only the newest failure is reported; a client redbox is never\nretired by a failed rebuild.',
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsx)(n.strong, { children: '#14' }),
                    ' \u2014 ',
                    (0, i.jsx)(n.code, { children: 'gc' }),
                    "'s device sweep waits 30s (was 10s) before giving up, so\norphaned emulators surface on a loaded machine.",
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsx)(n.strong, { children: '#18' }),
                    ' \u2014 Android tooling (',
                    (0, i.jsx)(n.code, { children: 'emulator' }),
                    ', ',
                    (0, i.jsx)(n.code, { children: 'adb' }),
                    ', ',
                    (0, i.jsx)(n.code, { children: 'avdmanager' }),
                    ') is resolved via\n',
                    (0, i.jsx)(n.code, { children: 'ANDROID_HOME' }),
                    ' / ',
                    (0, i.jsx)(n.code, { children: 'ANDROID_SDK_ROOT' }),
                    ' / ',
                    (0, i.jsx)(n.code, { children: '~/Library/Android/sdk' }),
                    ' before falling\nback to ',
                    (0, i.jsx)(n.code, { children: 'PATH' }),
                    ', so teardown from a shell without the SDK exported succeeds\ninstead of permanently orphaning the registry entry.',
                  ],
                }),
                '\n',
                (0, i.jsxs)(n.li, {
                  children: [
                    (0, i.jsx)(n.strong, { children: '#16' }),
                    ' \u2014 the skill documents the private-registry ',
                    (0, i.jsx)(n.code, { children: '.npmrc' }),
                    ' failure mode of\n',
                    (0, i.jsx)(n.code, { children: 'npx rn-iso' }),
                    ' (E401) and the ',
                    (0, i.jsx)(n.code, { children: '--registry' }),
                    ' workaround.',
                  ],
                }),
                '\n',
              ],
            }),
            '\n',
            (0, i.jsx)(n.h2, { id: 'docs-1', children: 'Docs' }),
            '\n',
            (0, i.jsxs)(n.ul, {
              children: [
                '\n',
                (0, i.jsx)(n.li, {
                  children:
                    'Clean-slate pass: comments and docs describe the tool as it is, without\nversion archaeology; executed implementation plans removed.',
                }),
                '\n',
              ],
            }),
          ],
        });
      }
      function h(e = {}) {
        let { wrapper: n } = { ...(0, t.R)(), ...e.components };
        return n ? (0, i.jsx)(n, { ...e, children: (0, i.jsx)(a, { ...e }) }) : a(e);
      }
    },
    8453(e, n, s) {
      s.d(n, { R: () => o, x: () => d });
      var r = s(6540);
      let i = {},
        t = r.createContext(i);
      function o(e) {
        let n = r.useContext(t);
        return r.useMemo(
          function () {
            return 'function' == typeof e ? e(n) : { ...n, ...e };
          },
          [n, e],
        );
      }
      function d(e) {
        let n;
        return (
          (n = e.disableParentContext
            ? 'function' == typeof e.components
              ? e.components(i)
              : e.components || i
            : o(e.components)),
          r.createElement(t.Provider, { value: n }, e.children)
        );
      }
    },
  },
]);
