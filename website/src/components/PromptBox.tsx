import { useEffect, useRef, useState, type ReactNode } from 'react';
import CodeBlock from '@theme/CodeBlock';
import styles from './PromptBox.module.css';

export function PromptGrid({ children }: { children: ReactNode }): ReactNode {
  return <div className={styles.promptGrid}>{children}</div>;
}

export default function PromptBox({
  title,
  children,
  response,
}: {
  title: string;
  children: string;
  response?: string;
}): ReactNode {
  const [simulation, setSimulation] = useState<'idle' | 'running' | 'complete'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function runExample(): void {
    if (timer.current) clearTimeout(timer.current);
    setSimulation('running');
    timer.current = setTimeout(() => setSimulation('complete'), 800);
  }

  return (
    <article className={styles.promptBox}>
      <h3 className={styles.promptTitle}>{title}</h3>
      <CodeBlock language="text">{children.trim()}</CodeBlock>
      {response ? (
        <div className={styles.simulation}>
          <button
            type="button"
            className={styles.runButton}
            onClick={runExample}
            disabled={simulation === 'running'}
            aria-expanded={simulation === 'complete'}
          >
            {simulation === 'idle' ? 'Run example' : simulation === 'running' ? 'Running...' : 'Run again'}
          </button>
          {simulation === 'running' ? (
            <div className={styles.running} role="status">
              <i aria-hidden="true" /> Agent is running the prompt...
            </div>
          ) : simulation === 'complete' ? (
            <div className={styles.response} role="status">
              <span>Example agent response</span>
              <pre>{response.trim()}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
