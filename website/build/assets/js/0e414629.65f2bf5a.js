'use strict';
(self.webpackChunkwebsite = self.webpackChunkwebsite || []).push([
  ['699'],
  {
    872(e, n, r) {
      (r.r(n),
        r.d(n, {
          metadata: () => i,
          default: () => l,
          frontMatter: () => o,
          contentTitle: () => a,
          toc: () => d,
          assets: () => c,
        }));
      var i = JSON.parse(
          '{"id":"build-caches","title":"Build caches","description":"Fingerprint-keyed native builds shared across worktrees, and single-flight compiles","source":"@site/docs/build-caches.md","sourceDirName":".","slug":"/build-caches","permalink":"/rn-iso/docs/build-caches","draft":false,"unlisted":false,"editUrl":"https://github.com/appandflow/rn-iso/tree/main/website/docs/build-caches.md","tags":[],"version":"current","sidebarPosition":3,"frontMatter":{"title":"Build caches","sidebar_position":3,"description":"Fingerprint-keyed native builds shared across worktrees, and single-flight compiles"},"sidebar":"docs","previous":{"title":"The dev server and logs","permalink":"/rn-iso/docs/dev-server-and-logs"},"next":{"title":"Worktrees","permalink":"/rn-iso/docs/worktrees"}}',
        ),
        t = r(4848),
        s = r(8453);
      let o = {
          title: 'Build caches',
          sidebar_position: 3,
          description: 'Fingerprint-keyed native builds shared across worktrees, and single-flight compiles',
        },
        a,
        c = {},
        d = [
          {
            value: 'Registering a cache rn-iso cannot detect',
            id: 'registering-a-cache-rn-iso-cannot-detect',
            level: 3,
          },
          { value: 'The cache packages', id: 'the-cache-packages', level: 2 },
        ];
      function h(e) {
        let n = {
          a: 'a',
          code: 'code',
          em: 'em',
          h2: 'h2',
          h3: 'h3',
          li: 'li',
          p: 'p',
          pre: 'pre',
          strong: 'strong',
          ul: 'ul',
          ...(0, s.R)(),
          ...e.components,
        };
        return (0, t.jsxs)(t.Fragment, {
          children: [
            (0, t.jsxs)(n.p, {
              children: [
                'Everything ',
                (0, t.jsx)(n.code, { children: 'gc' }),
                ' reclaims is ',
                (0, t.jsx)(n.em, { children: 'dead' }),
                ': a project entry whose directory no longer\nexists belongs to nobody, and a ',
                (0, t.jsx)(n.code, { children: 'rn-iso-*' }),
                ' simulator nothing references is\nnever coming back. Shared build caches are the opposite -- alive by design,\nshared by every project on the machine, and pruned by nothing:',
              ],
            }),
            '\n',
            (0, t.jsxs)(n.ul, {
              children: [
                '\n',
                (0, t.jsxs)(n.li, {
                  children: [
                    (0, t.jsxs)(n.strong, { children: ["Metro's ", (0, t.jsx)(n.code, { children: 'FileStore' })] }),
                    ' has no eviction logic whatsoever.',
                  ],
                }),
                '\n',
                (0, t.jsxs)(n.li, {
                  children: [(0, t.jsx)(n.strong, { children: "Xcode's compilation cache" }), ' has no size cap.'],
                }),
                '\n',
                (0, t.jsxs)(n.li, {
                  children: [
                    (0, t.jsx)(n.strong, { children: 'Metro file maps' }),
                    ' accumulate one file per project root ever served.',
                  ],
                }),
                '\n',
              ],
            }),
            '\n',
            (0, t.jsxs)(n.p, {
              children: [
                'So every ',
                (0, t.jsx)(n.code, { children: 'gc' }),
                ' run reports them -- in their own bucket, tagged ',
                (0, t.jsx)(n.em, { children: 'registered' }),
                ' or\n',
                (0, t.jsx)(n.em, { children: 'detected' }),
                ', and never counted in the reclaim total -- and a plain ',
                (0, t.jsx)(n.code, { children: 'gc --delete' }),
                '\n',
                (0, t.jsx)(n.em, { children: 'never' }),
                ' touches them:',
              ],
            }),
            '\n',
            (0, t.jsx)(n.pre, {
              children: (0, t.jsx)(n.code, {
                className: 'language-bash',
                children:
                  'npx rn-iso gc                            # report everything, caches included\nnpx rn-iso gc --delete --older-than 30   # trim entries unused for 30 days\nnpx rn-iso gc --delete --all             # empty them completely\n',
              }),
            }),
            '\n',
            (0, t.jsxs)(n.p, {
              children: [
                "Prefer trimming. Most of these caches are a flat collection of independent\nentries -- one file per key for Metro's ",
                (0, t.jsx)(n.code, { children: 'FileStore' }),
                ', one directory per\nfingerprint for a build cache -- so the ones nothing has touched in weeks\ncan go while the rest keep working. "Unused" means neither read nor written: a\ncache hit reads an entry without rewriting it, so pruning on modification time\nalone would evict exactly the entries that are earning their keep.',
              ],
            }),
            '\n',
            (0, t.jsxs)(n.p, {
              children: [
                "Xcode's compilation cache is the exception. It is an LLVM CAS whose ",
                (0, t.jsx)(n.code, { children: 'v4.actions' }),
                '\nindex references its ',
                (0, t.jsx)(n.code, { children: 'v9.*.leaf' }),
                ' data files, so removing leaves individually\nwould leave the index pointing at data that is gone. ',
                (0, t.jsx)(n.code, { children: '--older-than' }),
                ' reports it\nas left alone; it can only be emptied whole, which is what ',
                (0, t.jsx)(n.code, { children: '--all' }),
                ' does.',
              ],
            }),
            '\n',
            (0, t.jsx)(n.p, {
              children:
                'Emptying is a performance decision, not cleanup: the next build in every\nproject pays to refill what you removed. The summary says so.',
            }),
            '\n',
            (0, t.jsx)(n.h3, {
              id: 'registering-a-cache-rn-iso-cannot-detect',
              children: 'Registering a cache rn-iso cannot detect',
            }),
            '\n',
            (0, t.jsxs)(n.p, {
              children: [
                'A Metro ',
                (0, t.jsx)(n.code, { children: 'FileStore' }),
                " root, a build-cache provider's artifact directory, a\nrelocated ",
                (0, t.jsx)(n.code, { children: 'COMPILATION_CACHE_CAS_PATH' }),
                " -- all come from a project's own config,\nso rn-iso cannot guess them. The cache names itself instead, once, from code:",
              ],
            }),
            '\n',
            (0, t.jsx)(n.pre, {
              children: (0, t.jsx)(n.code, {
                className: 'language-js',
                children:
                  "// A setup script, a build-cache provider -- anywhere that creates the cache.\n// `rn-iso/cache-manifest` is ESM, so a CJS caller needs `await import(...)`.\nimport { register } from 'rn-iso/cache-manifest';\n\nregister({\n  dir: '~/.myapp-metro-cache',\n  name: 'Metro transforms',\n  entriesDepth: 2,\n});\nregister({ dir: '~/.myapp-cas', prune: 'atomic' }); // index-backed: emptied whole or not at all\n",
              }),
            }),
            '\n',
            (0, t.jsxs)(n.p, {
              children: [
                (0, t.jsx)(n.code, { children: 'entriesDepth' }),
                ' says how far below the directory one entry sits, and it is\nwhat keeps trimming safe. The default, 1, is a flat store: every child of the\nroot is an entry. A root with a layer of grouping ',
                (0, t.jsx)(n.em, { children: 'above' }),
                " the entries registers\n2 -- Metro's ",
                (0, t.jsx)(n.code, { children: 'FileStore' }),
                ' shards its keys across 256 directories, and a build\ncache is keyed ',
                (0, t.jsx)(n.code, { children: '<platform>/<key>' }),
                ' -- so ',
                (0, t.jsx)(n.code, { children: 'gc --delete --older-than 30' }),
                "\ntrims one transform or one build instead of a 256th of every transform on the\nmachine, or an entire platform's builds.",
              ],
            }),
            '\n',
            (0, t.jsxs)(n.p, {
              children: [
                'Registration is idempotent and keyed on the directory, so a cache can call it on\nevery build; ',
                (0, t.jsx)(n.code, { children: '@rn-iso/metro' }),
                ' and ',
                (0, t.jsx)(n.code, { children: '@rn-iso/expo-build-cache' }),
                ' both do (by writing\nthe manifest directly, so they need no rn-iso installed at all).',
              ],
            }),
            '\n',
            (0, t.jsxs)(n.p, {
              children: [
                'The ',
                (0, t.jsx)(n.code, { children: 'caches' }),
                ' setting is the no-code alternative and is still read: a list of\npaths under ',
                (0, t.jsx)(n.code, { children: 'caches' }),
                ' in a committed ',
                (0, t.jsx)(n.code, { children: '.rn-iso.json' }),
                ' is reported alongside the\nregistered ones. Every path in it is treated as a flat store, so register from\ncode for anything that needs a depth or ',
                (0, t.jsx)(n.code, { children: 'atomic' }),
                '.',
              ],
            }),
            '\n',
            (0, t.jsx)(n.pre, {
              children: (0, t.jsx)(n.code, {
                className: 'language-json',
                children: '{ "caches": ["~/.myapp-metro-cache", "~/.myapp-build-cache"] }\n',
              }),
            }),
            '\n',
            (0, t.jsx)(n.h2, { id: 'the-cache-packages', children: 'The cache packages' }),
            '\n',
            (0, t.jsxs)(n.p, {
              children: [
                'Two optional packages ship alongside the CLI. Both register themselves with\nrn-iso the first time they run, so ',
                (0, t.jsx)(n.code, { children: 'gc' }),
                ' reports and trims them, and\nboth work fine without rn-iso installed -- it is an optional peer.',
              ],
            }),
            '\n',
            (0, t.jsxs)(n.ul, {
              children: [
                '\n',
                (0, t.jsxs)(n.li, {
                  children: [
                    (0, t.jsx)(n.strong, {
                      children: (0, t.jsx)(n.a, {
                        href: 'https://www.npmjs.com/package/@rn-iso/metro',
                        children: (0, t.jsx)(n.code, { children: '@rn-iso/metro' }),
                      }),
                    }),
                    "\n-- one Metro transform cache shared by every worktree, instead of Metro's\nper-project default that makes each new workspace re-transform the whole\nmodule graph. It also carries the NDJSON reporter rn-iso uses to capture a\ndev server's logs, which is not a cache and is not wired up by ",
                    (0, t.jsx)(n.code, { children: 'init' }),
                    '.',
                  ],
                }),
                '\n',
                (0, t.jsxs)(n.li, {
                  children: [
                    (0, t.jsx)(n.strong, {
                      children: (0, t.jsx)(n.a, {
                        href: 'https://www.npmjs.com/package/@rn-iso/expo-build-cache',
                        children: (0, t.jsx)(n.code, { children: '@rn-iso/expo-build-cache' }),
                      }),
                    }),
                    '\n-- a local Expo build cache provider. When no native input changed, the Expo\nCLI installs a cached ',
                    (0, t.jsx)(n.code, { children: '.app' }),
                    ' / ',
                    (0, t.jsx)(n.code, { children: '.apk' }),
                    ' instead of compiling. Wire it to\n',
                    (0, t.jsx)(n.code, { children: 'expo.buildCacheProvider' }),
                    ' on SDK 54+, or ',
                    (0, t.jsx)(n.code, { children: 'expo.experiments.buildCacheProvider' }),
                    '\non SDK 53, which reads only that key and ignores the top-level one in silence.',
                  ],
                }),
                '\n',
              ],
            }),
            '\n',
            (0, t.jsxs)(n.p, {
              children: [
                "Each package's README has the wiring. Neither is needed for ",
                (0, t.jsx)(n.code, { children: 'rn-iso ios' }),
                ' /\n',
                (0, t.jsx)(n.code, { children: 'rn-iso android' }),
                ', which address the build cache directly: the Expo provider is\nfor builds run ',
                (0, t.jsx)(n.em, { children: 'outside' }),
                ' rn-iso (',
                (0, t.jsx)(n.code, { children: 'expo run:ios' }),
                ' by hand, or EAS), so that the two\nshare artifacts instead of filling two caches with the same builds. Bare React\nNative has no provider hook at all and needs none.',
              ],
            }),
            '\n',
            (0, t.jsxs)(n.p, {
              children: [
                'What every entry point does need is ',
                (0, t.jsx)(n.code, { children: '@expo/fingerprint' }),
                ', resolved from the\nproject, to compute the key. It works on a project with no Expo in it at all.\nWithout it ',
                (0, t.jsx)(n.code, { children: 'rn-iso ios' }),
                ' refuses with ',
                (0, t.jsx)(n.code, { children: 'RN_ISO_NO_FINGERPRINT' }),
                ' rather than\ncompiling from scratch forever.',
              ],
            }),
            '\n',
            (0, t.jsxs)(n.p, {
              children: [
                'Entries are keyed ',
                (0, t.jsx)(n.code, { children: '<fingerprintHash>-<variant>-<target>' }),
                ', identically by every\nentry point. The fingerprint covers what the project ',
                (0, t.jsx)(n.em, { children: 'is' }),
                ', never how it was\nbuilt, so the variant (the Xcode configuration on iOS, the gradle variant on\nAndroid; ',
                (0, t.jsx)(n.code, { children: 'debug' }),
                ' when unset) and the target class (',
                (0, t.jsx)(n.code, { children: 'sim' }),
                ' unless the device\nselector says otherwise) are part of the key. Without them a Release build would\nanswer a Debug lookup and a device build would answer a simulator one -- both\nsilently, both producing a binary that cannot run. rn-iso builds Debug for a\nsimulator and nothing else, so those fields are constant here; they exist\nbecause the Expo provider and any future release path share the same keyspace.',
              ],
            }),
          ],
        });
      }
      function l(e = {}) {
        let { wrapper: n } = { ...(0, s.R)(), ...e.components };
        return n ? (0, t.jsx)(n, { ...e, children: (0, t.jsx)(h, { ...e }) }) : h(e);
      }
    },
    8453(e, n, r) {
      r.d(n, { R: () => o, x: () => a });
      var i = r(6540);
      let t = {},
        s = i.createContext(t);
      function o(e) {
        let n = i.useContext(s);
        return i.useMemo(
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
              ? e.components(t)
              : e.components || t
            : o(e.components)),
          i.createElement(s.Provider, { value: n }, e.children)
        );
      }
    },
  },
]);
