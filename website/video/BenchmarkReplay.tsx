import { Video } from '@remotion/media';
import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { terminalRows, type BenchmarkCommand } from './terminalRows';

type BenchmarkMessage = {
  atSeconds: number;
  text: string;
};

export type BenchmarkReplayProps = {
  benchmarkTitle: string;
  interactionSrc: string;
  interactionStartSrc: string;
  interactionEndSrc: string;
  run: {
    model: string;
    totalSeconds: number;
    settingsReadySeconds: number;
    messages: BenchmarkMessage[];
    commands: BenchmarkCommand[];
    proof: {
      src: string;
      expected: string;
    };
  };
  control: {
    settingsReadySeconds: number;
  };
};

const segments = [
  { videoStart: 0, videoEnd: 4.5, sourceStart: 0, sourceEnd: 0, label: 'task' },
  { videoStart: 4.5, videoEnd: 14.9774, sourceStart: 0, sourceEnd: 52.387, label: '5x setup' },
  { videoStart: 14.9774, videoEnd: 24.5788, sourceStart: 52.387, sourceEnd: 100.394, label: '5x build' },
  { videoStart: 24.5788, videoEnd: 41.3103, sourceStart: 100.394, sourceEnd: 133.857, label: '2x device' },
  { videoStart: 41.3103, videoEnd: 45.871, sourceStart: 133.857, sourceEnd: 159.853, label: '5.7x wrap-up' },
  { videoStart: 45.871, videoEnd: 50.871, sourceStart: 159.853, sourceEnd: 159.853, label: 'complete' },
] as const;

const colors = {
  background: '#071019',
  panelStrong: '#101e2c',
  line: '#243647',
  text: '#f7fafc',
  muted: '#8da0b3',
  green: '#6ee7c4',
  greenDark: '#0b5c4f',
  orange: '#ff9f66',
};

function sourceTime(videoSeconds: number) {
  const segment =
    segments.find((candidate) => videoSeconds >= candidate.videoStart && videoSeconds < candidate.videoEnd) ??
    segments[segments.length - 1];
  if (segment.sourceStart === segment.sourceEnd) return segment.sourceStart;
  return interpolate(videoSeconds, [segment.videoStart, segment.videoEnd], [segment.sourceStart, segment.sourceEnd], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
}

function videoTime(sourceSeconds: number) {
  const segment = segments.find(
    (candidate) => sourceSeconds >= candidate.sourceStart && sourceSeconds <= candidate.sourceEnd,
  );
  if (!segment || segment.sourceStart === segment.sourceEnd) return 0;
  return interpolate(sourceSeconds, [segment.sourceStart, segment.sourceEnd], [segment.videoStart, segment.videoEnd]);
}

function clock(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(1).padStart(4, '0')}`;
}

function currentMessage(messages: BenchmarkMessage[], sourceSeconds: number) {
  let message = '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].atSeconds <= sourceSeconds) {
      message = messages[index].text;
      break;
    }
  }
  if (message.startsWith('Completed.')) {
    return 'Completed. The required wait succeeded, the screenshot was copied and verified, and Metro remains running.';
  }
  return message;
}

export function BenchmarkReplay({
  benchmarkTitle,
  interactionSrc,
  interactionStartSrc,
  interactionEndSrc,
  run,
  control,
}: BenchmarkReplayProps) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const videoSeconds = frame / fps;
  const sourceSeconds = sourceTime(videoSeconds);
  const segment =
    segments.find((candidate) => videoSeconds >= candidate.videoStart && videoSeconds < candidate.videoEnd) ??
    segments[segments.length - 1];
  const social = width < 1500;
  const promptExit = interpolate(videoSeconds, [3.8, 5.4], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const terminalIn = spring({ frame: frame - 120, fps, config: { damping: 18, stiffness: 110 } });
  const deviceStart = videoTime(79.984);
  const deviceIn = spring({
    frame: frame - Math.round(deviceStart * fps),
    fps,
    config: { damping: 20, stiffness: 100 },
  });
  const clipStart = Math.round(videoTime(112.99) * fps);
  const clipDuration = 10 * fps;
  const clipEnd = clipStart + clipDuration;
  const ready = sourceSeconds >= run.settingsReadySeconds;
  const finishIn = spring({
    frame: frame - Math.round(videoTime(run.settingsReadySeconds) * fps),
    fps,
    config: { damping: 18, stiffness: 110 },
  });
  const rows = terminalRows(run.commands, sourceSeconds);
  const message = currentMessage(run.messages, sourceSeconds).replaceAll('`', '').replaceAll('\n', ' ');
  const percent = Math.round((1 - run.settingsReadySeconds / control.settingsReadySeconds) * 100);
  const padding = social ? 46 : 68;
  const headerHeight = social ? 126 : 104;
  const contentTop = padding + headerHeight;
  const contentBottom = social ? 48 : 62;
  const contentHeight = height - contentTop - contentBottom;
  const phoneWidth = social ? 286 : 396;
  const phoneHeight = social ? 621 : 858;
  const terminalWidth = social
    ? width - padding * 2
    : interpolate(deviceIn, [0, 1], [width - padding * 2, width - padding * 2 - 520]);
  const terminalHeight = social ? interpolate(deviceIn, [0, 1], [contentHeight, 520]) : contentHeight;
  const phoneTop = social ? contentTop + 524 : contentTop + (contentHeight - phoneHeight) / 2;
  const phoneLeft = width - padding - phoneWidth;
  const promptWidth = social ? width - 92 : 1180;

  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(circle at ${70 + Math.sin(videoSeconds / 7) * 8}% 0%, #12304a 0%, ${colors.background} 46%, #050a10 100%)`,
        color: colors.text,
        fontFamily: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0.2,
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)',
          backgroundSize: '52px 52px',
        }}
      />

      <div
        style={{
          position: 'absolute',
          left: padding,
          right: padding,
          top: padding,
          height: headerHeight - 18,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <div style={{ color: colors.green, fontSize: social ? 18 : 20, fontWeight: 800, letterSpacing: 3 }}>
            STIM / AGENT BENCHMARK
          </div>
          <div style={{ marginTop: 10, color: colors.muted, fontSize: social ? 17 : 19 }}>
            {benchmarkTitle} / JavaScript / {run.model}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div
            style={{
              padding: social ? '10px 13px' : '11px 17px',
              border: `1px solid ${segment.label === '2x device' ? colors.green : colors.line}`,
              borderRadius: 999,
              color: segment.label === '2x device' ? colors.green : colors.muted,
              background: 'rgba(7,16,25,0.86)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: social ? 15 : 18,
              fontWeight: 700,
            }}
          >
            {segment.label}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ color: colors.muted, fontSize: social ? 12 : 14, fontWeight: 800, letterSpacing: 2 }}>
              AUDITED CLOCK
            </div>
            <div
              style={{
                marginTop: 3,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: social ? 29 : 36,
                fontWeight: 800,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {clock(sourceSeconds)}
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          top: social ? 160 : 174,
          left: (width - promptWidth) / 2,
          width: promptWidth,
          padding: social ? '34px 38px' : '38px 48px',
          border: `1px solid ${colors.greenDark}`,
          borderRadius: 28,
          background: 'linear-gradient(145deg, rgba(16,30,44,0.98), rgba(10,21,31,0.98))',
          boxShadow: '0 30px 90px rgba(0,0,0,0.42), 0 0 70px rgba(45,212,191,0.08)',
          opacity: 1 - promptExit,
          transform: `translateY(${-promptExit * 90}px) scale(${1 - promptExit * 0.06})`,
        }}
      >
        <div style={{ color: colors.muted, fontSize: social ? 17 : 19, fontWeight: 800, letterSpacing: 2.5 }}>
          FIXED BENCHMARK TASK
        </div>
        <div style={{ marginTop: 24, fontSize: social ? 31 : 44, fontWeight: 750, lineHeight: 1.16 }}>
          Update Settings / Offline maps in a separate worktree.
        </div>
        <div
          style={{
            marginTop: 25,
            padding: social ? '22px 24px' : '24px 28px',
            borderRadius: 18,
            background: 'rgba(4,12,18,0.7)',
            color: colors.green,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: social ? 21 : 27,
            lineHeight: 1.45,
          }}
        >
          Keep map tiles for saved trails on device
          <br />
          <span style={{ color: colors.muted }}>becomes</span> Keep saved trail maps available offline
        </div>
        <div style={{ marginTop: 22, color: colors.muted, fontSize: social ? 18 : 21 }}>
          Launch on iOS, reach Settings, and save screenshot proof.
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          left: padding,
          top: contentTop,
          width: terminalWidth,
          height: terminalHeight,
          opacity: terminalIn,
          transform: `translateY(${(1 - terminalIn) * 45}px)`,
          border: `1px solid ${colors.line}`,
          borderRadius: 24,
          overflow: 'hidden',
          background: 'rgba(8,17,26,0.94)',
          boxShadow: '0 28px 80px rgba(0,0,0,0.36)',
        }}
      >
        <div
          style={{
            height: 58,
            display: 'flex',
            alignItems: 'center',
            padding: '0 22px',
            gap: 10,
            borderBottom: `1px solid ${colors.line}`,
            background: colors.panelStrong,
          }}
        >
          {['#ff6b7b', '#f8c35b', '#60d394'].map((color) => (
            <div key={color} style={{ width: 12, height: 12, borderRadius: 99, background: color }} />
          ))}
          <div
            style={{
              marginLeft: 10,
              color: colors.muted,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: social ? 15 : 17,
            }}
          >
            agent / trailhead
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            height: terminalHeight - 58,
            flexDirection: 'column',
            padding: social ? '22px 24px' : '26px 30px',
            boxSizing: 'border-box',
          }}
        >
          {message ? (
            <div
              style={{
                marginBottom: 20,
                padding: social ? '15px 17px' : '17px 20px',
                borderLeft: `3px solid ${colors.green}`,
                borderRadius: 10,
                background: 'rgba(110,231,196,0.07)',
                color: '#c9d7e3',
                fontSize: social ? 17 : 19,
                lineHeight: 1.35,
              }}
            >
              {message.length > (social ? 150 : 210) ? `${message.slice(0, social ? 150 : 210)}...` : message}
            </div>
          ) : null}
          <div
            style={{
              position: 'relative',
              flex: 1,
              minHeight: 0,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                position: 'absolute',
                right: 0,
                bottom: 0,
                left: 0,
                display: 'flex',
                minHeight: '100%',
                flexDirection: 'column',
                gap: social ? 8 : 10,
                paddingBottom: ready && !social ? 64 : 0,
                boxSizing: 'border-box',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: social ? 15 : 18,
                lineHeight: 1.3,
              }}
            >
              {rows.map((row, index) => (
                <div
                  key={`${row.text}-${index}`}
                  style={{
                    color: row.kind === 'command' ? colors.text : row.kind === 'active' ? colors.orange : colors.green,
                    opacity: row.kind === 'command' ? 1 : 0.82,
                    overflowWrap: 'anywhere',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {row.kind === 'active' ? '  * ' : row.kind === 'output' ? '  -> ' : ''}
                  {row.kind === 'output' ? row.text.replaceAll('\n', '\n     ') : row.text}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          left: phoneLeft,
          top: phoneTop,
          width: phoneWidth,
          height: phoneHeight,
          opacity: deviceIn,
          transform: `translateX(${(1 - deviceIn) * 120}px) scale(${0.96 + deviceIn * 0.04})`,
          borderRadius: social ? 48 : 58,
          padding: social ? 12 : 14,
          background: '#05090d',
          border: `1px solid ${ready ? colors.green : '#3a4c5d'}`,
          boxShadow: ready ? '0 25px 90px rgba(45,212,191,0.22)' : '0 25px 80px rgba(0,0,0,0.48)',
        }}
      >
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            overflow: 'hidden',
            borderRadius: social ? 38 : 45,
            background: '#f4f4f1',
          }}
        >
          <Img src={staticFile(interactionStartSrc)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          <Sequence from={clipStart} durationInFrames={clipDuration} layout="none">
            <Video
              src={staticFile(interactionSrc)}
              muted
              playbackRate={2}
              objectFit="cover"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
            />
          </Sequence>
          {frame >= clipEnd ? (
            <Img
              src={staticFile(interactionEndSrc)}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : null}
          {ready ? (
            <Img
              src={staticFile(run.proof.src)}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                opacity: finishIn,
              }}
            />
          ) : null}
        </div>
        <div
          style={{
            position: 'absolute',
            left: 18,
            right: 18,
            bottom: social ? 19 : 22,
            display: 'flex',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              padding: '8px 12px',
              borderRadius: 999,
              background: 'rgba(5,9,13,0.86)',
              color: ready ? colors.green : '#d4dee7',
              fontSize: social ? 13 : 15,
              fontWeight: 750,
              backdropFilter: 'blur(10px)',
            }}
          >
            {ready
              ? 'Verified proof'
              : sourceSeconds >= 100.394
                ? 'Recreated interaction / 2x'
                : 'Stim-owned simulator'}
          </div>
        </div>
      </div>

      {ready ? (
        <div
          style={{
            position: 'absolute',
            left: padding,
            bottom: social ? 44 : 58,
            display: 'flex',
            gap: social ? 12 : 18,
            opacity: finishIn,
            transform: `translateY(${(1 - finishIn) * 25}px)`,
          }}
        >
          <div
            style={{
              padding: social ? '14px 17px' : '16px 21px',
              borderRadius: 16,
              background: colors.green,
              color: '#06231f',
              fontSize: social ? 17 : 20,
              fontWeight: 850,
            }}
          >
            SETTINGS READY {clock(run.settingsReadySeconds)}
          </div>
          <div
            style={{
              padding: social ? '14px 17px' : '16px 21px',
              border: `1px solid ${colors.line}`,
              borderRadius: 16,
              background: 'rgba(8,17,26,0.92)',
              color: colors.text,
              fontSize: social ? 17 : 20,
              fontWeight: 750,
            }}
          >
            {percent}% sooner than local toolchain
          </div>
        </div>
      ) : null}

      <div
        style={{
          position: 'absolute',
          left: padding,
          right: padding,
          bottom: 22,
          height: 5,
          borderRadius: 99,
          background: '#152332',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${Math.min(1, sourceSeconds / run.settingsReadySeconds) * 100}%`,
            height: '100%',
            borderRadius: 99,
            background: `linear-gradient(90deg, ${colors.greenDark}, ${colors.green})`,
          }}
        />
      </div>
    </AbsoluteFill>
  );
}
