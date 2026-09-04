import type { CSSProperties, ReactNode } from 'react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import {
  assignCommandLanes,
  commandAtCursor,
  formatCost,
  formatSeconds,
  formatTokens,
  initialAuditSelection,
  timeBreakdown,
  totalTokens,
  type BenchmarkAuditSelection,
  type BenchmarkBackgroundProcess,
  type BenchmarkCommand,
  type BenchmarkRun,
} from './benchmarkData';
import styles from './BenchmarkTimeline.module.css';

function position(seconds: number, total: number): string {
  return `${Math.min(100, Math.max(0, (seconds / total) * 100))}%`;
}

function shortCommand(command: string): string {
  return displayCommand(command).slice(0, 92);
}

function displayCommand(command: string): string {
  return command.replace(/^\/bin\/(?:zsh|bash|sh) -lc /, '').replace(/^['"]|['"]$/g, '');
}

function eventTime(selected: BenchmarkAuditSelection): number {
  if (selected.kind === 'command') return selected.event.endSeconds;
  if (selected.kind === 'background') return selected.event.endSeconds;
  return selected.event.atSeconds;
}

function BackgroundDetail({ process }: { process: BenchmarkBackgroundProcess }): ReactNode {
  return (
    <section className={styles.eventDetail} aria-live="polite">
      <div>
        <strong>{process.label}</strong>
        <span>
          +{formatSeconds(process.startSeconds)} to +{formatSeconds(process.endSeconds)}
        </span>
      </div>
      <p>
        A launcher detached this process with <code>nohup</code>. Later process-inspection commands referenced its PID
        or PID file {process.monitorCount} {process.monitorCount === 1 ? 'time' : 'times'} through the end of this span;
        this is recorded monitoring evidence, not a claim that the process exited there.
      </p>
    </section>
  );
}

function TerminalDetail({
  command,
  state = 'complete',
  cursorSeconds,
}: {
  command: BenchmarkCommand;
  state?: 'running' | 'complete';
  cursorSeconds?: number;
}): ReactNode {
  const elapsed =
    state === 'running'
      ? Math.max(0, (cursorSeconds ?? command.startSeconds) - command.startSeconds)
      : command.endSeconds - command.startSeconds;
  return (
    <section className={styles.terminal} aria-live="polite">
      <div className={styles.terminalBar}>
        <span className={styles.terminalLights} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span>Terminal</span>
        <span>
          {formatSeconds(elapsed)} / {state === 'running' ? 'running' : `exit ${command.exitCode ?? '-'}`}
        </span>
      </div>
      <pre>
        <span className={styles.prompt}>$ </span>
        {displayCommand(command.command)}
        {state === 'running' ? '\n\n... command still running' : command.output ? `\n\n${command.output}` : ''}
      </pre>
    </section>
  );
}

export default function BenchmarkTimeline({ run }: { run: BenchmarkRun }): ReactNode {
  const [selected, setSelected] = useState<BenchmarkAuditSelection | null>(() => initialAuditSelection(run));
  const [playbackMode, setPlaybackMode] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [cursorSeconds, setCursorSeconds] = useState(0);
  const [speed, setSpeed] = useState(20);
  const [zoom, setZoom] = useState(1);
  const { commands, laneCount } = useMemo(() => assignCommandLanes(run.commands), [run.commands]);
  const breakdown = useMemo(() => timeBreakdown(run), [run]);
  const playbackCommand = useMemo(() => commandAtCursor(run.commands, cursorSeconds), [run.commands, cursorSeconds]);
  const proofSrc = useBaseUrl(run.proof?.src ?? '');
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let previous = performance.now();
    const advance = (now: number) => {
      const elapsed = ((now - previous) / 1000) * speed;
      previous = now;
      setCursorSeconds((current) => {
        const next = Math.min(run.totalSeconds, current + elapsed);
        if (next >= run.totalSeconds) setPlaying(false);
        return next;
      });
      frame = requestAnimationFrame(advance);
    };
    frame = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(frame);
  }, [playing, run.totalSeconds, speed]);

  function inspect(selection: BenchmarkAuditSelection): void {
    setPlaying(false);
    setPlaybackMode(false);
    setSelected(selection);
  }

  function togglePlayback(): void {
    setPlaybackMode(true);
    if (cursorSeconds >= run.totalSeconds) setCursorSeconds(0);
    setPlaying((current) => !current);
  }

  return (
    <div className={styles.viewer}>
      <div className={styles.stats}>
        <div>
          <span>Settings ready</span>
          <strong>{formatSeconds(run.settingsReadySeconds)}</strong>
          <small>primary outcome</small>
        </div>
        <div>
          <span>Total tokens</span>
          <strong>{formatTokens(totalTokens(run.usage))}</strong>
          <small>
            {formatTokens(run.usage.input_tokens)} input / {formatTokens(run.usage.output_tokens)} output /{' '}
            {formatTokens(run.usage.reasoning_output_tokens)} reasoning
          </small>
        </div>
        <div>
          <span>Token cost</span>
          <strong>{formatCost(run.estimatedTokenCostUsd)}</strong>
          <small>reported by runner or API-equivalent estimate</small>
        </div>
        <div>
          <span>Commands</span>
          <strong>{run.commandCount}</strong>
          <small>{formatTokens(run.usage.cached_input_tokens)} cached input</small>
        </div>
      </div>

      <div className={styles.runHeading}>
        <div>
          <h2>
            {run.model} / {run.variant} / {run.arm}
          </h2>
          <span className={run.valid ? styles.valid : styles.invalid}>
            {run.valid ? 'Valid run' : `Invalid: ${run.invalidReasons.join(', ')}`}
          </span>
        </div>
        <span>Agent turn {formatSeconds(run.totalSeconds)}</span>
      </div>

      <section className={styles.summary}>
        <span>What the agent did</span>
        <p>{run.summary}</p>
      </section>

      <div className={styles.breakdown}>
        <div className={styles.breakdownBar} aria-label="Agent time category summary">
          <span
            className={styles.agentTime}
            style={{ width: `${(breakdown.agentOtherSeconds / Math.max(1, run.totalSeconds)) * 100}%` }}
          />
          <span
            className={styles.shellTime}
            style={{ width: `${(breakdown.shellActiveSeconds / Math.max(1, run.totalSeconds)) * 100}%` }}
          />
        </div>
        <div className={styles.breakdownLegend}>
          <span>
            <i className={styles.agentKey} />
            Agent / other <strong>{formatSeconds(breakdown.agentOtherSeconds)}</strong>
          </span>
          <span>
            <i className={styles.shellKey} />
            Shell active <strong>{formatSeconds(breakdown.shellActiveSeconds)}</strong>
          </span>
          <span>
            Commands summed <strong>{formatSeconds(breakdown.summedCommandSeconds)}</strong>
          </span>
          <span>
            Peak concurrency <strong>{breakdown.peakConcurrency}</strong>
          </span>
        </div>
        <small>
          &quot;Agent / other&quot; is time with no command active; it includes reasoning, tool selection, harness
          latency, and idle gaps.
        </small>
      </div>

      <div className={styles.playbackControls}>
        <button type="button" onClick={togglePlayback}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          type="button"
          onClick={() => {
            setPlaying(false);
            setPlaybackMode(true);
            setCursorSeconds(0);
            setZoom(1);
          }}
        >
          Reset
        </button>
        <label>
          <span className="sr-only">Playback position</span>
          <input
            type="range"
            min={0}
            max={Math.max(0.01, run.totalSeconds)}
            step={0.1}
            value={cursorSeconds}
            onChange={(event) => {
              setPlaying(false);
              setPlaybackMode(true);
              setCursorSeconds(Number(event.currentTarget.value));
            }}
          />
        </label>
        <strong>
          {formatSeconds(cursorSeconds)} / {formatSeconds(run.totalSeconds)}
        </strong>
        <select
          value={speed}
          onChange={(event) => setSpeed(Number(event.currentTarget.value))}
          aria-label="Playback speed"
        >
          <option value={1}>1x</option>
          <option value={5}>5x</option>
          <option value={20}>20x</option>
          <option value={60}>60x</option>
        </select>
      </div>

      <label className={styles.zoomControl}>
        <span>Timeline zoom</span>
        <input
          type="range"
          min={1}
          max={4}
          step={0.5}
          value={zoom}
          aria-valuetext={`${zoom} times`}
          onChange={(event) => setZoom(Number(event.currentTarget.value))}
        />
        <output>{zoom}x</output>
      </label>

      <div className={styles.timelineScroller} tabIndex={0} aria-label="Benchmark command timeline">
        <div
          className={styles.timeline}
          style={{ width: zoom === 1 ? '100%' : `max(${49.5 * zoom}rem, ${zoom * 100}%)` }}
        >
          <div className={styles.axisLabel} />
          <div className={styles.axis}>
            {ticks.map((tick) => (
              <span key={tick} style={{ left: `${tick * 100}%` }}>
                {formatSeconds(run.totalSeconds * tick)}
              </span>
            ))}
            {playbackMode ? (
              <i className={styles.playhead} style={{ left: position(cursorSeconds, run.totalSeconds) }} />
            ) : null}
          </div>

          <div className={styles.laneLabel}>Agent</div>
          <div className={styles.dotTrack}>
            {run.messages.map((message) => (
              <button
                key={message.id}
                type="button"
                className={styles.agentDot}
                style={{ left: position(message.atSeconds, run.totalSeconds) }}
                aria-label={`Agent note at ${formatSeconds(message.atSeconds)}`}
                onClick={() => inspect({ kind: 'message', event: message })}
              />
            ))}
          </div>

          <div className={styles.laneLabel}>Shell</div>
          <div className={styles.shellTracks} style={{ '--lane-count': laneCount } as CSSProperties}>
            {playbackMode ? (
              <i className={styles.playhead} style={{ left: position(cursorSeconds, run.totalSeconds) }} />
            ) : null}
            {Array.from({ length: laneCount }, (_, lane) => (
              <div className={styles.shellTrack} key={lane}>
                {commands
                  .filter((command) => command.lane === lane)
                  .map((command) => (
                    <button
                      key={command.id}
                      type="button"
                      className={`${styles.commandBar} ${command.exitCode === 0 ? '' : styles.commandFailed} ${
                        (playbackMode && playbackCommand?.command.id === command.id) ||
                        (!playbackMode && selected?.kind === 'command' && selected.event.id === command.id)
                          ? styles.commandSelected
                          : ''
                      }`}
                      style={{
                        left: position(command.startSeconds, run.totalSeconds),
                        width: `${Math.max(
                          0.7,
                          ((command.endSeconds - command.startSeconds) / run.totalSeconds) * 100,
                        )}%`,
                      }}
                      aria-label={`${shortCommand(command.command)}, ${formatSeconds(
                        command.endSeconds - command.startSeconds,
                      )}, exit ${command.exitCode ?? 'unknown'}`}
                      onClick={() => inspect({ kind: 'command', event: command })}
                    >
                      {shortCommand(command.command)}
                    </button>
                  ))}
              </div>
            ))}
          </div>

          {run.backgroundProcesses.length
            ? run.backgroundProcesses.map((process, index) => {
                const active =
                  playbackMode && cursorSeconds >= process.startSeconds && cursorSeconds <= process.endSeconds;
                const selectedProcess =
                  !playbackMode && selected?.kind === 'background' && selected.event.id === process.id;
                return (
                  <Fragment key={process.id}>
                    <div className={styles.laneLabel}>{index === 0 ? 'Background' : null}</div>
                    <div className={styles.backgroundTrack}>
                      {playbackMode ? (
                        <i className={styles.playhead} style={{ left: position(cursorSeconds, run.totalSeconds) }} />
                      ) : null}
                      <button
                        type="button"
                        className={`${styles.backgroundBar} ${active || selectedProcess ? styles.commandSelected : ''}`}
                        style={{
                          left: position(process.startSeconds, run.totalSeconds),
                          width: `${Math.max(
                            0.7,
                            ((process.endSeconds - process.startSeconds) / run.totalSeconds) * 100,
                          )}%`,
                        }}
                        aria-label={`${process.label}, monitored for ${formatSeconds(
                          process.endSeconds - process.startSeconds,
                        )}`}
                        onClick={() => inspect({ kind: 'background', event: process })}
                      >
                        {process.label}
                      </button>
                    </div>
                  </Fragment>
                );
              })
            : null}

          <div className={styles.laneLabel}>App/device</div>
          <div className={styles.dotTrack}>
            {run.markers.map((marker) => (
              <button
                key={marker.id}
                type="button"
                className={`${styles.deviceDot} ${marker.kind === 'settingsReady' ? styles.readyDot : ''}`}
                style={{ left: position(marker.atSeconds, run.totalSeconds) }}
                aria-label={`${marker.label} at ${formatSeconds(marker.atSeconds)}`}
                onClick={() => inspect({ kind: 'marker', event: marker })}
              />
            ))}
          </div>
        </div>
      </div>

      {playbackMode && playbackCommand ? (
        <TerminalDetail command={playbackCommand.command} state={playbackCommand.state} cursorSeconds={cursorSeconds} />
      ) : playbackMode ? (
        <section className={styles.eventDetail} aria-live="polite">
          <div>
            <strong>Waiting for the first command</strong>
            <span>+{formatSeconds(cursorSeconds)}</span>
          </div>
          <p>Playback follows recorded event boundaries. Command output appears when that command completes.</p>
        </section>
      ) : selected?.kind === 'command' ? (
        <TerminalDetail command={selected.event} />
      ) : selected?.kind === 'background' ? (
        <BackgroundDetail process={selected.event} />
      ) : selected ? (
        <section className={styles.eventDetail} aria-live="polite">
          <div>
            <strong>{selected.kind === 'marker' ? selected.event.label : 'Agent note'}</strong>
            <span>+{formatSeconds(eventTime(selected))}</span>
          </div>
          <p>{selected.kind === 'message' ? selected.event.text : `${selected.event.label}.`}</p>
        </section>
      ) : (
        <section className={styles.eventDetail} aria-live="polite">
          <div>
            <strong>No audit events recorded</strong>
          </div>
          <p>This attempt ended before the agent emitted a command, message, or app/device marker.</p>
        </section>
      )}

      <details className={styles.commandIndex}>
        <summary>Commands in order ({run.commands.length})</summary>
        <div>
          {run.commands.map((command) => (
            <button type="button" key={command.id} onClick={() => inspect({ kind: 'command', event: command })}>
              <span>+{formatSeconds(command.startSeconds)}</span>
              <code>{shortCommand(command.command)}</code>
              <span>{formatSeconds(command.endSeconds - command.startSeconds)}</span>
            </button>
          ))}
        </div>
      </details>

      {run.proof ? (
        <section className={styles.proof}>
          <div>
            <span>Validated proof</span>
            <h2>Settings screen</h2>
            <p>
              Captured by <code>agent-device</code> after it found &quot;{run.proof.expected}&quot;. This screenshot
              completion is the timing endpoint used above.
            </p>
          </div>
          <img
            src={proofSrc}
            width={run.proof.width}
            height={run.proof.height}
            loading="lazy"
            alt={`Validated Settings screen for the ${run.variant} ${run.arm} run`}
          />
        </section>
      ) : (
        <section className={styles.proof}>
          <div>
            <span>Proof unavailable</span>
            <h2>No validated Settings screenshot</h2>
            <p>This attempt did not reach the benchmark's required visual endpoint.</p>
          </div>
        </section>
      )}
    </div>
  );
}
