import type { CSSProperties, ReactNode } from 'react';
import { useMemo, useState } from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import {
  assignCommandLanes,
  formatCost,
  formatSeconds,
  formatTokens,
  totalTokens,
  type BenchmarkCommand,
  type BenchmarkMarker,
  type BenchmarkMessage,
  type BenchmarkRun,
} from './benchmarkData';
import styles from './BenchmarkTimeline.module.css';

type SelectedEvent =
  | { kind: 'command'; event: BenchmarkCommand }
  | { kind: 'message'; event: BenchmarkMessage }
  | { kind: 'marker'; event: BenchmarkMarker };

function position(seconds: number, total: number): string {
  return `${Math.min(100, Math.max(0, (seconds / total) * 100))}%`;
}

function shortCommand(command: string): string {
  return displayCommand(command).slice(0, 92);
}

function displayCommand(command: string): string {
  return command.replace(/^\/bin\/(?:zsh|bash|sh) -lc /, '').replace(/^['"]|['"]$/g, '');
}

function eventTime(selected: SelectedEvent): number {
  if (selected.kind === 'command') return selected.event.endSeconds;
  return selected.event.atSeconds;
}

function TerminalDetail({ command }: { command: BenchmarkCommand }): ReactNode {
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
          {formatSeconds(command.endSeconds - command.startSeconds)} · exit {command.exitCode ?? '—'}
        </span>
      </div>
      <pre>
        <span className={styles.prompt}>$ </span>
        {displayCommand(command.command)}
        {command.output ? `\n\n${command.output}` : ''}
      </pre>
    </section>
  );
}

export default function BenchmarkTimeline({ run }: { run: BenchmarkRun }): ReactNode {
  const longestCommand = run.commands.reduce<BenchmarkCommand | undefined>(
    (longest, command) =>
      !longest || command.endSeconds - command.startSeconds > longest.endSeconds - longest.startSeconds
        ? command
        : longest,
    undefined,
  );
  const initial: SelectedEvent = longestCommand
    ? { kind: 'command', event: longestCommand }
    : run.markers[0]
      ? { kind: 'marker', event: run.markers[0] }
      : { kind: 'message', event: run.messages[0] };
  const [selected, setSelected] = useState<SelectedEvent>(initial);
  const { commands, laneCount } = useMemo(() => assignCommandLanes(run.commands), [run.commands]);
  const proofSrc = useBaseUrl(run.proof?.src ?? '');
  const ticks = [0, 0.25, 0.5, 0.75, 1];

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
            {formatTokens(run.usage.input_tokens)} input · {formatTokens(run.usage.output_tokens)} output ·{' '}
            {formatTokens(run.usage.reasoning_output_tokens)} reasoning
          </small>
        </div>
        <div>
          <span>Est. token cost</span>
          <strong>{formatCost(run.estimatedTokenCostUsd)}</strong>
          <small>API-equivalent base estimate</small>
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
            {run.model} · {run.variant} · {run.arm}
          </h2>
          <span className={run.valid ? styles.valid : styles.invalid}>
            {run.valid ? 'Valid run' : `Invalid: ${run.invalidReasons.join(', ')}`}
          </span>
        </div>
        <span>Agent turn {formatSeconds(run.totalSeconds)}</span>
      </div>

      <div className={styles.timelineScroller} tabIndex={0} aria-label="Benchmark command timeline">
        <div className={styles.timeline}>
          <div className={styles.axisLabel} />
          <div className={styles.axis}>
            {ticks.map((tick) => (
              <span key={tick} style={{ left: `${tick * 100}%` }}>
                {formatSeconds(run.totalSeconds * tick)}
              </span>
            ))}
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
                onClick={() => setSelected({ kind: 'message', event: message })}
              />
            ))}
          </div>

          <div className={styles.laneLabel}>Shell</div>
          <div className={styles.shellTracks} style={{ '--lane-count': laneCount } as CSSProperties}>
            {Array.from({ length: laneCount }, (_, lane) => (
              <div className={styles.shellTrack} key={lane}>
                {commands
                  .filter((command) => command.lane === lane)
                  .map((command) => (
                    <button
                      key={command.id}
                      type="button"
                      className={`${styles.commandBar} ${command.exitCode === 0 ? '' : styles.commandFailed} ${
                        selected.kind === 'command' && selected.event.id === command.id ? styles.commandSelected : ''
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
                      onClick={() => setSelected({ kind: 'command', event: command })}
                    >
                      {shortCommand(command.command)}
                    </button>
                  ))}
              </div>
            ))}
          </div>

          <div className={styles.laneLabel}>App/device</div>
          <div className={styles.dotTrack}>
            {run.markers.map((marker) => (
              <button
                key={marker.id}
                type="button"
                className={`${styles.deviceDot} ${marker.kind === 'settingsReady' ? styles.readyDot : ''}`}
                style={{ left: position(marker.atSeconds, run.totalSeconds) }}
                aria-label={`${marker.label} at ${formatSeconds(marker.atSeconds)}`}
                onClick={() => setSelected({ kind: 'marker', event: marker })}
              />
            ))}
          </div>
        </div>
      </div>

      {selected.kind === 'command' ? (
        <TerminalDetail command={selected.event} />
      ) : (
        <section className={styles.eventDetail} aria-live="polite">
          <div>
            <strong>{selected.kind === 'marker' ? selected.event.label : 'Agent note'}</strong>
            <span>+{formatSeconds(eventTime(selected))}</span>
          </div>
          <p>{selected.kind === 'message' ? selected.event.text : `${selected.event.label}.`}</p>
        </section>
      )}

      <details className={styles.commandIndex}>
        <summary>Commands in order ({run.commands.length})</summary>
        <div>
          {run.commands.map((command) => (
            <button type="button" key={command.id} onClick={() => setSelected({ kind: 'command', event: command })}>
              <span>+{formatSeconds(command.startSeconds)}</span>
              <code>{shortCommand(command.command)}</code>
              <span>{formatSeconds(command.endSeconds - command.startSeconds)}</span>
            </button>
          ))}
        </div>
      </details>

      <section className={styles.proof}>
        <div>
          <span>Validated proof</span>
          <h2>Settings screen</h2>
          <p>
            Captured by <code>agent-device</code> after it found “{run.proof?.expected}”. This screenshot completion is
            the timing endpoint used above.
          </p>
        </div>
        {run.proof ? (
          <img
            src={proofSrc}
            width={run.proof.width}
            height={run.proof.height}
            loading="lazy"
            alt={`Validated Settings screen for the ${run.variant} ${run.arm} run`}
          />
        ) : (
          <p>No validated Settings screenshot.</p>
        )}
      </section>
    </div>
  );
}
