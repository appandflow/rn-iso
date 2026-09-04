import { createElement, type ReactNode } from 'react';

export default function CodeBlock({ children }: { children: ReactNode }): ReactNode {
  return createElement('pre', null, children);
}
