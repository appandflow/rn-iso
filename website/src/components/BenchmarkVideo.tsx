import type { ReactNode } from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Heading from '@theme/Heading';
import styles from './BenchmarkVideo.module.css';

export default function BenchmarkVideo(): ReactNode {
  const video = useBaseUrl('/benchmarks/luna-rc12/javascript-stim-web.mp4');
  const poster = useBaseUrl('/benchmarks/luna-rc12/javascript-stim-video-poster.png');
  const social = useBaseUrl('/benchmarks/luna-rc12/javascript-stim-social.mp4');
  const audit = useBaseUrl('/benchmarks#audit-title');

  return (
    <section className={styles.story} aria-labelledby="benchmark-video-title">
      <div className={styles.heading}>
        <div>
          <span>Prompt to proof</span>
          <Heading as="h2" id="benchmark-video-title">
            Watch the Luna JavaScript run unfold
          </Heading>
        </div>
        <a href={social} download>
          Download 4:5 social video
        </a>
      </div>
      <div className={styles.frame}>
        <video
          controls
          playsInline
          preload="metadata"
          poster={poster}
          aria-label="Luna JavaScript Stim benchmark video"
        >
          <source src={video} type="video/mp4" />
          Your browser cannot play this video. The complete run remains available in the audit timeline below.
        </video>
      </div>
      <p>
        A continuous, silent replay of the published Luna rc.12 JavaScript run. The clock, commands, output, and proof
        come from the <a href={audit}>published Luna audit</a>; the matching simulator interaction was recreated with
        agent-device and plays at real speed.
      </p>
    </section>
  );
}
