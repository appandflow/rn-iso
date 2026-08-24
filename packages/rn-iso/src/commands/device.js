// src/commands/device.js
import chalk from 'chalk';
import { findProjectRoot } from '../project.js';
import { getProject } from '../config.js';
import { resolveProjectMetro } from '../metro.js';

export default function deviceCommand(program) {
  program
    .command('device')
    .description('Print the assigned device UDID/serial for the current project')
    .option('--platform <platform>', 'ios or android', 'ios')
    .option('--json', 'Emit JSON with full assignment info')
    .action(async (opts) => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project (no package.json found).'));
        process.exit(1);
      }
      const proj = getProject(root);
      if (!proj) {
        console.error(chalk.red(`No rn-iso assignment for project ${root}. Run \`rn-iso up ${opts.platform}\` first.`));
        process.exit(1);
      }
      const platformEntry = proj.platforms?.[opts.platform];
      if (!platformEntry) {
        console.error(chalk.red(`No ${opts.platform} device assigned. Run \`rn-iso up ${opts.platform}\` first.`));
        process.exit(1);
      }

      if (opts.json) {
        // Metro fields let agents verify the bundler is actually serving
        // (metroHealthy pings /status) and find the log without guessing paths.
        // Same identity proof as `up` and teardown: a bare /status ping would
        // report a foreign bundler on our reserved port as healthy.
        const resolution = proj.metroPort
          ? await resolveProjectMetro(proj.metroPort, root)
          : { missing: true };
        const metro = {
          metroPort: proj.metroPort,
          metroHealthy: Boolean(resolution.metro),
          metroConflict: resolution.notOurs ?? null,
        };
        let payload;
        if (opts.platform === 'ios') {
          payload = { platform: 'ios', udid: platformEntry.deviceUdid, ...metro };
        } else if (platformEntry.serial && !platformEntry.avdName) {
          payload = {
            platform: 'android',
            kind: 'physical',
            serial: platformEntry.serial,
            avdName: null,
            consolePort: null,
            ...metro,
          };
        } else {
          payload = {
            platform: 'android',
            kind: 'emulator',
            serial: `emulator-${platformEntry.consolePort}`,
            avdName: platformEntry.avdName,
            consolePort: platformEntry.consolePort,
            ...metro,
          };
        }
        console.log(JSON.stringify(payload));
        return;
      }

      if (opts.platform === 'ios') {
        console.log(platformEntry.deviceUdid);
      } else if (platformEntry.serial && !platformEntry.avdName) {
        console.log(platformEntry.serial);
      } else {
        console.log(`emulator-${platformEntry.consolePort}`);
      }
    });
}
