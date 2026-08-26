'use strict';
(self.webpackChunkwebsite = self.webpackChunkwebsite || []).push([
  ['355'],
  {
    5608(e, n, t) {
      (t.r(n),
        t.d(n, {
          metadata: () => s,
          default: () => h,
          frontMatter: () => r,
          contentTitle: () => d,
          toc: () => c,
          assets: () => a,
        }));
      var s = JSON.parse(
          '{"id":"owned-devices","title":"Owned devices","description":"Every device rn-iso touches is one it created, and exactly two commands destroy anything","source":"@site/docs/owned-devices.md","sourceDirName":".","slug":"/owned-devices","permalink":"/rn-iso/docs/owned-devices","draft":false,"unlisted":false,"editUrl":"https://github.com/appandflow/rn-iso/tree/main/website/docs/owned-devices.md","tags":[],"version":"current","sidebarPosition":1,"frontMatter":{"title":"Owned devices","sidebar_position":1,"description":"Every device rn-iso touches is one it created, and exactly two commands destroy anything"},"sidebar":"docs","previous":{"title":"Commands","permalink":"/rn-iso/docs/commands"},"next":{"title":"The dev server and logs","permalink":"/rn-iso/docs/dev-server-and-logs"}}',
        ),
        o = t(4848),
        i = t(8453);
      let r = {
          title: 'Owned devices',
          sidebar_position: 1,
          description: 'Every device rn-iso touches is one it created, and exactly two commands destroy anything',
        },
        d,
        a = {},
        c = [
          {
            value: 'Destruction lives in exactly two commands',
            id: 'destruction-lives-in-exactly-two-commands',
            level: 2,
          },
          {
            value: 'How devices, ports and config fit together',
            id: 'how-devices-ports-and-config-fit-together',
            level: 2,
          },
          { value: 'Device settings', id: 'device-settings', level: 2 },
        ];
      function l(e) {
        let n = {
          a: 'a',
          code: 'code',
          em: 'em',
          h2: 'h2',
          li: 'li',
          p: 'p',
          pre: 'pre',
          strong: 'strong',
          ul: 'ul',
          ...(0, i.R)(),
          ...e.components,
        };
        return (0, o.jsxs)(o.Fragment, {
          children: [
            (0, o.jsxs)(n.p, {
              children: [
                'Every simulator or emulator rn-iso uses is one ',
                (0, o.jsx)(n.strong, { children: 'rn-iso created' }),
                ', named ',
                (0, o.jsx)(n.code, { children: 'rn-iso-<label>' }),
                ', and recorded with ',
                (0, o.jsx)(n.code, { children: 'owned: true' }),
                ". rn-iso never boots, allocates, or destroys a device it did not create -- it cannot stomp a foreign tool's simulator, because it never touches devices it didn't make. Teardown of the owning project (",
                (0, o.jsx)(n.code, { children: 'worktree remove' }),
                ', or ',
                (0, o.jsx)(n.code, { children: 'gc' }),
                ' on an orphan) destroys the device, not just a claim on it.',
              ],
            }),
            '\n',
            (0, o.jsxs)(n.p, {
              children: [
                'That rule has ',
                (0, o.jsx)(n.strong, { children: 'no exception' }),
                '. rn-iso has no physical-device support: there is no code path that boots, installs onto, or even probes hardware. A legacy record naming a serial is reported once and replaced by an owned emulator; the serial itself is never touched.',
              ],
            }),
            '\n',
            (0, o.jsxs)(n.p, {
              children: [
                'This is a change from earlier versions, where rn-iso picked an existing, unclaimed simulator from the pool instead of creating one. That model existed to avoid accumulating junk simulators -- but the accumulation was really a symptom of creation ',
                (0, o.jsx)(n.em, { children: 'without' }),
                ' a reaper. The reaper now exists, so creating a device and guaranteeing its eventual destruction is no longer the same hazard.',
              ],
            }),
            '\n',
            (0, o.jsxs)(n.p, {
              children: [
                'A pre-pivot assignment without ',
                (0, o.jsx)(n.code, { children: 'owned: true' }),
                ' ("legacy") is reused only while it is actually running -- rn-iso will not boot, shut down, or delete it. It converges to an owned device naturally, once it is shut down and re-created.',
              ],
            }),
            '\n',
            (0, o.jsx)(n.h2, {
              id: 'destruction-lives-in-exactly-two-commands',
              children: 'Destruction lives in exactly two commands',
            }),
            '\n',
            (0, o.jsxs)(n.p, {
              children: [
                (0, o.jsx)(n.code, { children: 'worktree remove' }),
                ' destroys the workspace you name; ',
                (0, o.jsx)(n.code, { children: 'gc --delete' }),
                ' sweeps the machine. ',
                (0, o.jsx)(n.strong, { children: 'Nothing else deletes anything.' }),
              ],
            }),
            '\n',
            (0, o.jsxs)(n.p, {
              children: [
                'In particular ',
                (0, o.jsx)(n.code, { children: 'stop' }),
                ' does not, by design: it shuts the owned device down and leaves it assigned, so returning to a branch costs a boot rather than a create, a provision and a reinstall. There is no ',
                (0, o.jsx)(n.code, { children: '--delete' }),
                ' on it, because an agent reaching for ',
                (0, o.jsx)(n.code, { children: 'stop' }),
                ' to reclaim memory must not have one within reach of a typo. Destruction lives in ',
                (0, o.jsx)(n.code, { children: 'worktree remove' }),
                ' and ',
                (0, o.jsx)(n.code, { children: 'gc' }),
                ', never here.',
              ],
            }),
            '\n',
            (0, o.jsxs)(n.p, {
              children: [
                (0, o.jsx)(n.strong, { children: 'A delete is not occupancy-guarded.' }),
                " An owned sim goes away even if another tool is still attached to it. It is a device rn-iso created, for a project that is going away, and the process holding it is almost always the caller's own UI-test runner, which has nothing to return to. Skipping occupied sims there leaked booted sims and live ",
                (0, o.jsx)(n.code, { children: 'xcodebuild test-without-building' }),
                ' runners out of ',
                (0, o.jsx)(n.code, { children: 'worktree remove' }),
                ', and "left for a later gc" only asked the same question again forever.',
              ],
            }),
            '\n',
            (0, o.jsxs)(n.p, {
              children: [
                (0, o.jsx)(n.code, { children: 'stop' }),
                ' ',
                (0, o.jsx)(n.em, { children: 'is' }),
                ' occupancy-guarded, because the device it spares survives the call and is still there to come back to: an iOS sim actively driven by a foreign UI-test runner is left running and reported instead of shut down. (Android has no occupancy probe, so an owned, identity-verified AVD is always eligible.)',
              ],
            }),
            '\n',
            (0, o.jsxs)(n.p, {
              children: [
                'If a delete fails, the failure is reported, the config record is ',
                (0, o.jsx)(n.strong, { children: 'kept' }),
                ' so the device stays tracked, and the command exits 1. Dropping the record on a failed teardown is exactly what turns it into a simulator nothing references.',
              ],
            }),
            '\n',
            (0, o.jsx)(n.h2, {
              id: 'how-devices-ports-and-config-fit-together',
              children: 'How devices, ports and config fit together',
            }),
            '\n',
            (0, o.jsxs)(n.ul, {
              children: [
                '\n',
                (0, o.jsxs)(n.li, {
                  children: [
                    (0, o.jsx)(n.strong, { children: 'Config' }),
                    ' at ',
                    (0, o.jsx)(n.code, { children: '~/.rn-iso/config.json' }),
                    ', keyed by absolute project path. Symlinked worktrees collapse via ',
                    (0, o.jsx)(n.code, { children: 'realpath' }),
                    ". Every write goes through a lockfile and lands by atomic rename, so several agents provisioning at once cannot lose each other's device records. A config that will not parse is reported by name and never reset automatically -- it holds the records of every device rn-iso owns, and resetting it would orphan all of them.",
                  ],
                }),
                '\n',
                (0, o.jsxs)(n.li, {
                  children: [
                    (0, o.jsx)(n.strong, { children: 'Port allocation:' }),
                    ' ',
                    (0, o.jsx)(n.code, { children: 'start' }),
                    ' scans upward from 8082 for a port that is both unclaimed in the registry and actually free on the machine, reclaiming ports from dead projects on the way. Claiming is race-safe: the write only lands if the config still shows the port unclaimed, so two parallel runs that probe the same free port cannot both take it. A project whose directory only ',
                    (0, o.jsx)(n.em, { children: 'looks' }),
                    ' gone because its volume is unmounted keeps its port.',
                  ],
                }),
                '\n',
                (0, o.jsxs)(n.li, {
                  children: [
                    (0, o.jsx)(n.strong, { children: 'Owned device creation:' }),
                    ' on iOS, ',
                    (0, o.jsx)(n.code, { children: 'ios' }),
                    " creates the newest iPhone device type -- highest generation number, base model rather than Pro/Pro Max -- on the newest installed runtime by default (or reuses the project's already-recorded owned sim, booting it if shut down). On Android, it creates an AVD via ",
                    (0, o.jsx)(n.code, { children: 'avdmanager create avd' }),
                    ' against the newest installed arm64 system image (rn-iso never installs system images itself -- it errors with install instructions if none is found). Override the defaults with ',
                    (0, o.jsx)(n.code, { children: 'ios.deviceType' }),
                    ' / ',
                    (0, o.jsx)(n.code, { children: 'ios.runtime' }),
                    ' / ',
                    (0, o.jsx)(n.code, { children: 'android.systemImage' }),
                    ' in a settings file -- see "Settings" below.',
                  ],
                }),
                '\n',
                (0, o.jsxs)(n.li, {
                  children: [
                    (0, o.jsx)(n.strong, { children: 'Build output is workspace-local.' }),
                    ' ',
                    (0, o.jsx)(n.code, { children: '-derivedDataPath' }),
                    ' points at ',
                    (0, o.jsx)(n.code, { children: '<worktree>/.rn-iso/derived-data' }),
                    ' and gradle builds under ',
                    (0, o.jsx)(n.code, { children: '<worktree>/.rn-iso/gradle-build' }),
                    ', so ',
                    (0, o.jsx)(n.code, { children: 'worktree remove' }),
                    ' reclaims them definitionally and there is no global DerivedData directory to reverse-map to a workspace.',
                  ],
                }),
                '\n',
                (0, o.jsxs)(n.li, {
                  children: [
                    (0, o.jsx)(n.strong, { children: 'The port is never baked into a build.' }),
                    ' The fingerprint cache shares binaries across workspaces, so a port compiled in would let a binary built for 8082 be served to a workspace holding 8083. iOS gets ',
                    (0, o.jsx)(n.code, { children: 'RCT_jsLocation' }),
                    " written into the app's simulator defaults (or an ",
                    (0, o.jsx)(n.code, { children: 'expo-development-client' }),
                    ' deep link); Android gets ',
                    (0, o.jsx)(n.code, { children: 'adb reverse tcp:8081 tcp:<port>' }),
                    '. ',
                    (0, o.jsx)(n.code, { children: 'RCT_METRO_PORT' }),
                    ' is deliberately not passed to builds.',
                  ],
                }),
                '\n',
                (0, o.jsxs)(n.li, {
                  children: [
                    (0, o.jsx)(n.strong, { children: 'Starting the bundler yourself still works.' }),
                    ' Both Expo and the RN CLI probe the port and skip spawning a second bundler when one already answers ',
                    (0, o.jsx)(n.code, { children: '/status' }),
                    ', and ',
                    (0, o.jsx)(n.code, { children: 'ios' }),
                    "'s Metro gate accepts a server you started as long as it runs from inside the project -- but nothing is captured that way, so ",
                    (0, o.jsx)(n.code, { children: 'rn-iso logs' }),
                    ' stays empty. Teardown (',
                    (0, o.jsx)(n.code, { children: 'stop' }),
                    ', ',
                    (0, o.jsx)(n.code, { children: 'worktree remove' }),
                    ', ',
                    (0, o.jsx)(n.code, { children: 'gc' }),
                    ') finds Metro by port via ',
                    (0, o.jsx)(n.code, { children: 'lsof' }),
                    ' and only kills it after confirming it answers ',
                    (0, o.jsx)(n.code, { children: '/status' }),
                    ' ',
                    (0, o.jsx)(n.strong, { children: 'and' }),
                    ' runs from inside the project: a port is not identity, so an unidentified listener is reported instead of killed.',
                  ],
                }),
                '\n',
              ],
            }),
            '\n',
            (0, o.jsxs)(n.p, {
              children: [
                'If you need a single shared sim with a mutex instead of one owned device per project, see ',
                (0, o.jsx)(n.a, {
                  href: 'https://github.com/aleqsio/react-native-worktree',
                  children: (0, o.jsx)(n.code, { children: 'react-native-worktree' }),
                }),
                '.',
              ],
            }),
            '\n',
            (0, o.jsx)(n.h2, { id: 'device-settings', children: 'Device settings' }),
            '\n',
            (0, o.jsxs)(n.p, {
              children: [
                "The device model, runtime and system image can be pinned per project so rn-iso's defaults are not what you get. There is no ",
                (0, o.jsx)(n.code, { children: 'rn-iso config' }),
                " command -- rn-iso's commands take no device flags, so settings are ",
                (0, o.jsx)(n.strong, { children: 'files' }),
                '. See "Settings" below for the layers; the one that travels with the repo is ',
                (0, o.jsx)(n.code, { children: '.rn-iso.json' }),
                ' at its root:',
              ],
            }),
            '\n',
            (0, o.jsx)(n.pre, {
              children: (0, o.jsx)(n.code, {
                className: 'language-json',
                children:
                  '{\n  "ios": { "deviceType": "iPhone 17 Pro", "runtime": "26.2" },\n  "android": { "systemImage": "system-images;android-36;google_apis;arm64-v8a" }\n}\n',
              }),
            }),
            '\n',
            (0, o.jsxs)(n.p, {
              children: [
                "Resolution order: the project layer, then the repo layer, then that committed file, then rn-iso's own default (newest iPhone, base model, on the newest installed runtime; newest installed arm64 system image). A pinned model is honoured on ",
                (0, o.jsx)(n.strong, { children: 'reuse' }),
                ' as well as on creation: an existing owned sim of a different model is refused rather than silently booted.',
              ],
            }),
          ],
        });
      }
      function h(e = {}) {
        let { wrapper: n } = { ...(0, i.R)(), ...e.components };
        return n ? (0, o.jsx)(n, { ...e, children: (0, o.jsx)(l, { ...e }) }) : l(e);
      }
    },
    8453(e, n, t) {
      t.d(n, { R: () => r, x: () => d });
      var s = t(6540);
      let o = {},
        i = s.createContext(o);
      function r(e) {
        let n = s.useContext(i);
        return s.useMemo(
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
              ? e.components(o)
              : e.components || o
            : r(e.components)),
          s.createElement(i.Provider, { value: n }, e.children)
        );
      }
    },
  },
]);
