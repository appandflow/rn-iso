import type { ReactNode } from 'react';
import CodeBlock from '@theme/CodeBlock';
import TabItem from '@theme/TabItem';
import Tabs from '@theme/Tabs';

const groupId = 'stim-invocation';
const npxPrefix = 'npx stim-cli';

function normalize(code: string): string {
  return code.trim();
}

function toNpx(code: string): string {
  return normalize(code).replace(/\bstim(?=\s)/g, npxPrefix);
}

export default function StimTabs({ code }: { code: string }): ReactNode {
  const globalCode = normalize(code);

  return (
    <Tabs groupId={groupId} defaultValue="global">
      <TabItem value="global" label="Global">
        <CodeBlock language="bash">{globalCode}</CodeBlock>
      </TabItem>
      <TabItem value="npx" label="npx">
        <CodeBlock language="bash">{toNpx(globalCode)}</CodeBlock>
      </TabItem>
    </Tabs>
  );
}

export function StimInstallTabs(): ReactNode {
  return (
    <Tabs groupId={groupId} defaultValue="global">
      <TabItem value="global" label="Global">
        <CodeBlock language="bash">{`npm install --global stim-cli
stim <command>`}</CodeBlock>
      </TabItem>
      <TabItem value="npx" label="npx">
        <CodeBlock language="bash">{`${npxPrefix} <command>`}</CodeBlock>
      </TabItem>
    </Tabs>
  );
}
