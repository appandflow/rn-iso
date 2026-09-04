import type { ReactNode } from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import { benchmarks, defaultRun, displayVariant } from '@site/src/components/benchmarkCatalog';
import BenchmarkVideo from '@site/src/components/BenchmarkVideo';
import {
  benchmarkDisplayTitle,
  benchmarkOverview,
  benchmarkSelectionSearch,
  formatCost,
  formatSeconds,
  formatTokens,
  totalTokens,
  type BenchmarkData,
  type BenchmarkRun,
} from '@site/src/components/benchmarkData';
import styles from './benchmarks.module.css';

const readinessBenchmarks = benchmarks.filter((benchmark) => benchmark.suite !== 'launch-crash');
const launchCrashBenchmarks = benchmarks.filter((benchmark) => benchmark.suite === 'launch-crash');
const readinessPlatforms = (['ios', 'android'] as const)
  .map((platform) => ({
    platform,
    benchmarks: readinessBenchmarks.filter((benchmark) => (benchmark.platform ?? 'ios') === platform),
  }))
  .filter(({ benchmarks: platformBenchmarks }) => platformBenchmarks.length > 0);

function LaunchCrashCard({ benchmark }: { benchmark: BenchmarkData }): ReactNode {
  const runs = benchmark.runs.filter((run) => run.valid && run.diagnosisSeconds !== null);
  const maxSeconds = Math.max(1, ...runs.map((run) => run.diagnosisSeconds ?? 0));
  return (
    <article className={styles.comparisonCard}>
      <h3>{benchmark.runs[0]?.model ?? benchmarkDisplayTitle(benchmark.title)}: JavaScript launch failure</h3>
      <span className={`${styles.outcome} ${styles.neutral}`}>Time to first actionable diagnosis</span>
      {runs.map((run) => (
        <div className={styles.barRow} key={run.id}>
          <div className={styles.barHead}>
            <span>{run.arm === 'stim' ? 'Stim' : 'Control'}</span>
            <strong>{formatSeconds(run.diagnosisSeconds ?? null)}</strong>
          </div>
          <div className={styles.barTrack}>
            <div
              className={`${styles.bar} ${run.arm === 'control' ? styles.controlBar : ''}`}
              style={{ width: `${((run.diagnosisSeconds ?? 0) / maxSeconds) * 100}%` }}
            />
          </div>
          <div className={styles.barMeta}>
            <span>Settings repaired {formatSeconds(run.settingsReadySeconds)}</span>
            <span>{run.diagnosisUsage ? formatTokens(totalTokens(run.diagnosisUsage)) : 'unavailable'} tokens</span>
            <span>{formatCost(run.estimatedDiagnosisCostUsd ?? null)} cost</span>
          </div>
        </div>
      ))}
      <Link
        to={`/benchmarks/details${benchmarkSelectionSearch(
          { stage: benchmark.stage, runId: defaultRun(benchmark)?.id ?? '' },
          benchmarks,
        )}#audit-title`}
      >
        Open the run audit
      </Link>
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
              Compare how coding agents launch the same React Native app with Stim and the local Expo/native toolchain.
              Platforms and JavaScript/native tasks are measured separately, and every published time links to its
              command-level audit and Settings-screen proof.
            </p>
          </header>

          {readinessPlatforms.map(({ platform, benchmarks: platformBenchmarks }) => (
            <section className={styles.overview} aria-labelledby={`${platform}-overview-title`} key={platform}>
              <div className={styles.sectionHeading}>
                <div>
                  <Heading as="h2" id={`${platform}-overview-title`}>
                    {platform === 'ios' ? 'iOS' : 'Android'} performance across models
                  </Heading>
                  <p>Each bar is one valid run; missing or invalid cells are labeled. Lower time is better.</p>
                </div>
              </div>
              <div className={styles.overviewGrid}>
                {(['javascript', 'native'] as const).map((variant) => (
                  <OverviewChart key={variant} variant={variant} benchmarks={platformBenchmarks} />
                ))}
              </div>
            </section>
          ))}

          {launchCrashBenchmarks.length ? (
            <section className={styles.overview} aria-labelledby="launch-crash-title">
              <div className={styles.sectionHeading}>
                <div>
                  <Heading as="h2" id="launch-crash-title">
                    Launch failure diagnosis
                  </Heading>
                  <p>
                    A deterministic root-render exception is committed before dispatch. The agent must launch first,
                    diagnose from captured errors, repair the source, and prove the unchanged Settings screen.
                  </p>
                </div>
              </div>
              <div className={styles.comparisonGrid}>
                {launchCrashBenchmarks.map((candidate) => (
                  <LaunchCrashCard benchmark={candidate} key={candidate.stage} />
                ))}
              </div>
            </section>
          ) : null}

          <section className={styles.methodology} aria-labelledby="methodology-title">
            <div>
              <span className={styles.eyebrow}>Methodology</span>
              <Heading as="h2" id="methodology-title">
                What these numbers measure
              </Heading>
              <p>
                Readiness comparisons use the same clean app fixture, requested model, machine, and fixed code change.
                The primary endpoint starts when the agent is dispatched and stops only after agent-device finds the
                expected text on Settings and saves a screenshot. Each current run also records onboarding and
                navigation from the exact run device.
              </p>
              <a href="https://github.com/appandflow/stim/blob/main/docs/agent-benchmark.md">Read the full protocol</a>
            </div>
            <dl>
              <div>
                <dt>Two tasks</dt>
                <dd>JavaScript-only and native changes run as separate benchmark passes.</dd>
              </div>
              <div>
                <dt>Two arms</dt>
                <dd>
                  Stim uses its pinned published build; control uses local Expo and native platform tooling. iOS reuses
                  a prepared parked simulator, while both Android arms create a fresh matched AVD.
                </dd>
              </div>
              <div>
                <dt>Proof, not process liveness</dt>
                <dd>The reported time is the validated Settings screenshot, not the earlier app-process marker.</dd>
              </div>
              <div>
                <dt>Launch-failure suite</dt>
                <dd>Diagnosis time and repaired Settings proof are reported separately from readiness results.</dd>
              </div>
              <div>
                <dt>Audited attempts</dt>
                <dd>Transcript rules, device identity, isolation, and proof are checked; invalid runs are excluded.</dd>
              </div>
            </dl>
          </section>

          <BenchmarkVideo />

          <section className={styles.detailCta} aria-labelledby="detail-cta-title">
            <div>
              <span className={styles.eyebrow}>Command-level evidence</span>
              <Heading as="h2" id="detail-cta-title">
                Inspect every benchmark run
              </Heading>
              <p>
                Compare environments, play each command timeline, inspect terminal output, and open proof images and
                simulator recordings.
              </p>
            </div>
            <Link className="button button--primary" to="/benchmarks/details">
              Explore detailed audits
            </Link>
          </section>
        </div>
      </main>
    </Layout>
  );
}
