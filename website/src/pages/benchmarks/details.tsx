import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useHistory, useLocation } from '@docusaurus/router';
import useIsBrowser from '@docusaurus/useIsBrowser';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import { benchmarks, defaultRun, displayVariant } from '@site/src/components/benchmarkCatalog';
import BenchmarkTimeline from '@site/src/components/BenchmarkTimeline';
import {
  benchmarkDisplayTitle,
  comparableRuns,
  benchmarkSelectionFromSearch,
  benchmarkSelectionSearch,
  comparisonOutcome,
  formatCost,
  formatSeconds,
  formatTokens,
  totalTokens,
  type BenchmarkRun,
} from '@site/src/components/benchmarkData';
import styles from '../benchmarks.module.css';

function ComparisonCard({
  variant,
  runs,
  maxSeconds,
}: {
  variant: BenchmarkRun['variant'];
  runs: BenchmarkRun[];
  maxSeconds: number;
}): ReactNode {
  const isLaunchCrash = variant === 'launch-crash';
  const comparable = isLaunchCrash
    ? runs.filter((run) => run.valid && run.diagnosisSeconds !== null)
    : comparableRuns(runs);
  const stim = comparable.find((run) => run.arm === 'stim');
  const control = comparable.find((run) => run.arm === 'control');
  const outcome = comparisonOutcome(stim?.settingsReadySeconds, control?.settingsReadySeconds);
  return (
    <article className={styles.comparisonCard}>
      <h3>{displayVariant(variant)}</h3>
      <span className={`${styles.outcome} ${styles[isLaunchCrash ? 'neutral' : outcome.tone]}`}>
        {isLaunchCrash ? 'Time to first actionable diagnosis' : outcome.label}
      </span>
      {comparable.map((run) => {
        const endpoint = (isLaunchCrash ? run.diagnosisSeconds : run.settingsReadySeconds) ?? null;
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
              {isLaunchCrash ? (
                <>
                  <span>Settings repaired {formatSeconds(run.settingsReadySeconds)}</span>
                  <span>
                    {run.diagnosisUsage ? formatTokens(totalTokens(run.diagnosisUsage)) : 'unavailable'} tokens
                  </span>
                  <span>{formatCost(run.estimatedDiagnosisCostUsd ?? null)} cost</span>
                </>
              ) : (
                <>
                  <span>{formatTokens(totalTokens(run.usage))} tokens</span>
                  <span>{formatCost(run.estimatedTokenCostUsd)} cost</span>
                  <span>{run.commandCount} commands</span>
                </>
              )}
            </div>
          </div>
        );
      })}
    </article>
  );
}

export default function BenchmarkDetails(): ReactNode {
  const history = useHistory();
  const location = useLocation();
  const isBrowser = useIsBrowser();
  const search = isBrowser ? location.search : '';
  const selection = useMemo(() => benchmarkSelectionFromSearch(search, benchmarks), [search]);
  const benchmark = benchmarks.find((candidate) => candidate.stage === selection.stage) ?? benchmarks[0];
  const publishedRuns = useMemo(() => benchmark?.runs.filter((run) => run.valid) ?? [], [benchmark]);
  const activeRun = publishedRuns.find((run) => run.id === selection.runId) ?? defaultRun(benchmark);
  const navigateTo = (nextStage: string, nextRunId: string) => {
    history.push({
      pathname: location.pathname,
      search: benchmarkSelectionSearch({ stage: nextStage, runId: nextRunId }, benchmarks),
      hash: location.hash,
    });
  };
  const grouped = useMemo(() => {
    const variants: BenchmarkRun['variant'][] =
      benchmark?.suite === 'launch-crash' ? ['launch-crash'] : ['javascript', 'native'];
    return variants.map((variant) => ({
      variant,
      runs: publishedRuns.filter((run) => run.variant === variant),
    }));
  }, [benchmark?.suite, publishedRuns]);
  const maxSeconds = Math.max(
    1,
    ...(benchmark?.suite === 'launch-crash'
      ? publishedRuns.map((run) => run.diagnosisSeconds ?? 0)
      : comparableRuns(publishedRuns).map((run) => run.settingsReadySeconds)),
  );

  if (!benchmark || !activeRun) {
    return (
      <Layout title="Benchmark details" description="Auditable Stim benchmark run details.">
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
      title="Benchmark details"
      description="Command timelines, environments, terminal output, and proof for published Stim agent benchmarks."
    >
      <main className={styles.page}>
        <div className="container">
          <header className={styles.detailHero}>
            <Link to="/benchmarks">Benchmark overview</Link>
            <span className={styles.eyebrow}>Detailed audit</span>
            <Heading as="h1">{benchmarkDisplayTitle(benchmark.title)}: Stim vs local toolchain</Heading>
            <p>Select a model and run to inspect its timing, commands, terminal output, and Settings-screen proof.</p>
          </header>

          <nav className={styles.modelPicker} aria-label="Benchmark model">
            <span>Model</span>
            {benchmarks.map((candidate) => (
              <button
                key={candidate.stage}
                type="button"
                aria-pressed={candidate.stage === benchmark.stage}
                onClick={() => navigateTo(candidate.stage, defaultRun(candidate)?.id ?? '')}
              >
                {benchmarkDisplayTitle(candidate.title)}
              </button>
            ))}
          </nav>

          <section className={styles.comparison} aria-labelledby="comparison-title">
            <div className={styles.sectionHeading}>
              <Heading as="h2" id="comparison-title">
                {benchmark.suite === 'launch-crash' ? 'Launch-failure result' : 'Settings-ready comparison'}
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
