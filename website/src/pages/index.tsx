import type { ReactNode } from 'react';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import CodeBlock from '@theme/CodeBlock';
import Heading from '@theme/Heading';
import {
  CacheIllustration,
  CleanupIllustration,
  ParallelIllustration,
  PlatformsIllustration,
} from '@site/src/components/FeatureIllustrations';

const quickStart = `# install the CLI and its agent skill
npm install --global stim-cli
npx skills add appandflow/stim

# then tell your coding agent:
#   "Build and run the app on the iOS simulator and fix anything that breaks."
# Stim runs on a clean checkout. There is nothing to commit.`;

const features: Array<{ title: string; body: ReactNode; illustration: ReactNode }> = [
  {
    title: 'Fast builds across worktrees',
    body: (
      <>
        Native artifacts, Xcode compilation data, Gradle output, and Metro transforms are shared safely. A new worktree
        can install a cached app when its native inputs match. Concurrent misses use one build.
      </>
    ),
    illustration: <CacheIllustration />,
  },
  {
    title: 'Parallel agents without collisions',
    body: (
      <>
        Each checkout gets its own Metro port and owned device. Agents can create isolated git worktrees and work in
        parallel. Small, streaming output and focused errors reduce waiting and token use.
      </>
    ),
    illustration: <ParallelIllustration />,
  },
  {
    title: 'React Native and Expo, here or remote',
    body: (
      <>
        Stim works with React Native Community CLI and Expo projects. It builds locally, then launches on an owned local
        simulator or a configured remote simulator. The agent gets the exact device and launch state.
      </>
    ),
    illustration: <PlatformsIllustration />,
  },
  {
    title: 'Owned resources and complete cleanup',
    body: (
      <>
        Stim tracks every port, process, build, device, and remote session it creates. <code>stop</code>,{' '}
        <code>worktree remove</code>, and <code>gc</code> reclaim resources without touching devices Stim does not own.
      </>
    ),
    illustration: <CleanupIllustration />,
  },
];

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout description="Stim gives coding agents fast, isolated React Native and Expo environments with shared build caches and owned devices.">
      <header className="hero hero--dark stimHero">
        <div className="container">
          <Heading as="h1" className="hero__title">
            {siteConfig.title}
          </Heading>
          <p className="hero__subtitle">{siteConfig.tagline}</p>
          <p className="stimHeroLead">
            Give each coding agent a fast, isolated React Native environment. Stim shares build caches across worktrees,
            owns each device and port, supports local and remote simulators, and cleans up when the work is done.
          </p>
          <div className="stimQuickStart">
            <CodeBlock language="bash">{quickStart}</CodeBlock>
          </div>
          <div className="stimHeroActions">
            <Link className="button button--primary button--lg" to="/docs/getting-started">
              Get started
            </Link>
            <Link className="button button--secondary button--lg" to="/docs/why">
              Why Stim
            </Link>
          </div>
        </div>
      </header>
      <main>
        <section className="container stimFeatures">
          <div className="stimFeatureGrid">
            {features.map((f) => (
              <article key={f.title} className="stimFeatureCard">
                {f.illustration}
                <Heading as="h3">{f.title}</Heading>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </section>
      </main>
    </Layout>
  );
}
