import type { ReactNode } from 'react';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import CodeBlock from '@theme/CodeBlock';
import Heading from '@theme/Heading';

const quickStart = `# the only command a human runs:
npx skills add appandflow/rn-iso

# then tell your agent:
#   /rn-iso-init
#   "Build and run the app on the iOS simulator and fix anything that breaks."`;

const features: Array<{ title: string; body: ReactNode }> = [
  {
    title: 'Isolated environments',
    body: (
      <>
        Every project or git worktree gets its own reserved Metro port and its own <em>owned</em> simulator or emulator.
        Several coding agents build the same app on one machine at the same time without fighting over ports and
        devices.
      </>
    ),
  },
  {
    title: 'Built for agent loops',
    body: (
      <>
        Never prompts, prints on the order of ten lines, takes <code>--json</code> everywhere, and reports a failing
        build as the extracted compiler diagnostic plus a log path — not four thousand lines of transcript.{' '}
        <code>logs --errors</code> returning nothing is the pass condition.
      </>
    ),
  },
  {
    title: 'Builds that hit a cache',
    body: (
      <>
        Native inputs are fingerprinted; when nothing native changed, the app installs from a shared cache instead of
        compiling. When two workspaces miss at once, exactly one compiles and the other installs its artifact.
      </>
    ),
  },
  {
    title: 'Cleans up after dying agents',
    body: (
      <>
        A killed agent leaves a booted simulator, a Metro squatting on a port, a stale lock. <code>stop</code>,{' '}
        <code>worktree remove</code> and <code>gc</code> reclaim all of it — and rn-iso never touches a device it did
        not create.
      </>
    ),
  },
];

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout description="The React Native / Expo CLI for AI agents: isolated dev environments, owned simulators, shared build caches, structured logs.">
      <header className="hero hero--dark" style={{ textAlign: 'center', padding: '4rem 1rem' }}>
        <div className="container">
          <Heading as="h1" className="hero__title">
            {siteConfig.title}
          </Heading>
          <p className="hero__subtitle">{siteConfig.tagline}</p>
          <p style={{ maxWidth: 720, margin: '0 auto 2rem' }}>
            Humans never run it — your agent does. Isolated dev environments, so several coding agents can build the
            same app on one machine at the same time, with a build loop optimised for an agent, not a terminal.
          </p>
          <div style={{ maxWidth: 720, margin: '0 auto', textAlign: 'left' }}>
            <CodeBlock language="bash">{quickStart}</CodeBlock>
          </div>
          <div style={{ marginTop: '1.5rem', display: 'flex', gap: '1rem', justifyContent: 'center' }}>
            <Link className="button button--primary button--lg" to="/docs/getting-started">
              Get started
            </Link>
            <Link className="button button--secondary button--lg" to="/docs/why">
              Why rn-iso
            </Link>
          </div>
        </div>
      </header>
      <main>
        <section className="container" style={{ padding: '3rem 1rem' }}>
          <div className="row">
            {features.map((f) => (
              <div key={f.title} className="col col--6" style={{ marginBottom: '2rem' }}>
                <Heading as="h3">{f.title}</Heading>
                <p>{f.body}</p>
              </div>
            ))}
          </div>
        </section>
      </main>
    </Layout>
  );
}
