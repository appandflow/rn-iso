import { Composition } from 'remotion';
import { BenchmarkReplay, type BenchmarkReplayProps } from './BenchmarkReplay';

const defaultProps: BenchmarkReplayProps = {
  benchmarkTitle: 'Luna rc.12',
  interactionSrc: 'benchmarks/luna-rc12/javascript-stim-interaction.mp4',
  interactionStartSrc: 'benchmarks/luna-rc12/javascript-stim-interaction-start.png',
  interactionEndSrc: 'benchmarks/luna-rc12/javascript-stim-interaction-end.png',
  run: {
    model: 'gpt-5.6-luna',
    totalSeconds: 159.853,
    settingsReadySeconds: 133.857,
    messages: [],
    commands: [],
    proof: {
      src: 'benchmarks/luna-rc12/javascript-stim.png',
      expected: 'Keep saved trail maps available offline',
    },
  },
  control: {
    settingsReadySeconds: 479.412,
  },
};

export function BenchmarkRoot() {
  return (
    <>
      <Composition
        id="BenchmarkLandscape"
        component={BenchmarkReplay}
        durationInFrames={1527}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={defaultProps}
      />
      <Composition
        id="BenchmarkSocial"
        component={BenchmarkReplay}
        durationInFrames={1527}
        fps={30}
        width={1080}
        height={1350}
        defaultProps={defaultProps}
      />
    </>
  );
}
