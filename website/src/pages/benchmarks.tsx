import type { ReactNode } from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import { benchmarks, displayVariant } from '@site/src/components/benchmarkCatalog';
import BenchmarkVideo from '@site/src/components/BenchmarkVideo';
import {
  benchmarkDisplayTitle,
  benchmarkOverview,
  formatSeconds,
  type BenchmarkData,
  type BenchmarkRun,
} from '@site/src/components/benchmarkData';
import styles from './benchmarks.module.css';

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

          <BenchmarkVideo />

          <section className={styles.detailCta} aria-labelledby="detail-cta-title">
            <div>
              <span className={styles.eyebrow}>Command-level evidence</span>
              <Heading as="h2" id="detail-cta-title">
                Inspect every benchmark run
              </Heading>
              <p>Compare environments, play each command timeline, inspect terminal output, and open proof images.</p>
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
