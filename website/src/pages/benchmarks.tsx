import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import BenchmarkTimeline from '@site/src/components/BenchmarkTimeline';
import {
  comparableRuns,
  formatCost,
  formatSeconds,
  formatTokens,
  totalTokens,
  type BenchmarkData,
  type BenchmarkRun,
} from '@site/src/components/benchmarkData';
import benchmarkJson from '@site/src/data/benchmarks/luna-rc12.json';
import styles from './benchmarks.module.css';

const benchmark = benchmarkJson as BenchmarkData;

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
  const improvement =
    stim && control ? Math.round((1 - stim.settingsReadySeconds / control.settingsReadySeconds) * 100) : null;
  return (
    <article className={styles.comparisonCard}>
      <h3>{displayVariant(variant)}</h3>
      <span className={styles.gain}>
        {improvement == null ? 'Matched run unavailable' : `Stim reached Settings ${improvement}% sooner`}
      </span>
      {runs.map((run) => {
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
              <span>{formatCost(run.estimatedTokenCostUsd)} est.</span>
              <span>{run.commandCount} commands</span>
            </div>
          </div>
        );
      })}
    </article>
  );
}

export default function Benchmarks(): ReactNode {
  const [activeId, setActiveId] = useState(benchmark.runs[0].id);
  const activeRun = benchmark.runs.find((run) => run.id === activeId) ?? benchmark.runs[0];
  const grouped = useMemo(
    () =>
      (['javascript', 'native'] as const).map((variant) => ({
        variant,
        runs: benchmark.runs.filter((run) => run.variant === variant),
      })),
    [],
  );
  const maxSeconds = Math.max(1, ...comparableRuns(benchmark.runs).map((run) => run.settingsReadySeconds));

  return (
    <Layout
      title="Agent benchmarks"
      description="Auditable Stim agent benchmark results with command timelines and Settings-screen proof."
    >
      <main className={styles.page}>
        <div className="container">
          <header className={styles.hero}>
            <div className={styles.eyebrow}>Agent benchmark · protocol v{benchmark.protocolVersion}</div>
            <Heading as="h1">{benchmark.title}: Stim vs local toolchain</Heading>
            <p>
              One matched run per arm. The sole performance endpoint is elapsed time from agent dispatch to a validated
              Settings screenshot; lower is better. Every command and proof image remains available below for audit.
            </p>
          </header>

          <section className={styles.comparison} aria-labelledby="comparison-title">
            <div className={styles.sectionHeading}>
              <Heading as="h2" id="comparison-title">
                Settings-ready comparison
              </Heading>
              <p>
                Recorded {benchmark.recordedOn} ·{' '}
                {benchmark.runs.every((run) => run.valid) ? 'all runs valid' : 'contains invalid runs'}
              </p>
            </div>
            <div className={styles.comparisonGrid}>
              {grouped.map(({ variant, runs }) => (
                <ComparisonCard key={variant} variant={variant} runs={runs} maxSeconds={maxSeconds} />
              ))}
            </div>
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
              {benchmark.runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  aria-pressed={run.id === activeRun.id}
                  onClick={() => setActiveId(run.id)}
                >
                  {run.variant} · {run.arm}
                </button>
              ))}
            </div>
            <BenchmarkTimeline key={activeRun.id} run={activeRun} />
          </section>

          <aside className={styles.notes}>
            <p>
              <strong>About cost.</strong> {benchmark.pricing?.estimateNote}{' '}
              {benchmark.pricing ? (
                <a href={benchmark.pricing.source}>See the recorded model’s official token rates.</a>
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
