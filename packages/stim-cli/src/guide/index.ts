import agent from './agent.ts';
import facts from './facts.ts';
import metro from './metro.ts';
import logs from './logs.ts';
import errors from './errors.ts';
import lifecycle from './lifecycle.ts';
import cleanup from './cleanup.ts';
import settings from './settings.ts';

export interface GuideSection {
  summary: string;
  aliases?: string[];
  separator?: string;
  context?: string;
  body: () => string;
}

export interface GuideTopic {
  summary: string;
  sectionHint?: string;
  body?: () => string;
  preamble?: () => string;
  sections?: Record<string, GuideSection>;
}

const TOPICS: Record<string, GuideTopic> = {
  agent,
  facts,
  metro,
  logs,
  errors,
  lifecycle,
  cleanup,
  settings,
};

export default TOPICS;
