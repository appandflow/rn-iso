'use strict';
(self.webpackChunkwebsite = self.webpackChunkwebsite || []).push([
  ['359'],
  {
    3853(e, n, t) {
      (t.r(n),
        t.d(n, {
          metadata: () => i,
          default: () => u,
          frontMatter: () => o,
          contentTitle: () => c,
          toc: () => a,
          assets: () => l,
        }));
      var i = JSON.parse(
          '{"id":"requirements","title":"Requirements","description":"What rn-iso needs from the machine","source":"@site/docs/requirements.md","sourceDirName":".","slug":"/requirements","permalink":"/rn-iso/docs/requirements","draft":false,"unlisted":false,"editUrl":"https://github.com/appandflow/rn-iso/tree/main/website/docs/requirements.md","tags":[],"version":"current","sidebarPosition":4,"frontMatter":{"title":"Requirements","sidebar_position":4,"description":"What rn-iso needs from the machine"},"sidebar":"docs","previous":{"title":"Agent skills","permalink":"/rn-iso/docs/agent-skills"},"next":{"title":"Changelog","permalink":"/rn-iso/docs/changelog"}}',
        ),
        s = t(4848),
        r = t(8453);
      let o = { title: 'Requirements', sidebar_position: 4, description: 'What rn-iso needs from the machine' },
        c,
        l = {},
        a = [];
      function d(e) {
        let n = { code: 'code', li: 'li', ul: 'ul', ...(0, r.R)(), ...e.components };
        return (0, s.jsxs)(n.ul, {
          children: [
            '\n',
            (0, s.jsx)(n.li, { children: 'macOS (iOS); macOS or Linux (Android)' }),
            '\n',
            (0, s.jsx)(n.li, { children: 'Node 20+' }),
            '\n',
            (0, s.jsx)(n.li, {
              children: 'Xcode (iOS), Android SDK + at least one installed arm64 system image (Android)',
            }),
            '\n',
            (0, s.jsxs)(n.li, {
              children: [
                (0, s.jsx)(n.code, { children: 'expo' }),
                ' or ',
                (0, s.jsx)(n.code, { children: 'react-native' }),
                " in the project's ",
                (0, s.jsx)(n.code, { children: 'package.json' }),
              ],
            }),
            '\n',
          ],
        });
      }
      function u(e = {}) {
        let { wrapper: n } = { ...(0, r.R)(), ...e.components };
        return n ? (0, s.jsx)(n, { ...e, children: (0, s.jsx)(d, { ...e }) }) : d(e);
      }
    },
    8453(e, n, t) {
      t.d(n, { R: () => o, x: () => c });
      var i = t(6540);
      let s = {},
        r = i.createContext(s);
      function o(e) {
        let n = i.useContext(r);
        return i.useMemo(
          function () {
            return 'function' == typeof e ? e(n) : { ...n, ...e };
          },
          [n, e],
        );
      }
      function c(e) {
        let n;
        return (
          (n = e.disableParentContext
            ? 'function' == typeof e.components
              ? e.components(s)
              : e.components || s
            : o(e.components)),
          i.createElement(r.Provider, { value: n }, e.children)
        );
      }
    },
  },
]);
