// src/commands/guide.js
//
// Version-matched reference documentation, printed by the binary itself.
//
// Why this exists: skill/SKILL.md ships through `npx skills add` (GitHub) while
// the CLI ships through npm, with no version relationship between them. A user
// reported running a 0.10.0 CLI against a 0.6.x skill and not noticing. Docs
// that live only in the skill drift silently.
//
// The split is by VOLATILITY, not by length. The skill keeps what makes an
// agent trigger correctly and behave safely -- the ownership model, the
// destructive-command rules, the parallel-agent rules. Everything that changes
// per release -- exact flags, payload shape, error remedies -- lives here, so
// `npx rn-iso@latest guide facts` always describes the binary the agent is
// about to run.
import chalk from 'chalk';

const TOPICS = {
  facts: {
    summary: 'The `up --json` / `device --json` payload, field by field',
    body: () => `FACTS CONTRACT

\`rn-iso up <ios|android> --json\` prints exactly ONE line of JSON on stdout.
Every other line goes to stderr, so it is safe to pipe.

  platform       "ios" | "android"
  owned          true when rn-iso created the device (and so may destroy it)
  metroPort      the port RESERVED for this project. rn-iso does not start
                 Metro; you start it on this port.
  metroHealthy   true only when a Metro answering /status is running FROM
                 INSIDE this project. Normally false right after \`up\`.
  metroConflict  null, or why the process on metroPort could not be proven to
                 be this project's Metro. Non-null means: do not build yet.
  bundleId       iOS bundle id. On Android this is the ANDROID PACKAGE NAME.

iOS adds:      udid, deviceName
Android adds:  kind ("emulator" | "physical"), serial, avdName, consolePort

RULES
  - Never hardcode or guess a udid/serial/port. Read them from the payload.
  - Pass them EXPLICITLY to your build and to every device tool
    (agent-device, xcrun simctl, adb -s, idb).
  - Never assume "booted" is your simulator. Other agents have theirs booted
    too.
  - Do not build while metroConflict is non-null: the build CLIs reuse
    whatever answers on the port, so you would build against it.`,
  },

  metro: {
    summary: 'How to start Metro on the reserved port, per project shape',
    body: () => `STARTING METRO

rn-iso reserves a collision-free port and never starts Metro. Which bundler
command a project needs is judgment you have from reading the repo.

  Expo                    npx expo start --port <port>
  Bare React Native       npx react-native start --port <port>
  Has its own start script  run it and append --port <port>; it may carry
                          flags that matter (e.g. --client-logs)
  Monorepo                run from the APP directory, not the repo root

TWO RULES THAT KEEP TEARDOWN WORKING
  1. Start it from inside the project directory, in the background. Teardown
     identifies your Metro by checking the process on the port both answers
     /status AND runs from inside the project. Started elsewhere, rn-iso
     refuses to kill it rather than risk killing something of yours.
  2. Redirect output to a predictable file. rn-iso does not capture Metro's
     log, so a later session can only find it if the path is guessable.

  npx expo start --port 8082 > /tmp/metro-<label>.log 2>&1 &

Then wait for it. Either poll \`rn-iso device --platform ios --json\` until
metroHealthy is true, or let rn-iso do it:

  npx rn-iso up ios --wait-metro --json`,
  },

  errors: {
    summary: 'Every refusal rn-iso can print, and what to do about it',
    body: () => `WHAT RN-ISO REFUSES, AND WHY

"port <n> is in use but is NOT this project's Metro" / metroConflict non-null
  Something holds your reserved port that rn-iso cannot prove is your Metro.
  Causes, most common first:
    - You started Metro from the wrong directory (repo root instead of the
      app dir in a monorepo). Restart it from inside the project.
    - Another repo's Metro owns the port. Stop it there, or free the port and
      re-run \`up\` to get a fresh reservation.
    - A non-Metro server (a web dev server) took the port. Free it.
  \`rn-iso stop <port> --force\` kills whatever holds it -- destructive, ask
  the user first.

"Refusing to kill port <n>: ... runs from <dir>, outside <project>"
  Same cause. rn-iso will not kill a process it cannot attribute to you.

"this project's sim is X, but --device-type asked for Y"
  The project already owns a simulator of a different model. \`rn-iso release\`
  deletes it (losing that sim's app state), then \`up ios\` creates the one you
  asked for.

"Refusing to remove <path>: uncommitted changes / untracked files / commits
not on any remote"
  A native build rewrites tracked files -- \`pod install\` always touches
  Podfile.lock and project.pbxproj -- so this fires after almost every iOS
  build. RESTORE THOSE FILES rather than reaching for --force:
    git checkout -- ios/Podfile.lock ios/*.xcodeproj/project.pbxproj
  Use --force only when you genuinely intend to discard work; it deletes
  uncommitted and untracked files permanently.

"No Metro port assigned to <path>, and no registered project under it owns one"
  Nothing to stop. Exit code 1, deliberately: exit 0 here used to let agents
  believe they had torn down a still-running Metro.

"Found no free Metro port between ..."
  200 consecutive ports are claimed or occupied. \`rn-iso status\` shows what
  rn-iso knows about; the rest is other software.

"Failed to ensure android device: No physical device is connected"
  \`up android --serial <s>\` needs the device visible to \`adb devices\`.`,
  },

  lifecycle: {
    summary: 'The full worktree -> device -> Metro -> build -> teardown flow',
    body: () => `ENVIRONMENT LIFECYCLE

  # 1. Isolated worktree (skip if you are already in one).
  #    It does NOT install dependencies -- that is yours.
  cd "$(npx rn-iso worktree create feature-x)"
  npm install

  # 2. Device + reserved port.
  npx rn-iso up ios --json

  # 3. Start Metro on the reserved port, from inside the project.
  npx expo start --port <metroPort> > /tmp/metro-feature-x.log 2>&1 &

  # 4. Confirm it is yours before building.
  npx rn-iso up ios --wait-metro --json    # metroHealthy: true

  # 5. YOUR build, against the printed facts.
  npx expo run:ios --device <udid> --port <metroPort>

  # 6. Work. Then tear the environment down whole.
  npx rn-iso worktree remove <path>

DESTRUCTIVE COMMANDS -- ask the user first
  gc --delete             erases build output, tens of GB
  worktree remove --force discards uncommitted and untracked work
  release                 DELETES the owned device, not just its assignment
  stop --force            kills a process rn-iso could not identify

CAPACITY
  A booted iOS sim is roughly 1-2 GB of RAM, an Android emulator 2-3 GB. On a
  16 GB machine plan for 2-3 live environments. Nothing enforces this.`,
  },

  settings: {
    summary: 'Settings rn-iso reads, and where they can live',
    body: () => `SETTINGS

Resolution order, first match wins:
  1. CLI flag        --device-type / --runtime / --system-image / --serial
  2. project layer   rn-iso config <key> <value>
  3. repo layer      rn-iso config --repo <key> <value>
  4. committed       .rn-iso.json at the repo root
  5. rn-iso default

KEYS RN-ISO READS
  ios.deviceType        e.g. "iPhone 17 Pro"
  ios.runtime           e.g. "26.2"
  android.systemImage   e.g. "system-images;android-36;google_apis;arm64-v8a"
  worktreeDir           where worktrees are created (repo layer)
  worktree.baseRef      "fresh" (origin/HEAD) or "head"
  worktree.include      carry-over patterns, same role as .worktreeinclude

Anything else is IGNORED, and rn-iso warns about it by name. If you see such a
warning, the key was either renamed or removed -- check this list rather than
assuming it still applies.`,
  },
};

export function topicNames() {
  return Object.keys(TOPICS);
}

export function renderTopic(name) {
  const topic = TOPICS[name];
  if (!topic) return null;
  return topic.body();
}

export function renderIndex(version) {
  const lines = [
    `rn-iso ${version} -- reference for the binary you are running.`,
    '',
    'This output is generated by the CLI, so it always matches this version.',
    'The bundled skill covers the stable rules; these topics cover the surface',
    'that changes between releases.',
    '',
    'TOPICS',
  ];
  const width = Math.max(...topicNames().map(n => n.length));
  for (const name of topicNames()) {
    lines.push(`  ${name.padEnd(width)}  ${TOPICS[name].summary}`);
  }
  lines.push('', 'Read one with:  npx rn-iso guide <topic>');
  return lines.join('\n');
}

export default function guideCommand(program, version) {
  program
    .command('guide [topic]')
    .description('Print reference documentation for THIS version of rn-iso (topics: ' + topicNames().join(', ') + '). Generated by the binary, so it cannot drift from the installed CLI.')
    .action((topic) => {
      if (!topic) {
        console.log(renderIndex(version));
        return;
      }
      const body = renderTopic(topic);
      if (!body) {
        console.error(chalk.red(`Unknown topic "${topic}".`));
        console.error(chalk.dim(`Available: ${topicNames().join(', ')}`));
        process.exit(1);
      }
      console.log(body);
    });
}
