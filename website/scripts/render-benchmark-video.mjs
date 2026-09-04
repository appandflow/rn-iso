import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const websiteDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const benchmarkStage = 'luna-rc12';
const runId = 'javascript-stim';
const data = JSON.parse(readFileSync(join(websiteDir, `src/data/benchmarks/${benchmarkStage}.json`), 'utf8'));
const run = data.runs.find(
  (candidate) =>
    candidate.id === runId && candidate.variant === 'javascript' && candidate.arm === 'stim' && candidate.valid,
);
const control = data.runs.find(
  (candidate) => candidate.variant === run?.variant && candidate.arm === 'control' && candidate.valid,
);

if (!run || !control || run.settingsReadySeconds == null || control.settingsReadySeconds == null || !run.proof) {
  throw new Error('The selected published JavaScript Stim/control comparison is incomplete.');
}

const outputDir = join(websiteDir, 'static/benchmarks', benchmarkStage);
const workDir = mkdtempSync(join(tmpdir(), 'stim-remotion-'));
const propsPath = join(workDir, 'props.json');
const entry = join(websiteDir, 'video/index.ts');
const props = {
  benchmarkTitle: data.title,
  run,
  control,
  interactionSrc: `benchmarks/${benchmarkStage}/${runId}-interaction.mp4`,
  interactionStartSrc: `benchmarks/${benchmarkStage}/${runId}-interaction-start.png`,
  interactionEndSrc: `benchmarks/${benchmarkStage}/${runId}-interaction-end.png`,
};

mkdirSync(outputDir, { recursive: true });
writeFileSync(propsPath, JSON.stringify(props));

function remotion(args) {
  execFileSync('pnpm', ['exec', 'remotion', ...args, '--props', propsPath, '--public-dir', 'static'], {
    cwd: websiteDir,
    stdio: 'inherit',
  });
}

try {
  remotion([
    'render',
    entry,
    'BenchmarkLandscape',
    join(outputDir, `${runId}-web.mp4`),
    '--codec',
    'h264',
    '--crf',
    '18',
    '--overwrite',
  ]);
  remotion([
    'render',
    entry,
    'BenchmarkSocial',
    join(outputDir, `${runId}-social.mp4`),
    '--codec',
    'h264',
    '--crf',
    '18',
    '--overwrite',
  ]);
  remotion([
    'still',
    entry,
    'BenchmarkLandscape',
    join(outputDir, `${runId}-video-poster.png`),
    '--frame',
    '1',
    '--overwrite',
  ]);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
