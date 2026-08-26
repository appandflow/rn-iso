'use strict';
(self.webpackChunkwebsite = self.webpackChunkwebsite || []).push([
  ['717'],
  {
    6285(e, s, n) {
      (n.r(s),
        n.d(s, {
          metadata: () => r,
          default: () => h,
          frontMatter: () => i,
          contentTitle: () => d,
          toc: () => a,
          assets: () => c,
        }));
      var r = JSON.parse(
          '{"id":"commands","title":"Commands","description":"The closed, ten-command surface, and what each one does","source":"@site/docs/commands.md","sourceDirName":".","slug":"/commands","permalink":"/rn-iso/docs/commands","draft":false,"unlisted":false,"editUrl":"https://github.com/appandflow/rn-iso/tree/main/website/docs/commands.md","tags":[],"version":"current","sidebarPosition":3,"frontMatter":{"title":"Commands","sidebar_position":3,"description":"The closed, ten-command surface, and what each one does"},"sidebar":"docs","previous":{"title":"Getting started","permalink":"/rn-iso/docs/getting-started"},"next":{"title":"Owned devices","permalink":"/rn-iso/docs/owned-devices"}}',
        ),
        t = n(4848),
        o = n(8453);
      let i = {
          title: 'Commands',
          sidebar_position: 3,
          description: 'The closed, ten-command surface, and what each one does',
        },
        d,
        c = {},
        a = [
          { value: 'Quick start', id: 'quick-start', level: 2 },
          { value: 'The ten commands', id: 'the-ten-commands', level: 2 },
          { value: 'Project labels (<code>--label</code>)', id: 'project-labels---label', level: 2 },
        ];
      function l(e) {
        let s = {
          a: 'a',
          code: 'code',
          em: 'em',
          h2: 'h2',
          p: 'p',
          pre: 'pre',
          strong: 'strong',
          table: 'table',
          tbody: 'tbody',
          td: 'td',
          th: 'th',
          thead: 'thead',
          tr: 'tr',
          ...(0, o.R)(),
          ...e.components,
        };
        return (0, t.jsxs)(t.Fragment, {
          children: [
            (0, t.jsx)(s.h2, { id: 'quick-start', children: 'Quick start' }),
            '\n',
            (0, t.jsxs)(s.p, {
              children: [
                'Run via ',
                (0, t.jsx)(s.code, { children: 'npx' }),
                ' from any RN/Expo project directory -- no install needed:',
              ],
            }),
            '\n',
            (0, t.jsx)(s.pre, {
              children: (0, t.jsx)(s.code, {
                className: 'language-bash',
                children:
                  'npx rn-iso start             # dev server on a reserved port, under a supervisor\nnpx rn-iso ios               # owned sim booted, app installed and launched on it\nnpx rn-iso logs --errors     # no output + exit 0 = nothing is broken\nnpx rn-iso stop              # supervisor down, sim shut down, port freed\n',
              }),
            }),
            '\n',
            (0, t.jsx)(s.pre, {
              children: (0, t.jsx)(s.code, {
                children:
                  '$ npx rn-iso start\nOK: dev server on port 8082, supervisor pid 41233 (expo-child)\n\n$ npx rn-iso ios\ndevice      rn-iso-myproject (BF2A..) booted\nfingerprint a3f9b1.. hit\ninstall     from cache (3.1s)\nlaunch      com.example.app\nOK: com.example.app launched on BF2A..\n',
              }),
            }),
            '\n',
            (0, t.jsxs)(s.p, {
              children: [
                'The order is not optional: ',
                (0, t.jsx)(s.code, { children: 'ios' }),
                ' / ',
                (0, t.jsx)(s.code, { children: 'android' }),
                ' never start the bundler, so with nothing holding the reserved port they refuse in about a second with ',
                (0, t.jsx)(s.code, { children: 'RN_ISO_NO_METRO' }),
                ' instead of spending four minutes building an app that cannot load a bundle.',
              ],
            }),
            '\n',
            (0, t.jsxs)(s.p, {
              children: [
                'Each command takes ',
                (0, t.jsx)(s.code, { children: '--json' }),
                ' and then prints exactly one line of JSON on stdout, with every other line on stderr:',
              ],
            }),
            '\n',
            (0, t.jsx)(s.pre, {
              children: (0, t.jsx)(s.code, {
                className: 'language-json',
                children:
                  '{\n  "platform": "ios",\n  "udid": "BF2A-...",\n  "deviceName": "rn-iso-myproject",\n  "fingerprint": "a3f9b1...",\n  "cacheKey": "...",\n  "cacheHit": "local",\n  "cacheSkipped": false,\n  "appPath": "/...",\n  "bundleId": "com.example.app",\n  "launched": true,\n  "metroPort": 8082,\n  "logs": { "dir": "/path/.rn-iso/logs" },\n  "durationMs": 9412\n}\n',
              }),
            }),
            '\n',
            (0, t.jsxs)(s.p, {
              children: [
                (0, t.jsx)(s.code, { children: 'cacheHit' }),
                ' is a LEVEL, not a boolean: ',
                (0, t.jsx)(s.code, { children: '"local"' }),
                " (this machine's shared cache), ",
                (0, t.jsx)(s.code, { children: '"remote"' }),
                " (the project's own Expo ",
                (0, t.jsx)(s.code, { children: 'buildCacheProvider' }),
                ', whose artifact is copied into the local cache on the way past) or ',
                (0, t.jsx)(s.code, { children: 'false' }),
                ' (it was compiled). ',
                (0, t.jsx)(s.code, { children: 'cacheSkipped' }),
                ' is true only when ',
                (0, t.jsx)(s.code, { children: '--no-build-cache' }),
                ' was passed, which is "nothing was looked up" rather than "nothing was found".',
              ],
            }),
            '\n',
            (0, t.jsxs)(s.p, {
              children: [
                'In a different worktree of the same app, the same two commands get a ',
                (0, t.jsx)(s.em, { children: 'different' }),
                ' owned sim and Metro port, so both run side by side.',
              ],
            }),
            '\n',
            (0, t.jsxs)(s.p, {
              children: [
                'To set a repo up for that in the first place, run ',
                (0, t.jsx)(s.code, { children: 'rn-iso doctor' }),
                ' and work\nthrough what it reports:',
              ],
            }),
            '\n',
            (0, t.jsx)(s.pre, {
              children: (0, t.jsx)(s.code, { className: 'language-bash', children: 'npx rn-iso doctor\n' }),
            }),
            '\n',
            (0, t.jsxs)(s.p, {
              children: [
                'There is no ',
                (0, t.jsx)(s.code, { children: 'rn-iso init' }),
                '. Every edit that setup needs lands in a file the\nproject already owns -- a ',
                (0, t.jsx)(s.code, { children: 'metro.config.js' }),
                ' with its own transformer, a\n',
                (0, t.jsx)(s.code, { children: 'Podfile' }),
                ' with existing ',
                (0, t.jsx)(s.code, { children: 'post_install' }),
                ' logic, an app config that may be\nTypeScript -- and a generator that rewrites those eventually corrupts one. So\n',
                (0, t.jsx)(s.code, { children: 'doctor' }),
                ' reports, read-only and always exit 0, and the bundled ',
                (0, t.jsx)(s.code, { children: 'rn-iso-init' }),
                '\nskill is the playbook for applying each finding by hand. The one edit that\nneeded no judgement, ',
                (0, t.jsx)(s.code, { children: '.rn-iso/' }),
                ' in ',
                (0, t.jsx)(s.code, { children: '.gitignore' }),
                ', is self-ensured: ',
                (0, t.jsx)(s.code, { children: 'start' }),
                ',\n',
                (0, t.jsx)(s.code, { children: 'ios' }),
                ' and ',
                (0, t.jsx)(s.code, { children: 'android' }),
                ' each add it if it is missing and say so once on stderr --\ncommit that line with the change you were already making, and it stops being\nrewritten in every fresh worktree.',
              ],
            }),
            '\n',
            (0, t.jsx)(s.p, {
              children:
                'For AI coding agents, install the bundled skills so the agent knows how to drive the CLI (the lifecycle, the facts contract, and the destructive-command rules). They install with the skills CLI, straight from GitHub:',
            }),
            '\n',
            (0, t.jsx)(s.pre, {
              children: (0, t.jsx)(s.code, {
                className: 'language-bash',
                children: 'npx skills add appandflow/rn-iso\n',
              }),
            }),
            '\n',
            (0, t.jsxs)(s.p, {
              children: [
                (0, t.jsx)(s.a, {
                  href: 'https://github.com/appandflow/rn-iso/blob/main/docs/getting-started.md',
                  children: 'Getting started',
                }),
                ' walks the whole integration -- first run, agent setup, cache wiring, worktrees -- in four short steps.',
              ],
            }),
            '\n',
            (0, t.jsx)(s.h2, { id: 'the-ten-commands', children: 'The ten commands' }),
            '\n',
            (0, t.jsxs)(s.p, {
              children: [
                'All commands below take the same ',
                (0, t.jsx)(s.code, { children: 'npx rn-iso' }),
                ' prefix.',
              ],
            }),
            '\n',
            (0, t.jsxs)(s.table, {
              children: [
                (0, t.jsx)(s.thead, {
                  children: (0, t.jsxs)(s.tr, {
                    children: [(0, t.jsx)(s.th, { children: 'Command' }), (0, t.jsx)(s.th, { children: 'Purpose' })],
                  }),
                }),
                (0, t.jsxs)(s.tbody, {
                  children: [
                    (0, t.jsxs)(s.tr, {
                      children: [
                        (0, t.jsx)(s.td, {
                          children: (0, t.jsx)(s.code, { children: 'start [--json] [--wait <seconds>]' }),
                        }),
                        (0, t.jsxs)(s.td, {
                          children: [
                            "Start this workspace's dev server on the reserved port under a detached supervisor, and block until it answers ",
                            (0, t.jsx)(s.em, { children: 'and' }),
                            " verifies as this project's (default 60s). Idempotent: a healthy dev server on the port is a no-op. Bare RN is hosted in-process with rn-iso's NDJSON reporter; Expo runs the project's own ",
                            (0, t.jsx)(s.code, { children: 'expo start --port <n>' }),
                            ' as a child. Structured logs land in ',
                            (0, t.jsx)(s.code, { children: '<root>/.rn-iso/logs' }),
                            ', and ',
                            (0, t.jsx)(s.code, { children: '.rn-iso/' }),
                            " is added to the project's ",
                            (0, t.jsx)(s.code, { children: '.gitignore' }),
                            ' if it is not already there. A failure under ',
                            (0, t.jsx)(s.code, { children: '--json' }),
                            ' still puts one line on stdout: the ',
                            (0, t.jsx)(s.code, { children: '{code, message, remedy}' }),
                            ' contract (',
                            (0, t.jsx)(s.code, { children: 'RN_ISO_METRO_TIMEOUT' }),
                            ', ',
                            (0, t.jsx)(s.code, { children: 'RN_ISO_SUPERVISOR_EXITED' }),
                            ', ...).',
                          ],
                        }),
                      ],
                    }),
                    (0, t.jsxs)(s.tr, {
                      children: [
                        (0, t.jsx)(s.td, {
                          children: (0, t.jsx)(s.code, {
                            children:
                              'logs [--source <s...>] [--level <l>] [--since <d>] [--grep <re>] [--tail <n>] [--errors] [--follow] [--json]',
                          }),
                        }),
                        (0, t.jsxs)(s.td, {
                          children: [
                            'Query the merged NDJSON timeline in ',
                            (0, t.jsx)(s.code, { children: '<root>/.rn-iso/logs' }),
                            '. Prints and exits; nothing matching is a successful, empty result (exit 0). ',
                            (0, t.jsx)(s.code, { children: '--errors' }),
                            ' is the agent-loop query: errors and fatals since the last marker. ',
                            (0, t.jsx)(s.code, { children: '--follow' }),
                            ' streams.',
                          ],
                        }),
                      ],
                    }),
                    (0, t.jsxs)(s.tr, {
                      children: [
                        (0, t.jsx)(s.td, {
                          children: (0, t.jsx)(s.code, {
                            children: 'ios [--json] [--no-metro-check] [--no-build-cache]',
                          }),
                        }),
                        (0, t.jsxs)(s.td, {
                          children: [
                            "Boot this workspace's owned simulator, verify the reserved port holds ",
                            (0, t.jsx)(s.em, { children: "this project's" }),
                            ' dev server, fingerprint the native inputs, install the cached ',
                            (0, t.jsx)(s.code, { children: '.app' }),
                            ' if that fingerprint has one (otherwise prebuild / ',
                            (0, t.jsx)(s.code, { children: 'pod install' }),
                            ' / ',
                            (0, t.jsx)(s.code, { children: 'xcodebuild' }),
                            ' and store the result), install, launch wired to the reserved port, and attach a device-log collector. Refuses with ',
                            (0, t.jsx)(s.code, { children: 'RN_ISO_NO_METRO' }),
                            ' in about a second when nothing holds the port; ',
                            (0, t.jsx)(s.code, { children: '--no-metro-check' }),
                            ' overrides. On an Expo project a local miss also asks the provider the project already configured (',
                            (0, t.jsx)(s.code, { children: 'expo.buildCacheProvider' }),
                            '), time-bounded, and a hit is stored locally on the way past. ',
                            (0, t.jsx)(s.code, { children: '--no-build-cache' }),
                            ' looks nothing up and builds fresh -- it still stores (replacing the entry) and still uploads. Debug / simulator only.',
                          ],
                        }),
                      ],
                    }),
                    (0, t.jsxs)(s.tr, {
                      children: [
                        (0, t.jsx)(s.td, {
                          children: (0, t.jsx)(s.code, {
                            children: 'android [--json] [--no-metro-check] [--no-build-cache]',
                          }),
                        }),
                        (0, t.jsxs)(s.td, {
                          children: [
                            'The same over ',
                            (0, t.jsx)(s.code, { children: 'gradlew assembleDebug' }),
                            ' and ',
                            (0, t.jsx)(s.code, { children: 'adb' }),
                            ", on this workspace's owned emulator, with ",
                            (0, t.jsx)(s.code, { children: 'adb reverse tcp:8081 tcp:<port>' }),
                            ' doing the port wiring.',
                          ],
                        }),
                      ],
                    }),
                    (0, t.jsxs)(s.tr, {
                      children: [
                        (0, t.jsx)(s.td, { children: (0, t.jsx)(s.code, { children: 'stop [--force] [--json]' }) }),
                        (0, t.jsxs)(s.td, {
                          children: [
                            'The inverse of ',
                            (0, t.jsx)(s.code, { children: 'start' }),
                            ": halt this workspace's supervisor, reap its device-log collectors, shut the owned device ",
                            (0, t.jsx)(s.strong, { children: 'down' }),
                            ' (never deleted, so it stays assigned), and free the reserved port. Non-destructive and takes no target -- it acts on the current workspace. With no supervisor recorded it falls back to killing an identity-verified Metro on the reserved port; ',
                            (0, t.jsx)(s.code, { children: '--force' }),
                            ' is only for an unproven listener there. Already-stopped is a success at every step.',
                          ],
                        }),
                      ],
                    }),
                    (0, t.jsxs)(s.tr, {
                      children: [
                        (0, t.jsx)(s.td, { children: (0, t.jsx)(s.code, { children: 'status [--json]' }) }),
                        (0, t.jsxs)(s.td, {
                          children: [
                            'Show every registered project (machine-wide by default; there is no ',
                            (0, t.jsx)(s.code, { children: '--all' }),
                            "): device assignments (owned/legacy), Metro state, supervisor pid / mode / health, last build (fingerprint, cache hit, duration), log directory and error count since the last marker, plus machine capacity and free disk -- on the boot volume, and on the current project's volume too when that is a different one.",
                          ],
                        }),
                      ],
                    }),
                    (0, t.jsxs)(s.tr, {
                      children: [
                        (0, t.jsx)(s.td, {
                          children: (0, t.jsx)(s.code, { children: 'gc [--delete] [--older-than <days>] [--all]' }),
                        }),
                        (0, t.jsxs)(s.td, {
                          children: [
                            'Report what rn-iso has left behind: entries for projects whose directory no longer exists, orphaned ',
                            (0, t.jsx)(s.code, { children: 'rn-iso-*' }),
                            ' devices, records naming a device that is no longer on the machine, and every shared build cache with its size. Reports and writes nothing by default; ',
                            (0, t.jsx)(s.code, { children: '--delete' }),
                            ' reclaims the dead entries (freeing their Metro ports), reaps the orphaned devices, and clears the stale device records (the record only -- there is no device left to touch, so it issues no simctl/avdmanager command). ',
                            (0, t.jsx)(s.code, { children: '--older-than <days>' }),
                            ' additionally reaps owned devices whose ',
                            (0, t.jsx)(s.em, { children: 'project' }),
                            ' has gone untouched that long, and trims cache entries nothing has used in that time. ',
                            (0, t.jsx)(s.code, { children: '--all' }),
                            ' (with ',
                            (0, t.jsx)(s.code, { children: '--delete' }),
                            ') empties the caches whole -- see below.',
                          ],
                        }),
                      ],
                    }),
                    (0, t.jsxs)(s.tr, {
                      children: [
                        (0, t.jsx)(s.td, { children: (0, t.jsx)(s.code, { children: 'doctor [--json]' }) }),
                        (0, t.jsx)(s.td, {
                          children:
                            'Report the configuration that makes a second workspace slower than it needs to be: a missing dev client, a per-project Metro cache, a compilation cache left at its default path, a ccache conflict, a build-cache provider on the key this SDK ignores. Read-only, and always exits 0.',
                        }),
                      ],
                    }),
                    (0, t.jsxs)(s.tr, {
                      children: [
                        (0, t.jsx)(s.td, {
                          children: (0, t.jsx)(s.code, {
                            children: 'worktree create <name> [--base <ref>] [--label <name>] [--carry-ignored]',
                          }),
                        }),
                        (0, t.jsxs)(s.td, {
                          children: [
                            'Create an isolated git worktree: carries over gitignored files, prints the worktree path (and, on stderr, what it branched from -- ref and short sha). ',
                            (0, t.jsx)(s.code, { children: '--base' }),
                            ' takes ',
                            (0, t.jsx)(s.code, { children: 'fresh' }),
                            ' (origin/HEAD, the default), ',
                            (0, t.jsx)(s.code, { children: 'head' }),
                            ', or any ref ',
                            (0, t.jsx)(s.code, { children: 'git rev-parse' }),
                            ' resolves; an unresolvable one is refused before anything is created. Does not install dependencies unless ',
                            (0, t.jsx)(s.code, { children: '--carry-ignored' }),
                            ' clones them.',
                          ],
                        }),
                      ],
                    }),
                    (0, t.jsxs)(s.tr, {
                      children: [
                        (0, t.jsx)(s.td, {
                          children: (0, t.jsx)(s.code, { children: 'worktree remove [<path>] [--force]' }),
                        }),
                        (0, t.jsxs)(s.td, {
                          children: [
                            'Remove a worktree, reclaiming its build artifacts, Metro port, and owned devices (deleted, not just freed). Defaults to the current workspace. Refuses if it has uncommitted or unpushed work unless ',
                            (0, t.jsx)(s.code, { children: '--force' }),
                            ', naming the right restore command per class (',
                            (0, t.jsx)(s.code, { children: 'git checkout --' }),
                            ' for modified tracked files, ',
                            (0, t.jsx)(s.code, { children: 'git clean -fd' }),
                            " for untracked ones). The workspace's own ",
                            (0, t.jsx)(s.code, { children: '.rn-iso/' }),
                            ' never counts as dirt -- it dies with the worktree by design.',
                          ],
                        }),
                      ],
                    }),
                    (0, t.jsxs)(s.tr, {
                      children: [
                        (0, t.jsx)(s.td, { children: (0, t.jsx)(s.code, { children: 'guide [topic]' }) }),
                        (0, t.jsx)(s.td, {
                          children:
                            'Print reference docs for the installed version (topics: facts, metro, logs, errors, lifecycle, cleanup, settings). Generated by the binary, so it cannot drift.',
                        }),
                      ],
                    }),
                  ],
                }),
              ],
            }),
            '\n',
            (0, t.jsxs)(s.h2, {
              id: 'project-labels---label',
              children: ['Project labels (', (0, t.jsx)(s.code, { children: '--label' }), ')'],
            }),
            '\n',
            (0, t.jsxs)(s.p, {
              children: [
                'Every project has a "shortcut": its ',
                (0, t.jsx)(s.code, { children: 'label' }),
                ' if one was set (e.g. via ',
                (0, t.jsx)(s.code, { children: 'worktree create --label' }),
                "), else inherited from the enclosing worktree's label, else the directory basename. It is what names the owned device -- ",
                (0, t.jsx)(s.code, { children: 'rn-iso-<label>' }),
                ' -- and what ',
                (0, t.jsx)(s.code, { children: 'status' }),
                ' reports a workspace as.',
              ],
            }),
            '\n',
            (0, t.jsx)(s.pre, {
              children: (0, t.jsx)(s.code, {
                className: 'language-bash',
                children: 'npx rn-iso worktree create feature-x --label agent-1   # its sim will be rn-iso-agent-1\n',
              }),
            }),
            '\n',
            (0, t.jsxs)(s.p, {
              children: [
                'Two projects sharing the same basename with no distinguishing label collide, which is why ',
                (0, t.jsx)(s.code, { children: 'worktree create' }),
                ' registers a label for the worktree root: every worktree of a monorepo otherwise shares the same app-dir basename.',
              ],
            }),
          ],
        });
      }
      function h(e = {}) {
        let { wrapper: s } = { ...(0, o.R)(), ...e.components };
        return s ? (0, t.jsx)(s, { ...e, children: (0, t.jsx)(l, { ...e }) }) : l(e);
      }
    },
    8453(e, s, n) {
      n.d(s, { R: () => i, x: () => d });
      var r = n(6540);
      let t = {},
        o = r.createContext(t);
      function i(e) {
        let s = r.useContext(o);
        return r.useMemo(
          function () {
            return 'function' == typeof e ? e(s) : { ...s, ...e };
          },
          [s, e],
        );
      }
      function d(e) {
        let s;
        return (
          (s = e.disableParentContext
            ? 'function' == typeof e.components
              ? e.components(t)
              : e.components || t
            : i(e.components)),
          r.createElement(o.Provider, { value: s }, e.children)
        );
      }
    },
  },
]);
