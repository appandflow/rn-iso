import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [baselinePath, outputPath, dispatchIso, variant, arm, parkedUdid] = process.argv.slice(2);
const baseline = new Set(JSON.parse(readFileSync(baselinePath, 'utf8')));
const deadline = Date.now() + 20 * 60 * 1000;
let firstAlive = null;

function simctl(...args) {
  return execFileSync('xcrun', ['simctl', ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function devices() {
  const parsed = JSON.parse(simctl('list', 'devices', '--json'));
  return Object.values(parsed.devices).flat();
}

function alive(udid) {
  try {
    simctl('get_app_container', udid, 'com.appandflow.trailhead', 'app');
    const processes = execFileSync('ps', ['-A', '-o', 'command='], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return processes
      .split('\n')
      .some((line) => line.includes(`/Devices/${udid}/`) && line.includes('/Trailhead.app/Trailhead'));
  } catch {
    return false;
  }
}

function captureJavascriptProof() {
  const expected = 'Keep saved trail maps available offline';
  for (let port = 8081; port <= 8090; port += 1) {
    const target = join(dirname(outputPath), 'proof', `metro-${port}-at-app-alive.bundle`);
    try {
      execFileSync(
        'curl',
        [
          '--fail',
          '--silent',
          '--show-error',
          '--max-time',
          '60',
          '--output',
          target,
          `http://127.0.0.1:${port}/.expo/.virtual-metro-entry.bundle?platform=ios&dev=true&minify=false`,
        ],
        { timeout: 70_000 },
      );
      const contents = readFileSync(target);
      if (contents.includes(Buffer.from(expected))) {
        return { valid: true, kind: 'metro-bundle-string-at-app-alive', expected, target, port };
      }
    } catch {}
    if (existsSync(target)) rmSync(target);
  }
  return { valid: false, reason: 'changed-metro-bundle-not-found-at-app-alive' };
}

while (Date.now() < deadline) {
  try {
    const candidates = devices().filter((device) => {
      if (!device.isAvailable) return false;
      return arm === 'stim' ? device.udid === parkedUdid : !baseline.has(device.udid);
    });
    if (candidates.length > 1) {
      writeFileSync(outputPath, `${JSON.stringify({ error: 'multiple-candidate-simulators', candidates }, null, 2)}\n`);
      process.exit(2);
    }
    if (candidates.length === 1 && alive(candidates[0].udid)) {
      firstAlive ??= {
        observedAt: new Date().toISOString(),
        simulator: candidates[0],
      };
      const proof = variant === 'javascript' ? captureJavascriptProof() : null;
      if (variant === 'javascript' && !proof.valid) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      const proofObservedAt = new Date().toISOString();
      writeFileSync(
        outputPath,
        `${JSON.stringify(
          {
            dispatchAt: dispatchIso,
            observedAt: firstAlive.observedAt,
            dispatchToAppAliveSeconds: (Date.parse(firstAlive.observedAt) - Date.parse(dispatchIso)) / 1000,
            simulator: firstAlive.simulator,
            proof,
            proofObservedAt,
            dispatchToProofSeconds: (Date.parse(proofObservedAt) - Date.parse(dispatchIso)) / 1000,
          },
          null,
          2,
        )}\n`,
      );
      process.exit(0);
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

writeFileSync(
  outputPath,
  `${JSON.stringify(
    firstAlive
      ? {
          error: 'proof-timeout-after-app-alive',
          dispatchAt: dispatchIso,
          observedAt: firstAlive.observedAt,
          dispatchToAppAliveSeconds: (Date.parse(firstAlive.observedAt) - Date.parse(dispatchIso)) / 1000,
          simulator: firstAlive.simulator,
        }
      : { error: 'app-alive-timeout', dispatchAt: dispatchIso },
    null,
    2,
  )}\n`,
);
process.exit(3);
