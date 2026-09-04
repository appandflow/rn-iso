import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useHistory, useLocation } from '@docusaurus/router';
import useIsBrowser from '@docusaurus/useIsBrowser';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import BenchmarkTimeline from '@site/src/components/BenchmarkTimeline';
import {
  benchmarkDisplayTitle,
  comparableRuns,
  benchmarkOverview,
  benchmarkSelectionFromSearch,
  benchmarkSelectionSearch,
  comparisonOutcome,
  formatCost,
  formatSeconds,
  formatTokens,
  totalTokens,
  type BenchmarkData,
  type BenchmarkRun,
} from '@site/src/components/benchmarkData';
import benchmarkJson from '@site/src/data/benchmarks/luna-rc12.json';
import opusBenchmarkJson from '@site/src/data/benchmarks/opus-rc12.json';
import sonnetBenchmarkJson from '@site/src/data/benchmarks/sonnet-rc12.json';
import solBenchmarkJson from '@site/src/data/benchmarks/sol-rc12.json';
import styles from './benchmarks.module.css';

const benchmarks = (
  [benchmarkJson, solBenchmarkJson, sonnetBenchmarkJson, opusBenchmarkJson] as BenchmarkData[]
).filter((benchmark) => benchmark.runs.some((run) => run.valid));

function defaultRun(benchmark: BenchmarkData | undefined): BenchmarkRun | undefined {
  return benchmark?.runs.find((run) => run.valid);
}

function displayVariant(variant: BenchmarkRun['variant']): string {
  return variant === 'javascript' ? 'JavaScript change' : 'Native change';
}

function ComparisonCard({
  variant,
  runs,
  maxSeconds,
}: {
  variant: BenchmarkRun['variant'];
  runs: BenchmarkRun[];
  maxSeconds: number;
}): ReactNode {
  const comparable = comparableRuns(runs);
  const stim = comparable.find((run) => run.arm === 'stim');
  const control = comparable.find((run) => run.arm === 'control');
  const outcome = comparisonOutcome(stim?.settingsReadySeconds, control?.settingsReadySeconds);
  return (
    <article className={styles.comparisonCard}>
      <h3>{displayVariant(variant)}</h3>
      <span className={`${styles.outcome} ${styles[outcome.tone]}`}>{outcome.label}</span>
      {comparable.map((run) => {
        const endpoint = comparable.find((candidate) => candidate.id === run.id)?.settingsReadySeconds ?? null;
        return (
          <div className={styles.barRow} key={run.id}>
            <div className={styles.barHead}>
              <span>{run.arm === 'stim' ? 'Stim' : 'Control'}</span>
              <strong>{formatSeconds(endpoint)}</strong>
            </div>
            <div className={styles.barTrack}>
              <div
                className={`${styles.bar} ${run.arm === 'control' ? styles.controlBar : ''}`}
                style={{ width: `${endpoint === null ? 0 : (endpoint / maxSeconds) * 100}%` }}
              />
            </div>
            <div className={styles.barMeta}>
              <span>{formatTokens(totalTokens(run.usage))} tokens</span>
              <span>{formatCost(run.estimatedTokenCostUsd)} cost</span>
              <span>{run.commandCount} commands</span>
            </div>
          </div>
        );
      })}
    </article>
  );
}

function OverviewChart({
  variant,
  benchmarks: allBenchmarks,
}: {
  variant: BenchmarkRun['variant'];
  benchmarks: BenchmarkData[];
}): ReactNode {
  const overview = benchmarkOverview(allBenchmarks, variant);
  return (
    <article className={styles.overviewChart}>
      <div className={styles.overviewChartHead}>
        <h3>{displayVariant(variant)}</h3>
        <span>Settings-ready time</span>
      </div>
      <div className={styles.overviewLegend} aria-hidden="true">
        <span className={styles.stimKey}>Stim</span>
        <span className={styles.controlKey}>Control</span>
      </div>
      {overview.rows.map((row) => (
        <div className={styles.overviewModel} key={row.stage}>
          <strong>{benchmarkDisplayTitle(row.title)}</strong>
          <div className={styles.overviewBars}>
            {row.arms.map((arm) => {
              if (!arm.run || !arm.href) {
                return (
                  <span className={styles.missingBar} key={arm.arm}>
                    <span>{arm.label}</span>
                    <span>No valid run</span>
                  </span>
                );
              }
              return (
                <Link
                  className={styles.overviewBarLink}
                  key={arm.arm}
                  to={arm.href}
                  aria-label={`${benchmarkDisplayTitle(row.title)} ${displayVariant(variant)}, ${arm.arm}, ${formatSeconds(arm.run.settingsReadySeconds)}. Open run audit.`}
                >
                  <span>{arm.label}</span>
                  <span className={styles.overviewTrack} aria-hidden="true">
                    <span
                      className={`${styles.overviewBar} ${arm.arm === 'control' ? styles.controlBar : ''}`}
                      style={{ width: `${arm.widthPercent}%` }}
                    />
                  </span>
                  <strong>{formatSeconds(arm.run.settingsReadySeconds)}</strong>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </article>
  );
}

export default function Benchmarks(): ReactNode {
  const history = useHistory();
  const location = useLocation();
  const isBrowser = useIsBrowser();
  const search = isBrowser ? location.search : '';
  const selection = useMemo(() => benchmarkSelectionFromSearch(search, benchmarks), [search]);
  const stage = selection.stage;
  const benchmark = benchmarks.find((candidate) => candidate.stage === stage) ?? benchmarks[0];
  const publishedRuns = useMemo(() => benchmark?.runs.filter((run) => run.valid) ?? [], [benchmark]);
  const activeId = selection.runId;
  const activeRun = publishedRuns.find((run) => run.id === activeId) ?? defaultRun(benchmark);
  const navigateTo = (nextStage: string, nextRunId: string) => {
    history.push({
      pathname: location.pathname,
      search: benchmarkSelectionSearch({ stage: nextStage, runId: nextRunId }, benchmarks),
      hash: location.hash,
    });
  };
  const grouped = useMemo(
    () =>
      (['javascript', 'native'] as const).map((variant) => ({
        variant,
        runs: publishedRuns.filter((run) => run.variant === variant),
      })),
    [publishedRuns],
  );
  const maxSeconds = Math.max(1, ...comparableRuns(publishedRuns).map((run) => run.settingsReadySeconds));

  if (!benchmark || !activeRun) {
    return (
      <Layout title="Agent benchmarks" description="Auditable Stim agent benchmark results.">
        <main className={styles.page}>
          <div className="container">
            <Heading as="h1">Agent benchmarks unavailable</Heading>
            <p>No valid benchmark runs have been published.</p>
          </div>
        </main>
      </Layout>
    );
  }

  return (
    <Layout
      title="Agent benchmarks"
      description="Auditable Stim agent benchmark results with command timelines and Settings-screen proof."
    >
      <main className={styles.page}>
        <div className="container">
          <header className={styles.hero}>
            <div className={styles.eyebrow}>Agent benchmark</div>
            <Heading as="h1">Stim agent benchmarks</Heading>
            <p>
              Compare how coding agents launch the same React Native app with Stim and the local Expo/Apple toolchain.
              Results are split into JavaScript and native tasks, and every published time links to its command-level
              audit and Settings-screen proof.
            </p>
          </header>

          <section className={styles.overview} aria-labelledby="overview-title">
            <div className={styles.sectionHeading}>
              <div>
                <Heading as="h2" id="overview-title">
                  Performance across models
                </Heading>
                <p>Each bar is one valid pilot run; missing or invalid cells are labeled. Lower time is better.</p>
              </div>
            </div>
            <div className={styles.overviewGrid}>
              {(['javascript', 'native'] as const).map((variant) => (
                <OverviewChart key={variant} variant={variant} benchmarks={benchmarks} />
              ))}
            </div>
          </section>

          <section className={styles.methodology} aria-labelledby="methodology-title">
            <div>
              <span className={styles.eyebrow}>Methodology</span>
              <Heading as="h2" id="methodology-title">
                What these numbers measure
              </Heading>
              <p>
                Each pair uses the same clean app fixture, requested model, machine, and fixed code change. The primary
                endpoint starts when the agent is dispatched and stops only after agent-device finds the expected text
                on Settings and saves a screenshot.
              </p>
              <a href="https://github.com/appandflow/stim/blob/main/docs/agent-benchmark-v4.md">
                Read the full protocol
              </a>
            </div>
            <dl>
              <div>
                <dt>Two tasks</dt>
                <dd>JavaScript-only and native changes run as separate benchmark passes.</dd>
              </div>
              <div>
                <dt>Two arms</dt>
                <dd>
                  Stim uses its pinned published build and parked simulator; control uses local Expo and Apple tooling.
                </dd>
              </div>
              <div>
                <dt>Proof, not process liveness</dt>
                <dd>The reported time is the validated Settings screenshot, not the earlier app-process marker.</dd>
              </div>
              <div>
                <dt>Audited attempts</dt>
                <dd>Transcript rules, device identity, isolation, and proof are checked; invalid runs are excluded.</dd>
              </div>
            </dl>
          </section>

          <div className={styles.detailHeading}>
            <span className={styles.eyebrow}>Detailed audit</span>
            <Heading as="h2">{benchmarkDisplayTitle(benchmark.title)}: Stim vs local toolchain</Heading>
          </div>

          <nav className={styles.modelPicker} aria-label="Benchmark model">
            <span>Model</span>
            {benchmarks.map((candidate) => (
              <button
                key={candidate.stage}
                type="button"
                aria-pressed={candidate.stage === benchmark.stage}
                onClick={() => {
                  navigateTo(candidate.stage, defaultRun(candidate)?.id ?? '');
                }}
              >
                {benchmarkDisplayTitle(candidate.title)}
              </button>
            ))}
          </nav>

          <section className={styles.comparison} aria-labelledby="comparison-title">
            <div className={styles.sectionHeading}>
              <Heading as="h2" id="comparison-title">
                Settings-ready comparison
              </Heading>
              <p>Recorded {benchmark.recordedOn} / valid runs only</p>
            </div>
            <div className={styles.comparisonGrid}>
              {grouped.map(({ variant, runs }) => (
                <ComparisonCard key={variant} variant={variant} runs={runs} maxSeconds={maxSeconds} />
              ))}
            </div>
          </section>

          <section className={styles.environment} aria-labelledby="environment-title">
            <div>
              <span>Benchmark machine</span>
              <Heading as="h2" id="environment-title">
                {benchmark.environment.machine.model}
              </Heading>
              <p>
                {benchmark.environment.machine.chip} / {benchmark.environment.machine.memory}
              </p>
            </div>
            <dl>
              <div>
                <dt>System</dt>
                <dd>{benchmark.environment.macos}</dd>
              </div>
              <div>
                <dt>Toolchain</dt>
                <dd>
                  {benchmark.environment.xcode} / {benchmark.environment.node}
                </dd>
              </div>
              <div>
                <dt>Device</dt>
                <dd>{benchmark.environment.simulator}</dd>
              </div>
            </dl>
          </section>

          <section className={styles.audit} aria-labelledby="audit-title">
            <div className={styles.sectionHeading}>
              <div>
                <Heading as="h2" id="audit-title">
                  Run audit
                </Heading>
                <p>Select a command bar to inspect its terminal output.</p>
              </div>
            </div>
            <div className={styles.runTabs} role="group" aria-label="Benchmark runs">
              {publishedRuns.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  aria-pressed={run.id === activeRun.id}
                  onClick={() => navigateTo(benchmark.stage, run.id)}
                >
                  {run.variant} / {run.arm}
                </button>
              ))}
            </div>
            <BenchmarkTimeline key={`${benchmark.stage}-${activeRun.id}`} run={activeRun} />
          </section>

          <aside className={styles.notes}>
            <p>
              <strong>About cost.</strong>{' '}
              {benchmark.pricing?.estimateNote ??
                'Provider-reported cost is shown when the benchmark runner supplies it.'}{' '}
              {benchmark.pricing ? (
                <a href={benchmark.pricing.source}>See the recorded model's official token rates.</a>
              ) : null}
            </p>
            <p>
              The protocol keeps JavaScript and native changes separate. App-process liveness is a secondary diagnostic
              marker in the timeline, not a reported performance result. Public artifacts use relative paths and
              redacted simulator identifiers.
            </p>
          </aside>
        </div>
      </main>
    </Layout>
  );
}
