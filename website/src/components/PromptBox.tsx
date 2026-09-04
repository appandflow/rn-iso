import type { ReactNode } from 'react';
import CodeBlock from '@theme/CodeBlock';
import styles from './PromptBox.module.css';

export function PromptGrid({ children }: { children: ReactNode }): ReactNode {
  return <div className={styles.promptGrid}>{children}</div>;
}

export default function PromptBox({ title, children }: { title: string; children: string }): ReactNode {
  return (
    <article className={styles.promptBox}>
      <h3 className={styles.promptTitle}>{title}</h3>
      <CodeBlock language="text">{children.trim()}</CodeBlock>
    </article>
  );
}
