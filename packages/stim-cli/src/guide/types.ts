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
