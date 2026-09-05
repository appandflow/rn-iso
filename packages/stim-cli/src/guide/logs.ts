export default {
  summary: 'Querying the merged NDJSON timeline, and what --errors means',
  body: () => `LOGS

  stim logs [filters]

Reads every *.ndjson file in the global workspace logs directory, merges them into one timeline
ordered by timestamp, prints what matches, and EXITS. The file set is
discovered, not enumerated.

EXIT 0 MEANS THE QUERY SUCCEEDED, whether or not records matched. A clean
\`stim logs --errors\` check requires exit code 0 AND no matching errors in
captured logs. An empty result does not prove launch or log capture succeeded;
a workspace with no log directory also returns an empty result.

For zero matches: STDOUT IS EMPTY, exit code 0, and
one dim note on STDERR reading \`No matching log records in <logs dir>\`
(human mode only -- \`--json\` prints nothing at all, on either stream).
The only exit-1 paths are a malformed query and no project.

FLAGS
  --source <s...>  metro, client, device, build (one or more), or all. An
                   unknown value is REJECTED rather than quietly matching
                   nothing.
  --level <l>      minimum level: debug, info, warn, error, fatal
  --since <d>      only records newer than this: 30s, 5m, 2h
  --grep <re>      only records whose msg matches this regular expression
  --tail <n>       only the last n MATCHING records (applied after filtering,
                   so --level error --tail 5 is the last five ERRORS)
  --errors         errors and fatals since the last marker, from metro, client
                   and build -- the agent query. Capped at 20 printed records.
  --follow         keep streaming until interrupted (Ctrl+C is exit 0)
  --json           the raw records, one per line, so stdout is valid NDJSON.
                   ZERO matches is ZERO bytes on stdout (an empty NDJSON
                   stream), exit 0 -- parse stdout line by line, never as one
                   JSON document. The "No matching log records" note is human
                   mode only, on stderr.

--ERRORS, PRECISELY
  Level error or fatal, from metro, client and build, timestamped after the
  marker that closes their window. Three rules, and a field test
  caught all three wrong at once -- it returned 3,004 iOS syslog lines on a
  healthy app while hiding a real startup crash.

  SCOPE. device is NOT in the default scope. A device log is the OS talking:
  \`simctl log stream\` is predicated on the app's PROCESS, and inside that
  process Apple's frameworks log thousands of Error-typed lines (nw_socket,
  SecTrust, WebKit, CoreUI) that have nothing to do with your app. The proven
  ones are demoted to info by the collector; the scope rule covers the rest.
  The metro stream carries exactly one demotion of its own, and it is Stim's
  doing: the dev-client deep link \`ios\`/\`android\` open to wire the app to
  your port arrives inside the app as a link, and React Navigation logs at
  error that no navigator handled a NAVIGATE to \`expo-development-client\`.
  There is no such screen and there is not meant to be, so that one record is
  recorded at info -- it made every healthy cold launch report 1 error. A real
  unhandled NAVIGATE names a route your app has, and is still an error.
  The app's own crashes reach client and metro either way. Opt back in with
  \`--source device\` or \`--source all\`; a plain \`logs\` with no --errors
  has always shown everything. ON A PHYSICAL IPHONE opting back in buys less
  than it does on a simulator: the device console carries no severity, so
  \`--source device --errors\` there reports crash and refusal lines only,
  never a level. Read a phone's device records with a plain \`logs
  --source device\`.

  THE WINDOW. A marker closes the window for the sources it can speak for:
    a BUNDLE marker (src metro: bundle_build_done / bundle_build_failed, or
      Expo's "Bundled" / "Bundling failed" lines) is written when a bundle
      attempt FINISHES, success or failure. It resets METRO errors from
      before the attempt -- a resolve failure you fixed and rebuilt is
      history, and when bundles fail back to back only the newest attempt's
      errors are reported -- and nothing else. A failed attempt's own summary
      and details land at or after its marker, so they stay reported.
    a LAUNCH marker (src build, written by \`ios\` / \`android\`) resets
      EVERYTHING: a new run of the app starts there.
  A finished bundle is not evidence that the app which loaded it is fine.
  In the field case the app threw at 16:03:54 and Metro wrote its marker at
  16:03:55, one second later, because the bundler finishes accounting for a
  build after the client has already evaluated it. Under one marker for all
  sources that crash was reported as nothing at all. The cost of the rule is
  the safe direction: a client redbox that Fast Refresh already fixed keeps
  being reported until the next launch.

  OUTPUT. --errors prints at most 20 error records, plus any stack context, and
  then a "... and N more" line. N is exactly what \`--tail N\` prints, because
  what was held back IS the tail. In non-follow human output, an Expo error includes its immediately
  following code frame and Call Stack lines. Bare React Native symbolication is
  shown as separate context because Metro does not provide an error correlation
  identifier. Context does not change the error count or the raw error records
  returned by --json. --json is never capped, and neither is an explicit --tail.

  In --follow mode the marker window is dropped -- every error arriving from
  then on is by definition after the last marker seen.

  \`stim status\` reports the same count per workspace, as
  logs.errorsSinceMarker: the same query, the same scope, so the two can never
  disagree about whether this workspace is failing.

THE RECORD
  { ts, src, level, msg } always. ts is epoch milliseconds; src is one of
  metro / client / device / build; level is one of the five above.
  Optional fields:
    event    the producer's own event name (bundle_build_done, client_log, ...)
    stack    frames of { file, line, column, fn }, passed through as reported
    marker   true on the records that close an error window
    raw      true when the level was inferred from a line of text rather than
             reported by the producer (every expo-child record)

WHAT WRITES WHAT
  metro.ndjson         the bundler, in both supervisor modes
  client.ndjson        in-app console logs and redboxes -- BARE PROJECTS ONLY.
                       In expo-child mode everything Expo prints lands in
                       metro.ndjson with raw: true, so \`--source client\`
                       returns nothing there.
  device.ndjson        the device-log collector \`ios\` / \`android\` attaches
                       after launch: \`simctl log stream\` predicated on the
                       app, or \`adb logcat\` filtered to the app's pid. This
                       is where a native crash that never reached JS shows up
                       -- and, on iOS, where every Apple framework running in
                       the app's process also logs. The proven noise sources
                       are recorded at info rather than error; the rest is why
                       --errors leaves this source out unless asked. A VERIFIED
                       LAUNCH prints NONE of these records one by one. It counts
                       them and prints one line instead:

                         launch      9 error-level records in the device log
                                     during launch
                                     (logs --errors --source device)

                       THE COUNT IS NOT ATTRIBUTED TO ANYTHING, and that is the
                       point. Both collectors already narrow the stream to the
                       app: the simulator's \`log stream\` runs under a
                       processImagePath predicate, and \`adb logcat\` is filtered
                       to the app's pid. So every record left is MEANT to be
                       inside the app's own process, and the error-level ones
                       are the Apple frameworks running there -- "Failed to send
                       CA Event for app launch measurements", "NSBundle (null)
                       initWithPath failed", the TCP refusal. Nothing about the
                       record says which of them wrote it, so the run does not
                       guess; a count plus the command that shows the records is
                       the honest report. The iOS predicate matches on a
                       substring of the process path today, which a short app
                       name can widen past the app -- appandflow/stim#264
                       anchors it. Until it lands, read the records rather than
                       trusting the count to be the app's alone. The app's OWN errors are not in this
                       number: a redbox or a console.error arrives on the client
                       or metro source and still prints line by line.

                       The connection refusal \`TCP Conn ... Failed :
                       error 0:61 [61]\` (61 is ECONNREFUSED) is not even
                       counted. The app got its bundle over this workspace's
                       Metro and outlived the stability window, so it
                       recovered. A refusal before the
                       launch verifies still prints, as does every record on a
                       launch that does not verify, and the record stays an
                       error in device.ndjson either way; read it with
                       \`logs --errors --source device\`.

  ON A PHYSICAL IPHONE THE SAME FILE CARRIES LESS, and the difference is not
  cosmetic. \`simctl spawn\` is simulator-only and there is no devicectl
  console subcommand, so a device run reads
  \`devicectl device process launch --console\`, which connects the app's own
  stdout and stderr and nothing else. Stim launches it with
  OS_ACTIVITY_DT_MODE, which makes os_log mirror itself onto that stderr --
  without it React Native's own logging, which goes through os_log, would not
  appear at all. What the mirror carries, and what it drops:

    ts        KEPT   the device's own timestamp, off the mirrored line
    proc      KEPT   as name(pid), from the mirrored line, not a path
    category  KEPT   only when the logger has a subsystem; \`javascript\` and
                     \`native\` for React Native's own log calls
    msg       KEPT   a multi-line message arrives as separate records
    subsystem LOST   the mirror never prints it
    level     LOST   Default, Error and Fault all render identically, and
                     Debug is not mirrored at all

  So every device record from a phone is \`raw: true\` and \`info\`, except
  the lines that OPEN with a marker the runtime itself prints: an uncaught
  ObjC exception, a libc++abi termination, an assertion failure, or a Swift
  fatal error. The match is anchored, so an app logging ABOUT a crash stays
  info. devicectl's own \`ERROR:\` is read only on a line with no mirror
  prefix, because that is the only kind devicectl writes. Severity cannot be
  recovered, so it is not guessed. The NOISE_RULES that demote Apple's framework chatter key on
  subsystem and cannot fire either -- but they have less to do, because
  --console carries only the app's streams rather than every framework
  logging inside its process.

  \`log collect --device-udid\` WOULD carry all six fields, in the same NDJSON
  the simulator path parses. It is not used because it requires root
  (\`log: Must be root to collect logs from attached device\`) and produces an
  archive rather than a stream. Streaming with full fidelity needs
  libimobiledevice or pymobiledevice3, which are third-party installs Stim
  does not require. See appandflow/stim#179.
  build-ios.ndjson     the xcodebuild / gradle transcript at level debug, the
  build-android.ndjson extracted diagnostics at level error, and the launch as
                       a marker record. One RUN's worth: each build starts the
                       file over, so the first error in it always belongs to
                       the run that pointed you at it.

  Only a dev server Stim hosted is captured. If you started the bundler
  yourself, the metro and client sources stay empty -- which is not a sign of a
  clean build. The device and build sources are written either way, because
  \`ios\` / \`android\` produce them.

  A collector is killed and replaced on the next \`ios\` / \`android\` run for
  that platform, and reaped by \`stop\`.`,
};
